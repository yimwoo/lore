import { describe, expect, it } from "vitest";

import {
  effectiveScore,
  frequencyPenalty,
  inferPromptTags,
  keywordScore,
  recentWhisperPenalty,
  sessionAffinityScore,
  tagScore,
  tokenize,
  turnRelevance,
} from "../src/plugin/whisper-scorer";
import type { SharedKnowledgeEntry, WhisperRecord } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => ({
  id: "sk-test",
  kind: "domain_rule",
  title: "Use snake_case",
  content: "All database columns must use snake_case naming",
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
  contentHash: contentHash("All database columns must use snake_case naming"),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-10T00:00:00Z",
  ...overrides,
});

describe("tokenize", () => {
  it("lowercases and splits", () => {
    expect(tokenize("Hello World Test")).toEqual(["hello", "world", "test"]);
  });

  it("filters short tokens", () => {
    expect(tokenize("a is the big one")).toEqual(["big", "one"]);
  });

  it("filters stopwords", () => {
    expect(tokenize("the quick brown fox")).toEqual(["quick", "brown", "fox"]);
  });

  it("respects minLength parameter", () => {
    expect(tokenize("ab cde fghij", 4)).toEqual(["fghij"]);
  });
});

describe("keywordScore", () => {
  it("returns 1.0 for identical token sets", () => {
    const tokens = ["database", "columns", "snake_case"];
    expect(keywordScore(tokens, tokens)).toBeCloseTo(1.0);
  });

  it("returns 0 for no overlap", () => {
    expect(keywordScore(["frontend", "react"], ["database", "sql"])).toBe(0);
  });

  it("does not crush score for long prompts", () => {
    const longPrompt = tokenize(
      "I need to fix the database migration for the billing service and also update the schema for the new columns",
    );
    const entry = tokenize("database columns snake_case naming");
    const score = keywordScore(longPrompt, entry);
    expect(score).toBeGreaterThan(0.1);
  });

  it("returns 0 when either side is empty", () => {
    expect(keywordScore([], ["test"])).toBe(0);
    expect(keywordScore(["test"], [])).toBe(0);
  });
});

describe("inferPromptTags", () => {
  it("infers typescript from .ts extension", () => {
    const tags = inferPromptTags("fix src/foo.ts", []);
    expect(tags).toContain("typescript");
  });

  it("infers database from .sql extension", () => {
    const tags = inferPromptTags("run migrate.sql", []);
    expect(tags).toContain("database");
  });

  it("infers testing from npm command", () => {
    const tags = inferPromptTags("npm test failed", []);
    expect(tags).toContain("testing");
  });

  it("infers domain keyword billing", () => {
    const tags = inferPromptTags("fix the billing endpoint", []);
    expect(tags).toContain("billing");
  });

  it("infers from recent files", () => {
    const tags = inferPromptTags("fix this", ["src/app.ts", "schema.sql"]);
    expect(tags).toContain("typescript");
    expect(tags).toContain("database");
  });
});

describe("tagScore", () => {
  it("returns correct Jaccard overlap", () => {
    // intersection: {database} = 1, union: {database, naming, testing} = 3
    expect(tagScore(["database", "testing"], ["database", "naming"])).toBeCloseTo(1 / 3);
  });

  it("returns 0 for no overlap", () => {
    expect(tagScore(["frontend"], ["backend"])).toBe(0);
  });

  it("returns 0 for empty sets", () => {
    expect(tagScore([], ["test"])).toBe(0);
    expect(tagScore(["test"], [])).toBe(0);
  });
});

describe("sessionAffinityScore", () => {
  it("boosts score for matching project", () => {
    const entry = makeEntry({ sourceProjectIds: ["my-project"] });
    const score = sessionAffinityScore(entry, "my-project", []);
    expect(score).toBeGreaterThan(0.4);
  });

  it("boosts score for tag affinity", () => {
    const entry = makeEntry({ tags: ["database", "naming"] });
    const score = sessionAffinityScore(entry, "other", ["database"]);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 for no match", () => {
    const entry = makeEntry({
      sourceProjectIds: ["other"],
      tags: ["backend"],
    });
    const score = sessionAffinityScore(entry, "my-project", ["frontend"]);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("turnRelevance", () => {
  it("combines all 4 dimensions", () => {
    const entry = makeEntry();
    const result = turnRelevance(entry, {
      promptTokens: tokenize("fix the database column naming"),
      promptTags: ["database"],
      currentProjectId: "proj-1",
      recentFileTags: ["database"],
    });

    expect(result.score).toBeGreaterThan(0);
    expect(result.topReason).toBeTruthy();
  });

  it("returns top reason as the highest-contributing dimension", () => {
    const entry = makeEntry({ tags: ["database", "naming"] });
    const result = turnRelevance(entry, {
      promptTokens: tokenize("database columns snake_case naming conventions"),
      promptTags: [],
      currentProjectId: "other",
      recentFileTags: [],
    });

    expect(result.topReason).toBe("keyword");
  });

  it("is deterministic", () => {
    const entry = makeEntry();
    const input = {
      promptTokens: tokenize("database migration"),
      promptTags: ["database"],
      currentProjectId: "proj-1",
      recentFileTags: [],
    };

    const r1 = turnRelevance(entry, input);
    const r2 = turnRelevance(entry, input);
    expect(r1.score).toBe(r2.score);
    expect(r1.topReason).toBe(r2.topReason);
  });
});

describe("recentWhisperPenalty", () => {
  const record: WhisperRecord = {
    contentHash: "abc",
    kind: "domain_rule",
    source: "shared",
    topReason: "keyword",
    turnIndex: 5,
    whisperCount: 1,
  };

  it("returns 1.0 (hard block) for last 2 turns", () => {
    expect(recentWhisperPenalty(record, 6, 2)).toBe(1.0);
    expect(recentWhisperPenalty(record, 7, 2)).toBe(1.0);
  });

  it("decays after hard block range", () => {
    expect(recentWhisperPenalty(record, 8, 2)).toBe(0.4);
    expect(recentWhisperPenalty(record, 10, 2)).toBe(0.4);
  });

  it("further decays at 10+ turns", () => {
    expect(recentWhisperPenalty(record, 11, 2)).toBe(0.15);
    expect(recentWhisperPenalty(record, 15, 2)).toBe(0.15);
  });

  it("returns 0 for old whispers", () => {
    expect(recentWhisperPenalty(record, 16, 2)).toBe(0);
  });

  it("returns 0 for undefined record", () => {
    expect(recentWhisperPenalty(undefined, 5, 2)).toBe(0);
  });
});

describe("frequencyPenalty", () => {
  it("grows with whisper count", () => {
    const r1: WhisperRecord = { contentHash: "a", kind: "domain_rule", source: "shared", topReason: "keyword", turnIndex: 1, whisperCount: 1 };
    const r3: WhisperRecord = { ...r1, whisperCount: 3 };
    expect(frequencyPenalty(r3)).toBeGreaterThan(frequencyPenalty(r1));
  });

  it("caps at 0.3", () => {
    const r: WhisperRecord = { contentHash: "a", kind: "domain_rule", source: "shared", topReason: "keyword", turnIndex: 1, whisperCount: 100 };
    expect(frequencyPenalty(r)).toBe(0.3);
  });

  it("returns 0 for undefined", () => {
    expect(frequencyPenalty(undefined)).toBe(0);
  });
});

describe("effectiveScore", () => {
  it("subtracts both penalties", () => {
    expect(effectiveScore(0.8, 0.2, 0.1)).toBeCloseTo(0.5);
  });

  it("can go negative", () => {
    expect(effectiveScore(0.3, 1.0, 0.1)).toBeLessThan(0);
  });
});
