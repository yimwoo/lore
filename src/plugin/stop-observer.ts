import { basename } from "node:path";
import { createInterface } from "node:readline";

import { resolveConfig } from "../config";
import type { LoreConfig } from "../config";
import type { ExtractionProvider, TurnArtifact } from "../extraction/extraction-provider";
import { DraftStoreWriter } from "../promotion/draft-store";
import { deriveSessionKey, readWhisperState, writeWhisperState } from "./whisper-state";
import type { VisibleLoreItem, WhisperSessionState } from "../shared/types";
import { isSharedKnowledgeKind } from "../shared/types";
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "../shared/debug-log";

type StopInput = {
  session_id?: string;
  cwd?: string;
  tool_calls?: Array<{ tool_name?: string; file_path?: string }>;
  files_modified?: string[];
  files_read?: string[];
  prompt?: string;
  response?: string;
  response_summary?: string;
  assistant_response?: string;
};

type DraftWriter = {
  append: (entry: Awaited<ReturnType<ExtractionProvider["extractCandidates"]>>[number]) => Promise<void>;
};

export type LoreDirective =
  | {
      type: "capture";
      kind: string;
      content: string;
    }
  | {
      type: "approve" | "dismiss";
      id?: string;
    };

type StopObserverDependencies = {
  config?: LoreConfig;
  provider?: ExtractionProvider;
  draftWriter?: DraftWriter;
  now?: () => string;
  readState?: (
    sessionKey: string,
    whisperStateDir: string,
  ) => Promise<WhisperSessionState>;
  writeState?: (
    state: WhisperSessionState,
    whisperStateDir: string,
    config: LoreConfig["whisper"],
  ) => Promise<void>;
};

export const applyStopUpdate = (
  state: WhisperSessionState,
  input: StopInput,
): WhisperSessionState => {
  const updated = { ...state };

  // Always increment turn index
  updated.turnIndex = state.turnIndex + 1;

  // Update recent files if data available
  const newFiles: string[] = [];
  if (input.files_modified) newFiles.push(...input.files_modified);
  if (input.files_read) newFiles.push(...input.files_read);

  if (newFiles.length > 0) {
    const combined = Array.from(new Set([...newFiles, ...state.recentFiles]));
    updated.recentFiles = combined;
  } else {
    updated.recentFiles = [...state.recentFiles];
  }

  // Update recent tool names if data available
  if (input.tool_calls && input.tool_calls.length > 0) {
    const toolNames = input.tool_calls
      .map((tc) => tc.tool_name)
      .filter((n): n is string => Boolean(n));
    const combined = Array.from(
      new Set([...toolNames, ...state.recentToolNames]),
    );
    updated.recentToolNames = combined;
  } else {
    updated.recentToolNames = [...state.recentToolNames];
  }

  // Copy whisperHistory and injectedContentHashes as-is
  updated.whisperHistory = [...state.whisperHistory];
  updated.injectedContentHashes = [...state.injectedContentHashes];
  updated.activeReceipt = state.activeReceipt;
  updated.visibleItems = [...(state.visibleItems ?? [])];

  return updated;
};

export const parseLoreDirectives = (
  assistantResponse: string,
): LoreDirective[] => {
  const directives: LoreDirective[] = [];
  const lines = assistantResponse.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    const captureMatch = /^\[lore:capture\s+kind=([a-z_]+)\]\s+(.+)$/i.exec(trimmed);
    if (captureMatch) {
      const kind = captureMatch[1]?.trim() ?? "";
      if (!isSharedKnowledgeKind(kind) || kind === "decision_record") {
        continue;
      }
      directives.push({
        type: "capture",
        kind,
        content: captureMatch[2]?.trim() ?? "",
      });
      continue;
    }

    const actionMatch = /^\[lore:(approve|dismiss)(?:\s+id=(\S+))?\]$/i.exec(trimmed);
    if (!actionMatch) {
      continue;
    }

    directives.push({
      type: actionMatch[1]?.toLowerCase() === "approve" ? "approve" : "dismiss",
      id: actionMatch[2],
    });
  }

  return directives;
};

export const resolveLoreDirectiveTarget = (
  directive: Extract<LoreDirective, { type: "approve" | "dismiss" }>,
  visibleItems: VisibleLoreItem[],
): VisibleLoreItem | null => {
  if (directive.id) {
    return visibleItems.find((item) => item.handle === directive.id) ?? null;
  }

  if (directive.type === "dismiss") {
    const receipt = visibleItems.find((item) => item.itemType === "receipt");
    if (receipt) {
      return receipt;
    }
  }

  return visibleItems.find((item) => item.itemType === "suggested") ?? null;
};

const deriveProjectId = (cwd: string): string => basename(cwd) || "unknown-project";

const summarizeToolCalls = (
  toolCalls?: Array<{ tool_name?: string; file_path?: string }>,
): string[] => {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      const toolName = toolCall.tool_name?.trim();
      const filePath = toolCall.file_path?.trim();

      if (toolName && filePath) {
        return `${toolName} ${filePath}`;
      }

      return toolName ?? filePath ?? "";
    })
    .filter((summary): summary is string => summary.length > 0);
};

export const buildTurnArtifact = (
  state: WhisperSessionState,
  input: StopInput,
  cwd: string,
  timestamp: string,
): TurnArtifact => {
  const files = Array.from(
    new Set([
      ...(input.files_modified ?? []),
      ...(input.files_read ?? []),
    ]),
  );

  return {
    sessionId: input.session_id ?? "",
    projectId: deriveProjectId(cwd),
    turnIndex: state.turnIndex,
    turnTimestamp: timestamp,
    userPrompt: input.prompt,
    assistantResponse:
      input.assistant_response ?? input.response_summary ?? input.response,
    toolSummaries: summarizeToolCalls(input.tool_calls),
    files,
    recentToolNames: [...state.recentToolNames],
  };
};

const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    const reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => { data += line; });
    reader.on("close", () => { resolve(data); });
    setTimeout(() => { reader.close(); }, 100);
  });

export const runStopObserver = async (
  stdinData?: string,
  dependencies?: StopObserverDependencies,
): Promise<void> => {
  const startedAt = Date.now();
  const runId = debugLoggingEnabled ? createRunId() : undefined;
  const config = dependencies?.config ?? resolveConfig();
  const now = dependencies?.now ?? (() => new Date().toISOString());
  const readState = dependencies?.readState ?? readWhisperState;
  const writeState = dependencies?.writeState ?? writeWhisperState;
  const log = (
    level: DebugLogLevel,
    event: string,
    data?: Record<string, unknown>,
    extras?: {
      ok?: boolean;
      summary?: string;
      durationMs?: number;
      sessionId?: string;
      sessionKey?: string;
      projectId?: string;
    },
  ): void => {
    if (!runId) {
      return;
    }

    dlog({
      level,
      component: "stop-observer",
      event,
      hook: "Stop",
      runId,
      sessionId: extras?.sessionId,
      sessionKey: extras?.sessionKey,
      projectId: extras?.projectId,
      ok: extras?.ok,
      summary: extras?.summary,
      durationMs: extras?.durationMs,
      data,
    });
  };
  const input = stdinData ?? (await readStdin());
  log("debug", "stop.invoked", {
    hasStdinData: stdinData !== undefined,
    inputLength: input.length,
  });

  let parsed: StopInput = {};
  try {
    if (input.trim().length > 0) {
      parsed = JSON.parse(input) as StopInput;
    }
  } catch {
    log("warn", "stop.input_parsed", {
      parsed: false,
      inputLength: input.length,
    }, {
      ok: false,
      durationMs: Date.now() - startedAt,
      summary: "Stop hook input was malformed and ignored.",
    });
    return; // unparseable → no-op
  }

  const sessionId = parsed.session_id;
  const cwd = parsed.cwd ?? process.cwd();
  const projectId = deriveProjectId(cwd);
  log("debug", "stop.input_parsed", {
    parsed: true,
    cwd,
    hasSessionId: sessionId !== undefined,
    hasPrompt: typeof parsed.prompt === "string" && parsed.prompt.length > 0,
    hasResponse:
      typeof parsed.assistant_response === "string" ||
      typeof parsed.response_summary === "string" ||
      typeof parsed.response === "string",
    toolCallCount: parsed.tool_calls?.length ?? 0,
    filesModifiedCount: parsed.files_modified?.length ?? 0,
    filesReadCount: parsed.files_read?.length ?? 0,
  }, {
    ok: true,
    sessionId,
    projectId,
  });

  if (!sessionId) {
    log("debug", "stop.extraction.skipped", {
      reason: "no_session_id",
    }, {
      ok: true,
      durationMs: Date.now() - startedAt,
      summary: "Stop hook skipped because session_id was missing.",
      projectId,
    });
    return; // whispers disabled
  }

  const sessionKey = deriveSessionKey(sessionId, cwd);
  const state = await readState(sessionKey, config.whisperStateDir);
  log("trace", "stop.state_loaded", {
    turnIndex: state.turnIndex,
    recentFileCount: state.recentFiles.length,
    recentToolCount: state.recentToolNames.length,
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
  });

  const updated = applyStopUpdate(state, parsed);
  await writeState(updated, config.whisperStateDir, config.whisper);
  log("debug", "stop.state_updated", {
    turnIndex: updated.turnIndex,
    recentFileCount: updated.recentFiles.length,
    recentToolCount: updated.recentToolNames.length,
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
  });

  if (!dependencies?.provider) {
    log("debug", "stop.extraction.skipped", {
      reason: "no_provider_configured",
    }, {
      ok: true,
      durationMs: Date.now() - startedAt,
      sessionId,
      sessionKey,
      projectId,
      summary: "Stop hook updated state but skipped extraction because no provider was configured.",
    });
    return;
  }

  const artifact = buildTurnArtifact(updated, parsed, cwd, now());
  const draftWriter =
    dependencies.draftWriter ??
    new DraftStoreWriter({
      draftDir: config.draftDir,
      sessionId,
    });

  try {
    log("debug", "stop.extraction.begin", {
      turnIndex: artifact.turnIndex,
      fileCount: artifact.files.length,
      toolSummaryCount: artifact.toolSummaries.length,
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
    });
    const drafts = await dependencies.provider.extractCandidates(artifact);
    log("debug", "stop.extraction.done", {
      draftCount: drafts.length,
      draftKinds: drafts.map((draft) => draft.kind),
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
    });
    for (const draft of drafts) {
      try {
        await draftWriter.append(draft);
      } catch (error) {
        log("warn", "stop.draft_write_error", {
          draftId: draft.id,
          error: error instanceof Error ? error.message : String(error),
        }, {
          ok: false,
          sessionId,
          sessionKey,
          projectId,
          summary: "Stop hook extracted a draft but failed to persist it.",
        });
        throw error;
      }
    }
    log("debug", "stop.drafts_written", {
      draftCount: drafts.length,
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
    });
  } catch {
    // Extraction is advisory only. The Stop hook should never surface failures.
    log("warn", "stop.extraction.error", undefined, {
      ok: false,
      sessionId,
      sessionKey,
      projectId,
      summary: "Stop hook extraction failed but was treated as advisory.",
    });
  }

  log("info", "stop.completed", undefined, {
    ok: true,
    durationMs: Date.now() - startedAt,
    sessionId,
    sessionKey,
    projectId,
    summary: "Stop hook completed.",
  });
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runStopObserver();
}
