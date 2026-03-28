import { createInterface } from "node:readline";

import { FileSharedStore } from "../core/file-shared-store";
import { FileMemoryStore } from "../core/memory-store";
import { resolveConfig } from "../config";
import { buildSessionStartContext } from "./context-builder";
import { renderSessionStartTemplate } from "./session-start-template";
import type { LoreCapabilities } from "../shared/types";
import { deriveSessionKey, initWhisperState } from "./whisper-state";
import type { MemoryEntry } from "../shared/types";

type SessionMetadata = {
  session_id?: string;
  cwd?: string;
  model?: string;
};

const deriveProjectId = (cwd: string): string => {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "unknown-project";
};

const deriveCurrentTags = (memories: MemoryEntry[]): string[] => {
  const tagCounts = new Map<string, number>();
  for (const memory of memories) {
    for (const tag of memory.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  return Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag);
};

const readStdin = (): Promise<string> => {
  return new Promise((resolve) => {
    let data = "";
    const reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => {
      data += line;
    });
    reader.on("close", () => {
      resolve(data);
    });
    // If stdin is not a TTY and has no data, resolve after a short timeout
    setTimeout(() => {
      reader.close();
    }, 100);
  });
};

export const runSessionStart = async (
  stdinData?: string,
): Promise<{ additionalContext: string }> => {
  const config = resolveConfig();

  let metadata: SessionMetadata = {};
  const input = stdinData ?? (await readStdin());

  try {
    if (input.trim().length > 0) {
      metadata = JSON.parse(input) as SessionMetadata;
    }
  } catch {
    // Malformed input — proceed with empty metadata
  }

  const cwd = metadata.cwd ?? process.cwd();
  const currentProjectId = deriveProjectId(cwd);

  const sharedStore = new FileSharedStore({
    storagePath: config.sharedStoragePath,
  });

  // Derive currentTags from project memory if available
  let currentTags: string[] = [];
  try {
    const projectStore = new FileMemoryStore({
      storageDir: config.projectMemoryDir,
    });
    const projectMemories = await projectStore.listByProject(currentProjectId);
    currentTags = deriveCurrentTags(projectMemories);
  } catch {
    // No project memories — fall back to empty tags (global-only scoring)
  }

  try {
    const result = await buildSessionStartContext({
      store: sharedStore,
      currentProjectId,
      currentTags,
      config: config.sessionStart,
    });

    // Initialize whisper state with injected content hashes (if session_id available)
    if (metadata.session_id) {
      try {
        const sessionKey = deriveSessionKey(metadata.session_id, cwd);
        await initWhisperState(
          sessionKey,
          result.injectedContentHashes,
          config.whisperStateDir,
          config.whisper,
        );
      } catch {
        // Whisper state init failure is non-fatal
      }
    }

    // Baseline capabilities — MCP tools not yet wired
    const capabilities: LoreCapabilities = {
      recall: false,
      promote: false,
      demote: false,
      cliAvailable: false,
    };

    const template = renderSessionStartTemplate({
      entries: result.selectedEntries,
      capabilities,
    });

    return { additionalContext: template ?? "" };
  } catch {
    // On any error, return empty context rather than crashing
    return { additionalContext: "" };
  }
};

// Entry point when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runSessionStart().then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
  });
}
