import { describe, expect, it } from "vitest";

import { normalizeSessionEvent, parseRawSessionEvent } from "../src/bridge/events";
import { extractMemoryCandidates } from "../src/core/candidate-extractor";

describe("normalizeSessionEvent", () => {
  it("normalizes a user prompt into a bridge event", () => {
    const event = normalizeSessionEvent(
      {
        kind: "user_prompt_submitted",
        prompt: "Keep memory project scoped and visible.",
        files: ["src/app.ts"],
      },
      {
        projectId: "project-alpha",
        now: () => "2026-03-26T18:10:00.000Z",
        createId: () => "event-1",
      },
    );

    expect(event).toMatchObject({
      id: "event-1",
      projectId: "project-alpha",
      kind: "user_prompt_submitted",
      summary: "User prompt submitted",
      details: "Keep memory project scoped and visible.",
      files: ["src/app.ts"],
    });
  });

  it("normalizes a failed tool run into a risk-oriented event", () => {
    const event = normalizeSessionEvent(
      {
        kind: "tool_run_failed",
        toolName: "npm test",
        summary: "Command failed with 2 test errors.",
      },
      {
        projectId: "project-alpha",
        now: () => "2026-03-26T18:12:00.000Z",
        createId: () => "event-2",
      },
    );

    expect(event.kind).toBe("tool_run_failed");
    expect(event.summary).toBe("Tool run failed");
    expect(event.metadata).toMatchObject({
      toolName: "npm test",
      outcome: "failed",
    });
  });
});

describe("parseRawSessionEvent", () => {
  it("accepts well-formed raw events", () => {
    expect(
      parseRawSessionEvent({
        kind: "tool_run_failed",
        toolName: "npm test",
        summary: "Command failed with 2 test errors.",
        files: ["src/app.ts"],
      }),
    ).toEqual({
      kind: "tool_run_failed",
      toolName: "npm test",
      summary: "Command failed with 2 test errors.",
      files: ["src/app.ts"],
    });
  });

  it("rejects malformed raw events", () => {
    expect(() =>
      parseRawSessionEvent({
        kind: "tool_run_failed",
        toolName: "",
        summary: "Command failed.",
      }),
    ).toThrow(/toolName/i);

    expect(() =>
      parseRawSessionEvent({
        kind: "unexpected_kind",
      }),
    ).toThrow(/unknown event kind/i);
  });
});

describe("extractMemoryCandidates", () => {
  it("extracts a decision candidate from a user prompt", () => {
    const candidates = extractMemoryCandidates({
      id: "event-1",
      projectId: "project-alpha",
      timestamp: "2026-03-26T18:10:00.000Z",
      kind: "user_prompt_submitted",
      summary: "User prompt submitted",
      details: "Let's keep memory project scoped for v1.",
      files: ["src/shared/types.ts"],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      projectId: "project-alpha",
      kind: "decision",
      content: "Keep memory project scoped for v1.",
    });
    expect(candidates[1]).toMatchObject({
      kind: "working_context",
      content: "Active files: src/shared/types.ts",
    });
  });

  it("extracts reminder and working-context candidates from tool failures", () => {
    const candidates = extractMemoryCandidates({
      id: "event-2",
      projectId: "project-alpha",
      timestamp: "2026-03-26T18:12:00.000Z",
      kind: "tool_run_failed",
      summary: "Tool run failed",
      details: "npm test failed while running the event-ingestion suite.",
      metadata: {
        toolName: "npm test",
        outcome: "failed",
      },
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        kind: "reminder",
        content: "Investigate the failing tool run: npm test failed while running the event-ingestion suite.",
      }),
      expect.objectContaining({
        kind: "working_context",
        content: "Recent failure: npm test failed while running the event-ingestion suite.",
      }),
    ]);
  });

  it("extracts focus context from assistant responses without inventing decisions", () => {
    const candidates = extractMemoryCandidates({
      id: "event-3",
      projectId: "project-alpha",
      timestamp: "2026-03-26T18:14:00.000Z",
      kind: "assistant_response_completed",
      summary: "Assistant response completed",
      details: "Next I will implement the sidecar state in src/ui/sidecar-store.ts.",
      files: ["src/ui/sidecar-store.ts"],
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        kind: "working_context",
        content: "Active files: src/ui/sidecar-store.ts",
      }),
    ]);
  });
});
