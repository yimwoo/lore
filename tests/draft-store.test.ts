import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DraftStoreReader,
  DraftStoreWriter,
  readConsolidationState,
  writeConsolidationState,
} from "../src/promotion/draft-store";
import type { ConsolidationState, DraftCandidate } from "../src/shared/types";

let testDir: string;

const makeDraftCandidate = (
  overrides?: Partial<DraftCandidate>,
): DraftCandidate => ({
  id: "draft-1",
  kind: "domain_rule",
  title: "Use snake_case for columns",
  content: "All database columns use snake_case naming.",
  confidence: 0.84,
  evidenceNote: "Observed after a naming correction.",
  sessionId: "session-1",
  projectId: "proj-1",
  turnIndex: 1,
  timestamp: "2026-03-28T19:00:00Z",
  tags: ["database", "naming"],
  ...overrides,
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-draft-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("DraftStoreWriter", () => {
  it("creates directory and persists appended drafts", async () => {
    const draftDir = join(testDir, "drafts");
    const writer = new DraftStoreWriter({
      draftDir,
      sessionId: "session-1",
    });

    await writer.append(makeDraftCandidate());

    const reader = new DraftStoreReader({ draftDir });
    const drafts = await reader.readAll();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.sessionId).toBe("session-1");
  });
});

describe("DraftStoreReader", () => {
  it("reads across multiple session files", async () => {
    const draftDir = join(testDir, "drafts");
    const writerA = new DraftStoreWriter({
      draftDir,
      sessionId: "session-a",
    });
    const writerB = new DraftStoreWriter({
      draftDir,
      sessionId: "session-b",
    });

    await writerA.append(makeDraftCandidate({ sessionId: "session-a" }));
    await writerB.append(makeDraftCandidate({
      id: "draft-2",
      sessionId: "session-b",
    }));

    const reader = new DraftStoreReader({ draftDir });
    const drafts = await reader.readAll();
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.sessionId)).toContain("session-a");
    expect(drafts.map((draft) => draft.sessionId)).toContain("session-b");
  });

  it("filters by watermark timestamp", async () => {
    const draftDir = join(testDir, "drafts");
    const writer = new DraftStoreWriter({
      draftDir,
      sessionId: "session-1",
    });

    await writer.append(makeDraftCandidate({ timestamp: "2026-03-28T19:00:00Z" }));
    await writer.append(makeDraftCandidate({
      id: "draft-2",
      timestamp: "2026-03-28T20:00:00Z",
    }));

    const reader = new DraftStoreReader({ draftDir });
    const drafts = await reader.readSince("2026-03-28T19:30:00Z");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.id).toBe("draft-2");
  });

  it("skips malformed trailing lines", async () => {
    const draftDir = join(testDir, "drafts");
    await mkdir(draftDir, { recursive: true });

    const filePath = join(draftDir, "session-partial.jsonl");
    const validLine = `${JSON.stringify(makeDraftCandidate())}\n`;
    const partialLine = '{"id":"draft-2","kind":"domain_rule"';
    await writeFile(filePath, validLine + partialLine, "utf8");

    const reader = new DraftStoreReader({ draftDir });
    const drafts = await reader.readAll();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.id).toBe("draft-1");
  });
});

describe("consolidation state", () => {
  it("returns empty state when the file does not exist", async () => {
    const state = await readConsolidationState(join(testDir, "missing-state.json"));
    expect(state).toEqual({});
  });

  it("persists and reads watermark state", async () => {
    const path = join(testDir, "consolidation-state.json");
    const state: ConsolidationState = {
      lastConsolidatedAt: "2026-03-28T20:00:00Z",
      lastAttemptedAt: "2026-03-28T20:01:00Z",
      lastStatus: "ok",
    };

    await writeConsolidationState(path, state);

    const read = await readConsolidationState(path);
    expect(read).toEqual(state);
  });
});
