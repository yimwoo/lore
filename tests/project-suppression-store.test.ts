import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileProjectSuppressionStore } from "../src/plugin/project-suppression-store";
import type { ProjectSuppressionRecord } from "../src/shared/types";

let testDir: string;
let storagePath: string;
let timeCounter: number;

const makeTimestamp = (): string =>
  `2026-01-01T00:00:${String(timeCounter++).padStart(2, "0")}Z`;

const makeStore = (): FileProjectSuppressionStore =>
  new FileProjectSuppressionStore({
    storagePath,
    now: makeTimestamp,
  });

const makeRecord = (
  overrides?: Partial<ProjectSuppressionRecord>,
): ProjectSuppressionRecord => ({
  entryId: "sk-0001",
  projectId: "proj-a",
  createdAt: "2026-01-01T00:00:00Z",
  reason: "user:dismissed",
  ...overrides,
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-suppression-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  storagePath = join(testDir, "project-suppressions.json");
  timeCounter = 0;
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("FileProjectSuppressionStore", () => {
  it("adds and reads suppressions", async () => {
    const store = makeStore();

    await store.add(makeRecord());

    const all = await store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.entryId).toBe("sk-0001");
    expect(all[0]!.projectId).toBe("proj-a");
  });

  it("deduplicates the same entry and project pair", async () => {
    const store = makeStore();

    await store.add(makeRecord());
    await store.add(makeRecord({ createdAt: "2026-01-01T00:00:10Z" }));

    const all = await store.readAll();
    expect(all).toHaveLength(1);
  });

  it("checks suppression by entry and project", async () => {
    const store = makeStore();

    await store.add(makeRecord());
    await store.add(makeRecord({ entryId: "sk-0002", projectId: "proj-b" }));

    await expect(store.isSuppressed("sk-0001", "proj-a")).resolves.toBe(true);
    await expect(store.isSuppressed("sk-0001", "proj-b")).resolves.toBe(false);
  });

  it("lists suppressions by project", async () => {
    const store = makeStore();

    await store.add(makeRecord({ entryId: "sk-0001", projectId: "proj-a" }));
    await store.add(makeRecord({ entryId: "sk-0002", projectId: "proj-a" }));
    await store.add(makeRecord({ entryId: "sk-0003", projectId: "proj-b" }));

    const projectA = await store.listByProject("proj-a");
    expect(projectA.map((record) => record.entryId)).toEqual([
      "sk-0001",
      "sk-0002",
    ]);
  });

  it("removes a suppression for one project without affecting others", async () => {
    const store = makeStore();

    await store.add(makeRecord({ entryId: "sk-0001", projectId: "proj-a" }));
    await store.add(makeRecord({ entryId: "sk-0001", projectId: "proj-b" }));

    await store.remove("sk-0001", "proj-a");

    await expect(store.isSuppressed("sk-0001", "proj-a")).resolves.toBe(false);
    await expect(store.isSuppressed("sk-0001", "proj-b")).resolves.toBe(true);
  });

  it("persists across instances", async () => {
    const store1 = makeStore();
    await store1.add(makeRecord());

    const store2 = makeStore();
    const all = await store2.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.reason).toBe("user:dismissed");
  });
});
