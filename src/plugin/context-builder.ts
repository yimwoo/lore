import type {
  ContextBuilderResult,
  SelectedEntry,
  SessionStartConfig,
  SharedKnowledgeEntry,
  SharedKnowledgeKind,
} from "../shared/types";
import { kindPriorityScore } from "../shared/types";
import type { SharedKnowledgeStore } from "../core/shared-store";

type BuildContextOptions = {
  store: SharedKnowledgeStore;
  currentProjectId: string;
  currentTags: string[];
  config: SessionStartConfig;
  now?: () => string;
};

export const clamp01 = (value: number): number =>
  Math.max(0, Math.min(1, value));

export const stabilityScore = (entry: SharedKnowledgeEntry): number =>
  clamp01(
    0.5 * Math.min(entry.sessionCount / 10, 1.0) +
      0.5 * Math.min(entry.projectCount / 3, 1.0),
  );

export const recencyScore = (
  entry: SharedKnowledgeEntry,
  now: Date,
): number => {
  const lastSeen = new Date(entry.lastSeenAt);
  const daysSince =
    (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);
  return clamp01(1.0 - daysSince / 90);
};

export const relevanceScore = (
  entry: SharedKnowledgeEntry,
  currentProjectId: string,
  currentTags: string[],
): number => {
  const projectMatch = entry.sourceProjectIds.includes(currentProjectId)
    ? 1.0
    : 0.0;

  let tagOverlap = 0.0;
  if (currentTags.length > 0 && entry.tags.length > 0) {
    const entryTagSet = new Set(entry.tags);
    const currentTagSet = new Set(currentTags);
    const intersection = currentTags.filter((t) => entryTagSet.has(t));
    const union = new Set([...entryTagSet, ...currentTagSet]);
    tagOverlap = union.size > 0 ? intersection.length / union.size : 0.0;
  }

  const universalFlag =
    entry.tags.includes("universal") || entry.kind === "domain_rule"
      ? 1.0
      : 0.0;

  return clamp01(
    0.5 * projectMatch + 0.3 * tagOverlap + 0.2 * universalFlag,
  );
};

export const injectionScore = (
  entry: SharedKnowledgeEntry,
  currentProjectId: string,
  currentTags: string[],
  config: SessionStartConfig,
  now: Date,
): number => {
  const w = config.weights;
  return (
    w.confidence * entry.confidence +
    w.stability * stabilityScore(entry) +
    w.recency * recencyScore(entry, now) +
    w.kindPriority * (kindPriorityScore[entry.kind] ?? 0) +
    w.relevance * relevanceScore(entry, currentProjectId, currentTags)
  );
};

const estimateTokens = (entry: SharedKnowledgeEntry): number =>
  Math.ceil((entry.title.length + entry.content.length) / 4);

const toSelectedEntry = (entry: SharedKnowledgeEntry): SelectedEntry => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  content: entry.content,
  contentHash: entry.contentHash,
});

export const buildSessionStartContext = async (
  options: BuildContextOptions,
): Promise<ContextBuilderResult> => {
  const { store, currentProjectId, currentTags, config } = options;
  const now = new Date(options.now?.() ?? new Date().toISOString());

  // 1. Load approved entries
  const allEntries = await store.list({ approvalStatus: "approved" });

  // 2. Hard gate
  const gated = allEntries.filter(
    (entry) =>
      entry.confidence >= config.minConfidenceForInjection &&
      entry.title.trim().length > 0 &&
      entry.content.trim().length > 0,
  );

  if (gated.length === 0) {
    return { selectedEntries: [], injectedContentHashes: [] };
  }

  // 3. Score
  const scored = gated.map((entry) => ({
    entry,
    score: injectionScore(entry, currentProjectId, currentTags, config, now),
  }));

  // 4. Deduplicate by contentHash
  const seen = new Map<string, (typeof scored)[number]>();
  for (const item of scored) {
    const existing = seen.get(item.entry.contentHash);
    if (!existing || item.score > existing.score) {
      seen.set(item.entry.contentHash, item);
    }
  }
  const deduped = Array.from(seen.values());

  // 5. Sort descending
  deduped.sort((a, b) => b.score - a.score);

  // 6. Select with per-kind caps + total + token budget
  const selected: SharedKnowledgeEntry[] = [];
  const kindCounts: Partial<Record<SharedKnowledgeKind, number>> = {};
  let totalTokens = 0;

  for (const item of deduped) {
    if (selected.length >= config.maxItems) break;
    if (totalTokens >= config.maxTokenEstimate) break;

    const kindCount = kindCounts[item.entry.kind] ?? 0;
    const kindCap = config.perKindCaps[item.entry.kind] ?? 2;
    if (kindCount >= kindCap) continue;

    const tokens = estimateTokens(item.entry);
    if (totalTokens + tokens > config.maxTokenEstimate) continue;

    selected.push(item.entry);
    kindCounts[item.entry.kind] = kindCount + 1;
    totalTokens += tokens;
  }

  // 7. Diversity pass: fill remaining budget with underrepresented kinds
  if (selected.length < config.maxItems && totalTokens < config.maxTokenEstimate) {
    const selectedKinds = new Set(selected.map((e) => e.kind));
    for (const item of deduped) {
      if (selected.length >= config.maxItems) break;
      if (totalTokens >= config.maxTokenEstimate) break;
      if (selected.includes(item.entry)) continue;

      const kindCount = kindCounts[item.entry.kind] ?? 0;
      const kindCap = config.perKindCaps[item.entry.kind] ?? 2;
      if (kindCount >= kindCap) continue;

      // Prefer kinds not yet represented
      if (!selectedKinds.has(item.entry.kind)) {
        const tokens = estimateTokens(item.entry);
        if (totalTokens + tokens > config.maxTokenEstimate) continue;

        selected.push(item.entry);
        kindCounts[item.entry.kind] = kindCount + 1;
        selectedKinds.add(item.entry.kind);
        totalTokens += tokens;
      }
    }
  }

  if (selected.length === 0) {
    return { selectedEntries: [], injectedContentHashes: [] };
  }

  return {
    selectedEntries: selected.map(toSelectedEntry),
    injectedContentHashes: selected.map((e) => e.contentHash),
  };
};
