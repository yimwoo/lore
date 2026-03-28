import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { FileSharedStore } from "../core/file-shared-store";
import { FileMemoryStore } from "../core/memory-store";
import { FileApprovalStore } from "../promotion/approval-store";
import { Consolidator } from "../promotion/consolidator";
import { DraftStoreReader } from "../promotion/draft-store";
import { ObservationLogReader } from "../promotion/observation-log";
import { resolveConfig } from "../config";
import { buildSessionStartContext } from "./context-builder";
import { renderSessionStartTemplate } from "./session-start-template";
import type { LoreCapabilities } from "../shared/types";
import { deriveSessionKey, initWhisperState } from "./whisper-state";
import type { MemoryEntry } from "../shared/types";
import { CodexConsolidationProvider } from "../extraction/codex-consolidation-provider";

type SessionMetadata = {
  session_id?: string;
  cwd?: string;
  model?: string;
};

type SessionStartDependencies = {
  config?: ReturnType<typeof resolveConfig>;
  consolidate?: () => Promise<void>;
  warn?: (message: string) => void;
};

type LoreAuthSummary = {
  authMode?: string;
  hasApiKey: boolean;
};

const writeWarning = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const getCodexAuthPath = (): string => join(homedir(), ".codex", "auth.json");

const readLoreAuthSummary = async (): Promise<LoreAuthSummary> => {
  try {
    const raw = await readFile(getCodexAuthPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return {
      authMode: typeof parsed.auth_mode === "string" ? parsed.auth_mode : undefined,
      hasApiKey:
        typeof parsed.OPENAI_API_KEY === "string" &&
        parsed.OPENAI_API_KEY.trim().length > 0,
    };
  } catch {
    return {
      authMode: undefined,
      hasApiKey: false,
    };
  }
};

const warnIfLlmIngestionUnavailable = async (
  warn: (message: string) => void,
): Promise<void> => {
  const auth = await readLoreAuthSummary();
  if (auth.authMode !== "chatgpt" || auth.hasApiKey) {
    return;
  }

  warn(
    'Lore reminder: LLM ingestion is inactive because Codex auth_mode="chatgpt" has no OPENAI_API_KEY. Shared knowledge still works, but automatic extraction needs API-key-backed Codex config.',
  );
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

const getLoreCapabilities = (): LoreCapabilities => ({
  // The plugin bundles Lore's recall MCP server, so the agent can rely on
  // recall tools being present when this SessionStart hook is active.
  recall: true,
  // Promotion and demotion remain manual/CLI-driven until inline mutation
  // tools are exposed to the agent.
  promote: false,
  demote: false,
  cliAvailable: false,
});

export const runSessionStart = async (
  stdinData?: string,
  dependencies?: SessionStartDependencies,
): Promise<{ additionalContext: string }> => {
  const config = dependencies?.config ?? resolveConfig();
  const warn = dependencies?.warn ?? writeWarning;

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

  const runConsolidationPass = async (): Promise<void> => {
    if (dependencies?.consolidate) {
      await dependencies.consolidate();
      return;
    }

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({
        draftDir: config.draftDir,
      }),
      observationReader: new ObservationLogReader({
        observationDir: config.observationDir,
      }),
      sharedStore,
      approvalStore: new FileApprovalStore({
        ledgerPath: config.approvalLedgerPath,
        sharedStore,
      }),
      provider: new CodexConsolidationProvider(),
      statePath: config.consolidationStatePath,
    });

    await consolidator.run();
  };

  const runConsolidationWithTimeout = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        runConsolidationPass(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, config.consolidationTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

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
    try {
      await runConsolidationWithTimeout();
    } catch {
      // Consolidation is advisory only at startup.
    }

    await warnIfLlmIngestionUnavailable(warn);

    const result = await buildSessionStartContext({
      store: sharedStore,
      currentProjectId,
      currentTags,
      config: config.sessionStart,
    });
    const pendingCount = (
      await sharedStore.list({ approvalStatus: "pending" })
    ).length;

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

    const capabilities = getLoreCapabilities();

    const template = renderSessionStartTemplate({
      entries: result.selectedEntries,
      capabilities,
      pendingCount,
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
