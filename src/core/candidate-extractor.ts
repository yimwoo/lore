import type { MemoryCandidate, SessionEvent } from "../shared/types";

const titleCase = (value: string): string =>
  value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

const stripLeadIn = (value: string): string =>
  value
    .replace(/^let'?s\s+/i, "")
    .replace(/^we should\s+/i, "")
    .replace(/^please\s+/i, "")
    .trim();

export const extractMemoryCandidates = (event: SessionEvent): MemoryCandidate[] => {
  const candidates: MemoryCandidate[] = [];

  if (event.kind === "user_prompt_submitted" && event.details) {
    const normalized = stripLeadIn(event.details);
    if (/project scoped/i.test(normalized)) {
      candidates.push({
        projectId: event.projectId,
        kind: "decision",
        content: titleCase(normalized.replace(/\.$/, ".")),
        sourceEventIds: [event.id],
        confidence: 0.9,
        tags: ["decision", "user-preference"],
      });
    }
  }

  if (event.files && event.files.length > 0) {
    candidates.push({
      projectId: event.projectId,
      kind: "working_context",
      content: `Active files: ${event.files.join(", ")}`,
      sourceEventIds: [event.id],
      confidence: 0.78,
      tags: ["focus"],
    });
  }

  if (event.kind === "tool_run_failed" && event.details) {
    candidates.unshift({
      projectId: event.projectId,
      kind: "reminder",
      content: `Investigate the failing tool run: ${event.details}`,
      sourceEventIds: [event.id],
      confidence: 0.86,
      tags: ["risk", "follow-up"],
    });
    candidates.push({
      projectId: event.projectId,
      kind: "working_context",
      content: `Recent failure: ${event.details}`,
      sourceEventIds: [event.id],
      confidence: 0.8,
      tags: ["risk", "working-set"],
    });
  }

  return candidates;
};
