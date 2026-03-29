import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const runHarness = async (): Promise<CommandResult> => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/live-transcript-harness.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
      },
      stdio: "pipe",
    },
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
};

describe("live transcript harness", () => {
  it("prints a readable Lore whisper transcript with the visible block", async () => {
    const result = await runHarness();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("=== Lore Whisper Output ===");
    expect(result.stdout).toContain("[Lore · suggested @l1]");
    expect(result.stdout).toContain("[Lore · visible]");
    expect(result.stdout).toContain("=== Expected Visible Codex Prelude ===");
    expect(result.stdout).toContain("=== Lore Receipt Output ===");
    expect(result.stdout).toContain("[Lore · saved @l1]");
  });
});
