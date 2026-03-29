import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileSharedStore } from "../src/core/file-shared-store";
import { DraftStoreWriter, readConsolidationState } from "../src/promotion/draft-store";
import { ObservationLogWriter } from "../src/promotion/observation-log";
import { FileApprovalStore } from "../src/promotion/approval-store";
import { Consolidator } from "../src/promotion/consolidator";
import { FileConflictStore } from "../src/promotion/conflict-store";
import type { ConsolidationProvider } from "../src/extraction/consolidation-provider";
import { DraftStoreReader } from "../src/promotion/draft-store";
import { ObservationLogReader } from "../src/promotion/observation-log";
import type { DraftCandidate, SharedKnowledgeEntry } from "../src/shared/types";
import { computeNormalizedHash } from "../src/shared/semantic-normalizer";
import { contentHash } from "../src/shared/validators";

let testDir: string;
let idCounter: number;
let timeCounter: number;

const makeTimestamp = (): string =>
  `2026-03-28T20:00:${String(timeCounter++).padStart(2, "0")}Z`;

const makeDraft = (overrides?: Partial<DraftCandidate>): DraftCandidate => ({
  id: `draft-${String(idCounter++).padStart(4, "0")}`,
  kind: "domain_rule",
  title: "Use snake_case for DB columns",
  content: "All database columns use snake_case naming.",
  confidence: 0.83,
  evidenceNote: "Observed after a naming correction.",
  sessionId: "session-1",
  projectId: "proj-1",
  turnIndex: 1,
  timestamp: makeTimestamp(),
  tags: ["database", "naming"],
  ...overrides,
});

const makePendingEntry = (overrides?: Partial<SharedKnowledgeEntry>): SharedKnowledgeEntry => ({
  id: `sk-${String(idCounter++).padStart(4, "0")}`,
  kind: "domain_rule",
  title: "Pending snake_case rule",
  content: "Use snake_case for columns.",
  confidence: 0.8,
  tags: ["database"],
  evidenceSummary: "Observed across 1 turn.",
  contradictionCount: 0,
  sourceTurnCount: 1,
  sourceProjectIds: ["proj-1"],
  sourceMemoryIds: [],
  promotionSource: "suggested",
  createdBy: "system",
  approvalStatus: "pending",
  sessionCount: 1,
  projectCount: 1,
  lastSeenAt: "2026-03-28T19:59:00Z",
  contentHash: contentHash("Use snake_case for columns."),
  createdAt: "2026-03-28T19:59:00Z",
  updatedAt: "2026-03-28T19:59:00Z",
  ...overrides,
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-consolidator-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
  idCounter = 1;
  timeCounter = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Consolidator", () => {
  it("updates pending entries and records merge metadata", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });
    const pendingEntry = makePendingEntry({ id: "sk-pending-1" });
    const duplicateEntry = makePendingEntry({
      id: "sk-pending-2",
      content: "All database columns use snake_case naming.",
      contentHash: contentHash("All database columns use snake_case naming."),
      title: "Duplicate pending rule",
    });
    await sharedStore.save(pendingEntry);
    await sharedStore.save(duplicateEntry);

    const draftWriter = new DraftStoreWriter({
      draftDir,
      sessionId: "session-1",
    });
    const draft = makeDraft();
    await draftWriter.append(draft);

    const observationWriter = new ObservationLogWriter({
      observationDir,
      sessionId: "session-1",
    });
    await observationWriter.append({
      sessionId: "session-1",
      projectId: "proj-1",
      contentHash: contentHash(draft.content),
      kind: "reminder",
      confidence: 0.95,
      timestamp: draft.timestamp,
    });

    const provider: ConsolidationProvider = {
      consolidate: async (input) => ({
        entries: [
          {
            entry: {
              ...duplicateEntry,
              id: "sk-pending-2",
              title: draft.title,
              content: draft.content,
              confidence: 0.93,
              tags: draft.tags,
              evidenceSummary: "Observed across 2 sessions and 1 contributing turns.",
              contradictionCount: 0,
              sourceTurnCount: 1,
              sessionCount: 2,
              projectCount: 1,
              lastSeenAt: draft.timestamp,
              contentHash: contentHash(draft.content),
              updatedAt: draft.timestamp,
            },
            consumedEntryIds: ["sk-pending-1"],
          },
        ],
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();

    expect(result.ok).toBe(true);
    const pendingEntries = await sharedStore.list({ approvalStatus: "pending" });
    expect(pendingEntries).toHaveLength(1);
    expect(pendingEntries[0]!.id).toBe("sk-pending-2");
    expect(pendingEntries[0]!.title).toBe("Use snake_case for DB columns");

    const ledger = await approvalStore.readAll();
    expect(ledger).toEqual([
      expect.objectContaining({
        action: "merge",
        actor: "system",
        knowledgeEntryId: "sk-pending-2",
        metadata: {
          survivorId: "sk-pending-2",
          consumedIds: ["sk-pending-1"],
        },
      }),
    ]);

    const state = await readConsolidationState(join(testDir, "consolidation-state.json"));
    expect(state.lastStatus).toBe("ok");
    expect(state.lastConsolidatedAt).toBe(draft.timestamp);
  });

  it("does not advance the watermark when consolidation fails", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
    });

    await new DraftStoreWriter({
      draftDir,
      sessionId: "session-1",
    }).append(makeDraft());

    const provider: ConsolidationProvider = {
      consolidate: async () => {
        throw new Error("provider unavailable");
      },
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();

    expect(result.ok).toBe(false);
    const state = await readConsolidationState(join(testDir, "consolidation-state.json"));
    expect(state.lastStatus).toBe("error");
    expect(state.lastConsolidatedAt).toBeUndefined();
  });

  it("emits structured consolidator trace events when debug logging is enabled", async () => {
    vi.resetModules();
    vi.stubEnv("LORE_DEBUG", "trace");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    await new DraftStoreWriter({
      draftDir,
      sessionId: "session-1",
    }).append(makeDraft());

    const provider: ConsolidationProvider = {
      consolidate: async (input) => ({
        entries: input.drafts.map((draft) => ({
          entry: makePendingEntry({
            id: "",
            title: draft.title,
            content: draft.content,
            contentHash: contentHash(draft.content),
          }),
          consumedEntryIds: [],
        })),
      }),
    };

    const { Consolidator: ConsolidatorWithLogging } = await import("../src/promotion/consolidator");
    const consolidator = new ConsolidatorWithLogging({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    stderrSpy.mockRestore();

    expect(result.ok).toBe(true);
    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
    expect(lines.some((line) => line.event === "consolidation.invoked")).toBe(true);
    expect(lines.some((line) => line.event === "consolidation.drafts_loaded")).toBe(true);
    expect(lines.some((line) => line.event === "consolidation.entry_saved")).toBe(true);
    expect(lines.some((line) => line.event === "consolidation.completed")).toBe(true);
  });

  it("emits consolidation provider fallback trace events", async () => {
    vi.resetModules();
    vi.stubEnv("LORE_DEBUG", "trace");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const { CodexConsolidationProvider: ProviderWithLogging } = await import(
      "../src/extraction/codex-consolidation-provider"
    );
    const provider = new ProviderWithLogging();
    const result = await provider.consolidate({
      drafts: [makeDraft()],
      observations: [],
      existingPendingEntries: [],
    });
    stderrSpy.mockRestore();

    expect(result.entries).toHaveLength(1);
    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
    expect(lines.some((line) => line.event === "consolidation_provider.config_loaded")).toBe(true);
    expect(lines.some((line) => line.event === "consolidation_provider.fallback_used")).toBe(true);
  });

  it("auto-approves low-risk entries when observations converge across sessions and contexts", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    const draft = makeDraft();
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    const observationWriter = new ObservationLogWriter({
      observationDir,
      sessionId: "session-1",
    });
    for (const [sessionId, contextKey] of [
      ["session-1", "file:db/migrations"],
      ["session-2", "tool:psql"],
      ["session-3", "prompt:database-naming"],
    ] as const) {
      await observationWriter.append({
        sessionId,
        projectId: "proj-1",
        contentHash: contentHash(draft.content),
        kind: "reminder",
        confidence: 0.95,
        timestamp: draft.timestamp,
        contextKey,
      });
    }

    const provider: ConsolidationProvider = {
      consolidate: async () => ({
        entries: [
          {
            entry: makePendingEntry({
              id: "",
              kind: "domain_rule",
              title: draft.title,
              content: draft.content,
              contentHash: contentHash(draft.content),
              sessionCount: 3,
            }),
            consumedEntryIds: [],
          },
        ],
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);

    const approved = await sharedStore.list({ approvalStatus: "approved" });
    expect(approved).toHaveLength(1);
    expect(approved[0]!.approvalSource).toBe("auto:convergence");
  });

  it("caps convergence auto-approval at three entries per run", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });
    const observationWriter = new ObservationLogWriter({
      observationDir,
      sessionId: "session-1",
    });

    const drafts = Array.from({ length: 4 }, (_, index) =>
      makeDraft({
        id: `draft-cap-${index}`,
        title: `Rule ${index}`,
        content: `Converged rule ${index}`,
        sessionId: `session-${index + 1}`,
      }),
    );
    for (const draft of drafts) {
      await new DraftStoreWriter({ draftDir, sessionId: draft.sessionId }).append(draft);
      for (const [sessionId, contextKey] of [
        [`${draft.sessionId}-a`, "file:ctx-a"],
        [`${draft.sessionId}-b`, "tool:ctx-b"],
        [`${draft.sessionId}-c`, "prompt:ctx-c"],
      ] as const) {
        await observationWriter.append({
          sessionId,
          projectId: "proj-1",
          contentHash: contentHash(draft.content),
          kind: "reminder",
          confidence: 0.95,
          timestamp: draft.timestamp,
          contextKey,
        });
      }
    }

    const provider: ConsolidationProvider = {
      consolidate: async () => ({
        entries: drafts.map((draft) => ({
          entry: makePendingEntry({
            id: "",
            kind: "domain_rule",
            title: draft.title,
            content: draft.content,
            contentHash: contentHash(draft.content),
            sessionCount: 3,
          }),
          consumedEntryIds: [],
        })),
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);

    const approved = await sharedStore.list({ approvalStatus: "approved" });
    const pending = await sharedStore.list({ approvalStatus: "pending" });
    expect(approved).toHaveLength(3);
    expect(pending).toHaveLength(1);
  });
});

describe("conflict detection post-step", () => {
  it("detects a conflict between a new entry and an existing approved entry", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });
    const conflictStore = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: () => `conf-${String(idCounter++).padStart(4, "0")}`,
    });

    // Pre-existing approved entry
    const existingEntry = makePendingEntry({
      id: "sk-existing",
      content: "Always use snake_case for DB columns",
      contentHash: contentHash("Always use snake_case for DB columns"),
      approvalStatus: "approved",
      approvedAt: "2026-03-28T19:00:00Z",
    });
    await sharedStore.save(existingEntry);

    // Draft that will be consolidated into a contradictory approved entry
    const draft = makeDraft({
      content: "Never use snake_case for DB columns",
      title: "Contradictory rule",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    const observationWriter = new ObservationLogWriter({
      observationDir,
      sessionId: "session-1",
    });
    for (const [sessionId, contextKey] of [
      ["session-1", "file:db/schema"],
      ["session-2", "tool:psql"],
      ["session-3", "prompt:naming"],
    ] as const) {
      await observationWriter.append({
        sessionId,
        projectId: "proj-1",
        contentHash: contentHash(draft.content),
        kind: "reminder",
        confidence: 0.95,
        timestamp: draft.timestamp,
        contextKey,
      });
    }

    const provider: ConsolidationProvider = {
      consolidate: async () => ({
        entries: [
          {
            entry: makePendingEntry({
              id: "",
              kind: "domain_rule",
              title: draft.title,
              content: draft.content,
              contentHash: contentHash(draft.content),
              approvalStatus: "approved",
              approvalSource: "auto:convergence",
              approvedAt: makeTimestamp(),
              sessionCount: 3,
            }),
            consumedEntryIds: [],
          },
        ],
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      conflictStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);

    const conflicts = await conflictStore.list({ status: "open" });
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    const conflict = conflicts[0]!;
    expect(conflict.conflictType).toBe("direct_negation");
  });

  it("updates contradictionCount on both entries when conflict detected", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });
    const conflictStore = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: () => `conf-${String(idCounter++).padStart(4, "0")}`,
    });

    const existingEntry = makePendingEntry({
      id: "sk-exist",
      content: "Always use snake_case for DB columns",
      contentHash: contentHash("Always use snake_case for DB columns"),
      approvalStatus: "approved",
      contradictionCount: 0,
    });
    await sharedStore.save(existingEntry);

    const draft = makeDraft({
      content: "Never use snake_case for DB columns",
      title: "Contradictory rule",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    const provider: ConsolidationProvider = {
      consolidate: async () => ({
        entries: [
          {
            entry: makePendingEntry({
              id: "",
              kind: "domain_rule",
              title: draft.title,
              content: draft.content,
              contentHash: contentHash(draft.content),
              approvalStatus: "approved",
              contradictionCount: 0,
              sessionCount: 1,
            }),
            consumedEntryIds: [],
          },
        ],
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      conflictStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    await consolidator.run();

    const existing = await sharedStore.getById("sk-exist");
    expect(existing!.contradictionCount).toBe(1);

    // The new entry also has its contradictionCount incremented
    const allApproved = await sharedStore.list({ approvalStatus: "approved" });
    const newEntry = allApproved.find((e) => e.id !== "sk-exist");
    expect(newEntry!.contradictionCount).toBe(1);
  });

  it("skips specialization conflicts (disjoint scopes)", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });
    const conflictStore = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: () => `conf-${String(idCounter++).padStart(4, "0")}`,
    });

    // Existing entry with DB scope
    const existingEntry = makePendingEntry({
      id: "sk-db",
      content: "Use snake_case for DB columns",
      contentHash: contentHash("Use snake_case for DB columns"),
      approvalStatus: "approved",
    });
    await sharedStore.save(existingEntry);

    // New entry with API scope -- disjoint from DB scope
    const draft = makeDraft({
      content: "Never use snake_case for API fields",
      title: "API rule",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    const provider: ConsolidationProvider = {
      consolidate: async () => ({
        entries: [
          {
            entry: makePendingEntry({
              id: "",
              kind: "domain_rule",
              title: draft.title,
              content: draft.content,
              contentHash: contentHash(draft.content),
              approvalStatus: "approved",
              sessionCount: 1,
            }),
            consumedEntryIds: [],
          },
        ],
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      conflictStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    await consolidator.run();

    const conflicts = await conflictStore.list();
    expect(conflicts).toHaveLength(0);
  });

  it("does not create duplicate conflicts on re-consolidation", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });
    const conflictStore = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: () => `conf-${String(idCounter++).padStart(4, "0")}`,
    });

    const existingEntry = makePendingEntry({
      id: "sk-old",
      content: "Always use snake_case for DB columns",
      contentHash: contentHash("Always use snake_case for DB columns"),
      approvalStatus: "approved",
    });
    await sharedStore.save(existingEntry);

    const newEntry = makePendingEntry({
      id: "sk-new",
      content: "Never use snake_case for DB columns",
      contentHash: contentHash("Never use snake_case for DB columns"),
      approvalStatus: "approved",
    });
    await sharedStore.save(newEntry);

    // Pre-existing conflict
    await conflictStore.add({
      entryIdA: "sk-new",
      entryIdB: "sk-old",
      conflictType: "direct_negation",
      subjectOverlap: 1.0,
      scopeOverlap: 1.0,
      suggestedWinnerId: "sk-new",
      explanation: "Already detected",
    });

    const draft = makeDraft({
      content: "Never use snake_case for DB columns",
      title: "Same contradictory rule again",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-2" }).append(draft);

    const provider: ConsolidationProvider = {
      consolidate: async () => ({
        entries: [
          {
            entry: {
              ...newEntry,
              updatedAt: makeTimestamp(),
            },
            consumedEntryIds: [],
          },
        ],
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      conflictStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    await consolidator.run();

    const conflicts = await conflictStore.list();
    const matchingPairs = conflicts.filter(
      (c) =>
        (c.entryIdA === "sk-new" && c.entryIdB === "sk-old") ||
        (c.entryIdA === "sk-old" && c.entryIdB === "sk-new"),
    );
    expect(matchingPairs).toHaveLength(1);
  });

  it("skips different kinds", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });
    const conflictStore = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: () => `conf-${String(idCounter++).padStart(4, "0")}`,
    });

    const existingEntry = makePendingEntry({
      id: "sk-rule",
      kind: "glossary_term",
      content: "Always use snake_case for DB columns",
      contentHash: contentHash("Always use snake_case for DB columns"),
      approvalStatus: "approved",
    });
    await sharedStore.save(existingEntry);

    const draft = makeDraft({
      kind: "domain_rule",
      content: "Never use snake_case for DB columns",
      title: "Different kind",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    const provider: ConsolidationProvider = {
      consolidate: async () => ({
        entries: [
          {
            entry: makePendingEntry({
              id: "",
              kind: "domain_rule",
              title: draft.title,
              content: draft.content,
              contentHash: contentHash(draft.content),
              approvalStatus: "approved",
              sessionCount: 1,
            }),
            consumedEntryIds: [],
          },
        ],
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      conflictStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    await consolidator.run();

    const conflicts = await conflictStore.list();
    expect(conflicts).toHaveLength(0);
  });
});
describe("semantic dedup pre-step", () => {
  it("filters exact normalized duplicate of existing approved entry", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    // Create an existing approved entry
    const existingEntry = makePendingEntry({
      id: "sk-approved-1",
      content: "Always use snake_case for columns",
      contentHash: contentHash("Always use snake_case for columns"),
      approvalStatus: "approved",
      approvedAt: "2026-03-28T19:00:00Z",
    });
    await sharedStore.save(existingEntry);

    // Create a draft with semantically equivalent content (different imperative verb)
    const draft = makeDraft({
      content: "Must use snake_case for columns",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    let providerCalledWithDrafts: DraftCandidate[] = [];
    const provider: ConsolidationProvider = {
      consolidate: async (input) => {
        providerCalledWithDrafts = input.drafts;
        return { entries: [] };
      },
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mergedEntryIds).toContain(draft.id);
      // Provider should not be called since all drafts were deduped
      expect(providerCalledWithDrafts).toHaveLength(0);
    }
  });

  it("passes candidate pairs to provider for Jaccard >= 0.65 matches", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    // Create an existing approved entry
    const existingEntry = makePendingEntry({
      id: "sk-approved-1",
      content: "enable strict typescript eslint prettier",
      contentHash: contentHash("enable strict typescript eslint prettier"),
      approvalStatus: "approved",
      approvedAt: "2026-03-28T19:00:00Z",
    });
    await sharedStore.save(existingEntry);

    // Draft with candidate-level similarity (4/6 Jaccard)
    const draft = makeDraft({
      content: "enable strict typescript eslint linting",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    let receivedCandidatePairs: Array<{ draftId: string; existingEntryId: string; similarity: number }> = [];
    const provider: ConsolidationProvider = {
      consolidate: async (input) => {
        receivedCandidatePairs = input.candidatePairs ?? [];
        return {
          entries: input.drafts.map((d) => ({
            entry: makePendingEntry({
              id: "",
              title: d.title,
              content: d.content,
              contentHash: contentHash(d.content),
            }),
            consumedEntryIds: [],
          })),
        };
      },
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);
    expect(receivedCandidatePairs).toHaveLength(1);
    expect(receivedCandidatePairs[0]!.draftId).toBe(draft.id);
    expect(receivedCandidatePairs[0]!.existingEntryId).toBe("sk-approved-1");
    expect(receivedCandidatePairs[0]!.similarity).toBeGreaterThanOrEqual(0.65);
  });

  it("returns early without calling provider when all drafts are duplicates", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    const existingEntry = makePendingEntry({
      id: "sk-approved-1",
      content: "Always use snake_case for columns",
      contentHash: contentHash("Always use snake_case for columns"),
      approvalStatus: "approved",
    });
    await sharedStore.save(existingEntry);

    const draft1 = makeDraft({
      id: "draft-dup-1",
      content: "Must use snake_case for columns",
    });
    const draft2 = makeDraft({
      id: "draft-dup-2",
      content: "Should use snake_case for columns",
    });
    const draftWriter = new DraftStoreWriter({ draftDir, sessionId: "session-1" });
    await draftWriter.append(draft1);
    await draftWriter.append(draft2);

    let providerCalled = false;
    const provider: ConsolidationProvider = {
      consolidate: async () => {
        providerCalled = true;
        return { entries: [] };
      },
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedEntryIds).toHaveLength(0);
      expect(result.mergedEntryIds).toContain("draft-dup-1");
      expect(result.mergedEntryIds).toContain("draft-dup-2");
    }
    expect(providerCalled).toBe(false);
  });

  it("passes only unique drafts to provider in a mixed batch", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    const existingEntry = makePendingEntry({
      id: "sk-approved-1",
      content: "Always use snake_case for columns",
      contentHash: contentHash("Always use snake_case for columns"),
      approvalStatus: "approved",
    });
    await sharedStore.save(existingEntry);

    const dupDraft = makeDraft({
      id: "draft-dup",
      content: "Must use snake_case for columns",
    });
    const uniqueDraft = makeDraft({
      id: "draft-unique",
      content: "Enable connection pooling for PostgreSQL production databases",
    });
    const draftWriter = new DraftStoreWriter({ draftDir, sessionId: "session-1" });
    await draftWriter.append(dupDraft);
    await draftWriter.append(uniqueDraft);

    let providerDrafts: DraftCandidate[] = [];
    const provider: ConsolidationProvider = {
      consolidate: async (input) => {
        providerDrafts = input.drafts;
        return {
          entries: input.drafts.map((d) => ({
            entry: makePendingEntry({
              id: "",
              title: d.title,
              content: d.content,
              contentHash: contentHash(d.content),
            }),
            consumedEntryIds: [],
          })),
        };
      },
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);
    expect(providerDrafts).toHaveLength(1);
    expect(providerDrafts[0]!.id).toBe("draft-unique");
    if (result.ok) {
      expect(result.mergedEntryIds).toContain("draft-dup");
    }
  });

  it("deduplicates intra-batch drafts with the same normalized hash", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    // Two drafts with same normalized hash, no existing entries
    const draft1 = makeDraft({
      id: "draft-intra-1",
      content: "Always use snake_case for columns",
    });
    const draft2 = makeDraft({
      id: "draft-intra-2",
      content: "Must use snake_case for columns",
    });
    const draftWriter = new DraftStoreWriter({ draftDir, sessionId: "session-1" });
    await draftWriter.append(draft1);
    await draftWriter.append(draft2);

    let providerDrafts: DraftCandidate[] = [];
    const provider: ConsolidationProvider = {
      consolidate: async (input) => {
        providerDrafts = input.drafts;
        return {
          entries: input.drafts.map((d) => ({
            entry: makePendingEntry({
              id: "",
              title: d.title,
              content: d.content,
              contentHash: contentHash(d.content),
            }),
            consumedEntryIds: [],
          })),
        };
      },
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);
    // Only the first draft should survive
    expect(providerDrafts).toHaveLength(1);
    expect(providerDrafts[0]!.id).toBe("draft-intra-1");
    if (result.ok) {
      expect(result.mergedEntryIds).toContain("draft-intra-2");
    }
  });

  it("stores normalizedHash on saved entries", async () => {
    const draftDir = join(testDir, "drafts");
    const observationDir = join(testDir, "observations");
    const sharedStore = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: makeTimestamp,
      createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(testDir, "approval-ledger.json"),
      sharedStore,
      now: makeTimestamp,
      createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
    });

    const draft = makeDraft({
      content: "Enable connection pooling for PostgreSQL databases",
    });
    await new DraftStoreWriter({ draftDir, sessionId: "session-1" }).append(draft);

    const provider: ConsolidationProvider = {
      consolidate: async (input) => ({
        entries: input.drafts.map((d) => ({
          entry: makePendingEntry({
            id: "",
            title: d.title,
            content: d.content,
            contentHash: contentHash(d.content),
          }),
          consumedEntryIds: [],
        })),
      }),
    };

    const consolidator = new Consolidator({
      draftReader: new DraftStoreReader({ draftDir }),
      observationReader: new ObservationLogReader({ observationDir }),
      sharedStore,
      approvalStore,
      provider,
      statePath: join(testDir, "consolidation-state.json"),
      now: makeTimestamp,
    });

    const result = await consolidator.run();
    expect(result.ok).toBe(true);

    const entries = await sharedStore.list({ approvalStatus: "pending" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.normalizedHash).toBe(
      computeNormalizedHash(draft.content),
    );
  });
});
