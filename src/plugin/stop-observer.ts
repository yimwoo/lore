import { basename } from "node:path";
import { createInterface } from "node:readline";

import { resolveConfig } from "../config";
import type { LoreConfig } from "../config";
import { FileSharedStore } from "../core/file-shared-store";
import type { ExtractionProvider, TurnArtifact } from "../extraction/extraction-provider";
import { FileApprovalStore } from "../promotion/approval-store";
import { DraftStoreWriter } from "../promotion/draft-store";
import { Promoter } from "../promotion/promoter";
import { FileProjectSuppressionStore } from "./project-suppression-store";
import { deriveSessionKey, readWhisperState, writeWhisperState } from "./whisper-state";
import type {
  LoreVisibleItem,
  ReceiptRecord,
  WhisperSessionState,
} from "../shared/types";
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

const MAX_CAPTURES_PER_STOP = 2;

const deriveTitle = (content: string): string =>
  content.length <= 80 ? content : `${content.slice(0, 77)}...`;

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
  visibleItems: LoreVisibleItem[],
): LoreVisibleItem | null => {
  if (directive.id) {
    return visibleItems.find((item) => item.handle === directive.id) ?? null;
  }

  if (directive.type === "dismiss") {
    const receipt = visibleItems.find((item) => item.kind === "saved_receipt");
    if (receipt) {
      return receipt;
    }
  }

  return visibleItems.find((item) => item.kind === "pending_suggestion") ?? null;
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

  // Parse and execute Lore directives from assistant response before turnIndex increment
  const assistantResponse = parsed.assistant_response ?? parsed.response_summary ?? parsed.response ?? "";
  const directives = parseLoreDirectives(assistantResponse);
  let pendingReceipt: ReceiptRecord | undefined;

  if (directives.length > 0) {
    log("debug", "stop.directives_parsed", {
      directiveCount: directives.length,
      directiveTypes: directives.map((d) => d.type),
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
    });

    const sharedStore = new FileSharedStore({
      storagePath: config.sharedStoragePath,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: config.approvalLedgerPath,
      sharedStore,
    });
    const promoter = new Promoter({
      sharedStore,
      approvalStore,
      policy: config.promotionPolicy,
    });

    let captureCount = 0;
    for (const directive of directives) {
      if (directive.type !== "capture") continue;
      if (captureCount >= MAX_CAPTURES_PER_STOP) {
        log("debug", "stop.capture.rate_limited", {
          captureCount,
          maxCaptures: MAX_CAPTURES_PER_STOP,
        }, {
          ok: true,
          sessionId,
          sessionKey,
          projectId,
        });
        break;
      }
      if (!isSharedKnowledgeKind(directive.kind) || directive.kind === "decision_record") {
        log("debug", "stop.capture.invalid_kind", {
          kind: directive.kind,
        }, {
          ok: true,
          sessionId,
          sessionKey,
          projectId,
        });
        continue;
      }
      if (!directive.content || directive.content.trim().length === 0) {
        continue;
      }

      try {
        const result = await promoter.promoteExplicit({
          kind: directive.kind,
          title: deriveTitle(directive.content),
          content: directive.content,
          tags: [],
          sourceProjectId: projectId,
        });
        if (result.ok) {
          captureCount += 1;
          pendingReceipt = {
            sessionKey,
            entryId: result.entry.id,
            kind: "saved",
            createdAt: result.entry.approvedAt ?? result.entry.updatedAt,
            expiresAfterTurn: state.turnIndex + 1,
            undoCommand: "lore no",
          };
          log("info", "stop.capture.completed", {
            entryId: result.entry.id,
            kind: directive.kind,
            captureCount,
          }, {
            ok: true,
            sessionId,
            sessionKey,
            projectId,
          });
        } else {
          log("debug", "stop.capture.rejected", {
            kind: directive.kind,
            reason: result.reason,
          }, {
            ok: true,
            sessionId,
            sessionKey,
            projectId,
          });
        }
      } catch {
        log("warn", "stop.capture.error", {
          kind: directive.kind,
        }, {
          ok: false,
          sessionId,
          sessionKey,
          projectId,
          summary: "Capture directive execution failed (advisory).",
        });
      }
    }

    // Process approve and dismiss directives
    for (const directive of directives) {
      if (directive.type === "approve") {
        const target = resolveLoreDirectiveTarget(
          directive,
          state.visibleItems ?? [],
        );
        if (!target || target.kind !== "pending_suggestion") {
          log("debug", "stop.approve.no_target", {
            id: directive.id,
          }, {
            ok: true,
            sessionId,
            sessionKey,
            projectId,
          });
          continue;
        }
        try {
          const result = await promoter.approve(target.entryId);
          if (result.ok) {
            pendingReceipt = {
              sessionKey,
              entryId: target.entryId,
              kind: "saved",
              createdAt: now(),
              expiresAfterTurn: state.turnIndex + 1,
              undoCommand: "lore no",
            };
            log("info", "stop.approve.completed", {
              entryId: target.entryId,
            }, {
              ok: true,
              sessionId,
              sessionKey,
              projectId,
            });
          }
        } catch {
          log("warn", "stop.approve.error", {
            entryId: target.entryId,
          }, {
            ok: false,
            sessionId,
            sessionKey,
            projectId,
            summary: "Approve directive execution failed (advisory).",
          });
        }
      }

      if (directive.type === "dismiss") {
        const target = resolveLoreDirectiveTarget(
          directive,
          state.visibleItems ?? [],
        );
        if (!target) {
          log("debug", "stop.dismiss.no_target", {
            id: directive.id,
          }, {
            ok: true,
            sessionId,
            sessionKey,
            projectId,
          });
          continue;
        }
        try {
          if (target.actionOnDismiss === "reject_pending") {
            await promoter.reject(target.entryId, "Dismissed from conversation.");
          } else if (target.actionOnDismiss === "demote_undo_captured") {
            await promoter.demote(target.entryId, "User undid a saved Lore entry.");
          } else if (target.actionOnDismiss === "suppress_project") {
            const suppressionStore = new FileProjectSuppressionStore({
              storagePath: `${config.sharedStoragePath.replace(/shared\.json$/, "")}suppressions.json`,
            });
            await suppressionStore.add({
              entryId: target.entryId,
              projectId: target.projectId,
              createdAt: now(),
              reason: "user:dismissed",
            });
          }
          log("info", "stop.dismiss.completed", {
            entryId: target.entryId,
            action: target.actionOnDismiss,
          }, {
            ok: true,
            sessionId,
            sessionKey,
            projectId,
          });
        } catch {
          log("warn", "stop.dismiss.error", {
            entryId: target.entryId,
          }, {
            ok: false,
            sessionId,
            sessionKey,
            projectId,
            summary: "Dismiss directive execution failed (advisory).",
          });
        }
      }
    }
  }

  const updated = applyStopUpdate(state, parsed);
  const finalState: WhisperSessionState = {
    ...updated,
    activeReceipt: pendingReceipt ?? state.activeReceipt,
    visibleItems: [],
  };
  await writeState(finalState, config.whisperStateDir, config.whisper);
  log("debug", "stop.state_updated", {
    turnIndex: finalState.turnIndex,
    recentFileCount: finalState.recentFiles.length,
    recentToolCount: finalState.recentToolNames.length,
    hasActiveReceipt: finalState.activeReceipt !== undefined,
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
