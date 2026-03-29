import type { ObservationEntry, SharedKnowledgeKind, MemoryKind, SignalStrength } from "../shared/types";
import { isSharedKnowledgeKind } from "../shared/types";
import type { PromotionCriteria } from "../config";
import type { SharedKnowledgeStore } from "../core/shared-store";
import type { ObservationLogReader } from "./observation-log";
import { checkForbidPatterns } from "./policy";

export type SuggestionCandidate = {
  contentHash: string;
  kind: SharedKnowledgeKind;
  confidence: number;
  sessionCount: number;
  projectCount: number;
  lastSeenAt: string;
  sampleProjectIds: string[];
};

type AggregatedObservation = {
  contentHash: string;
  kind: MemoryKind;
  maxConfidence: number;
  sessionIds: Set<string>;
  projectIds: Set<string>;
  lastSeenAt: string;
  maxSignalStrength?: SignalStrength;
};

const SIGNAL_STRENGTH_ORDER: Record<SignalStrength, number> = {
  strong: 2,
  medium: 1,
  weak: 0,
};

const memoryKindToSharedKind: Partial<Record<MemoryKind, SharedKnowledgeKind>> = {
  decision: "decision_record",
  working_context: "architecture_fact",
  reminder: "domain_rule",
};

type SuggestionEngineOptions = {
  reader: ObservationLogReader;
  sharedStore: SharedKnowledgeStore;
  policy: Record<SharedKnowledgeKind, PromotionCriteria>;
};

export class SuggestionEngine {
  private readonly reader: ObservationLogReader;
  private readonly sharedStore: SharedKnowledgeStore;
  private readonly policy: Record<SharedKnowledgeKind, PromotionCriteria>;

  constructor(options: SuggestionEngineOptions) {
    this.reader = options.reader;
    this.sharedStore = options.sharedStore;
    this.policy = options.policy;
  }

  async findCandidates(): Promise<SuggestionCandidate[]> {
    const observations = await this.reader.readAll();
    if (observations.length === 0) return [];

    // Aggregate by contentHash
    const aggregated = this.aggregate(observations);

    // Filter candidates
    const candidates: SuggestionCandidate[] = [];

    for (const agg of aggregated.values()) {
      const sharedKind = memoryKindToSharedKind[agg.kind];
      if (!sharedKind) continue;

      const criteria = this.policy[sharedKind];

      // Check eligibility
      if (criteria.eligibility !== "suggest_allowed") continue;

      // Check thresholds
      if (agg.maxConfidence < criteria.minConfidence) continue;
      const maxSignalStrength: SignalStrength = agg.maxSignalStrength ?? "weak";
      const effectiveMinSessionCount = maxSignalStrength === "strong" ? 1 : criteria.minSessionCount;
      if (agg.sessionIds.size < effectiveMinSessionCount) continue;
      if (agg.projectIds.size < criteria.minProjectCount) continue;

      // Check if already in shared store
      const existing = await this.sharedStore.list({
        kind: sharedKind,
        approvalStatus: "approved",
      });
      const alreadyExists = existing.some(
        (e) => e.contentHash === agg.contentHash,
      );
      if (alreadyExists) continue;

      // Also check pending
      const pending = await this.sharedStore.list({
        kind: sharedKind,
        approvalStatus: "pending",
      });
      const alreadyPending = pending.some(
        (e) => e.contentHash === agg.contentHash,
      );
      if (alreadyPending) continue;

      candidates.push({
        contentHash: agg.contentHash,
        kind: sharedKind,
        confidence: agg.maxConfidence,
        sessionCount: agg.sessionIds.size,
        projectCount: agg.projectIds.size,
        lastSeenAt: agg.lastSeenAt,
        sampleProjectIds: Array.from(agg.projectIds),
      });
    }

    return candidates;
  }

  private aggregate(
    observations: ObservationEntry[],
  ): Map<string, AggregatedObservation> {
    const map = new Map<string, AggregatedObservation>();

    for (const obs of observations) {
      const key = `${obs.contentHash}:${obs.kind}`;
      const existing = map.get(key);

      if (existing) {
        existing.maxConfidence = Math.max(existing.maxConfidence, obs.confidence);
        existing.sessionIds.add(obs.sessionId);
        existing.projectIds.add(obs.projectId);
        if (obs.timestamp > existing.lastSeenAt) {
          existing.lastSeenAt = obs.timestamp;
        }
        const obsStrength: SignalStrength = obs.signalStrength ?? "weak";
        const existingStrength: SignalStrength = existing.maxSignalStrength ?? "weak";
        if (SIGNAL_STRENGTH_ORDER[obsStrength] > SIGNAL_STRENGTH_ORDER[existingStrength]) {
          existing.maxSignalStrength = obsStrength;
        }
      } else {
        map.set(key, {
          contentHash: obs.contentHash,
          kind: obs.kind,
          maxConfidence: obs.confidence,
          sessionIds: new Set([obs.sessionId]),
          projectIds: new Set([obs.projectId]),
          lastSeenAt: obs.timestamp,
          maxSignalStrength: obs.signalStrength,
        });
      }
    }

    return map;
  }
}
