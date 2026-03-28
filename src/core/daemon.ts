import { normalizeSessionEvent } from "../bridge/events";
import type { RawSessionEvent } from "../bridge/events";
import { buildPreTurnHint } from "./hint-engine";
import { extractMemoryCandidates } from "./candidate-extractor";
import { FileMemoryStore } from "./memory-store";
import type { ObservationLogWriter } from "../promotion/observation-log";
import { contentHash } from "../shared/validators";
import type { SharedKnowledgeStore } from "./shared-store";
import type { Hint, SessionEvent, SharedKnowledgeEntry, SidecarActivity } from "../shared/types";

type LoreDaemonOptions = {
  projectId: string;
  memoryStore: FileMemoryStore;
  sessionId?: string;
  observationWriter?: ObservationLogWriter;
  sharedStore?: SharedKnowledgeStore;
  injectedContentHashes?: string[];
  now?: () => string;
  createEventId?: () => string;
};

export type LoreSnapshot = {
  events: SessionEvent[];
  memories: Awaited<ReturnType<FileMemoryStore["listByProject"]>>;
  latestHint: Hint | null;
  activity: SidecarActivity[];
};

export class LoreDaemon {
  private readonly projectId: string;
  private readonly memoryStore: FileMemoryStore;
  private readonly sessionId?: string;
  private readonly observationWriter?: ObservationLogWriter;
  private readonly sharedStore?: SharedKnowledgeStore;
  private readonly injectedContentHashes: string[];
  private readonly now: () => string;
  private readonly createEventId?: () => string;
  private readonly events: SessionEvent[] = [];
  private readonly activity: SidecarActivity[] = [];
  private latestHint: Hint | null = null;

  constructor(options: LoreDaemonOptions) {
    this.projectId = options.projectId;
    this.memoryStore = options.memoryStore;
    this.sessionId = options.sessionId;
    this.observationWriter = options.observationWriter;
    this.sharedStore = options.sharedStore;
    this.injectedContentHashes = options.injectedContentHashes ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEventId = options.createEventId;
  }

  async ingest(rawEvent: RawSessionEvent): Promise<Hint | null> {
    const event = normalizeSessionEvent(rawEvent, {
      projectId: this.projectId,
      now: this.now,
      createId: this.createEventId,
    });

    this.events.push(event);
    this.activity.unshift({
      type: "event_ingested",
      eventId: event.id,
      projectId: this.projectId,
      createdAt: this.now(),
      message: event.summary,
    });

    const candidates = extractMemoryCandidates(event);

    if (this.observationWriter && this.sessionId) {
      for (const candidate of candidates) {
        await this.observationWriter.append({
          sessionId: this.sessionId,
          projectId: this.projectId,
          contentHash: contentHash(candidate.content),
          kind: candidate.kind,
          confidence: candidate.confidence,
          timestamp: this.now(),
        });
      }
    }

    const saveResult = await this.memoryStore.saveCandidates(candidates);
    for (const memory of saveResult.saved) {
      this.activity.unshift({
        type: "memory_saved",
        memoryId: memory.id,
        projectId: this.projectId,
        createdAt: this.now(),
        message: `${memory.kind}: ${memory.content}`,
      });
    }

    const memories = await this.memoryStore.listByProject(this.projectId);

    let sharedKnowledge: SharedKnowledgeEntry[] | undefined;
    if (this.sharedStore) {
      sharedKnowledge = await this.sharedStore.list({ approvalStatus: "approved" });
    }

    const nextHint = buildPreTurnHint({
      projectId: this.projectId,
      recentEvents: this.events,
      memories,
      previousHint: this.latestHint ?? undefined,
      sharedKnowledge,
      injectedContentHashes: this.injectedContentHashes,
      now: this.now,
    });

    if (nextHint) {
      this.latestHint = {
        ...nextHint,
        promotedAt: this.now(),
      };
      this.activity.unshift({
        type: "hint_promoted",
        projectId: this.projectId,
        createdAt: this.now(),
        message: nextHint.bullets[0]?.text ?? "Hint promoted",
      });
    }

    return this.latestHint;
  }

  async getSnapshot(): Promise<LoreSnapshot> {
    return {
      events: [...this.events],
      memories: await this.memoryStore.listByProject(this.projectId),
      latestHint: this.latestHint,
      activity: [...this.activity],
    };
  }
}
