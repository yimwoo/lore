import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DebugLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type DebugHook =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop"
  | "MCP"
  | "CLI"
  | "Core";

export type DebugEvent = {
  ts: string;
  level: DebugLogLevel;
  component: string;
  event: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  projectId?: string;
  hook?: DebugHook;
  ok?: boolean;
  durationMs?: number;
  summary?: string;
  data?: Record<string, unknown>;
};

type DebugLogger = {
  enabled: boolean;
  level: DebugLogLevel | null;
  dlog: (event: Omit<DebugEvent, "ts">) => void;
};

type DebugLoggerDependencies = {
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  writeStderr?: (line: string) => void;
  appendLine?: (path: string, line: string) => void;
  ensureDir?: (path: string) => void;
  randomBytesImpl?: (size: number) => Buffer;
};

const levelPriority: Record<DebugLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export const resolveDebugLevel = (
  env: NodeJS.ProcessEnv,
): DebugLogLevel | null => {
  const raw = env.LORE_DEBUG?.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (raw === "trace") {
    return "trace";
  }

  if (raw === "1" || raw === "true") {
    return "debug";
  }

  return null;
};

export const shouldLogLevel = (
  configuredLevel: DebugLogLevel | null,
  eventLevel: DebugLogLevel,
): boolean => {
  if (configuredLevel === null) {
    return false;
  }

  return levelPriority[eventLevel] >= levelPriority[configuredLevel];
};

export const createRunId = (
  randomBytesImpl: (size: number) => Buffer = randomBytes,
): string => `run-${randomBytesImpl(4).toString("hex")}`;

const defaultAppendLine = (path: string, line: string): void => {
  // Sync append keeps event ordering stable in short-lived hook processes.
  appendFileSync(path, line, "utf8");
};

const defaultEnsureDir = (path: string): void => {
  mkdirSync(path, { recursive: true });
};

export const createDebugLogger = (
  dependencies?: DebugLoggerDependencies,
): DebugLogger => {
  const env = dependencies?.env ?? process.env;
  const configuredLevel = resolveDebugLevel(env);

  if (configuredLevel === null) {
    return {
      enabled: false,
      level: null,
      dlog: (_event: Omit<DebugEvent, "ts">): void => undefined,
    };
  }

  const now = dependencies?.now ?? (() => new Date().toISOString());
  const writeStderr = dependencies?.writeStderr ?? ((line: string): void => {
    process.stderr.write(line);
  });
  const appendLine = dependencies?.appendLine ?? defaultAppendLine;
  const ensureDir = dependencies?.ensureDir ?? defaultEnsureDir;
  const logFilePath = env.LORE_LOG_FILE;

  const dlog = (event: Omit<DebugEvent, "ts">): void => {
    if (!shouldLogLevel(configuredLevel, event.level)) {
      return;
    }

    const line = `${JSON.stringify({
      ts: now(),
      ...event,
    })}\n`;

    try {
      if (typeof logFilePath === "string" && logFilePath.length > 0) {
        ensureDir(dirname(logFilePath));
        appendLine(logFilePath, line);
        return;
      }

      writeStderr(line);
    } catch {
      try {
        writeStderr(line);
      } catch {
        // Debug tracing must never affect normal Lore behavior.
      }
    }
  };

  return {
    enabled: true,
    level: configuredLevel,
    dlog,
  };
};

const runtimeLogger = createDebugLogger();

export const dlog = runtimeLogger.dlog;
export const debugLoggingEnabled = runtimeLogger.enabled;
export const debugLoggingLevel = runtimeLogger.level;
