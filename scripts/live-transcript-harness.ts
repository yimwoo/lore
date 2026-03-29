#!/usr/bin/env -S node --import tsx

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveConfig } from "../src/config";
import { runStopObserver } from "../src/plugin/stop-observer";
import { deriveSessionKey, readWhisperState } from "../src/plugin/whisper-state";

type HarnessOptions = {
  keepArtifacts: boolean;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type SharedEntrySummary = {
  id: string;
  title: string;
  content: string;
  approvalStatus: string;
  promotionSource: string;
};

const parseArgs = (argv: string[]): HarnessOptions => ({
  keepArtifacts: argv.includes("--keep-artifacts"),
});

const runLoreCommand = async (
  args: string[],
  homeDir: string,
  input?: string,
): Promise<CommandResult> => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
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

  if (input) {
    child.stdin.write(input);
  }
  child.stdin.end();

  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
};

const readJsonFile = async <T,>(filePath: string): Promise<T> => {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const extractVisibleBlock = (whisperOutput: string): string => {
  const lines = whisperOutput.trimEnd().split("\n");
  const start = lines.findIndex((line) => line.trim() === "[Lore · visible]");
  if (start === -1) {
    return "(no [Lore · visible] block emitted)";
  }

  const block: string[] = [];
  for (const line of lines.slice(start)) {
    block.push(line);
  }

  return block.join("\n");
};

const formatSection = (title: string, content: string): string =>
  [
    `=== ${title} ===`,
    content.trim().length > 0 ? content.trimEnd() : "(empty)",
    "",
  ].join("\n");

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const homeDir = await mkdtemp(join(tmpdir(), "lore-live-transcript-"));
  const config = resolveConfig({
    sharedStoragePath: join(homeDir, ".lore", "shared.json"),
    approvalLedgerPath: join(homeDir, ".lore", "approval-ledger.json"),
    observationDir: join(homeDir, ".lore", "observations"),
    draftDir: join(homeDir, ".lore", "drafts"),
    consolidationStatePath: join(homeDir, ".lore", "consolidation-state.json"),
    projectMemoryDir: join(homeDir, ".lore", "projects"),
    whisperStateDir: join(homeDir, ".lore", "whisper-sessions"),
  });

  try {
    const initialStopInput = {
      session_id: "session-live-1",
      cwd: "/tmp/workspaces/billing-service",
      prompt:
        "Please update the migration. All database columns must use snake_case naming.",
      assistant_response:
        "I will update the migration and keep the new column names snake_case.",
      tool_calls: [{ tool_name: "Edit", file_path: "src/db/migrate.ts" }],
      files_modified: ["src/db/migrate.ts"],
    };

    await runStopObserver(JSON.stringify(initialStopInput), {
      config,
      now: () => "2026-03-29T02:00:00.000Z",
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
    });

    const sessionStart = await runLoreCommand(
      ["src/plugin/session-start.ts"],
      homeDir,
      JSON.stringify({
        session_id: "session-live-2",
        cwd: "/tmp/workspaces/billing-service",
      }),
    );

    if (sessionStart.code !== 0) {
      throw new Error(`SessionStart failed:\n${sessionStart.stderr}`);
    }

    const sessionStartPayload = JSON.parse(sessionStart.stdout) as {
      additionalContext: string;
    };

    const whisperBeforeApproval = await runLoreCommand(
      ["src/plugin/pre-prompt-whisper.ts"],
      homeDir,
      JSON.stringify({
        session_id: "session-live-2",
        cwd: "/tmp/workspaces/billing-service",
        prompt: "Please update the database column naming.",
      }),
    );

    if (whisperBeforeApproval.code !== 0) {
      throw new Error(`Pre-prompt whisper failed:\n${whisperBeforeApproval.stderr}`);
    }

    const sessionKey = deriveSessionKey(
      "session-live-2",
      "/tmp/workspaces/billing-service",
    );
    const stateAfterSuggestion = await readWhisperState(
      sessionKey,
      config.whisperStateDir,
    );

    const approvalStep = await runLoreCommand(
      ["src/plugin/pre-prompt-whisper.ts"],
      homeDir,
      JSON.stringify({
        session_id: "session-live-2",
        cwd: "/tmp/workspaces/billing-service",
        prompt: "lore yes",
      }),
    );

    if (approvalStep.code !== 0) {
      throw new Error(`Approval step failed:\n${approvalStep.stderr}`);
    }

    const stateAfterApproval = await readWhisperState(
      sessionKey,
      config.whisperStateDir,
    );
    const sharedEntries = await readJsonFile<SharedEntrySummary[]>(
      config.sharedStoragePath,
    );
    const draftContent = await readFile(
      join(config.draftDir, "session-live-1.jsonl"),
      "utf8",
    );

    const transcript = [
      formatSection(
        "Harness",
        [
          `Home dir: ${homeDir}`,
          `Keep artifacts: ${options.keepArtifacts ? "yes" : "no"}`,
        ].join("\n"),
      ),
      formatSection("Turn 1 User", initialStopInput.prompt),
      formatSection("Turn 1 Assistant", initialStopInput.assistant_response),
      formatSection(
        "Lore Action After Stop",
        [
          "Draft candidate written by automatic ingestion:",
          draftContent.trim(),
        ].join("\n"),
      ),
      formatSection(
        "Next SessionStart Context",
        sessionStartPayload.additionalContext,
      ),
      formatSection("Turn 2 User", "Please update the database column naming."),
      formatSection("Lore Whisper Output", whisperBeforeApproval.stdout),
      formatSection(
        "Expected Visible Codex Prelude",
        [
          "If Codex follows the SessionStart instruction, this block should appear at the top of the assistant reply:",
          extractVisibleBlock(whisperBeforeApproval.stdout),
        ].join("\n"),
      ),
      formatSection(
        "State After Suggestion",
        JSON.stringify(stateAfterSuggestion.visibleItems, null, 2),
      ),
      formatSection("Turn 2 User Approval", "lore yes"),
      formatSection("Lore Receipt Output", approvalStep.stdout),
      formatSection(
        "State After Approval",
        JSON.stringify(
          {
            activeReceipt: stateAfterApproval.activeReceipt,
            visibleItems: stateAfterApproval.visibleItems,
          },
          null,
          2,
        ),
      ),
      formatSection(
        "Shared Knowledge Snapshot",
        JSON.stringify(sharedEntries, null, 2),
      ),
      formatSection(
        "Notes",
        [
          "The whisper output above is the exact hook payload Lore injects.",
          "The visible Codex chat rendering is still best-effort because the current integration relies on the assistant echoing [Lore · visible].",
        ].join("\n"),
      ),
    ].join("");

    process.stdout.write(transcript);
  } finally {
    if (!options.keepArtifacts) {
      await rm(homeDir, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nArtifacts kept at: ${dirname(config.sharedStoragePath)}\n`);
    }
  }
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
