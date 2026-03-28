import { describe, expect, it } from "vitest";

import { buildPreTurnHint } from "../src/core/hint-engine";
import type { MemoryEntry, SessionEvent } from "../src/shared/types";

const recentEvents: SessionEvent[] = [
  {
    id: "event-1",
    projectId: "project-alpha",
    timestamp: "2026-03-26T18:10:00.000Z",
    kind: "tool_run_failed",
    summary: "Tool run failed",
    details: "npm test failed while running the hint suite.",
    metadata: {
      toolName: "npm test",
      outcome: "failed",
    },
  },
  {
    id: "event-2",
    projectId: "project-alpha",
    timestamp: "2026-03-26T18:11:00.000Z",
    kind: "assistant_response_completed",
    summary: "Assistant response completed",
    details: "Next I will inspect src/echo/hint-engine.ts.",
    files: ["src/echo/hint-engine.ts"],
  },
];

const memories: MemoryEntry[] = [
  {
    id: "memory-1",
    projectId: "project-alpha",
    kind: "decision",
    content: "Keep memory project scoped for v1.",
    sourceEventIds: ["event-0"],
    confidence: 0.95,
    createdAt: "2026-03-26T18:00:00.000Z",
    updatedAt: "2026-03-26T18:00:00.000Z",
    tags: ["decision"],
  },
  {
    id: "memory-2",
    projectId: "project-alpha",
    kind: "reminder",
    content: "Investigate the failing tool run: npm test failed while running the hint suite.",
    sourceEventIds: ["event-1"],
    confidence: 0.82,
    createdAt: "2026-03-26T18:10:00.000Z",
    updatedAt: "2026-03-26T18:10:00.000Z",
    tags: ["risk"],
  },
];

describe("buildPreTurnHint", () => {
  it("builds a bounded multi-category hint from memories and recent events", () => {
    const hint = buildPreTurnHint({
      projectId: "project-alpha",
      recentEvents,
      memories,
      now: () => "2026-03-26T18:12:00.000Z",
    });

    expect(hint).not.toBeNull();
    expect(hint?.bullets).toHaveLength(4);
    expect(hint?.bullets.map((bullet) => bullet.category)).toEqual([
      "recall",
      "risk",
      "focus",
      "next_step",
    ]);
  });

  it("returns null when the best available signal is below the confidence threshold", () => {
    const hint = buildPreTurnHint({
      projectId: "project-alpha",
      recentEvents: [
        {
          id: "event-low",
          projectId: "project-alpha",
          timestamp: "2026-03-26T18:12:00.000Z",
          kind: "assistant_response_completed",
          summary: "Assistant response completed",
          details: "I can look around if needed.",
        },
      ],
      memories: [],
      threshold: 0.7,
      now: () => "2026-03-26T18:12:00.000Z",
    });

    expect(hint).toBeNull();
  });

  it("suppresses identical hints when nothing relevant has changed", () => {
    const previousHint = buildPreTurnHint({
      projectId: "project-alpha",
      recentEvents,
      memories,
      now: () => "2026-03-26T18:12:00.000Z",
    });

    const nextHint = buildPreTurnHint({
      projectId: "project-alpha",
      recentEvents,
      memories,
      previousHint: previousHint ?? undefined,
      now: () => "2026-03-26T18:13:00.000Z",
    });

    expect(previousHint).not.toBeNull();
    expect(nextHint).toBeNull();
  });
});
