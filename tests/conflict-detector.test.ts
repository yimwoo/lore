import { describe, expect, it } from "vitest";

import {
  classifyConflict,
  detectConflicts,
  detectPolarity,
  extractSubjectScope,
  tokenJaccard,
} from "../src/promotion/conflict-detector";

const makeEntry = (overrides: {
  id: string;
  content: string;
  kind?: string;
  confidence?: number;
  lastSeenAt?: string;
}) => ({
  id: overrides.id,
  kind: overrides.kind ?? "domain_rule",
  content: overrides.content,
  confidence: overrides.confidence ?? 0.9,
  lastSeenAt: overrides.lastSeenAt ?? "2026-03-28T10:00:00Z",
});

describe("detectPolarity", () => {
  it("detects positive polarity for 'Always use X'", () => {
    expect(detectPolarity("Always use snake_case for DB columns")).toBe("positive");
  });

  it("detects negative polarity for 'Never use X'", () => {
    expect(detectPolarity("Never use snake_case for DB columns")).toBe("negative");
  });

  it("detects neutral polarity for 'X is a good tool'", () => {
    expect(detectPolarity("Postgres is a good tool")).toBe("neutral");
  });

  it("detects negative polarity for 'Do not use X'", () => {
    expect(detectPolarity("Do not use snake_case")).toBe("negative");
  });

  it("detects negative polarity for 'Must not use X'", () => {
    expect(detectPolarity("Must not use snake_case")).toBe("negative");
  });
});

describe("extractSubjectScope", () => {
  it("extracts subject containing 'snake_case' and scope containing 'database' and 'columns'", () => {
    const result = extractSubjectScope("Always use snake_case for database columns");
    expect(result.subject).toContain("snake_case");
    expect(result.scope).toContain("database");
    expect(result.scope).toContain("columns");
  });

  it("extracts scope containing 'api' and 'layer'", () => {
    const result = extractSubjectScope("Use camelCase in the API layer");
    expect(result.scope).toContain("api");
    expect(result.scope).toContain("layer");
  });
});

describe("tokenJaccard", () => {
  it("returns 0.5 for ['a','b','c'] vs ['b','c','d']", () => {
    expect(tokenJaccard(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
  });

  it("returns 1.0 for two empty arrays", () => {
    expect(tokenJaccard([], [])).toBe(1.0);
  });

  it("returns 0.0 when one array is empty", () => {
    expect(tokenJaccard(["a"], [])).toBe(0.0);
    expect(tokenJaccard([], ["a"])).toBe(0.0);
  });
});

describe("classifyConflict", () => {
  it("classifies direct negation: 'Always use snake_case for DB columns' vs 'Never use snake_case for DB columns'", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case for DB columns",
      confidence: 0.9,
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use snake_case for DB columns",
      confidence: 0.85,
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(true);
    if (result.isConflict) {
      expect(result.conflictType).toBe("direct_negation");
    }
  });

  it("classifies scope mismatch: universal vs scoped", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case",
      confidence: 0.9,
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use snake_case for API columns",
      confidence: 0.85,
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(true);
    if (result.isConflict) {
      expect(result.conflictType).toBe("scope_mismatch");
    }
  });

  it("classifies temporal supersession for entries 90 days apart", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case for DB columns",
      confidence: 0.9,
      lastSeenAt: "2026-01-01T10:00:00Z",
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use snake_case for DB columns",
      confidence: 0.85,
      lastSeenAt: "2026-04-01T10:00:00Z",
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(true);
    if (result.isConflict) {
      expect(result.conflictType).toBe("temporal_supersession");
      expect(result.suggestedWinnerId).toBe("sk-b");
    }
  });

  it("classifies specialization for entries with disjoint scopes", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Use snake_case for DB columns",
      confidence: 0.9,
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use snake_case for API fields",
      confidence: 0.85,
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(true);
    if (result.isConflict) {
      expect(result.conflictType).toBe("specialization");
    }
  });

  it("classifies ambiguous for overlapping scopes with opposing polarity within temporal window", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case for database column names",
      confidence: 0.9,
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use snake_case for database table names",
      confidence: 0.85,
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(true);
    if (result.isConflict) {
      expect(result.conflictType).toBe("ambiguous");
    }
  });

  it("returns isConflict false for different kinds", () => {
    const entryA = makeEntry({
      id: "sk-a",
      kind: "domain_rule",
      content: "Always use snake_case",
    });
    const entryB = makeEntry({
      id: "sk-b",
      kind: "glossary_term",
      content: "Never use snake_case",
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(false);
  });

  it("returns isConflict false for low subject overlap", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case for DB columns",
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use tabs for indentation",
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(false);
  });

  it("returns isConflict false for same polarity", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case for DB columns",
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Always use snake_case for DB tables",
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(false);
  });

  it("suggests higher-confidence entry as winner for direct negation", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case for DB columns",
      confidence: 0.95,
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use snake_case for DB columns",
      confidence: 0.80,
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(true);
    if (result.isConflict) {
      expect(result.suggestedWinnerId).toBe("sk-a");
    }
  });

  it("suggests more recent entry when confidence is equal", () => {
    const entryA = makeEntry({
      id: "sk-a",
      content: "Always use snake_case for DB columns",
      confidence: 0.90,
      lastSeenAt: "2026-03-20T10:00:00Z",
    });
    const entryB = makeEntry({
      id: "sk-b",
      content: "Never use snake_case for DB columns",
      confidence: 0.90,
      lastSeenAt: "2026-03-28T10:00:00Z",
    });
    const result = classifyConflict(entryA, entryB);
    expect(result.isConflict).toBe(true);
    if (result.isConflict) {
      expect(result.suggestedWinnerId).toBe("sk-b");
    }
  });
});

describe("detectConflicts", () => {
  it("finds correct conflicting pairs in a batch of 4 entries", () => {
    const entries = [
      makeEntry({ id: "sk-1", content: "Always use snake_case for DB columns" }),
      makeEntry({ id: "sk-2", content: "Never use snake_case for DB columns" }),
      makeEntry({ id: "sk-3", content: "Always use tabs for indentation" }),
      makeEntry({ id: "sk-4", content: "Never use tabs for indentation" }),
    ];

    const conflicts = detectConflicts(entries);
    expect(conflicts.length).toBeGreaterThanOrEqual(2);

    const conflictPairIds = conflicts.map((c) => [c.entryIdA, c.entryIdB].sort().join(","));
    expect(conflictPairIds).toContain(["sk-1", "sk-2"].sort().join(","));
    expect(conflictPairIds).toContain(["sk-3", "sk-4"].sort().join(","));
  });

  it("skips non-conflicts in batch", () => {
    const entries = [
      makeEntry({ id: "sk-1", content: "Always use snake_case for DB columns" }),
      makeEntry({ id: "sk-2", content: "Always use Postgres for billing" }),
    ];

    const conflicts = detectConflicts(entries);
    expect(conflicts).toHaveLength(0);
  });
});
