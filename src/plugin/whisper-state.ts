import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WhisperSessionState } from "../shared/types";
import type { WhisperConfig } from "../config";

export const deriveSessionKey = (
  sessionId: string,
  cwd: string,
): string =>
  createHash("sha256")
    .update(`${sessionId}:${cwd}`)
    .digest("hex")
    .slice(0, 12);

const defaultState = (sessionKey: string): WhisperSessionState => ({
  sessionKey,
  turnIndex: 0,
  recentFiles: [],
  recentToolNames: [],
  whisperHistory: [],
  injectedContentHashes: [],
  activeReceipt: undefined,
  visibleItems: [],
});

const normalizeState = (
  sessionKey: string,
  state: WhisperSessionState,
): WhisperSessionState => ({
  ...defaultState(sessionKey),
  ...state,
  sessionKey,
  recentFiles: state.recentFiles ?? [],
  recentToolNames: state.recentToolNames ?? [],
  whisperHistory: state.whisperHistory ?? [],
  injectedContentHashes: state.injectedContentHashes ?? [],
  visibleItems: state.visibleItems ?? [],
});

const statePath = (whisperStateDir: string, sessionKey: string): string =>
  join(whisperStateDir, `whisper-${sessionKey}.json`);

export const readWhisperState = async (
  sessionKey: string,
  whisperStateDir: string,
): Promise<WhisperSessionState> => {
  try {
    const content = await readFile(
      statePath(whisperStateDir, sessionKey),
      "utf8",
    );
    const parsed = JSON.parse(content) as WhisperSessionState;
    return normalizeState(sessionKey, parsed);
  } catch {
    return defaultState(sessionKey);
  }
};

const enforceCapacities = (
  state: WhisperSessionState,
  config: WhisperConfig,
): WhisperSessionState => ({
  ...state,
  recentFiles: state.recentFiles.slice(0, config.recentFilesCapacity),
  recentToolNames: state.recentToolNames.slice(
    0,
    config.recentToolNamesCapacity,
  ),
  whisperHistory: state.whisperHistory.slice(0, config.whisperHistoryCapacity),
});

export const writeWhisperState = async (
  state: WhisperSessionState,
  whisperStateDir: string,
  config: WhisperConfig,
): Promise<void> => {
  const normalized = normalizeState(state.sessionKey, state);
  const capped = enforceCapacities(normalized, config);
  const filePath = statePath(whisperStateDir, state.sessionKey);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(whisperStateDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(capped, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

export const initWhisperState = async (
  sessionKey: string,
  injectedContentHashes: string[],
  whisperStateDir: string,
  config: WhisperConfig,
): Promise<WhisperSessionState> => {
  const state: WhisperSessionState = {
    ...defaultState(sessionKey),
    injectedContentHashes,
  };
  await writeWhisperState(state, whisperStateDir, config);
  return state;
};
