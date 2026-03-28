import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contentHash } from "../src/shared/validators";
import type { SharedKnowledgeEntry, MemoryEntry } from "../src/shared/types";

let testDir: string;
let sharedStorePath: string;
let projectMemoryDir: string;

const makeSharedEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => ({
  id: `sk-${Math.random().toString(36).slice(2, 6)}`,
  kind: "domain_rule",
  title: "Use snake_case",
  content: "All DB columns must use snake_case.",
  confidence: 0.9,
  tags: ["naming", "database"],
  sourceProjectIds: ["my-project"],
  sourceMemoryIds: ["mem-1"],
  promotionSource: "explicit",
  createdBy: "user",
  approvalStatus: "approved",
  sessionCount: 5,
  projectCount: 2,
  lastSeenAt: "2026-01-10T00:00:00Z",
  contentHash: contentHash(overrides?.content ?? "All DB columns must use snake_case."),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-10T00:00:00Z",
  ...overrides,
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-ss-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  sharedStorePath = join(testDir, "shared.json");
  projectMemoryDir = join(testDir, "projects");
  await mkdir(testDir, { recursive: true });
  await mkdir(projectMemoryDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// We test runSessionStart by importing it and mocking the config
// Since resolveConfig uses homedir, we override it via the module
describe("session-start integration", () => {
  // Rather than fighting module-level imports, test the core logic
  // by using buildSessionStartContext directly with a FileSharedStore
  it("selects entries with seeded shared knowledge", async () => {
    const { FileSharedStore } = await import("../src/core/file-shared-store");
    const { buildSessionStartContext } = await import(
      "../src/plugin/context-builder"
    );
    const { resolveConfig } = await import("../src/config");

    const store = new FileSharedStore({ storagePath: sharedStorePath });
    await store.save(makeSharedEntry());
    await store.save(
      makeSharedEntry({
        kind: "architecture_fact",
        title: "PostgreSQL is source of truth",
        content: "Redis is cache-only, PostgreSQL is the authoritative store.",
        contentHash: contentHash(
          "Redis is cache-only, PostgreSQL is the authoritative store.",
        ),
        tags: ["architecture"],
        sourceProjectIds: ["my-project"],
      }),
    );

    const config = resolveConfig();
    const result = await buildSessionStartContext({
      store,
      currentProjectId: "my-project",
      currentTags: ["database", "naming"],
      config: config.sessionStart,
      now: () => "2026-01-15T00:00:00Z",
    });

    const entryTitles = result.selectedEntries.map((e) => e.title);
    expect(entryTitles).toContain("Use snake_case");
    expect(entryTitles).toContain("PostgreSQL is source of truth");
  });

  it("returns empty result with empty store", async () => {
    const { FileSharedStore } = await import("../src/core/file-shared-store");
    const { buildSessionStartContext } = await import(
      "../src/plugin/context-builder"
    );
    const { resolveConfig } = await import("../src/config");

    const store = new FileSharedStore({ storagePath: sharedStorePath });
    const config = resolveConfig();

    const result = await buildSessionStartContext({
      store,
      currentProjectId: "my-project",
      currentTags: [],
      config: config.sessionStart,
      now: () => "2026-01-15T00:00:00Z",
    });

    expect(result.selectedEntries).toHaveLength(0);
    expect(result.injectedContentHashes).toHaveLength(0);
  });

  it("biases toward relevant entries when project memories exist", async () => {
    const { FileSharedStore } = await import("../src/core/file-shared-store");
    const { buildSessionStartContext } = await import(
      "../src/plugin/context-builder"
    );
    const { resolveConfig } = await import("../src/config");

    const store = new FileSharedStore({ storagePath: sharedStorePath });

    const relevant = makeSharedEntry({
      title: "Project-relevant rule",
      content: "Relevant content for this project",
      contentHash: contentHash("Relevant content for this project"),
      sourceProjectIds: ["target-project"],
      tags: ["backend"],
    });
    const irrelevant = makeSharedEntry({
      title: "Irrelevant rule",
      content: "Totally unrelated to current project",
      contentHash: contentHash("Totally unrelated to current project"),
      sourceProjectIds: ["other-project"],
      kind: "architecture_fact",
      tags: ["frontend"],
    });

    await store.save(relevant);
    await store.save(irrelevant);

    const config = resolveConfig();
    const result = await buildSessionStartContext({
      store,
      currentProjectId: "target-project",
      currentTags: ["backend"],
      config: config.sessionStart,
      now: () => "2026-01-15T00:00:00Z",
    });

    expect(result.selectedEntries[0]!.title).toBe("Project-relevant rule");
  });

  it("degrades gracefully without project memories (empty tags)", async () => {
    const { FileSharedStore } = await import("../src/core/file-shared-store");
    const { buildSessionStartContext } = await import(
      "../src/plugin/context-builder"
    );
    const { resolveConfig } = await import("../src/config");

    const store = new FileSharedStore({ storagePath: sharedStorePath });
    await store.save(makeSharedEntry({ tags: ["universal"] }));

    const config = resolveConfig();
    const result = await buildSessionStartContext({
      store,
      currentProjectId: "unknown-project",
      currentTags: [],
      config: config.sessionStart,
      now: () => "2026-01-15T00:00:00Z",
    });

    const entryTitles = result.selectedEntries.map((e) => e.title);
    expect(entryTitles).toContain("Use snake_case");
  });

  it("returns SelectedEntry objects with expected fields", async () => {
    const { FileSharedStore } = await import("../src/core/file-shared-store");
    const { buildSessionStartContext } = await import(
      "../src/plugin/context-builder"
    );
    const { resolveConfig } = await import("../src/config");

    const store = new FileSharedStore({ storagePath: sharedStorePath });
    await store.save(makeSharedEntry());

    const config = resolveConfig();
    const result = await buildSessionStartContext({
      store,
      currentProjectId: "my-project",
      currentTags: [],
      config: config.sessionStart,
      now: () => "2026-01-15T00:00:00Z",
    });

    expect(result.selectedEntries.length).toBeGreaterThan(0);
    const entry = result.selectedEntries[0]!;
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("kind");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("content");
    expect(entry).toHaveProperty("contentHash");
  });
});
