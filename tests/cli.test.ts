import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
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
