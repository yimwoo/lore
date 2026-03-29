import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatWhisper,
  parseLoreMicroCommand,
  selectWhisperBullets,
  updateWhisperHistory,
} from "../src/plugin/pre-prompt-whisper";
import { deriveSessionKey, readWhisperState } from "../src/plugin/whisper-state";
import type {
  HintBullet,
  SharedKnowledgeEntry,
  WhisperSessionState,
} from "../src/shared/types";
import { contentHash } from "../src/shared/validators";
import { resolveConfig } from "../src/config";

const config = resolveConfig().whisper;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const makeState = (
  overrides?: Partial<WhisperSessionState>,
): WhisperSessionState => ({
  sessionKey: "test-key",
  turnIndex: 5,
  recentFiles: [],
  recentToolNames: [],
  whisperHistory: [],
  injectedContentHashes: [],
  ...overrides,
});

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => {
  const content = overrides?.content ?? "All database columns must use snake_case naming";
  return {
    id: "sk-test",
    kind: "domain_rule",
    title: "Use snake_case",
    content,
    confidence: 0.9,
    tags: ["naming", "database"],
    sourceProjectIds: ["proj-1"],
    sourceMemoryIds: [],
    promotionSource: "explicit",
    createdBy: "user",
    approvalStatus: "approved",
    approvedAt: "2026-01-01T00:00:00Z",
    sessionCount: 5,
    projectCount: 2,
    lastSeenAt: "2026-01-10T00:00:00Z",
    contentHash: contentHash(content),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-10T00:00:00Z",
    ...overrides,
  };
};

const makeHintBullet = (
  overrides?: Partial<HintBullet>,
): HintBullet => ({
  category: "risk",
  text: "Recent test failure in hint engine",
  confidence: 0.82,
  relatedMemoryIds: [],
  source: "project",
  ...overrides,
});

describe("selectWhisperBullets", () => {
  it("returns bullets for relevant prompt", () => {
    const bullets = selectWhisperBullets(
      { promptText: "fix the database column naming", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      [makeEntry()],
      [],
      config,
    );
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets[0]!.source).toBe("shared");
  });

  it("returns empty for irrelevant prompt", () => {
    const bullets = selectWhisperBullets(
      { promptText: "write a haiku about clouds", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      [makeEntry()],
      [],
      config,
    );
    expect(bullets).toHaveLength(0);
  });

  it("hard blocks entries whispered in last 2 turns", () => {
    const entry = makeEntry();
    const state = makeState({
      turnIndex: 5,
      whisperHistory: [
        {
          contentHash: entry.contentHash,
          kind: "domain_rule",
          source: "shared",
          topReason: "keyword",
          turnIndex: 4, // 1 turn ago
          whisperCount: 1,
        },
      ],
    });

    const bullets = selectWhisperBullets(
      { promptText: "fix database column naming", sessionKey: "k", cwd: "/proj-1" },
      state,
      [entry],
      [],
      config,
    );
    expect(bullets).toHaveLength(0);
  });

  it("allows resurfacing after hard block window", () => {
    const entry = makeEntry();
    const state = makeState({
      turnIndex: 20,
      whisperHistory: [
        {
          contentHash: entry.contentHash,
          kind: "domain_rule",
          source: "shared",
          topReason: "keyword",
          turnIndex: 5, // 15 turns ago
          whisperCount: 1,
        },
      ],
    });

    const bullets = selectWhisperBullets(
      { promptText: "fix database column naming conventions", sessionKey: "k", cwd: "/proj-1" },
      state,
      [entry],
      [],
      config,
    );
    expect(bullets.length).toBeGreaterThan(0);
  });

  it("deduplicates against injectedContentHashes", () => {
    const entry = makeEntry();
    const state = makeState({
      injectedContentHashes: [entry.contentHash],
    });

    const bullets = selectWhisperBullets(
      { promptText: "fix database column naming", sessionKey: "k", cwd: "/proj-1" },
      state,
      [entry],
      [],
      config,
    );
    expect(bullets).toHaveLength(0);
  });

  it("deduplicates hint against selected shared entry", () => {
    const entry = makeEntry({ content: "Recent test failure in hint engine" });
    const hint = makeHintBullet({ text: "Recent test failure in hint engine" });

    const bullets = selectWhisperBullets(
      { promptText: "fix the hint engine test failure", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      [entry],
      [hint],
      config,
    );

    const hintBullets = bullets.filter((b) => b.source === "hint");
    expect(hintBullets).toHaveLength(0);
  });

  it("caps at maxBullets", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        id: `sk-${i}`,
        title: `Database rule ${i}`,
        content: `Database naming convention rule number ${i}`,
        contentHash: contentHash(`Database naming convention rule number ${i}`),
        tags: ["database", "naming"],
      }),
    );

    const hints = Array.from({ length: 3 }, (_, i) =>
      makeHintBullet({ text: `Risk hint ${i}`, confidence: 0.9 }),
    );

    const bullets = selectWhisperBullets(
      { promptText: "database naming conventions", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      entries,
      hints,
      config,
    );
    expect(bullets.length).toBeLessThanOrEqual(4);
  });

  it("excludes hint recall category", () => {
    const hint = makeHintBullet({ category: "recall", confidence: 0.95 });
    const bullets = selectWhisperBullets(
      { promptText: "anything", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      [],
      [hint],
      config,
    );
    const recallBullets = bullets.filter((b) => b.label === "recall");
    expect(recallBullets).toHaveLength(0);
  });

  it("excludes hints below confidence threshold", () => {
    const hint = makeHintBullet({ confidence: 0.3 });
    const bullets = selectWhisperBullets(
      { promptText: "anything", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      [],
      [hint],
      config,
    );
    expect(bullets).toHaveLength(0);
  });

  it("suppresses standalone hints when prompt is irrelevant and session context is weak", () => {
    const bullets = selectWhisperBullets(
      { promptText: "write a haiku about clouds", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      [],
      [makeHintBullet({ confidence: 0.95 })],
      config,
    );

    expect(bullets).toHaveLength(0);
  });

  it("allows a high-confidence hint for a vague prompt when session context is strong", () => {
    const bullets = selectWhisperBullets(
      { promptText: "help me fix this", sessionKey: "k", cwd: "/proj-1" },
      makeState({
        recentFiles: ["src/hint-engine.ts"],
        recentToolNames: ["npm"],
      }),
      [],
      [makeHintBullet({ confidence: 0.95 })],
      config,
    );

    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.source).toBe("hint");
  });

  it("keeps shared bullets ahead of hint bullets when both are eligible", () => {
    const bullets = selectWhisperBullets(
      { promptText: "fix the database column naming", sessionKey: "k", cwd: "/proj-1" },
      makeState({
        recentFiles: ["src/hint-engine.ts"],
        recentToolNames: ["npm"],
      }),
      [makeEntry()],
      [makeHintBullet({ confidence: 0.95 })],
      config,
    );

    expect(bullets.length).toBeGreaterThan(1);
    expect(bullets[0]!.source).toBe("shared");
  });

  it("surfaces a relevant pending entry as a suggested whisper with a handle", () => {
    const bullets = selectWhisperBullets(
      { promptText: "fix database column naming", sessionKey: "k", cwd: "/proj-1" },
      makeState(),
      [
        makeEntry({
          id: "sk-pending-1",
          approvalStatus: "pending",
          promotionSource: "suggested",
          createdBy: "system",
        }),
      ],
      [],
      config,
    );

    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toMatchObject({
      displayMode: "suggested",
      handle: "@l1",
      entryId: "sk-pending-1",
    });
  });
});

describe("formatWhisper", () => {
  it("formats bullets with [Lore] header", () => {
    const output = formatWhisper([
      { label: "rule", text: "Use snake_case", contentHash: "abc", kind: "domain_rule", source: "shared", topReason: "keyword", score: 0.8 },
      { label: "risk", text: "Test failure", contentHash: "", kind: "hint", source: "hint", topReason: "keyword", score: 0.7 },
    ]);

    expect(output).toBe("[Lore]\n- **rule**: Use snake_case\n- **risk**: Test failure");
  });

  it("returns empty string for no bullets", () => {
    expect(formatWhisper([])).toBe("");
  });

  it("formats suggested bullets with a dedicated header and handle", () => {
    const output = formatWhisper([
      {
        label: "rule",
        text: "Feature flags live in config/flags.ts.",
        contentHash: "hash-1",
        kind: "domain_rule",
        source: "shared",
        topReason: "keyword",
        score: 0.8,
        displayMode: "suggested",
        handle: "@l2",
        entryId: "sk-pending-1",
      },
    ]);

    expect(output).toBe(
      "[Lore · suggested @l2]\n- **rule**: Feature flags live in config/flags.ts. (`lore yes` to keep, `lore no` to dismiss)",
    );
  });
});

describe("updateWhisperHistory", () => {
  it("adds new records for shared bullets", () => {
    const state = makeState();
    const bullets = [
      { label: "rule", text: "test", contentHash: "hash-1", kind: "domain_rule", source: "shared" as const, topReason: "keyword" as const, score: 0.8 },
    ];

    const updated = updateWhisperHistory(state, bullets);
    expect(updated.whisperHistory).toHaveLength(1);
    expect(updated.whisperHistory[0]!.contentHash).toBe("hash-1");
    expect(updated.whisperHistory[0]!.whisperCount).toBe(1);
  });

  it("increments whisperCount for existing records", () => {
    const state = makeState({
      whisperHistory: [
        { contentHash: "hash-1", kind: "domain_rule", source: "shared", topReason: "keyword", turnIndex: 3, whisperCount: 2 },
      ],
    });

    const bullets = [
      { label: "rule", text: "test", contentHash: "hash-1", kind: "domain_rule", source: "shared" as const, topReason: "keyword" as const, score: 0.8 },
    ];

    const updated = updateWhisperHistory(state, bullets);
    expect(updated.whisperHistory).toHaveLength(1);
    expect(updated.whisperHistory[0]!.whisperCount).toBe(3);
  });

  it("ignores hint bullets (no contentHash)", () => {
    const state = makeState();
    const bullets = [
      { label: "risk", text: "test", contentHash: "", kind: "hint", source: "hint" as const, topReason: "keyword" as const, score: 0.7 },
    ];

    const updated = updateWhisperHistory(state, bullets);
    expect(updated.whisperHistory).toHaveLength(0);
  });
});

describe("parseLoreMicroCommand", () => {
  it("parses bare lore yes", () => {
    expect(parseLoreMicroCommand("lore yes")).toEqual({
      action: "approve",
    });
  });

  it("parses lore no with an explicit target", () => {
    expect(parseLoreMicroCommand("lore no sk-123")).toEqual({
      action: "dismiss",
      target: "sk-123",
    });
  });

  it("returns null for normal prompts", () => {
    expect(parseLoreMicroCommand("please fix the failing test")).toBeNull();
  });
});

describe("runPrePromptWhisper", () => {
  it("surfaces relevant pending entries as suggested whispers and records visible handles", async () => {
    vi.resetModules();
    const homeDir = await mkdtemp(join(tmpdir(), "lore-whisper-pending-"));
    tempDirs.push(homeDir);
    vi.stubEnv("HOME", homeDir);

    const sharedPath = join(homeDir, ".lore", "shared.json");
    const whisperDir = join(homeDir, ".lore", "whisper-sessions");
    await mkdir(join(homeDir, ".lore"), { recursive: true });
    await mkdir(whisperDir, { recursive: true });
    await writeFile(
      sharedPath,
      `${JSON.stringify([
        makeEntry({
          id: "sk-pending-1",
          approvalStatus: "pending",
          promotionSource: "suggested",
          createdBy: "system",
          approvedAt: undefined,
        }),
      ], null, 2)}\n`,
      "utf8",
    );

    const sessionId = "session-pending-1";
    const cwd = "/tmp/workspaces/proj-1";
    const sessionKey = deriveSessionKey(sessionId, cwd);
    await writeFile(
      join(whisperDir, `whisper-${sessionKey}.json`),
      `${JSON.stringify(makeState({ sessionKey }), null, 2)}\n`,
      "utf8",
    );

    const stdoutWrites: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stdoutWrites.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    const { runPrePromptWhisper: runWhisper } = await import("../src/plugin/pre-prompt-whisper");
    await runWhisper(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        prompt: "Please update the database column naming.",
      }),
    );

    stdoutSpy.mockRestore();

    expect(stdoutWrites.join("")).toContain("[Lore · suggested @l1]");
    expect(stdoutWrites.join("")).toContain("lore yes");

    const updatedState = await readWhisperState(sessionKey, whisperDir);
    expect(updatedState.visibleItems).toEqual([
      expect.objectContaining({
        handle: "@l1",
        entryId: "sk-pending-1",
        kind: "pending_suggestion",
        entryKind: "domain_rule",
        content: "All database columns must use snake_case naming",
        actions: ["approve", "dismiss"],
        projectId: "proj-1",
        actionOnApprove: "approve_pending",
        actionOnDismiss: "reject_pending",
      }),
    ]);
  });

  it("approves the visible pending suggestion on lore yes", async () => {
    vi.resetModules();
    const homeDir = await mkdtemp(join(tmpdir(), "lore-whisper-approve-"));
    tempDirs.push(homeDir);
    vi.stubEnv("HOME", homeDir);

    const sharedPath = join(homeDir, ".lore", "shared.json");
    const whisperDir = join(homeDir, ".lore", "whisper-sessions");
    await mkdir(join(homeDir, ".lore"), { recursive: true });
    await mkdir(whisperDir, { recursive: true });
    await writeFile(
      sharedPath,
      `${JSON.stringify([
        makeEntry({
          id: "sk-pending-1",
          approvalStatus: "pending",
          promotionSource: "suggested",
          createdBy: "system",
          approvedAt: undefined,
        }),
      ], null, 2)}\n`,
      "utf8",
    );

    const sessionId = "session-approve-1";
    const cwd = "/tmp/workspaces/proj-1";
    const sessionKey = deriveSessionKey(sessionId, cwd);
    await writeFile(
      join(whisperDir, `whisper-${sessionKey}.json`),
      `${JSON.stringify(
        makeState({
          sessionKey,
          visibleItems: [
            {
              handle: "@l1",
              entryId: "sk-pending-1",
              kind: "pending_suggestion",
              entryKind: "domain_rule",
              content: "test content",
              actions: ["approve", "dismiss"],
              projectId: "proj-1",
              turnIndex: 5,
              actionOnDismiss: "reject_pending",
              actionOnApprove: "approve_pending",
            },
          ],
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdoutWrites: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stdoutWrites.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    const { runPrePromptWhisper: runWhisper } = await import("../src/plugin/pre-prompt-whisper");
    await runWhisper(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        prompt: "lore yes",
      }),
    );

    stdoutSpy.mockRestore();

    expect(stdoutWrites.join("")).toContain("[Lore · saved");

    const sharedContent = await readFile(sharedPath, "utf8");
    expect(sharedContent).toContain("\"approvalStatus\": \"approved\"");

    const updatedState = await readWhisperState(sessionKey, whisperDir);
    expect(updatedState.visibleItems).toEqual([]);
    expect(updatedState.activeReceipt?.entryId).toBe("sk-pending-1");
  });

  it("emits structured trace events to stderr when debug tracing is enabled", async () => {
    vi.resetModules();
    const homeDir = await mkdtemp(join(tmpdir(), "lore-whisper-trace-"));
    tempDirs.push(homeDir);
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("LORE_DEBUG", "trace");

    const sharedPath = join(homeDir, ".lore", "shared.json");
    const whisperDir = join(homeDir, ".lore", "whisper-sessions");
    await mkdir(join(homeDir, ".lore"), { recursive: true });
    await mkdir(whisperDir, { recursive: true });
    await writeFile(sharedPath, `${JSON.stringify([makeEntry()], null, 2)}\n`, "utf8");

    const sessionId = "session-1";
    const cwd = "/tmp/workspaces/proj-1";
    const sessionKey = deriveSessionKey(sessionId, cwd);
    await writeFile(
      join(whisperDir, `whisper-${sessionKey}.json`),
      `${JSON.stringify(makeState({ sessionKey }), null, 2)}\n`,
      "utf8",
    );

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stdoutWrites.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const { runPrePromptWhisper: runWhisper } = await import("../src/plugin/pre-prompt-whisper");
    await runWhisper(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        prompt: "Fix the database column naming.",
      }),
    );

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(stdoutWrites.join("")).toContain("[Lore]");
    expect(stderrWrites.length).toBeGreaterThan(0);
    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; component: string; hook: string; sessionId?: string });
    expect(lines.some((line) => line.event === "whisper.invoked")).toBe(true);
    expect(lines.some((line) => line.event === "whisper.scored")).toBe(true);
    expect(lines.some((line) => line.event === "whisper.completed")).toBe(true);
    expect(lines.every((line) => line.component === "pre-prompt-whisper")).toBe(true);
    expect(lines.every((line) => line.hook === "UserPromptSubmit")).toBe(true);
    expect(lines.some((line) => line.sessionId === sessionId)).toBe(true);
  });

  it("emits a suppression trace when no session id is present", async () => {
    vi.resetModules();
    const homeDir = await mkdtemp(join(tmpdir(), "lore-whisper-trace-"));
    tempDirs.push(homeDir);
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("LORE_DEBUG", "trace");

    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const { runPrePromptWhisper: runWhisper } = await import("../src/plugin/pre-prompt-whisper");
    await runWhisper(JSON.stringify({ cwd: "/tmp/workspaces/proj-1", prompt: "help" }));

    stderrSpy.mockRestore();

    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: { reason?: string } });
    expect(lines.some((line) => line.event === "whisper.suppressed")).toBe(true);
    expect(lines.some((line) => line.data?.reason === "no_session_id")).toBe(true);
  });
});
