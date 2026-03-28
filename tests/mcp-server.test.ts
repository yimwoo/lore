import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSharedStore } from "../src/core/file-shared-store";
import { handleToolCall, toolDefinitions } from "../src/mcp/server";
import type { SharedKnowledgeEntry } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

let testDir: string;
let store: FileSharedStore;
let idCounter: number;

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => {
  const content = overrides?.content ?? `Content ${idCounter}`;
  return {
    id: `sk-${String(idCounter++).padStart(4, "0")}`,
    kind: "domain_rule",
    title: `Entry ${idCounter}`,
    content,
    confidence: 0.9,
    tags: ["test"],
    sourceProjectIds: ["proj-1"],
    sourceMemoryIds: ["mem-1"],
    promotionSource: "explicit",
    createdBy: "user",
    approvalStatus: "approved",
    approvedAt: "2026-01-01T00:00:00Z",
    sessionCount: 5,
    projectCount: 2,
    lastSeenAt: "2026-01-10T00:00:00Z",
    contentHash: contentHash(content),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-10T00:00:00Z",
    ...overrides,
  };
};

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
  idCounter = 1;
  store = new FileSharedStore({
    storagePath: join(testDir, "shared.json"),
  });

  // Seed diverse entries
  await store.save(makeEntry({ kind: "domain_rule", title: "Snake case columns", content: "Use snake_case for DB columns", tags: ["naming", "database"] }));
  await store.save(makeEntry({ kind: "domain_rule", title: "No any in TypeScript", content: "Avoid any type, use unknown", tags: ["typescript"] }));
  await store.save(makeEntry({ kind: "glossary_term", title: "SLA", content: "Service Level Agreement", tags: ["glossary"] }));
  await store.save(makeEntry({ kind: "architecture_fact", title: "PostgreSQL is source of truth", content: "Redis is cache-only", tags: ["database", "architecture"] }));
  await store.save(makeEntry({ kind: "architecture_fact", title: "Event sourcing", content: "Services publish domain events", tags: ["architecture", "events"] }));
  await store.save(makeEntry({ kind: "decision_record", title: "Chose Postgres over Mongo", content: "Latency and ACID requirements", tags: ["database", "decision"] }));
  await store.save(makeEntry({ kind: "user_preference", title: "Prefer functional style", content: "Use map/filter over loops", tags: ["style"] }));
  await store.save(makeEntry({ kind: "domain_rule", title: "Demoted rule", content: "Old rule", tags: ["old"], approvalStatus: "demoted", demotedAt: "2026-01-05T00:00:00Z" }));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("toolDefinitions", () => {
  it("has four tools", () => {
    expect(toolDefinitions).toHaveLength(4);
  });

  it("all tools have name, description, inputSchema", () => {
    for (const tool of toolDefinitions) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });
});

describe("lore.recall_rules", () => {
  it("returns only domain_rule and glossary_term", async () => {
    const result = await handleToolCall("lore.recall_rules", {}, store);
    expect(result.count).toBeGreaterThan(0);
    for (const entry of result.entries) {
      expect(["domain_rule", "glossary_term"]).toContain(entry.kind);
    }
  });

  it("excludes demoted entries", async () => {
    const result = await handleToolCall("lore.recall_rules", {}, store);
    expect(result.entries.find((e) => e.title === "Demoted rule")).toBeUndefined();
  });

  it("respects tags filter", async () => {
    const result = await handleToolCall("lore.recall_rules", { tags: ["typescript"] }, store);
    expect(result.count).toBe(1);
    expect(result.entries[0]!.title).toBe("No any in TypeScript");
  });

  it("respects query filter", async () => {
    const result = await handleToolCall("lore.recall_rules", { query: "snake" }, store);
    expect(result.count).toBe(1);
    expect(result.entries[0]!.title).toContain("Snake case");
  });

  it("respects limit", async () => {
    const result = await handleToolCall("lore.recall_rules", { limit: 1 }, store);
    expect(result.count).toBe(1);
  });
});

describe("lore.recall_architecture", () => {
  it("returns only architecture_fact", async () => {
    const result = await handleToolCall("lore.recall_architecture", {}, store);
    expect(result.count).toBe(2);
    for (const entry of result.entries) {
      expect(entry.kind).toBe("architecture_fact");
    }
  });
});

describe("lore.recall_decisions", () => {
  it("returns only decision_record", async () => {
    const result = await handleToolCall("lore.recall_decisions", {}, store);
    expect(result.count).toBe(1);
    expect(result.entries[0]!.kind).toBe("decision_record");
  });
});

describe("lore.search_knowledge", () => {
  it("requires query", async () => {
    await expect(
      handleToolCall("lore.search_knowledge", {}, store),
    ).rejects.toThrow("query is required");
  });

  it("returns across all kinds", async () => {
    const result = await handleToolCall(
      "lore.search_knowledge",
      { query: "database" },
      store,
    );
    const kinds = new Set(result.entries.map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it("ranks exact title match first", async () => {
    const result = await handleToolCall(
      "lore.search_knowledge",
      { query: "SLA" },
      store,
    );
    expect(result.entries[0]!.title).toBe("SLA");
  });

  it("ranks title substring above content substring", async () => {
    const result = await handleToolCall(
      "lore.search_knowledge",
      { query: "PostgreSQL" },
      store,
    );
    // "PostgreSQL is source of truth" has it in the title
    expect(result.entries[0]!.title).toContain("PostgreSQL");
  });

  it("clamps limit to 25", async () => {
    const result = await handleToolCall(
      "lore.search_knowledge",
      { query: "a", limit: 100 },
      store,
    );
    expect(result.count).toBeLessThanOrEqual(25);
  });

  it("filters by kind", async () => {
    const result = await handleToolCall(
      "lore.search_knowledge",
      { query: "database", kind: "domain_rule" },
      store,
    );
    for (const entry of result.entries) {
      expect(entry.kind).toBe("domain_rule");
    }
  });

  it("filters by minConfidence", async () => {
    const result = await handleToolCall(
      "lore.search_knowledge",
      { query: "snake", minConfidence: 0.95 },
      store,
    );
    for (const entry of result.entries) {
      expect(entry.confidence).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("includes query in response", async () => {
    const result = await handleToolCall(
      "lore.search_knowledge",
      { query: "test" },
      store,
    );
    expect(result.query).toBe("test");
  });
});

describe("response shape", () => {
  it("includes correct fields and excludes internal provenance", async () => {
    const result = await handleToolCall("lore.recall_rules", {}, store);
    const entry = result.entries[0]!;

    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("kind");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("content");
    expect(entry).toHaveProperty("confidence");
    expect(entry).toHaveProperty("tags");
    expect(entry).toHaveProperty("projectCount");
    expect(entry).toHaveProperty("lastSeenAt");

    // Internal provenance must NOT be present
    expect(entry).not.toHaveProperty("sourceMemoryIds");
    expect(entry).not.toHaveProperty("approvalStatus");
    expect(entry).not.toHaveProperty("sourceProjectIds");
    expect(entry).not.toHaveProperty("promotionSource");
    expect(entry).not.toHaveProperty("createdBy");
    expect(entry).not.toHaveProperty("contentHash");
  });
});

describe("unknown tool", () => {
  it("throws for unknown tool name", async () => {
    await expect(
      handleToolCall("lore.unknown", {}, store),
    ).rejects.toThrow("Unknown tool");
  });
});
