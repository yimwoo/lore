import { createInterface } from "node:readline";

import { resolveConfig } from "../config";
import { deriveSessionKey, readWhisperState, writeWhisperState } from "./whisper-state";
import type { WhisperSessionState } from "../shared/types";

type StopInput = {
  session_id?: string;
  cwd?: string;
  tool_calls?: Array<{ tool_name?: string; file_path?: string }>;
  files_modified?: string[];
  files_read?: string[];
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
): Promise<void> => {
  const config = resolveConfig();
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
  const state = await readWhisperState(sessionKey, config.whisperStateDir);

  const updated = applyStopUpdate(state, parsed);
  await writeWhisperState(updated, config.whisperStateDir, config.whisper);
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runStopObserver();
}
