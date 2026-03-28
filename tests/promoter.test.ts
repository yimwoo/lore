import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSharedStore } from "../src/core/file-shared-store";
import { FileApprovalStore } from "../src/promotion/approval-store";
import { Promoter } from "../src/promotion/promoter";
import { resolveConfig } from "../src/config";
import { contentHash } from "../src/shared/validators";
import type { SharedKnowledgeEntry } from "../src/shared/types";

let testDir: string;
let idCounter: number;
let timeCounter: number;

const makeTimestamp = () =>
  `2026-01-01T00:00:${String(timeCounter++).padStart(2, "0")}Z`;

const setup = () => {
  const sharedStore = new FileSharedStore({
    storagePath: join(testDir, "shared.json"),
    now: makeTimestamp,
    createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
  });

  const approvalStore = new FileApprovalStore({
    ledgerPath: join(testDir, "ledger.json"),
    sharedStore,
    now: makeTimestamp,
    createId: () => `ledger-${String(idCounter++).padStart(4, "0")}`,
  });

  const config = resolveConfig();
  const promoter = new Promoter({
    sharedStore,
    approvalStore,
    policy: config.promotionPolicy,
    now: makeTimestamp,
    createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
  });

  return { sharedStore, approvalStore, promoter };
};

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-promoter-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
  idCounter = 1;
  timeCounter = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("Promoter.promoteExplicit", () => {
  it("creates entry with correct fields", async () => {
    const { promoter, sharedStore } = setup();

    const result = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Use snake_case",
      content: "All DB columns must use snake_case",
      tags: ["naming"],
      sourceProjectId: "proj-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("created");
      expect(result.entry.approvalStatus).toBe("approved");
      expect(result.entry.promotionSource).toBe("explicit");
      expect(result.entry.createdBy).toBe("user");
      expect(result.entry.confidence).toBe(1.0);
    }

    const entries = await sharedStore.list();
    expect(entries).toHaveLength(1);
  });

  it("writes ledger entry on promote", async () => {
    const { promoter, approvalStore } = setup();

    await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Use snake_case",
      content: "All DB columns must use snake_case",
    });

    const ledger = await approvalStore.readAll();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.action).toBe("promote");
    expect(ledger[0]!.actor).toBe("user");
    expect(ledger[0]!.actionSource).toBe("explicit");
  });

  it("rejects forbidden content", async () => {
    const { promoter } = setup();

    const result = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Bad rule",
      content: "/src/foo.ts should be refactored",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("forbidden pattern");
    }
  });

  it("rejects forbidden title", async () => {
    const { promoter } = setup();

    const result = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "/src/config.ts",
      content: "Valid content here",
    });

    expect(result.ok).toBe(false);
  });

  it("dedup merges provenance on matching contentHash+kind", async () => {
    const { promoter, sharedStore } = setup();

    await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Rule A",
      content: "Shared content",
      tags: ["tag-a"],
      sourceProjectId: "proj-1",
    });

    const result = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Rule A duplicate",
      content: "Shared content",
      tags: ["tag-b"],
      sourceProjectId: "proj-2",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("merged");
      expect(result.entry.sourceProjectIds).toContain("proj-1");
      expect(result.entry.sourceProjectIds).toContain("proj-2");
      expect(result.entry.tags).toContain("tag-a");
      expect(result.entry.tags).toContain("tag-b");
    }

    const entries = await sharedStore.list();
    expect(entries).toHaveLength(1);
  });

  it("creates new entry when existing is demoted (no resurrection)", async () => {
    const { promoter, sharedStore } = setup();

    const first = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Rule",
      content: "Content to demote",
    });
    expect(first.ok).toBe(true);

    if (first.ok) {
      await promoter.demote(first.entry.id, "outdated");
    }

    const second = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Rule revived",
      content: "Content to demote",
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.action).toBe("created");
      expect(second.entry.id).not.toBe(first.ok ? first.entry.id : "");
    }

    // Should have 2 entries total (one demoted, one approved)
    const allEntries = await sharedStore.list({ approvalStatus: "approved" });
    expect(allEntries).toHaveLength(1);
  });

  it("upgrades pending entry to approved", async () => {
    const { promoter, sharedStore } = setup();

    // Manually create a pending entry
    const pendingEntry: SharedKnowledgeEntry = {
      id: "sk-pending-1",
      kind: "domain_rule",
      title: "Pending rule",
      content: "Pending content",
      confidence: 0.85,
      tags: ["pending-tag"],
      sourceProjectIds: ["proj-1"],
      sourceMemoryIds: [],
      promotionSource: "suggested",
      createdBy: "system",
      approvalStatus: "pending",
      sessionCount: 3,
      projectCount: 1,
      lastSeenAt: "2026-01-01T00:00:00Z",
      contentHash: contentHash("Pending content"),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await sharedStore.save(pendingEntry);

    const result = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Pending rule",
      content: "Pending content",
      sourceProjectId: "proj-2",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("upgraded");
      expect(result.entry.approvalStatus).toBe("approved");
    }
  });

  it("rejects empty title", async () => {
    const { promoter } = setup();
    const result = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "",
      content: "Valid content",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects empty content", async () => {
    const { promoter } = setup();
    const result = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Valid title",
      content: "",
    });
    expect(result.ok).toBe(false);
  });
});

describe("Promoter.demote", () => {
  it("sets status to demoted and writes ledger", async () => {
    const { promoter, approvalStore } = setup();

    const promoted = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Rule to demote",
      content: "Content to demote later",
    });
    expect(promoted.ok).toBe(true);

    const id = promoted.ok ? promoted.entry.id : "";
    const result = await promoter.demote(id, "outdated");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.approvalStatus).toBe("demoted");
      expect(result.entry.statusReason).toBe("outdated");
    }

    const ledger = await approvalStore.readAll();
    const demoteEntry = ledger.find((e) => e.action === "demote");
    expect(demoteEntry).toBeTruthy();
    expect(demoteEntry!.reason).toBe("outdated");
  });

  it("rejects already-demoted entry", async () => {
    const { promoter } = setup();

    const promoted = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Rule",
      content: "Content for double demote",
    });
    expect(promoted.ok).toBe(true);

    const id = promoted.ok ? promoted.entry.id : "";
    await promoter.demote(id, "first demote");
    const result = await promoter.demote(id, "second demote");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Invalid state transition");
    }
  });

  it("rejects non-existent entry", async () => {
    const { promoter } = setup();
    const result = await promoter.demote("nonexistent", "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not found");
    }
  });
});

describe("Promoter.approve", () => {
  const createPending = async (sharedStore: FileSharedStore) => {
    const entry: SharedKnowledgeEntry = {
      id: "sk-pending-approve",
      kind: "domain_rule",
      title: "Pending for approval",
      content: "Content awaiting approval",
      confidence: 0.9,
      tags: [],
      sourceProjectIds: ["proj-1"],
      sourceMemoryIds: [],
      promotionSource: "suggested",
      createdBy: "system",
      approvalStatus: "pending",
      sessionCount: 3,
      projectCount: 1,
      lastSeenAt: "2026-01-01T00:00:00Z",
      contentHash: contentHash("Content awaiting approval"),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await sharedStore.save(entry);
    return entry;
  };

  it("approves pending entry", async () => {
    const { promoter, sharedStore } = setup();
    await createPending(sharedStore);

    const result = await promoter.approve("sk-pending-approve", "confirmed");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.approvalStatus).toBe("approved");
    }
  });

  it("writes ledger entry", async () => {
    const { promoter, sharedStore, approvalStore } = setup();
    await createPending(sharedStore);

    await promoter.approve("sk-pending-approve");
    const ledger = await approvalStore.readAll();
    const approveEntry = ledger.find((e) => e.action === "approve");
    expect(approveEntry).toBeTruthy();
  });

  it("rejects non-pending entry", async () => {
    const { promoter } = setup();
    const promoted = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Already approved",
      content: "Content already approved",
    });
    expect(promoted.ok).toBe(true);

    const result = await promoter.approve(
      promoted.ok ? promoted.entry.id : "",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects nonexistent entry", async () => {
    const { promoter } = setup();
    const result = await promoter.approve("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not found");
  });
});

describe("Promoter.reject", () => {
  const createPending = async (sharedStore: FileSharedStore) => {
    const entry: SharedKnowledgeEntry = {
      id: "sk-pending-reject",
      kind: "domain_rule",
      title: "Pending for rejection",
      content: "Content to reject",
      confidence: 0.9,
      tags: [],
      sourceProjectIds: ["proj-1"],
      sourceMemoryIds: [],
      promotionSource: "suggested",
      createdBy: "system",
      approvalStatus: "pending",
      sessionCount: 3,
      projectCount: 1,
      lastSeenAt: "2026-01-01T00:00:00Z",
      contentHash: contentHash("Content to reject"),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await sharedStore.save(entry);
    return entry;
  };

  it("rejects pending entry with reason", async () => {
    const { promoter, sharedStore } = setup();
    await createPending(sharedStore);

    const result = await promoter.reject("sk-pending-reject", "too specific");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.approvalStatus).toBe("rejected");
      expect(result.entry.statusReason).toBe("too specific");
    }
  });

  it("writes ledger entry", async () => {
    const { promoter, sharedStore, approvalStore } = setup();
    await createPending(sharedStore);

    await promoter.reject("sk-pending-reject", "not useful");
    const ledger = await approvalStore.readAll();
    const rejectEntry = ledger.find((e) => e.action === "reject");
    expect(rejectEntry).toBeTruthy();
    expect(rejectEntry!.reason).toBe("not useful");
  });

  it("rejects non-pending entry", async () => {
    const { promoter } = setup();
    const promoted = await promoter.promoteExplicit({
      kind: "domain_rule",
      title: "Approved",
      content: "Cannot reject approved",
    });
    expect(promoted.ok).toBe(true);

    const result = await promoter.reject(
      promoted.ok ? promoted.entry.id : "",
      "reason",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects nonexistent entry", async () => {
    const { promoter } = setup();
    const result = await promoter.reject("nonexistent", "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not found");
  });
});
