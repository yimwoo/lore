import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileSharedStore } from "../src/core/file-shared-store";
import { DraftStoreWriter, readConsolidationState } from "../src/promotion/draft-store";
import { ObservationLogWriter } from "../src/promotion/observation-log";
import { FileApprovalStore } from "../src/promotion/approval-store";
import { Consolidator } from "../src/promotion/consolidator";
import type { ConsolidationProvider } from "../src/extraction/consolidation-provider";
import { DraftStoreReader } from "../src/promotion/draft-store";
import { ObservationLogReader } from "../src/promotion/observation-log";
import type { DraftCandidate, SharedKnowledgeEntry } from "../src/shared/types";
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
});
