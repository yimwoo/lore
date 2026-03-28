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
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "../shared/debug-log";

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
): Promise<boolean> => {
  const auth = await readLoreAuthSummary();
  if (auth.authMode !== "chatgpt" || auth.hasApiKey) {
    return false;
  }

  warn(
    'Lore reminder: LLM ingestion is inactive because Codex auth_mode="chatgpt" has no OPENAI_API_KEY. Shared knowledge still works, but automatic extraction needs API-key-backed Codex config.',
  );
  return true;
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
  const startedAt = Date.now();
  const runId = debugLoggingEnabled ? createRunId() : undefined;
  const config = dependencies?.config ?? resolveConfig();
  const warn = dependencies?.warn ?? writeWarning;
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
      component: "session-start",
      event,
      hook: "SessionStart",
      runId,
      sessionId: extras?.sessionId ?? metadata.session_id,
      sessionKey: extras?.sessionKey,
      projectId: extras?.projectId,
      ok: extras?.ok,
      summary: extras?.summary,
      durationMs: extras?.durationMs,
      data,
    });
  };

  let metadata: SessionMetadata = {};
  const input = stdinData ?? (await readStdin());
  let parsedOk = true;
  log("debug", "session_start.invoked", {
    inputLength: input.length,
    hasStdinData: stdinData !== undefined,
  });

  try {
    if (input.trim().length > 0) {
      metadata = JSON.parse(input) as SessionMetadata;
    }
  } catch {
    // Malformed input — proceed with empty metadata
    parsedOk = false;
    log("warn", "session_start.stdin_parsed", {
      inputLength: input.length,
      parsed: false,
    }, {
      ok: false,
      summary: "SessionStart input was malformed; proceeding with empty metadata.",
    });
  }

  if (parsedOk) {
    log("debug", "session_start.stdin_parsed", {
      parsed: true,
      cwd: metadata.cwd,
      model: metadata.model,
      hasSessionId: metadata.session_id !== undefined,
    }, {
      ok: true,
    });
  }

  const cwd = metadata.cwd ?? process.cwd();
  const currentProjectId = deriveProjectId(cwd);
  log("debug", "session_start.project_derived", {
    cwd,
    model: metadata.model,
  }, {
    ok: true,
    projectId: currentProjectId,
  });

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

  const runConsolidationWithTimeout = async (): Promise<"completed" | "timed_out"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runConsolidationPass().then(() => "completed" as const),
        new Promise<"timed_out">((resolve) => {
          timer = setTimeout(() => {
            resolve("timed_out");
          }, config.consolidationTimeoutMs);
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
      log("debug", "session_start.consolidation.begin", undefined, {
        ok: true,
        projectId: currentProjectId,
      });
      const consolidationResult = await runConsolidationWithTimeout();
      if (consolidationResult === "timed_out") {
        log("warn", "session_start.consolidation.timeout", {
          timeoutMs: config.consolidationTimeoutMs,
        }, {
          ok: false,
          summary: "SessionStart consolidation timed out.",
          projectId: currentProjectId,
        });
      } else {
        log("debug", "session_start.consolidation.done", {
          timeoutMs: config.consolidationTimeoutMs,
        }, {
          ok: true,
          projectId: currentProjectId,
        });
      }
    } catch (error) {
      // Consolidation is advisory only at startup.
      log("warn", "session_start.consolidation.error", {
        error: error instanceof Error ? error.message : String(error),
      }, {
        ok: false,
        summary: "SessionStart consolidation failed but was treated as advisory.",
        projectId: currentProjectId,
      });
    }

    const llmIngestionUnavailable = await warnIfLlmIngestionUnavailable(warn);
    if (llmIngestionUnavailable) {
      log("warn", "session_start.llm_ingestion_unavailable", undefined, {
        ok: false,
        summary: "LLM ingestion is unavailable under the current Codex auth configuration.",
        projectId: currentProjectId,
      });
    }

    const result = await buildSessionStartContext({
      store: sharedStore,
      currentProjectId,
      currentTags,
      config: config.sessionStart,
    });
    log("debug", "session_start.context_built", {
      currentTags,
      selectedCount: result.selectedEntries.length,
      injectedContentHashes: result.injectedContentHashes,
    }, {
      ok: true,
      projectId: currentProjectId,
    });
    log("debug", "session_start.entries_selected", {
      selectedIds: result.selectedEntries.map((entry) => entry.id),
      selectedKinds: result.selectedEntries.map((entry) => entry.kind),
    }, {
      ok: true,
      projectId: currentProjectId,
    });
    const pendingCount = (
      await sharedStore.list({ approvalStatus: "pending" })
    ).length;
    log("debug", "session_start.pending_count", {
      pendingCount,
    }, {
      ok: true,
      projectId: currentProjectId,
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
        log("trace", "session_start.whisper_state_initialized", {
          injectedContentHashCount: result.injectedContentHashes.length,
        }, {
          ok: true,
          sessionKey,
          projectId: currentProjectId,
        });
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
    log("debug", "session_start.template_rendered", {
      pendingCount,
      selectedCount: result.selectedEntries.length,
      templateBytes: Buffer.byteLength(template ?? "", "utf8"),
    }, {
      ok: true,
      projectId: currentProjectId,
    });
    log("info", "session_start.completed", {
      additionalContextBytes: Buffer.byteLength(template ?? "", "utf8"),
    }, {
      ok: true,
      durationMs: Date.now() - startedAt,
      summary: "SessionStart completed.",
      projectId: currentProjectId,
    });

    return { additionalContext: template ?? "" };
  } catch (error) {
    // On any error, return empty context rather than crashing
    log("error", "session_start.error", {
      error: error instanceof Error ? error.message : String(error),
    }, {
      ok: false,
      durationMs: Date.now() - startedAt,
      summary: "SessionStart failed and returned empty context.",
      projectId: currentProjectId,
    });
    return { additionalContext: "" };
  }
};

// Entry point when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runSessionStart().then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
  });
}
