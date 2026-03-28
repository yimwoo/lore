import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deriveSessionKey } from "../src/plugin/whisper-state";
import type { WhisperSessionState } from "../src/shared/types";

const repoRoot = process.cwd();
const tempDirs: string[] = [];

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const runLoreCommand = async (
  args: string[],
  options?: {
    input?: string;
    homeDir?: string;
  },
): Promise<CommandResult> => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: options?.homeDir ?? process.env.HOME,
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

  if (options?.input) {
    child.stdin.write(options.input);
  }
  child.stdin.end();

  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
};

const readWhisperStateFile = async (
  homeDir: string,
  sessionId: string,
  cwd: string,
): Promise<WhisperSessionState> => {
  const sessionKey = deriveSessionKey(sessionId, cwd);
  const statePath = join(
    homeDir,
    ".lore",
    "whisper-sessions",
    `whisper-${sessionKey}.json`,
  );
  const content = await readFile(statePath, "utf8");
  return JSON.parse(content) as WhisperSessionState;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("Lore plugin end-to-end lifecycle", () => {
  it("promotes shared knowledge and injects it before the first user prompt", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "lore-plugin-e2e-"));
    tempDirs.push(homeDir);

    const promote = await runLoreCommand(
      [
        "scripts/cli.ts",
        "promote",
        "--kind",
        "domain_rule",
        "--title",
        "Snake case columns",
        "--content",
        "DB columns use snake_case across all services.",
        "--tags",
        "database,naming",
        "--project",
        "billing-service",
        "--json",
      ],
      { homeDir },
    );

    expect(promote.code).toBe(0);
    expect(promote.stderr).toBe("");

    const promotedEntry = JSON.parse(promote.stdout) as {
      contentHash: string;
      approvalStatus: string;
      title: string;
    };
    expect(promotedEntry.approvalStatus).toBe("approved");

    const listed = await runLoreCommand(
      ["scripts/cli.ts", "list-shared", "--json"],
      { homeDir },
    );

    expect(listed.code).toBe(0);
    const listedEntries = JSON.parse(listed.stdout) as Array<{
      title: string;
      approvalStatus: string;
    }>;
    expect(listedEntries).toEqual([
      expect.objectContaining({
        title: "Snake case columns",
        approvalStatus: "approved",
      }),
    ]);

    const sessionId = "session-e2e-1";
    const cwd = "/tmp/workspaces/billing-service";
    const sessionStart = await runLoreCommand(
      ["src/plugin/session-start.ts"],
      {
        homeDir,
        input: JSON.stringify({ session_id: sessionId, cwd }),
      },
    );

    expect(sessionStart.code).toBe(0);
    expect(sessionStart.stderr).toBe("");

    const startupPayload = JSON.parse(sessionStart.stdout) as {
      additionalContext: string;
    };
    expect(startupPayload.additionalContext).toContain("# Lore");
    expect(startupPayload.additionalContext).toContain("Snake case columns");
    expect(startupPayload.additionalContext).toContain(
      "DB columns use snake_case across all services.",
    );
    expect(startupPayload.additionalContext).toContain(
      "lore.recall_rules",
    );

    const initialState = await readWhisperStateFile(homeDir, sessionId, cwd);
    expect(initialState.turnIndex).toBe(0);
    expect(initialState.injectedContentHashes).toContain(
      promotedEntry.contentHash,
    );

    const firstPrompt = await runLoreCommand(
      ["src/plugin/pre-prompt-whisper.ts"],
      {
        homeDir,
        input: JSON.stringify({
          session_id: sessionId,
          cwd,
          prompt: "Update the billing migration for database columns.",
        }),
      },
    );

    expect(firstPrompt.code).toBe(0);
    expect(firstPrompt.stdout.trim()).toBe("");

    const stop = await runLoreCommand(
      ["src/plugin/stop-observer.ts"],
      {
        homeDir,
        input: JSON.stringify({
          session_id: sessionId,
          cwd,
          tool_calls: [{ tool_name: "Read" }, { tool_name: "Edit" }],
          files_read: ["src/plugin/session-start.ts"],
          files_modified: ["src/plugin/pre-prompt-whisper.ts"],
        }),
      },
    );

    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe("");

    const updatedState = await readWhisperStateFile(homeDir, sessionId, cwd);
    expect(updatedState.turnIndex).toBe(1);
    expect(updatedState.recentToolNames).toEqual(
      expect.arrayContaining(["Read", "Edit"]),
    );
    expect(updatedState.recentFiles).toEqual(
      expect.arrayContaining([
        "src/plugin/session-start.ts",
        "src/plugin/pre-prompt-whisper.ts",
      ]),
    );
    expect(updatedState.whisperHistory).toEqual([]);
  });

  it("silently no-ops whisper hooks when session_id is missing", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "lore-plugin-e2e-"));
    tempDirs.push(homeDir);

    const cwd = "/tmp/workspaces/billing-service";

    const firstPrompt = await runLoreCommand(
      ["src/plugin/pre-prompt-whisper.ts"],
      {
        homeDir,
        input: JSON.stringify({
          cwd,
          prompt: "Update the billing migration for database columns.",
        }),
      },
    );

    expect(firstPrompt.code).toBe(0);
    expect(firstPrompt.stdout).toBe("");
    expect(firstPrompt.stderr).toBe("");

    const stop = await runLoreCommand(
      ["src/plugin/stop-observer.ts"],
      {
        homeDir,
        input: JSON.stringify({
          cwd,
          tool_calls: [{ tool_name: "Read" }],
          files_read: ["src/plugin/session-start.ts"],
        }),
      },
    );

    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe("");
    expect(stop.stderr).toBe("");

    const whisperDir = join(homeDir, ".lore", "whisper-sessions");
    await expect(access(whisperDir)).rejects.toThrow();
  });
});
