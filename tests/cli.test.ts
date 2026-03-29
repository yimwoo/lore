import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLoreApp } from "../src/app";
import { runCli } from "../src/cli";

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
