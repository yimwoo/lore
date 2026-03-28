import { describe, expect, it } from "vitest";

import {
  formatWhisper,
  selectWhisperBullets,
  updateWhisperHistory,
} from "../src/plugin/pre-prompt-whisper";
import type {
  HintBullet,
  SharedKnowledgeEntry,
  WhisperSessionState,
} from "../src/shared/types";
import { contentHash } from "../src/shared/validators";
import { resolveConfig } from "../src/config";

const config = resolveConfig().whisper;

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
