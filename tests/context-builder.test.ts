import { describe, expect, it } from "vitest";

import {
  buildSessionStartContext,
  clamp01,
  injectionScore,
  recencyScore,
  relevanceScore,
  stabilityScore,
} from "../src/plugin/context-builder";
import type { SharedKnowledgeEntry, SessionStartConfig, SharedKnowledgeKind } from "../src/shared/types";
import { defaultPerKindCaps } from "../src/shared/types";
import type { SharedKnowledgeStore } from "../src/core/shared-store";
import { contentHash } from "../src/shared/validators";

const defaultConfig: SessionStartConfig = {
  maxItems: 10,
  maxTokenEstimate: 2000,
  minConfidenceForInjection: 0.7,
  weights: {
    confidence: 0.25,
    stability: 0.2,
    recency: 0.1,
    kindPriority: 0.15,
    relevance: 0.3,
  },
  perKindCaps: { ...defaultPerKindCaps },
};

const NOW = "2026-01-15T00:00:00Z";

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => ({
  id: `sk-${Math.random().toString(36).slice(2, 6)}`,
  kind: "domain_rule",
  title: "Test rule",
  content: "Test content",
  confidence: 0.9,
  tags: ["test"],
  sourceProjectIds: ["proj-1"],
  sourceMemoryIds: ["mem-1"],
  promotionSource: "explicit",
  createdBy: "user",
  approvalStatus: "approved",
  sessionCount: 5,
  projectCount: 2,
  lastSeenAt: "2026-01-10T00:00:00Z",
  contentHash: contentHash(overrides?.content ?? "Test content"),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-10T00:00:00Z",
  ...overrides,
});

const makeStore = (entries: SharedKnowledgeEntry[]): SharedKnowledgeStore => ({
  list: async (filter) => {
    let result = [...entries];
    if (filter?.approvalStatus) {
      result = result.filter((e) => e.approvalStatus === filter.approvalStatus);
    }
    if (filter?.kind) {
      result = result.filter((e) => e.kind === filter.kind);
    }
    return result;
  },
  getById: async (id) => entries.find((e) => e.id === id) ?? null,
  save: async () => ({ ok: true }),
  update: async () => ({ ok: true }),
  remove: async () => ({ ok: true }),
});

describe("clamp01", () => {
  it("clamps below 0", () => expect(clamp01(-0.5)).toBe(0));
  it("clamps above 1", () => expect(clamp01(1.5)).toBe(1));
  it("passes through values in range", () => expect(clamp01(0.5)).toBe(0.5));
});

describe("stabilityScore", () => {
  it("returns 0 for new entries", () => {
    expect(
      stabilityScore(makeEntry({ sessionCount: 0, projectCount: 0 })),
    ).toBe(0);
  });

  it("returns 1 for highly stable entries", () => {
    expect(
      stabilityScore(makeEntry({ sessionCount: 20, projectCount: 5 })),
    ).toBe(1);
  });

  it("returns intermediate values", () => {
    const score = stabilityScore(
      makeEntry({ sessionCount: 5, projectCount: 1 }),
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("recencyScore", () => {
  it("returns 1 for today", () => {
    const entry = makeEntry({ lastSeenAt: NOW });
    expect(recencyScore(entry, new Date(NOW))).toBeCloseTo(1, 1);
  });

  it("returns 0 for 90+ days ago", () => {
    const entry = makeEntry({ lastSeenAt: "2025-10-01T00:00:00Z" });
    expect(recencyScore(entry, new Date(NOW))).toBe(0);
  });
});

describe("relevanceScore", () => {
  it("scores high for matching project", () => {
    const entry = makeEntry({ sourceProjectIds: ["proj-a"] });
    const score = relevanceScore(entry, "proj-a", []);
    expect(score).toBeGreaterThan(0.4);
  });

  it("scores low for non-matching project without tags", () => {
    const entry = makeEntry({
      sourceProjectIds: ["proj-b"],
      kind: "architecture_fact",
      tags: [],
    });
    const score = relevanceScore(entry, "proj-a", []);
    expect(score).toBe(0);
  });

  it("gives domain_rule baseline relevance", () => {
    const entry = makeEntry({
      kind: "domain_rule",
      sourceProjectIds: ["other"],
      tags: [],
    });
    const score = relevanceScore(entry, "proj-a", []);
    expect(score).toBeGreaterThan(0);
  });

  it("gives universal-tagged entries baseline relevance", () => {
    const entry = makeEntry({
      kind: "architecture_fact",
      sourceProjectIds: ["other"],
      tags: ["universal"],
    });
    const score = relevanceScore(entry, "proj-a", []);
    expect(score).toBeGreaterThan(0);
  });

  it("accounts for tag overlap", () => {
    const entry = makeEntry({
      kind: "architecture_fact",
      sourceProjectIds: ["other"],
      tags: ["backend", "api"],
    });
    const withOverlap = relevanceScore(entry, "other-proj", ["backend", "api"]);
    const noOverlap = relevanceScore(entry, "other-proj", ["frontend"]);
    expect(withOverlap).toBeGreaterThan(noOverlap);
  });

  it("handles empty currentTags gracefully", () => {
    const entry = makeEntry({ sourceProjectIds: ["other"], kind: "architecture_fact", tags: [] });
    const score = relevanceScore(entry, "proj-a", []);
    expect(score).toBe(0); // no project match, no tags, no universal
  });
});

describe("buildSessionStartContext", () => {
  it("returns empty string for empty store", async () => {
    const result = await buildSessionStartContext({
      store: makeStore([]),
      currentProjectId: "proj-1",
      currentTags: [],
      config: defaultConfig,
      now: () => NOW,
    });
    expect(result).toBe("");
  });

  it("excludes entries below confidence threshold", async () => {
    const result = await buildSessionStartContext({
      store: makeStore([
        makeEntry({ confidence: 0.5, content: "Low confidence", contentHash: contentHash("Low confidence") }),
      ]),
      currentProjectId: "proj-1",
      currentTags: [],
      config: defaultConfig,
      now: () => NOW,
    });
    expect(result).toBe("");
  });

  it("enforces per-kind caps", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry({
        title: `Rule ${i}`,
        content: `Rule content ${i}`,
        contentHash: contentHash(`Rule content ${i}`),
        kind: "domain_rule",
      }),
    );

    const result = await buildSessionStartContext({
      store: makeStore(entries),
      currentProjectId: "proj-1",
      currentTags: [],
      config: { ...defaultConfig, perKindCaps: { ...defaultPerKindCaps, domain_rule: 4 } },
      now: () => NOW,
    });

    const ruleLines = result
      .split("\n")
      .filter((l) => l.startsWith("- **Rule"));
    expect(ruleLines.length).toBeLessThanOrEqual(4);
  });

  it("enforces total item cap", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => {
      const kinds: SharedKnowledgeKind[] = ["domain_rule", "architecture_fact", "glossary_term", "user_preference", "decision_record"];
      return makeEntry({
        title: `Entry ${i}`,
        content: `Content ${i}`,
        contentHash: contentHash(`Content ${i}`),
        kind: kinds[i % 5]!,
      });
    });

    const result = await buildSessionStartContext({
      store: makeStore(entries),
      currentProjectId: "proj-1",
      currentTags: [],
      config: { ...defaultConfig, maxItems: 5 },
      now: () => NOW,
    });

    const bulletLines = result
      .split("\n")
      .filter((l) => l.startsWith("- **"));
    expect(bulletLines.length).toBeLessThanOrEqual(5);
  });

  it("enforces token budget", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Rule ${i}`,
        content: "A".repeat(500),
        contentHash: contentHash(`Rule ${i} ${"A".repeat(500)}`),
      }),
    );

    const result = await buildSessionStartContext({
      store: makeStore(entries),
      currentProjectId: "proj-1",
      currentTags: [],
      config: { ...defaultConfig, maxTokenEstimate: 300 },
      now: () => NOW,
    });

    const bulletLines = result
      .split("\n")
      .filter((l) => l.startsWith("- **"));
    expect(bulletLines.length).toBeLessThan(5);
  });

  it("ranks workspace-relevant entries higher than globally stable but irrelevant", async () => {
    const relevant = makeEntry({
      title: "Relevant rule",
      content: "Project-specific rule",
      contentHash: contentHash("Project-specific rule"),
      sourceProjectIds: ["my-project"],
      confidence: 0.8,
      sessionCount: 2,
      projectCount: 1,
    });

    const stable = makeEntry({
      title: "Stable rule",
      content: "Very stable but irrelevant",
      contentHash: contentHash("Very stable but irrelevant"),
      sourceProjectIds: ["other-project"],
      kind: "architecture_fact",
      tags: [],
      confidence: 0.85,
      sessionCount: 10,
      projectCount: 3,
    });

    const result = await buildSessionStartContext({
      store: makeStore([stable, relevant]),
      currentProjectId: "my-project",
      currentTags: [],
      config: defaultConfig,
      now: () => NOW,
    });

    const lines = result.split("\n").filter((l) => l.startsWith("- **"));
    expect(lines.length).toBe(2);
    // Relevant entry should appear first (under Domain Rules, which comes first)
    expect(lines[0]).toContain("Relevant rule");
  });

  it("degrades gracefully with empty currentTags", async () => {
    const entry = makeEntry({ tags: ["universal"] });

    const result = await buildSessionStartContext({
      store: makeStore([entry]),
      currentProjectId: "unknown-project",
      currentTags: [],
      config: defaultConfig,
      now: () => NOW,
    });

    expect(result).toContain("Test rule");
  });

  it("groups output by kind and skips empty sections", async () => {
    const result = await buildSessionStartContext({
      store: makeStore([
        makeEntry({ kind: "domain_rule", title: "Rule A", content: "Rule A content", contentHash: contentHash("Rule A content") }),
        makeEntry({ kind: "architecture_fact", title: "Arch B", content: "Arch B content", contentHash: contentHash("Arch B content") }),
      ]),
      currentProjectId: "proj-1",
      currentTags: [],
      config: defaultConfig,
      now: () => NOW,
    });

    expect(result).toContain("## Domain Rules");
    expect(result).toContain("## Architecture");
    expect(result).not.toContain("## Glossary");
    expect(result).not.toContain("## Preferences");
    expect(result).not.toContain("## Decisions");
  });

  it("deduplicates by contentHash", async () => {
    const result = await buildSessionStartContext({
      store: makeStore([
        makeEntry({ id: "a", title: "Rule", content: "Same content", contentHash: contentHash("Same content") }),
        makeEntry({ id: "b", title: "Rule copy", content: "Same content", contentHash: contentHash("Same content") }),
      ]),
      currentProjectId: "proj-1",
      currentTags: [],
      config: defaultConfig,
      now: () => NOW,
    });

    const bulletLines = result
      .split("\n")
      .filter((l) => l.startsWith("- **"));
    expect(bulletLines).toHaveLength(1);
  });

  it("diversity pass prefers underrepresented kinds", async () => {
    // 4 domain_rules (will hit cap) + 1 glossary
    const entries = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeEntry({
          kind: "domain_rule",
          title: `DR ${i}`,
          content: `DR content ${i}`,
          contentHash: contentHash(`DR content ${i}`),
          confidence: 0.95,
          sessionCount: 10,
          projectCount: 3,
        }),
      ),
      makeEntry({
        kind: "glossary_term",
        title: "Glossary entry",
        content: "Glossary content",
        contentHash: contentHash("Glossary content"),
        confidence: 0.75,
        sessionCount: 1,
        projectCount: 1,
      }),
    ];

    const result = await buildSessionStartContext({
      store: makeStore(entries),
      currentProjectId: "proj-1",
      currentTags: [],
      config: defaultConfig,
      now: () => NOW,
    });

    expect(result).toContain("Glossary entry");
  });
});
