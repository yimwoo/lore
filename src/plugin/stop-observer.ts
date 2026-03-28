import { basename } from "node:path";
import { createInterface } from "node:readline";

import { resolveConfig } from "../config";
import type { LoreConfig } from "../config";
import type { ExtractionProvider, TurnArtifact } from "../extraction/extraction-provider";
import { DraftStoreWriter } from "../promotion/draft-store";
import { deriveSessionKey, readWhisperState, writeWhisperState } from "./whisper-state";
import type { WhisperSessionState } from "../shared/types";

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

  return updated;
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
  const config = dependencies?.config ?? resolveConfig();
  const now = dependencies?.now ?? (() => new Date().toISOString());
  const readState = dependencies?.readState ?? readWhisperState;
  const writeState = dependencies?.writeState ?? writeWhisperState;
  const input = stdinData ?? (await readStdin());

  let parsed: StopInput = {};
  try {
    if (input.trim().length > 0) {
      parsed = JSON.parse(input) as StopInput;
    }
  } catch {
    return; // unparseable → no-op
  }

  const sessionId = parsed.session_id;
  if (!sessionId) return; // whispers disabled

  const cwd = parsed.cwd ?? process.cwd();
  const sessionKey = deriveSessionKey(sessionId, cwd);
  const state = await readState(sessionKey, config.whisperStateDir);

  const updated = applyStopUpdate(state, parsed);
  await writeState(updated, config.whisperStateDir, config.whisper);

  if (!dependencies?.provider) {
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
    const drafts = await dependencies.provider.extractCandidates(artifact);
    for (const draft of drafts) {
      await draftWriter.append(draft);
    }
  } catch {
    // Extraction is advisory only. The Stop hook should never surface failures.
  }
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runStopObserver();
}
