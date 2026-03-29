import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli";
import { FileSharedStore } from "../src/core/file-shared-store";
import { FileApprovalStore } from "../src/promotion/approval-store";
import type { SharedKnowledgeEntry, DashboardData } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

let testDir: string;
let idCounter: number;

const createStreams = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutData = "";
  let stderrData = "";

  stdout.on("data", (chunk) => {
    stdoutData += chunk.toString();
  });
  stderr.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    getStdout: () => stdoutData,
    getStderr: () => stderrData,
  };
};

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => {
  idCounter += 1;
  const content = overrides?.content ?? `Content ${idCounter}`;
  return {
    id: `sk-${String(idCounter).padStart(4, "0")}`,
    kind: "domain_rule",
    title: `Entry ${idCounter}`,
    content,
    confidence: 0.9,
    tags: [],
    sourceProjectIds: ["proj-1"],
    sourceMemoryIds: ["mem-1"],
    promotionSource: "explicit",
    createdBy: "user",
    approvalStatus: "approved",
    sessionCount: 3,
    projectCount: 1,
    lastSeenAt: new Date().toISOString(),
    contentHash: contentHash(content),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
};

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-cli-dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
  idCounter = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("CLI dashboard command", () => {
  it("shows empty-state message when no entries exist", async () => {
    const streams = createStreams();
    const code = await runCli(
      ["dashboard", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("No shared knowledge entries found.");
    expect(streams.getStdout()).toContain("lore promote");
    expect(streams.getStdout()).toContain("lore list-shared");
  });

  it("shows dashboard with seeded entries", async () => {
    const store = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
    });

    await store.save(makeEntry({ kind: "domain_rule", tags: ["billing"], approvalStatus: "approved" }));
    await store.save(makeEntry({ kind: "architecture_fact", tags: ["auth"], approvalStatus: "pending" }));
    await store.save(makeEntry({ kind: "glossary_term", tags: ["billing"], approvalStatus: "approved" }));

    const streams = createStreams();
    const code = await runCli(
      ["dashboard", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    const output = streams.getStdout();
    expect(output).toContain("Lore Knowledge Dashboard");
    expect(output).toContain("Domain Rules");
    expect(output).toContain("Architecture Facts");
    expect(output).toContain("Glossary Terms");
    expect(output).toContain("Tag Coverage");
    expect(output).toContain("Recent Activity");
    expect(output).toContain("Health");
  });

  it("returns valid JSON with --json flag", async () => {
    const store = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
    });

    await store.save(makeEntry({ kind: "domain_rule", approvalStatus: "approved" }));

    const streams = createStreams();
    const code = await runCli(
      ["dashboard", "--json", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    const data = JSON.parse(streams.getStdout()) as DashboardData;
    expect(data).toHaveProperty("totalEntries");
    expect(data).toHaveProperty("kindCounts");
    expect(data).toHaveProperty("tagCoverage");
    expect(data).toHaveProperty("activity");
    expect(data).toHaveProperty("health");
    expect(data).toHaveProperty("generatedAt");
    expect(data.kindCounts).toHaveLength(5);
  });
});

describe("CLI list-shared filter flags", () => {
  it("filters by --tag", async () => {
    const store = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
    });

    await store.save(makeEntry({ tags: ["billing"], title: "Billing rule" }));
    await store.save(makeEntry({ tags: ["auth"], title: "Auth rule" }));

    const streams = createStreams();
    const code = await runCli(
      ["list-shared", "--tag", "billing", "--json", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    const entries = JSON.parse(streams.getStdout()) as SharedKnowledgeEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Billing rule");
  });

  it("filters by --stale", async () => {
    const store = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
    });

    await store.save(makeEntry({
      title: "Old rule",
      lastSeenAt: "2025-01-01T00:00:00Z",
    }));
    await store.save(makeEntry({
      title: "Fresh rule",
      lastSeenAt: new Date().toISOString(),
    }));

    const streams = createStreams();
    const code = await runCli(
      ["list-shared", "--stale", "--json", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    const entries = JSON.parse(streams.getStdout()) as SharedKnowledgeEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Old rule");
  });

  it("filters by --contradictions", async () => {
    const store = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
    });

    await store.save(makeEntry({
      title: "Contradicted rule",
      contradictionCount: 3,
    }));
    await store.save(makeEntry({
      title: "Clean rule",
      contradictionCount: 0,
    }));

    const streams = createStreams();
    const code = await runCli(
      ["list-shared", "--contradictions", "--json", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    const entries = JSON.parse(streams.getStdout()) as SharedKnowledgeEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Contradicted rule");
  });

  it("combines --kind and --tag flags", async () => {
    const store = new FileSharedStore({
      storagePath: join(testDir, "shared.json"),
    });

    await store.save(makeEntry({ kind: "domain_rule", tags: ["billing"], title: "Billing domain rule" }));
    await store.save(makeEntry({ kind: "domain_rule", tags: ["auth"], title: "Auth domain rule" }));
    await store.save(makeEntry({ kind: "architecture_fact", tags: ["billing"], title: "Billing arch fact" }));

    const streams = createStreams();
    const code = await runCli(
      ["list-shared", "--kind", "domain_rule", "--tag", "billing", "--json", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    const entries = JSON.parse(streams.getStdout()) as SharedKnowledgeEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Billing domain rule");
  });
});
