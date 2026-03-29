import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLoreApp } from "../src/app";
import { runCli } from "../src/cli";
import { FileSharedStore } from "../src/core/file-shared-store";
import { FileApprovalStore } from "../src/promotion/approval-store";
import { FileConflictStore } from "../src/promotion/conflict-store";
import { contentHash } from "../src/shared/validators";
import type { SharedKnowledgeEntry } from "../src/shared/types";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

const createWritable = () => {
  let value = "";

  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    read: () => value,
  };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runCli", () => {
  it("prints stored project memories as JSON", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-cli-"));
    tempDirs.push(storageDir);

    const app = createLoreApp({
      projectId: "project-alpha",
      storageDir,
    });

    await app.ingest({
      kind: "user_prompt_submitted",
      prompt: "Let's keep memory project scoped for v1.",
      files: ["src/shared/types.ts"],
    });

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      [
        "memories",
        "--project",
        "project-alpha",
        "--storage-dir",
        storageDir,
        "--json",
      ],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    const memories = JSON.parse(stdout.read()) as Array<{ kind: string; content: string }>;
    expect(memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "decision",
          content: "Keep memory project scoped for v1.",
        }),
      ]),
    );
  });

  it("skips malformed serve input without stopping the daemon", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-cli-"));
    tempDirs.push(storageDir);

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["serve", "--project", "project-alpha", "--storage-dir", storageDir],
      {
        stdin: Readable.from([
          '{"kind":"tool_run_failed","toolName":"","summary":"broken"}\n',
          '{"kind":"assistant_response_completed","response":"Next I will inspect src/app.ts.","files":["src/app.ts"]}\n',
        ]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.read()).toMatch(/skipped invalid event/i);
    expect(stdout.read()).toContain("Events: 1");
  });

  it("runs the lore bin wrapper from a different working directory", async () => {
    const otherCwd = await mkdtemp(join(tmpdir(), "lore-bin-"));
    tempDirs.push(otherCwd);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(repoRoot, "bin", "lore.js"), "help"],
      { cwd: otherCwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("Lore CLI");
    expect(stdout).toContain("list-shared");
  });

  it("emits CLI trace events to stderr when debug logging is enabled", async () => {
    vi.resetModules();
    vi.stubEnv("LORE_DEBUG", "trace");
    const stdout = createWritable();
    const stderr = createWritable();
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    const { runCli: runCliWithLogging } = await import("../src/cli");

    const exitCode = await runCliWithLogging(
      ["help"],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );
    stderrSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("Lore CLI");
    expect(stderr.read()).toBe("");
    const lines = stderrWrites.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string });
    expect(lines.some((line) => line.event === "cli.command_started")).toBe(true);
    expect(lines.some((line) => line.event === "cli.command_succeeded")).toBe(true);
  });
});

describe("import command", () => {
  const fixtureMarkdown = `## Naming Rules

Use camelCase for variables.

## Architecture

The system uses a layered module design.

## DB Choice

We decided to use PostgreSQL.
`;

  it("basic import creates pending entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const fixturePath = join(dir, "fixture.md");
    await writeFile(fixturePath, fixtureMarkdown, "utf8");

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["import", fixturePath, "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    const output = stdout.read();
    expect(output).toContain("Imported 3 entries");
    expect(output).toContain("pending");
  });

  it("dry run prints candidates without writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const fixturePath = join(dir, "fixture.md");
    await writeFile(fixturePath, fixtureMarkdown, "utf8");

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["import", fixturePath, "--shared-dir", dir, "--dry-run"],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    const output = stdout.read();
    expect(output).toContain("Dry run:");
    expect(output).toContain("3 entries would be imported");

    // Verify nothing was written to the store
    const listStdout = createWritable();
    const listStderr = createWritable();
    await runCli(
      ["list-shared", "--shared-dir", dir, "--json"],
      {
        stdin: Readable.from([]),
        stdout: listStdout.stream,
        stderr: listStderr.stream,
      },
    );
    const entries = JSON.parse(listStdout.read()) as unknown[];
    expect(entries).toHaveLength(0);
  });

  it("kind override forces all entries to specified kind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const fixturePath = join(dir, "fixture.md");
    await writeFile(fixturePath, fixtureMarkdown, "utf8");

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["import", fixturePath, "--shared-dir", dir, "--kind", "domain_rule"],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    const output = stdout.read();
    expect(output).toContain("domain rule");

    // Verify all entries are domain_rule
    const listStdout = createWritable();
    await runCli(
      ["list-shared", "--shared-dir", dir, "--json"],
      {
        stdin: Readable.from([]),
        stdout: listStdout.stream,
        stderr: createWritable().stream,
      },
    );
    const entries = JSON.parse(listStdout.read()) as Array<{ kind: string }>;
    for (const entry of entries) {
      expect(entry.kind).toBe("domain_rule");
    }
  });

  it("approve-all creates approved entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const fixturePath = join(dir, "fixture.md");
    await writeFile(fixturePath, fixtureMarkdown, "utf8");

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["import", fixturePath, "--shared-dir", dir, "--approve-all"],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    const output = stdout.read();
    expect(output).toContain("approved");

    // Verify entries are approved
    const listStdout = createWritable();
    await runCli(
      ["list-shared", "--shared-dir", dir, "--status", "approved", "--json"],
      {
        stdin: Readable.from([]),
        stdout: listStdout.stream,
        stderr: createWritable().stream,
      },
    );
    const entries = JSON.parse(listStdout.read()) as Array<{ approvalStatus: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry.approvalStatus).toBe("approved");
    }
  });

  it("missing file outputs error message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["import", join(dir, "nonexistent.md"), "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("Lore CLI error:");
  });

  it("empty file outputs no importable entries message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const emptyPath = join(dir, "empty.md");
    await writeFile(emptyPath, "", "utf8");

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["import", emptyPath, "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("No importable entries found in file.");
  });

  it("tag-prefix adds prefix to all entries' tags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const fixturePath = join(dir, "fixture.md");
    await writeFile(fixturePath, fixtureMarkdown, "utf8");

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["import", fixturePath, "--shared-dir", dir, "--tag-prefix", "foo"],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);

    // Verify all entries have the tag prefix
    const listStdout = createWritable();
    await runCli(
      ["list-shared", "--shared-dir", dir, "--json"],
      {
        stdin: Readable.from([]),
        stdout: listStdout.stream,
        stderr: createWritable().stream,
      },
    );
    const entries = JSON.parse(listStdout.read()) as Array<{ tags: string[] }>;
    for (const entry of entries) {
      expect(entry.tags).toContain("foo");
    }
  });

  it("dedup on second import skips all entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-import-"));
    tempDirs.push(dir);

    const fixturePath = join(dir, "fixture.md");
    await writeFile(fixturePath, fixtureMarkdown, "utf8");

    const stdout1 = createWritable();
    await runCli(
      ["import", fixturePath, "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout1.stream,
        stderr: createWritable().stream,
      },
    );
    expect(stdout1.read()).toContain("Imported 3 entries");

    // Import again
    const stdout2 = createWritable();
    await runCli(
      ["import", fixturePath, "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout2.stream,
        stderr: createWritable().stream,
      },
    );
    const output2 = stdout2.read();
    expect(output2).toContain("Skipped 3 duplicate");
    expect(output2).toContain("Imported 0 entries");
  });
});

const makeApprovedEntry = (
  id: string,
  content: string,
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => ({
  id,
  kind: "domain_rule",
  title: content.slice(0, 30),
  content,
  confidence: 0.9,
  tags: ["test"],
  sourceProjectIds: ["proj-1"],
  sourceMemoryIds: [],
  promotionSource: "explicit",
  createdBy: "user",
  approvalStatus: "approved",
  approvalSource: "manual",
  approvedAt: "2026-03-28T10:00:00Z",
  sessionCount: 1,
  projectCount: 1,
  lastSeenAt: "2026-03-28T10:00:00Z",
  contentHash: contentHash(content),
  createdAt: "2026-03-28T10:00:00Z",
  updatedAt: "2026-03-28T10:00:00Z",
  contradictionCount: 1,
  ...overrides,
});

const setupConflict = async (dir: string) => {
  const sharedStore = new FileSharedStore({
    storagePath: join(dir, "shared.json"),
  });
  const approvalStore = new FileApprovalStore({
    ledgerPath: join(dir, "approval-ledger.json"),
    sharedStore,
  });
  const conflictStore = new FileConflictStore({
    storagePath: join(dir, "conflicts.json"),
  });

  const entryA = makeApprovedEntry("sk-aaa", "Always use snake_case for DB columns");
  const entryB = makeApprovedEntry("sk-bbb", "Never use snake_case for DB columns");

  await sharedStore.save(entryA);
  await sharedStore.save(entryB);

  await conflictStore.add({
    entryIdA: "sk-aaa",
    entryIdB: "sk-bbb",
    conflictType: "direct_negation",
    subjectOverlap: 1.0,
    scopeOverlap: 1.0,
    suggestedWinnerId: "sk-aaa",
    explanation: "Direct contradiction",
  });

  return { sharedStore, approvalStore, conflictStore };
};

describe("resolve command", () => {
  it("--keep keeps the specified entry and demotes the other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-resolve-"));
    tempDirs.push(dir);
    const { sharedStore, approvalStore, conflictStore } = await setupConflict(dir);

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["resolve", "sk-aaa", "sk-bbb", "--keep", "sk-aaa", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("Resolved: kept sk-aaa, demoted sk-bbb");

    const demoted = await sharedStore.getById("sk-bbb");
    expect(demoted!.approvalStatus).toBe("demoted");

    const conflicts = await conflictStore.list({ status: "resolved" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolution).toBe("keep_a");

    const ledger = await approvalStore.readAll();
    const resolveLedger = ledger.filter((e) => e.action === "resolve");
    expect(resolveLedger).toHaveLength(1);
    expect(resolveLedger[0]!.metadata?.supersededEntryId).toBe("sk-bbb");
  });

  it("--dismiss marks conflict resolved without changing entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-resolve-"));
    tempDirs.push(dir);
    const { sharedStore, conflictStore } = await setupConflict(dir);

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["resolve", "sk-aaa", "sk-bbb", "--dismiss", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("Dismissed conflict");

    const entryA = await sharedStore.getById("sk-aaa");
    expect(entryA!.approvalStatus).toBe("approved");

    const entryB = await sharedStore.getById("sk-bbb");
    expect(entryB!.approvalStatus).toBe("approved");

    const conflicts = await conflictStore.list({ status: "resolved" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolution).toBe("dismiss");

    // contradictionCount decremented
    expect(entryA!.contradictionCount).toBe(0);
    expect(entryB!.contradictionCount).toBe(0);
  });

  it("--merge creates a merged entry and demotes both originals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-resolve-"));
    tempDirs.push(dir);
    const { sharedStore, conflictStore } = await setupConflict(dir);

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["resolve", "sk-aaa", "sk-bbb", "--merge", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    const output = stdout.read();
    expect(output).toContain("merged");

    const entryA = await sharedStore.getById("sk-aaa");
    expect(entryA!.approvalStatus).toBe("demoted");

    const entryB = await sharedStore.getById("sk-bbb");
    expect(entryB!.approvalStatus).toBe("demoted");

    const conflicts = await conflictStore.list({ status: "resolved" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolution).toBe("merge");
  });

  it("--scope adds project tag to scoped entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-resolve-"));
    tempDirs.push(dir);
    const { sharedStore, conflictStore } = await setupConflict(dir);

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["resolve", "sk-aaa", "sk-bbb", "--scope", "sk-bbb", "--project", "api", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("scoped sk-bbb to project");

    const scopedEntry = await sharedStore.getById("sk-bbb");
    expect(scopedEntry!.tags).toContain("project:api");

    const conflicts = await conflictStore.list({ status: "resolved" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolution).toBe("scope");
  });

  it("shows error when no conflict exists between given IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-resolve-"));
    tempDirs.push(dir);

    const sharedStore = new FileSharedStore({
      storagePath: join(dir, "shared.json"),
    });
    await sharedStore.save(makeApprovedEntry("sk-xxx", "Some entry"));
    await sharedStore.save(makeApprovedEntry("sk-yyy", "Another entry"));

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["resolve", "sk-xxx", "sk-yyy", "--keep", "sk-xxx", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("No conflict found");
  });

  it("shows error when no resolution option is specified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-resolve-"));
    tempDirs.push(dir);
    await setupConflict(dir);

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["resolve", "sk-aaa", "sk-bbb", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("Specify a resolution");
  });
});

describe("history command", () => {
  it("shows supersession chain when entry has been superseded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-history-"));
    tempDirs.push(dir);

    const sharedStore = new FileSharedStore({
      storagePath: join(dir, "shared.json"),
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: join(dir, "approval-ledger.json"),
      sharedStore,
    });

    const winner = makeApprovedEntry("sk-winner", "Always use camelCase");
    const loser = makeApprovedEntry("sk-loser", "Always use snake_case", {
      approvalStatus: "demoted",
    });
    await sharedStore.save(winner);
    await sharedStore.save(loser);

    await approvalStore.append({
      knowledgeEntryId: "sk-winner",
      action: "resolve",
      actor: "user",
      reason: "Kept sk-winner, demoted sk-loser",
      metadata: {
        conflictId: "conf-001",
        resolution: "keep_a",
        supersededEntryId: "sk-loser",
        supersessionReason: "superseded:user_correction",
      },
    });

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["history", "sk-winner", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    const output = stdout.read();
    expect(output).toContain("History for sk-winner");
    expect(output).toContain("Supersedes:");
    expect(output).toContain("sk-loser");
    expect(output).toContain("superseded:user_correction");

    // Also test from the loser's perspective
    const stdout2 = createWritable();
    const exitCode2 = await runCli(
      ["history", "sk-loser", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout2.stream,
        stderr: createWritable().stream,
      },
    );

    expect(exitCode2).toBe(0);
    const output2 = stdout2.read();
    expect(output2).toContain("History for sk-loser");
    expect(output2).toContain("Superseded by:");
    expect(output2).toContain("sk-winner");
  });

  it("shows entry details and ledger when no supersession history exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-history-"));
    tempDirs.push(dir);

    const sharedStore = new FileSharedStore({
      storagePath: join(dir, "shared.json"),
    });

    await sharedStore.save(makeApprovedEntry("sk-solo", "Standalone entry"));

    const stdout = createWritable();
    const stderr = createWritable();

    const exitCode = await runCli(
      ["history", "sk-solo", "--shared-dir", dir],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    const output = stdout.read();
    expect(output).toContain("History for sk-solo");
    expect(output).toContain("Kind: domain_rule");
    expect(output).toContain("Ledger:");
    expect(output).not.toContain("Superseded by:");
    expect(output).not.toContain("Supersedes:");
  });
});
