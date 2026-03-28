import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryCandidate } from "../src/shared/types";
import { FileMemoryStore } from "../src/core/memory-store";

const tempDirs: string[] = [];

const makeCandidate = (
  overrides: Partial<MemoryCandidate> = {},
): MemoryCandidate => ({
  projectId: "project-alpha",
  kind: "decision",
  content: "Keep memory project scoped.",
  sourceEventIds: ["event-1"],
  confidence: 0.92,
  tags: ["scope"],
  ...overrides,
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("FileMemoryStore", () => {
  it("persists and retrieves memories per project", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-memory-"));
    tempDirs.push(storageDir);

    const store = new FileMemoryStore({
      storageDir,
      now: () => "2026-03-26T18:00:00.000Z",
      createId: () => "memory-1",
    });

    await store.saveCandidates([makeCandidate()]);
    await store.saveCandidates([
      makeCandidate({
        projectId: "project-beta",
        content: "Watch API latency after deploy.",
        kind: "reminder",
      }),
    ]);

    const alphaMemories = await store.listByProject("project-alpha");
    const betaMemories = await store.listByProject("project-beta");

    expect(alphaMemories).toHaveLength(1);
    expect(alphaMemories[0]?.content).toBe("Keep memory project scoped.");
    expect(betaMemories).toHaveLength(1);
    expect(betaMemories[0]?.projectId).toBe("project-beta");
  });

  it("deduplicates repeated decisions for the same project", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-memory-"));
    tempDirs.push(storageDir);

    let idCounter = 0;
    const store = new FileMemoryStore({
      storageDir,
      now: () => "2026-03-26T18:00:00.000Z",
      createId: () => `memory-${++idCounter}`,
    });

    await store.saveCandidates([makeCandidate()]);
    await store.saveCandidates([
      makeCandidate({
        sourceEventIds: ["event-2"],
        confidence: 0.95,
      }),
    ]);

    const alphaMemories = await store.listByProject("project-alpha");

    expect(alphaMemories).toHaveLength(1);
    expect(alphaMemories[0]?.sourceEventIds).toEqual(["event-1", "event-2"]);
    expect(alphaMemories[0]?.confidence).toBe(0.95);
  });

  it("fails soft when the storage path is unavailable", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "lore-memory-"));
    tempDirs.push(storageRoot);

    const brokenPath = join(storageRoot, "store.json");
    await writeFile(brokenPath, "not-a-directory");

    const store = new FileMemoryStore({
      storageDir: brokenPath,
      now: () => "2026-03-26T18:00:00.000Z",
      createId: () => "memory-1",
    });

    const result = await store.saveCandidates([makeCandidate()]);
    const memories = await store.listByProject("project-alpha");

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/storage/i);
    expect(memories).toEqual([]);
  });

  it("stores escaped project ids inside the storage directory", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-memory-"));
    tempDirs.push(storageDir);

    const store = new FileMemoryStore({
      storageDir,
      now: () => "2026-03-26T18:00:00.000Z",
      createId: () => "memory-1",
    });

    await store.saveCandidates([
      makeCandidate({
        projectId: "../project-alpha/../../secrets",
      }),
    ]);

    const files = await readdir(storageDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    await expect(
      readFile(join(storageDir, files[0] ?? ""), "utf8"),
    ).resolves.toContain('"projectId": "../project-alpha/../../secrets"');
  });

  it("preserves all saved memories across concurrent writers", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-memory-"));
    tempDirs.push(storageDir);

    const writers = Array.from({ length: 8 }, (_, index) => {
      let counter = 0;
      return new FileMemoryStore({
        storageDir,
        now: () => `2026-03-26T18:00:0${index}.000Z`,
        createId: () => `memory-${index}-${++counter}`,
      });
    });

    await Promise.all(
      writers.map((store, index) =>
        store.saveCandidates([
          makeCandidate({
            kind: "reminder",
            content: `Reminder ${index}`,
            sourceEventIds: [`event-${index}`],
            tags: ["concurrency"],
          }),
        ]),
      ),
    );

    const memories = await writers[0].listByProject("project-alpha");

    expect(memories).toHaveLength(8);
    expect(memories.map((memory) => memory.content).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `Reminder ${index}`),
    );
  });
});
