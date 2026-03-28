import { appendFile, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ObservationLogReader,
  ObservationLogWriter,
} from "../src/promotion/observation-log";
import type { ObservationEntry } from "../src/shared/types";

let testDir: string;

const makeEntry = (
  overrides?: Partial<ObservationEntry>,
): ObservationEntry => ({
  sessionId: "session-1",
  projectId: "proj-1",
  contentHash: "abc123",
  kind: "decision",
  confidence: 0.9,
  timestamp: "2026-01-01T00:00:00Z",
  ...overrides,
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-obs-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("ObservationLogWriter", () => {
  it("creates directory and file on first append", async () => {
    const obsDir = join(testDir, "observations");
    const writer = new ObservationLogWriter({
      observationDir: obsDir,
      sessionId: "session-1",
    });

    await writer.append(makeEntry());

    const reader = new ObservationLogReader({ observationDir: obsDir });
    const entries = await reader.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sessionId).toBe("session-1");
  });

  it("appends multiple entries as JSONL", async () => {
    const obsDir = join(testDir, "observations");
    const writer = new ObservationLogWriter({
      observationDir: obsDir,
      sessionId: "session-1",
    });

    await writer.append(makeEntry({ contentHash: "hash-1" }));
    await writer.append(makeEntry({ contentHash: "hash-2" }));
    await writer.append(makeEntry({ contentHash: "hash-3" }));

    const reader = new ObservationLogReader({ observationDir: obsDir });
    const entries = await reader.readAll();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.contentHash)).toEqual([
      "hash-1",
      "hash-2",
      "hash-3",
    ]);
  });
});

describe("ObservationLogReader", () => {
  it("reads across multiple session files", async () => {
    const obsDir = join(testDir, "observations");
    const writer1 = new ObservationLogWriter({
      observationDir: obsDir,
      sessionId: "session-a",
    });
    const writer2 = new ObservationLogWriter({
      observationDir: obsDir,
      sessionId: "session-b",
    });

    await writer1.append(makeEntry({ sessionId: "session-a" }));
    await writer2.append(makeEntry({ sessionId: "session-b" }));

    const reader = new ObservationLogReader({ observationDir: obsDir });
    const entries = await reader.readAll();
    expect(entries).toHaveLength(2);
    const sessionIds = entries.map((e) => e.sessionId);
    expect(sessionIds).toContain("session-a");
    expect(sessionIds).toContain("session-b");
  });

  it("skips malformed trailing lines (partial write simulation)", async () => {
    const obsDir = join(testDir, "observations");
    await mkdir(obsDir, { recursive: true });

    const filePath = join(obsDir, "session-partial.jsonl");
    const validLine = JSON.stringify(makeEntry()) + "\n";
    const partialLine = '{"sessionId":"session-1","projectId":"proj-1';
    await writeFile(filePath, validLine + partialLine, "utf8");

    const reader = new ObservationLogReader({ observationDir: obsDir });
    const entries = await reader.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sessionId).toBe("session-1");
  });

  it("returns empty array for empty directory", async () => {
    const obsDir = join(testDir, "empty-obs");
    await mkdir(obsDir, { recursive: true });

    const reader = new ObservationLogReader({ observationDir: obsDir });
    const entries = await reader.readAll();
    expect(entries).toEqual([]);
  });

  it("returns empty array for nonexistent directory", async () => {
    const reader = new ObservationLogReader({
      observationDir: join(testDir, "does-not-exist"),
    });
    const entries = await reader.readAll();
    expect(entries).toEqual([]);
  });

  it("concurrent writers to same parent dir produce correct aggregate", async () => {
    const obsDir = join(testDir, "observations");

    const writers = Array.from({ length: 5 }, (_, i) =>
      new ObservationLogWriter({
        observationDir: obsDir,
        sessionId: `concurrent-${i}`,
      }),
    );

    await Promise.all(
      writers.map((writer, i) =>
        Promise.all([
          writer.append(
            makeEntry({
              sessionId: `concurrent-${i}`,
              contentHash: `hash-${i}-a`,
            }),
          ),
          writer.append(
            makeEntry({
              sessionId: `concurrent-${i}`,
              contentHash: `hash-${i}-b`,
            }),
          ),
        ]),
      ),
    );

    const reader = new ObservationLogReader({ observationDir: obsDir });
    const entries = await reader.readAll();
    expect(entries).toHaveLength(10);

    const sessionIds = new Set(entries.map((e) => e.sessionId));
    expect(sessionIds.size).toBe(5);
  });
});

describe("ObservationLogReader.cleanup", () => {
  it("removes old files but keeps recent ones", async () => {
    const obsDir = join(testDir, "observations");
    await mkdir(obsDir, { recursive: true });

    const oldFile = join(obsDir, "old-session.jsonl");
    const newFile = join(obsDir, "new-session.jsonl");

    await writeFile(oldFile, JSON.stringify(makeEntry()) + "\n", "utf8");
    await writeFile(newFile, JSON.stringify(makeEntry()) + "\n", "utf8");

    // Set old file mtime to 100 days ago
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, oldDate, oldDate);

    const reader = new ObservationLogReader({ observationDir: obsDir });
    const removed = await reader.cleanup(90);
    expect(removed).toBe(1);

    const entries = await reader.readAll();
    expect(entries).toHaveLength(1);
  });
});
