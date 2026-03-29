import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileConflictStore } from "../src/promotion/conflict-store";

let testDir: string;
let idCounter: number;
let timeCounter: number;

const makeTimestamp = (): string =>
  `2026-03-28T20:00:${String(timeCounter++).padStart(2, "0")}Z`;

const makeId = (): string => `conf-${String(idCounter++).padStart(4, "0")}`;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-conflict-store-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
  idCounter = 1;
  timeCounter = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("FileConflictStore", () => {
  it("adds a conflict record and lists it with status: open", async () => {
    const store = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: makeId,
    });

    const record = await store.add({
      entryIdA: "sk-a",
      entryIdB: "sk-b",
      conflictType: "direct_negation",
      subjectOverlap: 0.9,
      scopeOverlap: 1.0,
      suggestedWinnerId: "sk-a",
      explanation: "Direct contradiction",
    });

    expect(record.id).toBe("conf-0001");
    expect(record.status).toBe("open");
    expect(record.detectedAt).toBe("2026-03-28T20:00:00Z");

    const openConflicts = await store.list({ status: "open" });
    expect(openConflicts).toHaveLength(1);
    expect(openConflicts[0]!.entryIdA).toBe("sk-a");
  });

  it("finds a conflict by entry IDs (order-independent)", async () => {
    const store = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: makeId,
    });

    await store.add({
      entryIdA: "sk-a",
      entryIdB: "sk-b",
      conflictType: "direct_negation",
      subjectOverlap: 0.9,
      scopeOverlap: 1.0,
      suggestedWinnerId: "sk-a",
      explanation: "Direct contradiction",
    });

    const found1 = await store.findByEntryIds("sk-a", "sk-b");
    expect(found1).not.toBeNull();
    expect(found1!.entryIdA).toBe("sk-a");

    const found2 = await store.findByEntryIds("sk-b", "sk-a");
    expect(found2).not.toBeNull();
    expect(found2!.entryIdA).toBe("sk-a");
  });

  it("resolves a conflict record", async () => {
    const store = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: makeId,
    });

    const record = await store.add({
      entryIdA: "sk-a",
      entryIdB: "sk-b",
      conflictType: "direct_negation",
      subjectOverlap: 0.9,
      scopeOverlap: 1.0,
      suggestedWinnerId: "sk-a",
      explanation: "Direct contradiction",
    });

    const resolved = await store.resolve(record.id, "keep_a", "User kept sk-a");

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("keep_a");
    expect(resolved.resolvedAt).toBeDefined();
    expect(resolved.resolvedReason).toBe("User kept sk-a");

    const openConflicts = await store.list({ status: "open" });
    expect(openConflicts).toHaveLength(0);

    const resolvedConflicts = await store.list({ status: "resolved" });
    expect(resolvedConflicts).toHaveLength(1);
  });

  it("removes all conflicts involving an entry and returns the count", async () => {
    const store = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: makeId,
    });

    await store.add({
      entryIdA: "sk-a",
      entryIdB: "sk-b",
      conflictType: "direct_negation",
      subjectOverlap: 0.9,
      scopeOverlap: 1.0,
      suggestedWinnerId: null,
      explanation: "Test",
    });
    await store.add({
      entryIdA: "sk-a",
      entryIdB: "sk-c",
      conflictType: "scope_mismatch",
      subjectOverlap: 0.8,
      scopeOverlap: 0.5,
      suggestedWinnerId: null,
      explanation: "Test 2",
    });
    await store.add({
      entryIdA: "sk-d",
      entryIdB: "sk-e",
      conflictType: "ambiguous",
      subjectOverlap: 0.7,
      scopeOverlap: 0.6,
      suggestedWinnerId: null,
      explanation: "Test 3",
    });

    const removedCount = await store.removeByEntryId("sk-a");
    expect(removedCount).toBe(2);

    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.entryIdA).toBe("sk-d");
  });

  it("returns empty array when listing from a nonexistent file", async () => {
    const store = new FileConflictStore({
      storagePath: join(testDir, "nonexistent", "conflicts.json"),
      now: makeTimestamp,
      createId: makeId,
    });

    const conflicts = await store.list();
    expect(conflicts).toEqual([]);
  });

  it("does not create duplicate conflicts for the same entry pair", async () => {
    const store = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: makeId,
    });

    await store.add({
      entryIdA: "sk-a",
      entryIdB: "sk-b",
      conflictType: "direct_negation",
      subjectOverlap: 0.9,
      scopeOverlap: 1.0,
      suggestedWinnerId: "sk-a",
      explanation: "First detection",
    });

    await store.add({
      entryIdA: "sk-a",
      entryIdB: "sk-b",
      conflictType: "direct_negation",
      subjectOverlap: 0.9,
      scopeOverlap: 1.0,
      suggestedWinnerId: "sk-a",
      explanation: "Second detection",
    });

    const found = await store.list();
    const matchingPairs = found.filter(
      (c) =>
        (c.entryIdA === "sk-a" && c.entryIdB === "sk-b") ||
        (c.entryIdA === "sk-b" && c.entryIdB === "sk-a"),
    );
    expect(matchingPairs).toHaveLength(1);
  });

  it("produces deterministic IDs from injected createId", async () => {
    const store = new FileConflictStore({
      storagePath: join(testDir, "conflicts.json"),
      now: makeTimestamp,
      createId: makeId,
    });

    const record1 = await store.add({
      entryIdA: "sk-x",
      entryIdB: "sk-y",
      conflictType: "ambiguous",
      subjectOverlap: 0.6,
      scopeOverlap: 0.7,
      suggestedWinnerId: null,
      explanation: "Test",
    });

    const record2 = await store.add({
      entryIdA: "sk-p",
      entryIdB: "sk-q",
      conflictType: "scope_mismatch",
      subjectOverlap: 0.8,
      scopeOverlap: 0.3,
      suggestedWinnerId: null,
      explanation: "Test 2",
    });

    expect(record1.id).toBe("conf-0001");
    expect(record2.id).toBe("conf-0002");
  });
});
