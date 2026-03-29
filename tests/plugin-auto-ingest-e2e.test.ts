import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type LoreChildOptions = {
  homeDir: string;
  input?: string;
};

const repoRoot = process.cwd();
const tempDirs: string[] = [];

const runLoreCommand = async (
  args: string[],
  options: LoreChildOptions,
): Promise<CommandResult> => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: options.homeDir,
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

  if (options.input) {
    child.stdin.write(options.input);
  }
  child.stdin.end();

  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
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

describe("Lore automatic ingestion end-to-end lifecycle", () => {
  it("drafts knowledge on stop, surfaces it as pending next session, and injects it after approval", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "lore-auto-ingest-e2e-"));
    tempDirs.push(homeDir);

    vi.resetModules();
    vi.stubEnv("HOME", homeDir);

    const { runStopObserver } = await import("../src/plugin/stop-observer");

    await runStopObserver(
      JSON.stringify({
        session_id: "session-auto-1",
        cwd: "/tmp/workspaces/billing-service",
        prompt: "Please update the migration. All database columns must use snake_case naming.",
        assistant_response: "I will update the migration and keep the new column snake_case.",
        tool_calls: [{ tool_name: "Edit", file_path: "src/db/migrate.ts" }],
        files_modified: ["src/db/migrate.ts"],
      }),
      {
        now: () => "2026-03-28T20:00:00.000Z",
        provider: {
          extractCandidates: async (turn) => [
            {
              id: "draft-1",
              kind: "domain_rule",
              title: "Use snake_case for DB columns",
              content: "All database columns use snake_case naming.",
              confidence: 0.93,
              evidenceNote: "Observed after an explicit naming correction.",
              sessionId: turn.sessionId,
              projectId: turn.projectId,
              turnIndex: turn.turnIndex,
              timestamp: turn.turnTimestamp,
              tags: ["database", "naming"],
            },
          ],
        },
      },
    );

    const draftPath = join(homeDir, ".lore", "drafts", "session-auto-1.jsonl");
    const draftContent = await readFile(draftPath, "utf8");
    expect(draftContent).toContain("Use snake_case for DB columns");
    expect(draftContent).toContain("All database columns use snake_case naming.");

    const sessionStartWithPending = await runLoreCommand(
      ["src/plugin/session-start.ts"],
      {
        homeDir,
        input: JSON.stringify({
          session_id: "session-auto-2",
          cwd: "/tmp/workspaces/billing-service",
        }),
      },
    );

    expect(sessionStartWithPending.code).toBe(0);
    expect(sessionStartWithPending.stderr).toBe("");

    const pendingPayload = JSON.parse(sessionStartWithPending.stdout) as {
      additionalContext: string;
    };
    expect(pendingPayload.additionalContext).toContain("## Pending Suggestions");
    expect(pendingPayload.additionalContext).toContain(
      "lore list-shared --status pending",
    );

    const pendingList = await runLoreCommand(
      ["scripts/cli.ts", "list-shared", "--status", "pending", "--json"],
      { homeDir },
    );

    expect(pendingList.code).toBe(0);
    const pendingEntries = JSON.parse(pendingList.stdout) as Array<{
      id: string;
      title: string;
      content: string;
      approvalStatus: string;
      promotionSource: string;
    }>;
    expect(pendingEntries).toEqual([
      expect.objectContaining({
        title: "Use snake_case for DB columns",
        content: "All database columns use snake_case naming.",
        approvalStatus: "pending",
        promotionSource: "suggested",
      }),
    ]);

    const whisperBeforeApproval = await runLoreCommand(
      ["src/plugin/pre-prompt-whisper.ts"],
      {
        homeDir,
        input: JSON.stringify({
          session_id: "session-auto-2",
          cwd: "/tmp/workspaces/billing-service",
          prompt: "Please update the database column naming.",
        }),
      },
    );

    expect(whisperBeforeApproval.code).toBe(0);
    expect(whisperBeforeApproval.stdout).toContain("[Lore · suggested @l1]");
    expect(whisperBeforeApproval.stdout).toContain("lore yes");

    const approveWithInput = await runLoreCommand(
      ["src/plugin/pre-prompt-whisper.ts"],
      {
        homeDir,
        input: JSON.stringify({
          session_id: "session-auto-2",
          cwd: "/tmp/workspaces/billing-service",
          prompt: "lore yes",
        }),
      },
    );

    expect(approveWithInput.code).toBe(0);
    expect(approveWithInput.stdout).toContain("[Lore · saved @l1]");
    expect(approveWithInput.stdout).toContain("lore no");

    const sessionStartAfterApproval = await runLoreCommand(
      ["src/plugin/session-start.ts"],
      {
        homeDir,
        input: JSON.stringify({
          session_id: "session-auto-3",
          cwd: "/tmp/workspaces/billing-service",
        }),
      },
    );

    expect(sessionStartAfterApproval.code).toBe(0);
    const approvedPayload = JSON.parse(sessionStartAfterApproval.stdout) as {
      additionalContext: string;
    };
    expect(approvedPayload.additionalContext).toContain("# Lore");
    expect(approvedPayload.additionalContext).toContain("## Session Knowledge");
    expect(approvedPayload.additionalContext).toContain(
      "Use snake_case for DB columns",
    );
    expect(approvedPayload.additionalContext).toContain(
      "All database columns use snake_case naming.",
    );

    const whisperAfterApproval = await runLoreCommand(
      ["src/plugin/pre-prompt-whisper.ts"],
      {
        homeDir,
        input: JSON.stringify({
          session_id: "session-auto-3",
          cwd: "/tmp/workspaces/billing-service",
          prompt: "Update the billing migration to add payment_status_code.",
        }),
      },
    );

    expect(whisperAfterApproval.code).toBe(0);
    expect(whisperAfterApproval.stdout.trim()).toBe("");
  });
});
