import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveSessionKey,
  initWhisperState,
  readWhisperState,
  writeWhisperState,
} from "../src/plugin/whisper-state";
import { resolveConfig } from "../src/config";

let testDir: string;
const config = resolveConfig().whisper;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("deriveSessionKey", () => {
  it("is deterministic", () => {
    expect(deriveSessionKey("sess-1", "/my/project")).toBe(
      deriveSessionKey("sess-1", "/my/project"),
    );
  });

  it("differs for different session IDs", () => {
    expect(deriveSessionKey("sess-1", "/my/project")).not.toBe(
      deriveSessionKey("sess-2", "/my/project"),
    );
  });

  it("differs for different cwds", () => {
    expect(deriveSessionKey("sess-1", "/project-a")).not.toBe(
      deriveSessionKey("sess-1", "/project-b"),
    );
  });

  it("returns a 12-char hex string", () => {
    const key = deriveSessionKey("sess-1", "/my/project");
    expect(key).toHaveLength(12);
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("readWhisperState", () => {
  it("returns default state for missing file", async () => {
    const state = await readWhisperState("nonexistent", testDir);
    expect(state.sessionKey).toBe("nonexistent");
    expect(state.turnIndex).toBe(0);
    expect(state.recentFiles).toEqual([]);
    expect(state.whisperHistory).toEqual([]);
    expect(state.injectedContentHashes).toEqual([]);
    expect(state.activeReceipt).toBeUndefined();
    expect(state.visibleItems).toEqual([]);
  });
});

describe("writeWhisperState + readWhisperState", () => {
  it("persists and reads back state", async () => {
    const state = {
      sessionKey: "test-key",
      turnIndex: 5,
      recentFiles: ["src/foo.ts", "src/bar.ts"],
      recentToolNames: ["Edit", "Bash"],
      whisperHistory: [
        {
          contentHash: "abc123",
          kind: "domain_rule",
          source: "shared" as const,
          topReason: "keyword" as const,
          turnIndex: 3,
          whisperCount: 1,
        },
      ],
      injectedContentHashes: ["hash-1", "hash-2"],
      activeReceipt: {
        sessionKey: "test-key",
        entryId: "sk-0001",
        kind: "saved" as const,
        createdAt: "2026-01-01T00:00:00Z",
        expiresAfterTurn: 6,
        undoCommand: "lore no" as const,
      },
      visibleItems: [
        {
          handle: "@l1",
          entryId: "sk-0001",
          itemType: "receipt" as const,
          projectId: "proj-a",
          turnIndex: 5,
          actionOnDismiss: "demote_undo_captured" as const,
          actionOnApprove: "approve_pending" as const,
        },
      ],
    };

    await writeWhisperState(state, testDir, config);
    const read = await readWhisperState("test-key", testDir);

    expect(read.sessionKey).toBe("test-key");
    expect(read.turnIndex).toBe(5);
    expect(read.recentFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(read.whisperHistory).toHaveLength(1);
    expect(read.injectedContentHashes).toEqual(["hash-1", "hash-2"]);
    expect(read.activeReceipt?.entryId).toBe("sk-0001");
    expect(read.visibleItems?.[0]?.handle).toBe("@l1");
  });
});

describe("initWhisperState", () => {
  it("creates fresh state with injectedContentHashes", async () => {
    const state = await initWhisperState(
      "init-key",
      ["hash-a", "hash-b"],
      testDir,
      config,
    );

    expect(state.sessionKey).toBe("init-key");
    expect(state.turnIndex).toBe(0);
    expect(state.injectedContentHashes).toEqual(["hash-a", "hash-b"]);

    const read = await readWhisperState("init-key", testDir);
    expect(read.injectedContentHashes).toEqual(["hash-a", "hash-b"]);
  });
});

describe("capacity enforcement", () => {
  it("trims recentFiles to capacity", async () => {
    const state = {
      sessionKey: "cap-test",
      turnIndex: 0,
      recentFiles: Array.from({ length: 30 }, (_, i) => `file-${i}.ts`),
      recentToolNames: [],
      whisperHistory: [],
      injectedContentHashes: [],
    };

    await writeWhisperState(state, testDir, config);
    const read = await readWhisperState("cap-test", testDir);
    expect(read.recentFiles).toHaveLength(20);
  });

  it("trims recentToolNames to capacity", async () => {
    const state = {
      sessionKey: "cap-tools",
      turnIndex: 0,
      recentFiles: [],
      recentToolNames: Array.from({ length: 15 }, (_, i) => `tool-${i}`),
      whisperHistory: [],
      injectedContentHashes: [],
    };

    await writeWhisperState(state, testDir, config);
    const read = await readWhisperState("cap-tools", testDir);
    expect(read.recentToolNames).toHaveLength(10);
  });

  it("trims whisperHistory to capacity", async () => {
    const state = {
      sessionKey: "cap-history",
      turnIndex: 0,
      recentFiles: [],
      recentToolNames: [],
      whisperHistory: Array.from({ length: 60 }, (_, i) => ({
        contentHash: `hash-${i}`,
        kind: "domain_rule",
        source: "shared" as const,
        topReason: "keyword" as const,
        turnIndex: i,
        whisperCount: 1,
      })),
      injectedContentHashes: [],
    };

    await writeWhisperState(state, testDir, config);
    const read = await readWhisperState("cap-history", testDir);
    expect(read.whisperHistory).toHaveLength(50);
  });
});
