import {
  DEFAULT_HINT_CONFIDENCE_THRESHOLD,
  HINT_MAX_BULLETS,
} from "../shared/types";
import type {
  Hint,
  HintBullet,
  HintCategory,
  MemoryEntry,
  SessionEvent,
  SharedKnowledgeEntry,
  SharedKnowledgeKind,
} from "../shared/types";

type BuildPreTurnHintOptions = {
  projectId: string;
  recentEvents: SessionEvent[];
  memories: MemoryEntry[];
  previousHint?: Hint;
  threshold?: number;
  now?: () => string;
  sharedKnowledge?: SharedKnowledgeEntry[];
  injectedContentHashes?: string[];
};

const sameHint = (left: Hint, right: Hint): boolean =>
  JSON.stringify(left.bullets) === JSON.stringify(right.bullets);

const buildRecallBullet = (
  projectId: string,
  memories: MemoryEntry[],
): HintBullet | null => {
  const decision = memories.find(
    (memory) => memory.projectId === projectId && memory.kind === "decision",
  );
  if (!decision) {
    return null;
  }

  return {
    category: "recall",
    text: decision.content,
    confidence: decision.confidence,
    relatedMemoryIds: [decision.id],
    source: "project",
  };
};

const buildRiskBullet = (
  projectId: string,
  memories: MemoryEntry[],
  recentEvents: SessionEvent[],
): HintBullet | null => {
  const reminder = memories.find(
    (memory) => memory.projectId === projectId && memory.kind === "reminder",
  );
  if (reminder) {
    return {
      category: "risk",
      text: reminder.content,
      confidence: reminder.confidence,
      relatedMemoryIds: [reminder.id],
      source: "project",
    };
  }

  const failedEvent = recentEvents.find(
    (event) => event.projectId === projectId && event.kind === "tool_run_failed",
  );
  if (!failedEvent || !failedEvent.details) {
    return null;
  }

  return {
    category: "risk",
    text: `Recent failure: ${failedEvent.details}`,
    confidence: 0.72,
    relatedMemoryIds: [],
    source: "project",
  };
};

const buildFocusBullet = (
  projectId: string,
  recentEvents: SessionEvent[],
): HintBullet | null => {
  const files = recentEvents
    .filter((event) => event.projectId === projectId)
    .flatMap((event) => event.files ?? []);

  if (files.length === 0) {
    return null;
  }

  const uniqueFiles = Array.from(new Set(files));
  return {
    category: "focus",
    text: `Focus area: ${uniqueFiles.join(", ")}`,
    confidence: 0.76,
    relatedMemoryIds: [],
    source: "project",
  };
};

const buildNextStepBullet = (
  projectId: string,
  recentEvents: SessionEvent[],
): HintBullet | null => {
  const assistantEvent = [...recentEvents]
    .reverse()
    .find(
      (event) =>
        event.projectId === projectId &&
        event.kind === "assistant_response_completed" &&
        event.details,
    );

  if (!assistantEvent?.details) {
    return null;
  }

  return {
    category: "next_step",
    text: assistantEvent.details,
    confidence: 0.68,
    relatedMemoryIds: [],
    source: "project",
  };
};

const sharedKindToCategory: Record<SharedKnowledgeKind, HintCategory> = {
  domain_rule: "recall",
  glossary_term: "recall",
  architecture_fact: "focus",
  decision_record: "recall",
  user_preference: "recall",
};

const buildSharedKnowledgeBullets = (
  entries: SharedKnowledgeEntry[],
  injectedHashes: Set<string>,
  threshold: number,
): HintBullet[] => {
  const bullets: HintBullet[] = [];

  for (const entry of entries) {
    if (entry.approvalStatus !== "approved") continue;
    if (entry.confidence < threshold) continue;
    if (injectedHashes.has(entry.contentHash)) continue;

    bullets.push({
      category: sharedKindToCategory[entry.kind],
      text: `${entry.title}: ${entry.content}`,
      confidence: entry.confidence,
      relatedMemoryIds: [],
      source: "shared",
    });
  }

  return bullets.sort((a, b) => b.confidence - a.confidence);
};

export const buildPreTurnHint = (
  options: BuildPreTurnHintOptions,
): Hint | null => {
  const threshold = options.threshold ?? DEFAULT_HINT_CONFIDENCE_THRESHOLD;

  // Build project-local bullets first
  const projectBullets = [
    buildRecallBullet(options.projectId, options.memories),
    buildRiskBullet(options.projectId, options.memories, options.recentEvents),
    buildFocusBullet(options.projectId, options.recentEvents),
    buildNextStepBullet(options.projectId, options.recentEvents),
  ]
    .filter((bullet): bullet is HintBullet => Boolean(bullet))
    .filter((bullet) => bullet.confidence >= threshold);

  // Build shared knowledge bullets (deduplicated against SessionStart)
  const sharedBullets =
    options.sharedKnowledge && options.sharedKnowledge.length > 0
      ? buildSharedKnowledgeBullets(
          options.sharedKnowledge,
          new Set(options.injectedContentHashes ?? []),
          threshold,
        )
      : [];

  // Combine: project first, then shared, capped at max
  const allBullets = [...projectBullets, ...sharedBullets].slice(
    0,
    HINT_MAX_BULLETS,
  );

  if (allBullets.length === 0) {
    return null;
  }

  const hint: Hint = {
    projectId: options.projectId,
    bullets: allBullets,
    createdAt: options.now?.() ?? new Date().toISOString(),
    sourceEventIds: Array.from(
      new Set(options.recentEvents.map((event) => event.id)),
    ),
  };

  if (options.previousHint && sameHint(hint, options.previousHint)) {
    return null;
  }

  return hint;
};
