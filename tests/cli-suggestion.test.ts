import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli";
import { ObservationLogWriter } from "../src/promotion/observation-log";
import { FileSharedStore } from "../src/core/file-shared-store";
import { contentHash } from "../src/shared/validators";
import type { SharedKnowledgeEntry } from "../src/shared/types";

let testDir: string;
let obsDir: string;

const createStreams = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutData = "";
  let stderrData = "";
  stdout.on("data", (chunk) => { stdoutData += chunk.toString(); });
  stderr.on("data", (chunk) => { stderrData += chunk.toString(); });
  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    getStdout: () => stdoutData,
    getStderr: () => stderrData,
  };
};

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-cli-suggest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  obsDir = join(testDir, "observations");
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const seedObservations = async (content: string, sessions: number, projects: number) => {
  for (let s = 0; s < sessions; s++) {
    const writer = new ObservationLogWriter({
      observationDir: obsDir,
      sessionId: `session-${s}`,
    });
    await writer.append({
      sessionId: `session-${s}`,
      projectId: `proj-${s % projects}`,
      contentHash: contentHash(content),
      kind: "reminder",
      confidence: 0.95,
      timestamp: "2026-01-10T00:00:00Z",
    });
  }
};

const createPendingEntry = async (id: string) => {
  const store = new FileSharedStore({
    storagePath: join(testDir, "shared.json"),
  });
  const entry: SharedKnowledgeEntry = {
    id,
    kind: "domain_rule",
    title: "Pending suggestion",
    content: "Awaiting approval",
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
    contentHash: contentHash("Awaiting approval"),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  await store.save(entry);
};

describe("CLI suggest command", () => {
  it("creates pending entries from observation log", async () => {
    await seedObservations("Validate all inputs", 3, 1);

    const streams = createStreams();
    const code = await runCli(
      ["suggest", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("suggestion candidate");

    // Verify pending entries were created
    const streams2 = createStreams();
    await runCli(
      ["list-shared", "--status", "pending", "--shared-dir", testDir],
      streams2,
    );
    expect(streams2.getStdout()).toContain("Suggested");
  });

  it("reports no candidates when observation log is empty", async () => {
    const streams = createStreams();
    const code = await runCli(
      ["suggest", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("No suggestion candidates");
  });
});

describe("CLI approve command", () => {
  it("approves a pending entry", async () => {
    await createPendingEntry("sk-approve-test");

    const streams = createStreams();
    const code = await runCli(
      ["approve", "sk-approve-test", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("Approved:");
  });

  it("fails on non-pending entry", async () => {
    // Promote an entry (which is auto-approved)
    const streams1 = createStreams();
    await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "Already approved",
        "--content", "Cannot approve again",
        "--shared-dir", testDir,
      ],
      streams1,
    );

    const idMatch = streams1.getStdout().match(/Promoted: (sk-\S+)/);
    const entryId = idMatch?.[1] ?? "";

    const streams2 = createStreams();
    const code = await runCli(
      ["approve", entryId, "--shared-dir", testDir],
      streams2,
    );

    expect(code).toBe(1);
    expect(streams2.getStderr()).toContain("Invalid state transition");
  });
});

describe("CLI reject command", () => {
  it("rejects a pending entry with reason", async () => {
    await createPendingEntry("sk-reject-test");

    const streams = createStreams();
    const code = await runCli(
      ["reject", "sk-reject-test", "--reason", "too specific", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("Rejected:");
  });

  it("fails without --reason", async () => {
    await createPendingEntry("sk-reject-no-reason");

    const streams = createStreams();
    const code = await runCli(
      ["reject", "sk-reject-no-reason", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(1);
    expect(streams.getStderr()).toContain("Missing required option --reason");
  });
});
