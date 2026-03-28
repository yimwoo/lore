import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileApprovalStore } from "../src/promotion/approval-store";
import { FileSharedStore } from "../src/core/file-shared-store";
import type { SharedKnowledgeEntry } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

let testDir: string;
let sharedStorePath: string;
let ledgerPath: string;
let idCounter: number;
let timeCounter: number;

const makeTimestamp = () =>
  `2026-01-01T00:00:${String(timeCounter++).padStart(2, "0")}Z`;

const makeSharedStore = () =>
  new FileSharedStore({
    storagePath: sharedStorePath,
    now: makeTimestamp,
    createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
  });

const makeApprovalStore = (sharedStore: FileSharedStore) =>
  new FileApprovalStore({
    ledgerPath,
    sharedStore,
    now: makeTimestamp,
    createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
  });

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => ({
  id: `sk-${String(idCounter++).padStart(4, "0")}`,
  kind: "domain_rule",
  title: "Test rule",
  content: "Test content",
  confidence: 0.9,
  tags: ["test"],
  sourceProjectIds: ["proj-1"],
  sourceMemoryIds: ["mem-1"],
  promotionSource: "explicit",
  createdBy: "user",
  approvalStatus: "approved",
  approvedAt: "2026-01-01T00:00:00Z",
  sessionCount: 1,
  projectCount: 1,
  lastSeenAt: "2026-01-01T00:00:00Z",
  contentHash: contentHash("Test content"),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-approval-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  sharedStorePath = join(testDir, "shared.json");
  ledgerPath = join(testDir, "approval-ledger.json");
  await mkdir(testDir, { recursive: true });
  idCounter = 1;
  timeCounter = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("FileApprovalStore", () => {
  it("appends and reads ledger entries", async () => {
    const sharedStore = makeSharedStore();
    const store = makeApprovalStore(sharedStore);

    await store.append({
      knowledgeEntryId: "sk-0001",
      action: "promote",
      actor: "user",
      actionSource: "explicit",
    });

    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("promote");
    expect(entries[0]!.id).toBeTruthy();
    expect(entries[0]!.timestamp).toBeTruthy();
  });

  it("supports merge ledger entries", async () => {
    const sharedStore = makeSharedStore();
    const store = makeApprovalStore(sharedStore);

    await store.append({
      knowledgeEntryId: "sk-merged-1",
      action: "merge",
      actor: "system",
      reason: "merged duplicate pending entries",
    });

    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("merge");
    expect(entries[0]!.actor).toBe("system");
  });

  it("filters by knowledgeEntryId", async () => {
    const sharedStore = makeSharedStore();
    const store = makeApprovalStore(sharedStore);

    await store.append({
      knowledgeEntryId: "sk-0001",
      action: "promote",
      actor: "user",
    });
    await store.append({
      knowledgeEntryId: "sk-0002",
      action: "promote",
      actor: "user",
    });
    await store.append({
      knowledgeEntryId: "sk-0001",
      action: "demote",
      actor: "user",
      reason: "outdated",
    });

    const entries = await store.list("sk-0001");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.action).toBe("promote");
    expect(entries[1]!.action).toBe("demote");
  });

  it("persists across instances", async () => {
    const sharedStore = makeSharedStore();
    const store1 = makeApprovalStore(sharedStore);

    await store1.append({
      knowledgeEntryId: "sk-0001",
      action: "promote",
      actor: "user",
    });

    const store2 = makeApprovalStore(sharedStore);
    const entries = await store2.readAll();
    expect(entries).toHaveLength(1);
  });

  it("is append-only", async () => {
    const sharedStore = makeSharedStore();
    const store = makeApprovalStore(sharedStore);

    await store.append({
      knowledgeEntryId: "sk-0001",
      action: "promote",
      actor: "user",
    });
    await store.append({
      knowledgeEntryId: "sk-0002",
      action: "promote",
      actor: "user",
    });

    const entries = await store.readAll();
    expect(entries).toHaveLength(2);
    // First entry is still first
    expect(entries[0]!.knowledgeEntryId).toBe("sk-0001");
    expect(entries[1]!.knowledgeEntryId).toBe("sk-0002");
  });
});

describe("FileApprovalStore reconciliation", () => {
  it("replays demote from ledger when shared store is inconsistent", async () => {
    const sharedStore = makeSharedStore();
    const entry = makeEntry({ id: "sk-recon-1" });
    await sharedStore.save(entry);

    // Write a demote ledger entry directly (simulating crash after ledger write)
    const ledgerEntries = [
      {
        id: "ledger-crash-1",
        knowledgeEntryId: "sk-recon-1",
        action: "demote" as const,
        actor: "user" as const,
        reason: "outdated",
        timestamp: "2026-01-01T00:01:00Z",
      },
    ];
    await mkdir(testDir, { recursive: true });
    await writeFile(ledgerPath, JSON.stringify(ledgerEntries, null, 2), "utf8");

    // Create new store — reconciliation should replay the demote
    const store2 = makeApprovalStore(sharedStore);
    await store2.reconcile();

    const updated = await sharedStore.getById("sk-recon-1");
    expect(updated!.approvalStatus).toBe("demoted");
  });

  it("reconciliation is idempotent", async () => {
    const sharedStore = makeSharedStore();
    const entry = makeEntry({ id: "sk-idem-1" });
    await sharedStore.save(entry);

    // Demote the entry normally
    await sharedStore.update("sk-idem-1", {
      approvalStatus: "demoted",
      demotedAt: "2026-01-01T00:01:00Z",
    });

    // Write ledger entry for same demote
    const ledgerEntries = [
      {
        id: "ledger-idem-1",
        knowledgeEntryId: "sk-idem-1",
        action: "demote" as const,
        actor: "user" as const,
        timestamp: "2026-01-01T00:01:00Z",
      },
    ];
    await writeFile(ledgerPath, JSON.stringify(ledgerEntries, null, 2), "utf8");

    // Reconciliation should be a no-op
    const store = makeApprovalStore(sharedStore);
    await store.reconcile();

    const entry2 = await sharedStore.getById("sk-idem-1");
    expect(entry2!.approvalStatus).toBe("demoted");
  });
});
