import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDebugLogger,
  createRunId,
  resolveDebugLevel,
} from "../src/shared/debug-log";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("resolveDebugLevel", () => {
  it("returns null when debug logging is disabled", () => {
    expect(resolveDebugLevel({})).toBeNull();
    expect(resolveDebugLevel({ LORE_DEBUG: "" })).toBeNull();
    expect(resolveDebugLevel({ LORE_DEBUG: "0" })).toBeNull();
  });

  it("maps 1 and true to debug level", () => {
    expect(resolveDebugLevel({ LORE_DEBUG: "1" })).toBe("debug");
    expect(resolveDebugLevel({ LORE_DEBUG: "true" })).toBe("debug");
  });

  it("maps trace to trace level", () => {
    expect(resolveDebugLevel({ LORE_DEBUG: "trace" })).toBe("trace");
  });
});

describe("createRunId", () => {
  it("creates a short prefixed hex identifier", () => {
    const result = createRunId(() => Buffer.from([0xde, 0xad, 0xbe, 0xef]));

    expect(result).toBe("run-deadbeef");
  });
});

describe("createDebugLogger", () => {
  it("does nothing when debug logging is disabled", () => {
    const writes: string[] = [];
    const logger = createDebugLogger({
      env: {},
      writeStderr: (line: string): void => {
        writes.push(line);
      },
    });

    logger.dlog({
      level: "info",
      component: "session-start",
      event: "session_start.invoked",
    });

    expect(logger.enabled).toBe(false);
    expect(writes).toEqual([]);
  });

  it("filters trace events when debug level is enabled", () => {
    const writes: string[] = [];
    const logger = createDebugLogger({
      env: { LORE_DEBUG: "1" },
      now: () => "2026-03-28T21:15:00.000Z",
      writeStderr: (line: string): void => {
        writes.push(line);
      },
    });

    logger.dlog({
      level: "trace",
      component: "whisper",
      event: "whisper.state_loaded",
    });
    logger.dlog({
      level: "debug",
      component: "whisper",
      event: "whisper.selected",
      summary: "Selected one whisper bullet.",
    });

    expect(logger.enabled).toBe(true);
    expect(logger.level).toBe("debug");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({
      ts: "2026-03-28T21:15:00.000Z",
      level: "debug",
      component: "whisper",
      event: "whisper.selected",
      summary: "Selected one whisper bullet.",
    });
  });

  it("emits trace events when trace logging is enabled", () => {
    const writes: string[] = [];
    const logger = createDebugLogger({
      env: { LORE_DEBUG: "trace" },
      now: () => "2026-03-28T21:16:00.000Z",
      writeStderr: (line: string): void => {
        writes.push(line);
      },
    });

    logger.dlog({
      level: "trace",
      component: "stop-observer",
      event: "stop.state_loaded",
      sessionId: "session-1",
      data: { turnIndex: 3 },
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({
      ts: "2026-03-28T21:16:00.000Z",
      level: "trace",
      component: "stop-observer",
      event: "stop.state_loaded",
      sessionId: "session-1",
      data: { turnIndex: 3 },
    });
  });

  it("writes to a file sink when LORE_LOG_FILE is set", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lore-debug-log-"));
    tempPaths.push(tempDir);
    const logPath = join(tempDir, "nested", "debug.jsonl");

    const logger = createDebugLogger({
      env: { LORE_DEBUG: "1", LORE_LOG_FILE: logPath },
      now: () => "2026-03-28T21:17:00.000Z",
    });

    logger.dlog({
      level: "info",
      component: "consolidator",
      event: "consolidation.completed",
      ok: true,
    });

    const content = await readFile(logPath, "utf8");
    expect(content).toContain('"component":"consolidator"');
    expect(content).toContain('"event":"consolidation.completed"');
    expect(content).toContain('"ok":true');
  });

  it("swallows file sink failures and falls back to stderr", () => {
    const writes: string[] = [];
    const logger = createDebugLogger({
      env: { LORE_DEBUG: "1", LORE_LOG_FILE: "/tmp/debug.jsonl" },
      now: () => "2026-03-28T21:18:00.000Z",
      ensureDir: (): void => {
        throw new Error("mkdir failed");
      },
      writeStderr: (line: string): void => {
        writes.push(line);
      },
    });

    expect(() => {
      logger.dlog({
        level: "warn",
        component: "extraction",
        event: "extraction.llm_auth_warning",
      });
    }).not.toThrow();

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({
      ts: "2026-03-28T21:18:00.000Z",
      level: "warn",
      component: "extraction",
      event: "extraction.llm_auth_warning",
    });
  });

  it("swallows stderr sink failures", () => {
    const logger = createDebugLogger({
      env: { LORE_DEBUG: "1" },
      writeStderr: (): void => {
        throw new Error("stderr failed");
      },
    });

    expect(() => {
      logger.dlog({
        level: "error",
        component: "session-start",
        event: "session_start.error",
      });
    }).not.toThrow();
  });
});
