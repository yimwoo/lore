import { describe, expect, it } from "vitest";

import { buildPreTurnHint } from "../src/core/hint-engine";
import type { MemoryEntry, SessionEvent, SharedKnowledgeEntry } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

const projectId = "project-alpha";

const recentEvents: SessionEvent[] = [
  {
    id: "event-1",
    projectId,
    timestamp: "2026-01-01T00:00:00Z",
    kind: "tool_run_failed",
    summary: "Tool run failed",
    details: "npm test failed",
    metadata: { toolName: "npm test", outcome: "failed" },
  },
  {
    id: "event-2",
    projectId,
    timestamp: "2026-01-01T00:01:00Z",
    kind: "assistant_response_completed",
    summary: "Assistant response",
    details: "Will inspect hint engine next",
    files: ["src/echo/hint-engine.ts"],
  },
];

const memories: MemoryEntry[] = [
  {
    id: "memory-1",
    projectId,
    kind: "decision",
    content: "Keep memory project scoped",
    sourceEventIds: ["event-0"],
    confidence: 0.95,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tags: ["decision"],
  },
  {
    id: "memory-2",
    projectId,
    kind: "reminder",
    content: "Investigate failing test",
    sourceEventIds: ["event-1"],
    confidence: 0.82,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tags: ["risk"],
  },
];

const makeSharedEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => ({
  id: `sk-${Math.random().toString(36).slice(2, 6)}`,
  kind: "domain_rule",
  title: "Use snake_case",
  content: "All DB columns must use snake_case",
  confidence: 0.9,
  tags: ["naming"],
  sourceProjectIds: ["proj-1"],
  sourceMemoryIds: [],
  promotionSource: "explicit",
  createdBy: "user",
  approvalStatus: "approved",
  approvedAt: "2026-01-01T00:00:00Z",
  sessionCount: 5,
  projectCount: 2,
  lastSeenAt: "2026-01-10T00:00:00Z",
  contentHash: contentHash(overrides?.content ?? "All DB columns must use snake_case"),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-10T00:00:00Z",
  ...overrides,
});

describe("shared-knowledge-aware hints", () => {
  it("includes shared knowledge bullet when provided", () => {
    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories: [],
      sharedKnowledge: [makeSharedEntry()],
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).not.toBeNull();
    expect(hint!.bullets).toHaveLength(1);
    expect(hint!.bullets[0]!.source).toBe("shared");
    expect(hint!.bullets[0]!.text).toContain("snake_case");
  });

  it("shared bullet has source='shared' when project bullets leave room", () => {
    // Use only 1 project bullet (recall from decision memory) + shared
    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories: [memories[0]!],
      sharedKnowledge: [makeSharedEntry()],
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).not.toBeNull();
    const sharedBullets = hint!.bullets.filter((b) => b.source === "shared");
    expect(sharedBullets.length).toBeGreaterThan(0);
    expect(sharedBullets[0]!.source).toBe("shared");
  });

  it("project bullets have source='project'", () => {
    const hint = buildPreTurnHint({
      projectId,
      recentEvents,
      memories,
      now: () => "2026-01-01T00:05:00Z",
    });

    for (const bullet of hint!.bullets) {
      expect(bullet.source).toBe("project");
    }
  });

  it("deduplicates against injectedContentHashes", () => {
    const entry = makeSharedEntry();

    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories: [],
      sharedKnowledge: [entry],
      injectedContentHashes: [entry.contentHash],
      now: () => "2026-01-01T00:05:00Z",
    });

    // Entry is already injected via SessionStart, so hint should be null
    expect(hint).toBeNull();
  });

  it("project bullets come before shared bullets", () => {
    const hint = buildPreTurnHint({
      projectId,
      recentEvents,
      memories,
      sharedKnowledge: [makeSharedEntry()],
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).not.toBeNull();
    // First bullets should be project-local
    expect(hint!.bullets[0]!.source).toBe("project");
    // Last bullet should be shared (if there's room)
    const sources = hint!.bullets.map((b) => b.source);
    const lastProjectIdx = sources.lastIndexOf("project");
    const firstSharedIdx = sources.indexOf("shared");
    if (firstSharedIdx >= 0) {
      expect(firstSharedIdx).toBeGreaterThan(lastProjectIdx);
    }
  });

  it("respects HINT_MAX_BULLETS cap", () => {
    // 4 project bullets + shared → should cap at 4
    const hint = buildPreTurnHint({
      projectId,
      recentEvents,
      memories,
      sharedKnowledge: [
        makeSharedEntry(),
        makeSharedEntry({
          title: "Another rule",
          content: "Another content",
          contentHash: contentHash("Another content"),
        }),
      ],
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint!.bullets).toHaveLength(4);
  });

  it("with no shared knowledge, hint is unchanged from v1", () => {
    const hint = buildPreTurnHint({
      projectId,
      recentEvents,
      memories,
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).not.toBeNull();
    expect(hint!.bullets).toHaveLength(4);
    expect(hint!.bullets.map((b) => b.category)).toEqual([
      "recall",
      "risk",
      "focus",
      "next_step",
    ]);
  });

  it("with only shared knowledge and no project context, hint still works", () => {
    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories: [],
      sharedKnowledge: [makeSharedEntry()],
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).not.toBeNull();
    expect(hint!.bullets).toHaveLength(1);
    expect(hint!.bullets[0]!.source).toBe("shared");
  });

  it("maps kind to correct category", () => {
    const entries = [
      makeSharedEntry({ kind: "domain_rule", title: "DR", content: "DR content", contentHash: contentHash("DR content") }),
      makeSharedEntry({ kind: "architecture_fact", title: "AF", content: "AF content", contentHash: contentHash("AF content") }),
      makeSharedEntry({ kind: "decision_record", title: "Dec", content: "Dec content", contentHash: contentHash("Dec content") }),
      makeSharedEntry({ kind: "glossary_term", title: "GT", content: "GT content", contentHash: contentHash("GT content") }),
    ];

    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories: [],
      sharedKnowledge: entries,
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).not.toBeNull();
    const categories = hint!.bullets.map((b) => b.category);
    expect(categories).toContain("recall"); // domain_rule, glossary_term, decision_record
    expect(categories).toContain("focus"); // architecture_fact
  });

  it("excludes shared entries below confidence threshold", () => {
    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories: [],
      sharedKnowledge: [makeSharedEntry({ confidence: 0.3 })],
      threshold: 0.6,
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).toBeNull();
  });

  it("excludes non-approved shared entries", () => {
    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories: [],
      sharedKnowledge: [makeSharedEntry({ approvalStatus: "demoted" })],
      now: () => "2026-01-01T00:05:00Z",
    });

    expect(hint).toBeNull();
  });
});
