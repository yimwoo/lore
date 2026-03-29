import type { SharedKnowledgeStore } from "../core/shared-store";
import type { DraftStoreReader } from "./draft-store";
import {
  readConsolidationState,
  writeConsolidationState,
} from "./draft-store";
import type { ObservationLogReader } from "./observation-log";
import type { FileApprovalStore } from "./approval-store";
import type {
  ConsolidationProvider,
  ConsolidationObservation,
} from "../extraction/consolidation-provider";
import type { DraftCandidate, SharedKnowledgeEntry } from "../shared/types";
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "../shared/debug-log";

type ConsolidatorOptions = {
  draftReader: DraftStoreReader;
  observationReader: ObservationLogReader;
  sharedStore: SharedKnowledgeStore;
  approvalStore: FileApprovalStore;
  provider: ConsolidationProvider;
  statePath: string;
  now?: () => string;
};

export type ConsolidationRunResult =
  | {
      ok: true;
      processedDraftCount: number;
      savedEntryIds: string[];
      mergedEntryIds: string[];
    }
  | {
      ok: false;
      reason: string;
      processedDraftCount: number;
    };

type ObservationAggregate = {
  sessionIds: Set<string>;
  projectIds: Set<string>;
  contextKeys: Set<string>;
  confidence: number;
  lastSeenAt: string;
};

const CONVERGENCE_SESSION_THRESHOLD = 3;
const CONVERGENCE_CONTEXT_THRESHOLD = 3;
const CONVERGENCE_AUTO_APPROVAL_LIMIT = 3;

const isConvergenceEligibleKind = (
  kind: SharedKnowledgeEntry["kind"],
): boolean => kind === "domain_rule" || kind === "glossary_term";

const aggregateObservations = async (
  reader: ObservationLogReader,
): Promise<ConsolidationObservation[]> => {
  const observations = await reader.readAll();
  const aggregates = new Map<string, ObservationAggregate>();

  for (const observation of observations) {
    const current = aggregates.get(observation.contentHash);
    if (current) {
      current.sessionIds.add(observation.sessionId);
      current.projectIds.add(observation.projectId);
      if (observation.contextKey) {
        current.contextKeys.add(observation.contextKey);
      }
      current.confidence = Math.max(current.confidence, observation.confidence);
      if (observation.timestamp > current.lastSeenAt) {
        current.lastSeenAt = observation.timestamp;
      }
      continue;
    }

    aggregates.set(observation.contentHash, {
      sessionIds: new Set([observation.sessionId]),
      projectIds: new Set([observation.projectId]),
      contextKeys: new Set(
        observation.contextKey ? [observation.contextKey] : [],
      ),
      confidence: observation.confidence,
      lastSeenAt: observation.timestamp,
    });
  }

  return Array.from(aggregates.entries()).map(([contentHash, aggregate]) => ({
    contentHash,
    sessionCount: aggregate.sessionIds.size,
    projectCount: aggregate.projectIds.size,
    contextKeyCount: aggregate.contextKeys.size,
    lastSeenAt: aggregate.lastSeenAt,
    confidence: aggregate.confidence,
    sampleProjectIds: Array.from(aggregate.projectIds),
  }));
};

const reconcilePendingEntry = async (
  store: SharedKnowledgeStore,
  entry: SharedKnowledgeEntry,
): Promise<string> => {
  const existing = entry.id ? await store.getById(entry.id) : null;
  if (existing) {
    const result = await store.update(existing.id, {
      title: entry.title,
      content: entry.content,
      confidence: entry.confidence,
      tags: entry.tags,
      evidenceSummary: entry.evidenceSummary,
      contradictionCount: entry.contradictionCount,
      sourceTurnCount: entry.sourceTurnCount,
      sourceProjectIds: entry.sourceProjectIds,
      sourceMemoryIds: entry.sourceMemoryIds,
      approvalStatus: entry.approvalStatus,
      approvalSource: entry.approvalSource,
      approvedAt: entry.approvedAt,
      sessionCount: entry.sessionCount,
      projectCount: entry.projectCount,
      lastSeenAt: entry.lastSeenAt,
      contentHash: entry.contentHash,
      statusReason: entry.statusReason,
    });
    if (!result.ok) {
      throw new Error(result.reason ?? `Failed to update ${existing.id}`);
    }
    return existing.id;
  }

  const result = await store.save(entry);
  if (!result.ok || !result.saved?.[0]) {
    throw new Error(result.reason ?? "Failed to save consolidated entry");
  }
  return result.saved[0].id;
};

const appendMergeLedgerEntry = async (
  approvalStore: FileApprovalStore,
  survivorId: string,
  consumedIds: string[],
): Promise<void> => {
  if (consumedIds.length === 0) {
    return;
  }

  await approvalStore.append({
    knowledgeEntryId: survivorId,
    action: "merge",
    actor: "system",
    reason: `Merged pending duplicates into ${survivorId}.`,
    metadata: {
      survivorId,
      consumedIds,
    },
  });
};

const deleteConsumedPendingEntries = async (
  store: SharedKnowledgeStore,
  survivorId: string,
  consumedIds: string[],
): Promise<void> => {
  for (const consumedId of consumedIds) {
    if (consumedId === survivorId) {
      continue;
    }

    const result = await store.deletePending(consumedId);
    if (!result.ok && !result.reason?.includes("Entry not found")) {
      throw new Error(result.reason ?? `Failed to delete pending entry ${consumedId}`);
    }
  }
};

export class Consolidator {
  private readonly draftReader: DraftStoreReader;
  private readonly observationReader: ObservationLogReader;
  private readonly sharedStore: SharedKnowledgeStore;
  private readonly approvalStore: FileApprovalStore;
  private readonly provider: ConsolidationProvider;
  private readonly statePath: string;
  private readonly now: () => string;

  constructor(options: ConsolidatorOptions) {
    this.draftReader = options.draftReader;
    this.observationReader = options.observationReader;
    this.sharedStore = options.sharedStore;
    this.approvalStore = options.approvalStore;
    this.provider = options.provider;
    this.statePath = options.statePath;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(): Promise<ConsolidationRunResult> {
    const startedAtMs = Date.now();
    const runId = debugLoggingEnabled ? createRunId() : undefined;
    const log = (
      level: DebugLogLevel,
      event: string,
      data?: Record<string, unknown>,
      extras?: {
        ok?: boolean;
        summary?: string;
      },
    ): void => {
      if (!runId) {
        return;
      }

      dlog({
        level,
        component: "consolidator",
        event,
        hook: "Core",
        runId,
        ok: extras?.ok,
        summary: extras?.summary,
        durationMs: Date.now() - startedAtMs,
        data,
      });
    };
    const state = await readConsolidationState(this.statePath);
    const startedAt = this.now();
    log("info", "consolidation.invoked", {
      statePath: this.statePath,
    }, {
      ok: true,
      summary: "Consolidation run started.",
    });
    log("debug", "consolidation.state_loaded", {
      lastConsolidatedAt: state.lastConsolidatedAt,
      lastAttemptedAt: state.lastAttemptedAt,
      lastStatus: state.lastStatus,
    }, {
      ok: true,
    });
    await writeConsolidationState(this.statePath, {
      ...state,
      lastAttemptedAt: startedAt,
      lastStatus: "ok",
      lastError: undefined,
    });

    const drafts = await this.draftReader.readSince(state.lastConsolidatedAt);
    log("debug", "consolidation.drafts_loaded", {
      draftCount: drafts.length,
      sinceCutoff: state.lastConsolidatedAt,
    }, {
      ok: true,
    });
    if (drafts.length === 0) {
      log("debug", "consolidation.no_new_drafts", undefined, {
        ok: true,
        summary: "No new drafts were available for consolidation.",
      });
      return {
        ok: true,
        processedDraftCount: 0,
        savedEntryIds: [],
        mergedEntryIds: [],
      };
    }

    try {
      const observations = await aggregateObservations(this.observationReader);
      log("debug", "consolidation.observations_aggregated", {
        observationCount: observations.length,
      }, {
        ok: true,
      });
      const existingPendingEntries = await this.sharedStore.list({
        approvalStatus: "pending",
      });
      log("debug", "consolidation.pending_loaded", {
        pendingCount: existingPendingEntries.length,
      }, {
        ok: true,
      });
      log("debug", "consolidation.provider_started", {
        draftCount: drafts.length,
        pendingCount: existingPendingEntries.length,
      }, {
        ok: true,
      });
      const result = await this.provider.consolidate({
        drafts,
        observations,
        existingPendingEntries,
      });
      log("debug", "consolidation.provider_done", {
        entryCount: result.entries.length,
      }, {
        ok: true,
      });

      const savedEntryIds: string[] = [];
      const mergedEntryIds: string[] = [];
      let autoApprovedCount = 0;

      for (const consolidated of result.entries) {
        const observation = observations.find(
          (candidate) => candidate.contentHash === consolidated.entry.contentHash,
        );
        const shouldAutoApprove =
          consolidated.entry.approvalStatus === "pending" &&
          isConvergenceEligibleKind(consolidated.entry.kind) &&
          autoApprovedCount < CONVERGENCE_AUTO_APPROVAL_LIMIT &&
          (observation?.sessionCount ?? consolidated.entry.sessionCount) >=
            CONVERGENCE_SESSION_THRESHOLD &&
          (observation?.contextKeyCount ?? 0) >= CONVERGENCE_CONTEXT_THRESHOLD;
        const entryToSave = shouldAutoApprove
          ? {
              ...consolidated.entry,
              approvalStatus: "approved" as const,
              approvalSource: "auto:convergence" as const,
              approvedAt: this.now(),
            }
          : consolidated.entry;
        if (shouldAutoApprove) {
          autoApprovedCount += 1;
          log("debug", "consolidation.entry_auto_approved", {
            contentHash: consolidated.entry.contentHash,
            sessionCount: observation?.sessionCount ?? consolidated.entry.sessionCount,
            contextKeyCount: observation?.contextKeyCount ?? 0,
          }, {
            ok: true,
          });
        }

        const survivorId = await reconcilePendingEntry(this.sharedStore, entryToSave);
        savedEntryIds.push(survivorId);
        log("debug", "consolidation.entry_saved", {
          survivorId,
        }, {
          ok: true,
        });

        const consumedIds = consolidated.consumedEntryIds.filter((id) => id !== survivorId);
        if (consumedIds.length > 0) {
          await deleteConsumedPendingEntries(this.sharedStore, survivorId, consumedIds);
          await appendMergeLedgerEntry(this.approvalStore, survivorId, consumedIds);
          mergedEntryIds.push(...consumedIds);
          log("debug", "consolidation.entries_merged", {
            survivorId,
            consumedIds,
          }, {
            ok: true,
          });
        }
      }

      const lastConsolidatedAt = drafts.reduce(
        (latest, draft) => (draft.timestamp > latest ? draft.timestamp : latest),
        drafts[0]!.timestamp,
      );
      await writeConsolidationState(this.statePath, {
        lastAttemptedAt: startedAt,
        lastConsolidatedAt,
        lastStatus: "ok",
        lastError: undefined,
      });
      log("debug", "consolidation.state_written", {
        lastConsolidatedAt,
      }, {
        ok: true,
      });
      log("info", "consolidation.completed", {
        processedDraftCount: drafts.length,
        savedEntryIds,
        mergedEntryIds,
      }, {
        ok: true,
        summary: "Consolidation completed successfully.",
      });

      return {
        ok: true,
        processedDraftCount: drafts.length,
        savedEntryIds,
        mergedEntryIds,
      };
    } catch (error) {
      await writeConsolidationState(this.statePath, {
        ...state,
        lastAttemptedAt: startedAt,
        lastStatus: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
      log("error", "consolidation.error", {
        error: error instanceof Error ? error.message : String(error),
        processedDraftCount: drafts.length,
      }, {
        ok: false,
        summary: "Consolidation failed.",
      });
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        processedDraftCount: drafts.length,
      };
    }
  }
}
