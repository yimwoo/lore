import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSharedStore } from "../src/core/file-shared-store";
import type { SharedKnowledgeEntry } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

let testDir: string;
let idCounter: number;
let timeCounter: number;

const makeStore = () =>
  new FileSharedStore({
    storagePath: join(testDir, "shared.json"),
    now: () => `2026-01-01T00:00:${String(timeCounter++).padStart(2, "0")}Z`,
    createId: () => `sk-${String(idCounter++).padStart(4, "0")}`,
  });

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => ({
  id: "",
  kind: "domain_rule",
  title: "Test rule",
  content: "Test content for rule",
  confidence: 0.9,
  tags: ["test"],
  sourceProjectIds: ["proj-1"],
  sourceMemoryIds: ["mem-1"],
  promotionSource: "explicit",
  createdBy: "user",
  approvalStatus: "approved",
  statusReason: undefined,
  approvedAt: "2026-01-01T00:00:00Z",
  rejectedAt: undefined,
  demotedAt: undefined,
  sessionCount: 1,
  projectCount: 1,
  lastSeenAt: "2026-01-01T00:00:00Z",
  contentHash: contentHash("Test content for rule"),
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
  idCounter = 1;
  timeCounter = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("FileSharedStore", () => {
  it("saves and lists entries", async () => {
    const store = makeStore();
    const entry = makeEntry();
    const result = await store.save(entry);
    expect(result.ok).toBe(true);

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Test rule");
  });

  it("assigns id and timestamps on save", async () => {
    const store = makeStore();
    const result = await store.save(makeEntry());
    expect(result.ok).toBe(true);
    expect(result.saved![0]!.id).toBe("sk-0001");
    expect(result.saved![0]!.updatedAt).toBeTruthy();
  });

  it("getById returns entry or null", async () => {
    const store = makeStore();
    await store.save(makeEntry());
    const found = await store.getById("sk-0001");
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Test rule");

    const notFound = await store.getById("nonexistent");
    expect(notFound).toBeNull();
  });

  it("update patches fields", async () => {
    const store = makeStore();
    await store.save(makeEntry());
    const result = await store.update("sk-0001", { title: "Updated rule" });
    expect(result.ok).toBe(true);

    const entry = await store.getById("sk-0001");
    expect(entry!.title).toBe("Updated rule");
  });

  it("update returns error for missing entry", async () => {
    const store = makeStore();
    const result = await store.update("nonexistent", { title: "X" });
    expect(result.ok).toBe(false);
  });

  it("remove sets status to demoted", async () => {
    const store = makeStore();
    await store.save(makeEntry());
    const result = await store.remove("sk-0001");
    expect(result.ok).toBe(true);

    const entry = await store.getById("sk-0001");
    expect(entry!.approvalStatus).toBe("demoted");
    expect(entry!.demotedAt).toBeTruthy();
  });

  it("deletePending removes pending entries without demoting them", async () => {
    const store = makeStore();
    await store.save(
      makeEntry({
        approvalStatus: "pending",
        promotionSource: "suggested",
        createdBy: "system",
      }),
    );

    const result = await store.deletePending("sk-0001");
    expect(result.ok).toBe(true);

    const entry = await store.getById("sk-0001");
    expect(entry).toBeNull();
  });

  it("deletePending rejects non-pending entries", async () => {
    const store = makeStore();
    await store.save(makeEntry());

    const result = await store.deletePending("sk-0001");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Only pending entries");
  });

  it("demoted entries excluded from default list", async () => {
    const store = makeStore();
    await store.save(makeEntry());
    await store.save(
      makeEntry({
        title: "Second rule",
        content: "Different content",
        contentHash: contentHash("Different content"),
      }),
    );
    await store.remove("sk-0001");

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Second rule");
  });

  it("list with approvalStatus filter includes demoted", async () => {
    const store = makeStore();
    await store.save(makeEntry());
    await store.remove("sk-0001");

    const entries = await store.list({ approvalStatus: "demoted" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.approvalStatus).toBe("demoted");
  });

  it("contentHash dedup merges provenance on save", async () => {
    const store = makeStore();
    const first = makeEntry();
    await store.save(first);

    const duplicate = makeEntry({
      sourceProjectIds: ["proj-2"],
      sourceMemoryIds: ["mem-2"],
      tags: ["extra"],
      confidence: 0.95,
    });
    await store.save(duplicate);

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sourceProjectIds).toContain("proj-1");
    expect(entries[0]!.sourceProjectIds).toContain("proj-2");
    expect(entries[0]!.sourceMemoryIds).toContain("mem-1");
    expect(entries[0]!.sourceMemoryIds).toContain("mem-2");
    expect(entries[0]!.tags).toContain("test");
    expect(entries[0]!.tags).toContain("extra");
    expect(entries[0]!.confidence).toBe(0.95);
  });

  it("empty store returns empty array", async () => {
    const store = makeStore();
    const entries = await store.list();
    expect(entries).toEqual([]);
  });

  it("filters by kind", async () => {
    const store = makeStore();
    await store.save(makeEntry());
    await store.save(
      makeEntry({
        kind: "glossary_term",
        title: "Glossary item",
        content: "Glossary content",
        contentHash: contentHash("Glossary content"),
      }),
    );

    const rules = await store.list({ kind: "domain_rule" });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.kind).toBe("domain_rule");
  });

  it("filters by tags", async () => {
    const store = makeStore();
    await store.save(makeEntry({ tags: ["naming"] }));
    await store.save(
      makeEntry({
        title: "Other",
        content: "Other content",
        contentHash: contentHash("Other content"),
        tags: ["security"],
      }),
    );

    const result = await store.list({ tags: ["naming"] });
    expect(result).toHaveLength(1);
    expect(result[0]!.tags).toContain("naming");
  });

  it("filters by minConfidence", async () => {
    const store = makeStore();
    await store.save(makeEntry({ confidence: 0.5 }));
    await store.save(
      makeEntry({
        title: "High confidence",
        content: "High confidence content",
        contentHash: contentHash("High confidence content"),
        confidence: 0.95,
      }),
    );

    const result = await store.list({ minConfidence: 0.8 });
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe(0.95);
  });

  it("filters by query substring on title, content, tags", async () => {
    const store = makeStore();
    await store.save(
      makeEntry({
        title: "Snake case columns",
        content: "Use snake_case for DB columns",
        contentHash: contentHash("Use snake_case for DB columns"),
      }),
    );
    await store.save(
      makeEntry({
        title: "Event sourcing",
        content: "Services publish events",
        contentHash: contentHash("Services publish events"),
        tags: ["architecture"],
      }),
    );

    const byTitle = await store.list({ query: "snake" });
    expect(byTitle).toHaveLength(1);

    const byContent = await store.list({ query: "publish" });
    expect(byContent).toHaveLength(1);

    const byTag = await store.list({ query: "architecture" });
    expect(byTag).toHaveLength(1);
  });

  it("respects limit", async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) {
      await store.save(
        makeEntry({
          title: `Rule ${i}`,
          content: `Content ${i}`,
          contentHash: contentHash(`Content ${i}`),
        }),
      );
    }

    const result = await store.list({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("handles concurrent saves with lock contention", async () => {
    const store1 = makeStore();
    const store2 = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
      now: () =>
        `2026-01-01T00:00:${String(timeCounter++).padStart(2, "0")}Z`,
      createId: () => `sk-b-${String(idCounter++).padStart(4, "0")}`,
    });

    const [r1, r2] = await Promise.all([
      store1.save(
        makeEntry({
          title: "From store 1",
          content: "Content from store 1",
          contentHash: contentHash("Content from store 1"),
        }),
      ),
      store2.save(
        makeEntry({
          title: "From store 2",
          content: "Content from store 2",
          contentHash: contentHash("Content from store 2"),
        }),
      ),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const entries = await store1.list();
    expect(entries).toHaveLength(2);
  });
});
