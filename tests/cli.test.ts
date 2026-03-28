import { Readable, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLoreApp } from "../src/app";
import { runCli } from "../src/cli";

const tempDirs: string[] = [];

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
});
