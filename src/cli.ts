import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { createLoreApp } from "./app";
import { parseRawSessionEvent } from "./bridge/events";
import { FileMemoryStore } from "./core/memory-store";
import { FileSharedStore } from "./core/file-shared-store";
import { FileApprovalStore } from "./promotion/approval-store";
import { Promoter } from "./promotion/promoter";
import { ObservationLogReader } from "./promotion/observation-log";
import { contentHash } from "./shared/validators";
import { resolveConfig } from "./config";
import type { LoreSnapshot } from "./core/daemon";
import type { MemoryEntry, SharedKnowledgeEntry, SharedKnowledgeKind } from "./shared/types";
import { isSharedKnowledgeKind } from "./shared/types";

type CliStreams = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
};

const helpText = `Lore CLI

Usage:
  lore <command> [options]

Commands:
  demo                           Run a simulated Lore session
  serve                          Read newline-delimited JSON events from stdin
  memories                       Print stored project memories
  promote                        Promote knowledge to shared store
  list-shared                    List shared knowledge entries
  inspect <id>                   Show full shared knowledge entry + ledger
  demote <id>                    Soft-delete a shared knowledge entry
  approve <id>                   Approve a pending suggestion
  reject <id>                    Reject a pending suggestion
  suggest                        Show observation/debug info for the retired suggestion path
  help                           Show this help message

Options:
  --project <id>                 Project identifier
  --storage-dir <path>           Directory for project-scoped memory files
  --shared-dir <path>            Directory for shared knowledge files
  --kind <kind>                  Shared knowledge kind
  --title <title>                Entry title
  --content <content>            Entry content
  --tags <tags>                  Comma-separated tags
  --status <status>              Filter by approval status
  --reason <reason>              Reason for demote
  --json                         Print JSON output
`;

type ParsedArgs = {
  command: string;
  positional: string[];
  options: Record<string, string | boolean>;
};

const parseArgs = (argv: string[]): ParsedArgs => {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) {
      positional.push(token!);
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { command, positional, options };
};

const requireOption = (
  options: Record<string, string | boolean>,
  key: string,
): string => {
  const value = options[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing required option --${key}`);
};

const renderSnapshotText = (snapshot: LoreSnapshot): string => {
  const lines = ["Lore snapshot"];
  const hint = snapshot.latestHint;

  if (hint) {
    lines.push("Hint:");
    for (const bullet of hint.bullets) {
      lines.push(`- ${bullet.category}: ${bullet.text}`);
    }
  } else {
    lines.push("Hint: none");
  }

  lines.push(`Memories: ${snapshot.memories.length}`);
  lines.push(`Events: ${snapshot.events.length}`);
  lines.push(`Activity: ${snapshot.activity.length}`);
  return lines.join("\n");
};

const renderMemoriesText = (projectId: string, memories: MemoryEntry[]): string => {
  const lines = [`Lore memories for ${projectId}`];

  if (memories.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }

  for (const memory of memories) {
    lines.push(`- ${memory.kind}: ${memory.content}`);
  }

  return lines.join("\n");
};

const writeOutput = (
  stream: Writable,
  content: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(`${content}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const runDemo = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
) => {
  const projectId =
    typeof options.project === "string" ? options.project : "demo-project";
  const storageDir =
    typeof options["storage-dir"] === "string"
      ? options["storage-dir"]
      : join(tmpdir(), "lore-demo");

  await rm(storageDir, { recursive: true, force: true });
  await mkdir(storageDir, { recursive: true });

  const app = createLoreApp({
    projectId,
    storageDir,
  });

  await app.ingest({
    kind: "user_prompt_submitted",
    prompt: "Let's keep memory project scoped for v1.",
    files: ["src/shared/types.ts"],
  });
  await app.ingest({
    kind: "tool_run_failed",
    toolName: "npm test",
    summary: "npm test failed while running the hint suite.",
  });
  await app.ingest({
    kind: "assistant_response_completed",
    response: "Next I will inspect src/echo/hint-engine.ts.",
    files: ["src/echo/hint-engine.ts"],
  });

  const snapshot = app.sidecar.getSnapshot();
  const output =
    options.json === true
      ? JSON.stringify(snapshot, null, 2)
      : `${renderSnapshotText(snapshot)}\nStorage: ${storageDir}`;

  await writeOutput(streams.stdout, output);
};

const runServe = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
) => {
  const projectId = requireOption(options, "project");
  const storageDir = requireOption(options, "storage-dir");
  const app = createLoreApp({
    projectId,
    storageDir,
  });

  const reader = createInterface({
    input: streams.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let snapshot: LoreSnapshot;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const event = parseRawSessionEvent(parsed);
      snapshot = await app.ingest(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeOutput(streams.stderr, `Skipped invalid event: ${message}`);
      continue;
    }

    const output =
      options.json === true
        ? JSON.stringify(snapshot, null, 2)
        : renderSnapshotText(snapshot);
    await writeOutput(streams.stdout, output);
  }
};

const runMemories = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
) => {
  const projectId = requireOption(options, "project");
  const storageDir = requireOption(options, "storage-dir");
  const store = new FileMemoryStore({ storageDir });
  const memories = await store.listByProject(projectId);
  const output =
    options.json === true
      ? JSON.stringify(memories, null, 2)
      : renderMemoriesText(projectId, memories);
  await writeOutput(streams.stdout, output);
};

const createPromoter = (options: Record<string, string | boolean>) => {
  const sharedDir =
    typeof options["shared-dir"] === "string" ? options["shared-dir"] : undefined;
  const config = resolveConfig({
    sharedStoragePath: sharedDir ? join(sharedDir, "shared.json") : undefined,
    approvalLedgerPath: sharedDir
      ? join(sharedDir, "approval-ledger.json")
      : undefined,
    observationDir: sharedDir
      ? join(sharedDir, "observations")
      : undefined,
  });

  const sharedStore = new FileSharedStore({
    storagePath: config.sharedStoragePath,
  });

  const approvalStore = new FileApprovalStore({
    ledgerPath: config.approvalLedgerPath,
    sharedStore,
  });

  return { sharedStore, approvalStore, promoter: new Promoter({
    sharedStore,
    approvalStore,
    policy: config.promotionPolicy,
  }), config };
};

const runPromote = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
) => {
  const kind = requireOption(options, "kind");
  if (!isSharedKnowledgeKind(kind)) {
    throw new Error(`Invalid kind: ${kind}. Must be one of: domain_rule, architecture_fact, decision_record, user_preference, glossary_term`);
  }

  const title = requireOption(options, "title");
  const content = requireOption(options, "content");
  const tags =
    typeof options.tags === "string"
      ? options.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
  const sourceProjectId =
    typeof options.project === "string" ? options.project : undefined;

  const { promoter } = createPromoter(options);
  const result = await promoter.promoteExplicit({
    kind: kind as SharedKnowledgeKind,
    title,
    content,
    tags,
    sourceProjectId,
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }

  const output =
    options.json === true
      ? JSON.stringify(result.entry, null, 2)
      : `Promoted: ${result.entry.id} (${result.action})\n  ${result.entry.kind}: ${result.entry.title}`;

  await writeOutput(streams.stdout, output);
};

const renderSharedListText = (entries: SharedKnowledgeEntry[]): string => {
  if (entries.length === 0) {
    return "No shared knowledge entries found.";
  }

  const lines = ["ID                | Kind              | Title                          | Confidence | Status   | Projects"];
  lines.push("------------------|-------------------|--------------------------------|------------|----------|--------");

  for (const entry of entries) {
    const id = entry.id.padEnd(18);
    const kind = entry.kind.padEnd(19);
    const title = entry.title.length > 30
      ? `${entry.title.slice(0, 27)}...`
      : entry.title.padEnd(30);
    const confidence = entry.confidence.toFixed(2).padEnd(12);
    const status = entry.approvalStatus.padEnd(10);
    const projects = String(entry.projectCount);
    lines.push(`${id}| ${kind}| ${title} | ${confidence}| ${status}| ${projects}`);
  }

  return lines.join("\n");
};

const runListShared = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
) => {
  const { sharedStore } = createPromoter(options);

  const kind =
    typeof options.kind === "string" && isSharedKnowledgeKind(options.kind)
      ? (options.kind as SharedKnowledgeKind)
      : undefined;

  const status =
    typeof options.status === "string"
      ? (options.status as SharedKnowledgeEntry["approvalStatus"])
      : undefined;

  const entries = await sharedStore.list({
    kind,
    approvalStatus: status,
  });

  const output =
    options.json === true
      ? JSON.stringify(entries, null, 2)
      : renderSharedListText(entries);

  await writeOutput(streams.stdout, output);
};

const runInspect = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
  entryId: string,
) => {
  const { sharedStore, approvalStore } = createPromoter(options);

  const entry = await sharedStore.getById(entryId);
  if (!entry) {
    throw new Error(`Entry not found: ${entryId}`);
  }

  const ledger = await approvalStore.list(entryId);

  if (options.json === true) {
    await writeOutput(
      streams.stdout,
      JSON.stringify({ entry, ledger }, null, 2),
    );
    return;
  }

  const lines = [
    `Entry: ${entry.id}`,
    `Kind: ${entry.kind}`,
    `Title: ${entry.title}`,
    `Content: ${entry.content}`,
    `Confidence: ${entry.confidence}`,
    `Status: ${entry.approvalStatus}`,
    `Tags: ${entry.tags.join(", ") || "(none)"}`,
    `Source Projects: ${entry.sourceProjectIds.join(", ") || "(none)"}`,
    `Sessions: ${entry.sessionCount}, Projects: ${entry.projectCount}`,
    `Created: ${entry.createdAt}`,
    `Updated: ${entry.updatedAt}`,
    "",
    "Ledger:",
  ];

  if (ledger.length === 0) {
    lines.push("  (no ledger entries)");
  } else {
    for (const le of ledger) {
      lines.push(
        `  ${le.timestamp} | ${le.action} | ${le.actor}${le.reason ? ` | ${le.reason}` : ""}`,
      );
    }
  }

  await writeOutput(streams.stdout, lines.join("\n"));
};

const runDemote = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
  entryId: string,
) => {
  const reason = requireOption(options, "reason");
  const { promoter } = createPromoter(options);

  const result = await promoter.demote(entryId, reason);
  if (!result.ok) {
    throw new Error(result.reason);
  }

  const output =
    options.json === true
      ? JSON.stringify(result.entry, null, 2)
      : `Demoted: ${result.entry.id}\n  Reason: ${reason}`;

  await writeOutput(streams.stdout, output);
};

const runApprove = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
  entryId: string,
) => {
  const reason =
    typeof options.reason === "string" ? options.reason : undefined;
  const { promoter } = createPromoter(options);
  const result = await promoter.approve(entryId, reason);
  if (!result.ok) throw new Error(result.reason);

  const output =
    options.json === true
      ? JSON.stringify(result.entry, null, 2)
      : `Approved: ${result.entry.id}\n  ${result.entry.title}`;
  await writeOutput(streams.stdout, output);
};

const runReject = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
  entryId: string,
) => {
  const reason = requireOption(options, "reason");
  const { promoter } = createPromoter(options);
  const result = await promoter.reject(entryId, reason);
  if (!result.ok) throw new Error(result.reason);

  const output =
    options.json === true
      ? JSON.stringify(result.entry, null, 2)
      : `Rejected: ${result.entry.id}\n  Reason: ${reason}`;
  await writeOutput(streams.stdout, output);
};

const runSuggest = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
) => {
  const { config } = createPromoter(options);

  const reader = new ObservationLogReader({
    observationDir: config.observationDir,
  });
  const observations = await reader.readAll();

  const output =
    options.json === true
      ? JSON.stringify({
          retired: true,
          observations: observations.length,
        })
      : `SuggestionEngine is retired. Pending entries are now created by SessionStart consolidation. Observation log currently has ${observations.length} entr${observations.length === 1 ? "y" : "ies"}.`;
  await writeOutput(streams.stdout, output);
};

export const runCli = async (
  argv: string[],
  streams: CliStreams = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> => {
  const parsed = parseArgs(argv);

  try {
    switch (parsed.command) {
      case "demo":
        await runDemo(parsed.options, streams);
        return 0;
      case "serve":
        await runServe(parsed.options, streams);
        return 0;
      case "memories":
        await runMemories(parsed.options, streams);
        return 0;
      case "promote":
        await runPromote(parsed.options, streams);
        return 0;
      case "list-shared":
        await runListShared(parsed.options, streams);
        return 0;
      case "inspect": {
        const inspectId = parsed.positional[0];
        if (!inspectId) throw new Error("Missing entry ID for inspect command.");
        await runInspect(parsed.options, streams, inspectId);
        return 0;
      }
      case "demote": {
        const demoteId = parsed.positional[0];
        if (!demoteId) throw new Error("Missing entry ID for demote command.");
        await runDemote(parsed.options, streams, demoteId);
        return 0;
      }
      case "approve": {
        const approveId = parsed.positional[0];
        if (!approveId) throw new Error("Missing entry ID for approve command.");
        await runApprove(parsed.options, streams, approveId);
        return 0;
      }
      case "reject": {
        const rejectId = parsed.positional[0];
        if (!rejectId) throw new Error("Missing entry ID for reject command.");
        await runReject(parsed.options, streams, rejectId);
        return 0;
      }
      case "suggest":
        await runSuggest(parsed.options, streams);
        return 0;
      case "help":
      case "--help":
      case "-h":
      default:
        await writeOutput(streams.stdout, helpText);
        return 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeOutput(streams.stderr, `Lore CLI error: ${message}`);
    return 1;
  }
};
