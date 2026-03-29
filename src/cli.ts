import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { createLoreApp } from "./app";
import { parseRawSessionEvent } from "./bridge/events";
import { aggregateDashboard, renderDashboardText } from "./core/dashboard-aggregator";
import { FileMemoryStore } from "./core/memory-store";
import { FileSharedStore } from "./core/file-shared-store";
import { FileApprovalStore } from "./promotion/approval-store";
import { FileConflictStore } from "./promotion/conflict-store";
import { Promoter } from "./promotion/promoter";
import type { PromoteImportResult } from "./promotion/promoter";
import { parseMarkdownEntries } from "./core/markdown-parser";
import type { ImportCandidate } from "./core/markdown-parser";
import { runInit } from "./cli/init";
import { ObservationLogReader } from "./promotion/observation-log";
import { contentHash } from "./shared/validators";
import { resolveConfig } from "./config";
import type { LoreSnapshot } from "./core/daemon";
import type { MemoryEntry, SharedKnowledgeEntry, SharedKnowledgeKind } from "./shared/types";
import { isSharedKnowledgeKind } from "./shared/types";
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "./shared/debug-log";

export type CliStreams = {
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
  import <file>                  Import knowledge from a convention file
  init                             Interactive onboarding — scan and import convention files
  suggest                        Show observation/debug info for the retired suggestion path
  dashboard                      Show knowledge base overview and health
  resolve <idA> <idB>            Resolve a conflict between two entries
  history <id>                   Show the supersession chain for an entry
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
  --approve-all                  Approve all imported entries immediately
  --tag-prefix <prefix>          Add a tag prefix to all imported entries
  --dry-run                      Show what would be imported without writing
  --yes                            Import all found files without prompting
  --project-dir <path>             Project directory to scan (default: cwd)
  --json                         Print JSON output
  --tag <tag>                    Filter by tag
  --stale                        Show entries not seen in 60+ days
  --contradictions               Show entries with contradictions flagged
  --keep <id>                    Keep this entry, demote the other
  --scope <id>                   Scope this entry (use with --project)
  --merge                        Merge both entries into one
  --dismiss                      Dismiss the conflict, keep both as-is
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
    conflictStoragePath: sharedDir
      ? join(sharedDir, "conflicts.json")
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

  const lines = ["ID                | Kind              | Title                          | Confidence | Status   | Approval Source     | Projects"];
  lines.push("------------------|-------------------|--------------------------------|------------|----------|---------------------|--------");

  for (const entry of entries) {
    const id = entry.id.padEnd(18);
    const kind = entry.kind.padEnd(19);
    const title = entry.title.length > 30
      ? `${entry.title.slice(0, 27)}...`
      : entry.title.padEnd(30);
    const confidence = entry.confidence.toFixed(2).padEnd(12);
    const status = entry.approvalStatus.padEnd(10);
    const approvalSource = (entry.approvalSource ?? "manual").padEnd(21);
    const projects = String(entry.projectCount);
    lines.push(`${id}| ${kind}| ${title} | ${confidence}| ${status}| ${approvalSource}| ${projects}`);
  }

  return lines.join("\n");
};

const runListShared = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
) => {
  const { sharedStore, config } = createPromoter(options);

  const kind =
    typeof options.kind === "string" && isSharedKnowledgeKind(options.kind)
      ? (options.kind as SharedKnowledgeKind)
      : undefined;

  const status =
    typeof options.status === "string"
      ? (options.status as SharedKnowledgeEntry["approvalStatus"])
      : undefined;

  let entries = await sharedStore.list({
    kind,
    approvalStatus: status,
  });

  if (typeof options.tag === "string") {
    const tagValue = options.tag;
    entries = entries.filter((e) => e.tags.includes(tagValue));
  }

  if (options.stale === true) {
    const threshold = config.staleDaysThreshold;
    const now = Date.now();
    entries = entries.filter((e) => {
      const diffMs = now - new Date(e.lastSeenAt).getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      return diffDays >= threshold;
    });
  }

  if (options.contradictions === true) {
    entries = entries.filter((e) => (e.contradictionCount ?? 0) > 0);
  }

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
    `Approval Source: ${entry.approvalSource ?? "manual"}`,
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

type ImportResult = {
  candidate: ImportCandidate;
  outcome: PromoteImportResult;
};

const importCandidates = async (
  promoter: Promoter,
  candidates: ImportCandidate[],
  sourceFilePath: string,
  approveAll: boolean,
): Promise<ImportResult[]> => {
  const results: ImportResult[] = [];

  for (const candidate of candidates) {
    const outcome = await promoter.promoteImport({
      kind: candidate.inferredKind,
      title: candidate.title,
      content: candidate.content,
      tags: candidate.tags,
      sourceFilePath: basename(sourceFilePath),
      approveAll,
    });

    results.push({ candidate, outcome });
  }

  return results;
};

const renderImportSummary = (
  results: ImportResult[],
  filePath: string,
  approveAll: boolean,
): string => {
  const created = results.filter((r) => r.outcome.ok && r.outcome.action === "created");
  const skipped = results.filter((r) => r.outcome.ok && r.outcome.action === "skipped");
  const failed = results.filter((r) => !r.outcome.ok);

  const kindCounts: Record<string, number> = {};
  for (const r of created) {
    if (r.outcome.ok) {
      const k = r.outcome.entry.kind;
      kindCounts[k] = (kindCounts[k] ?? 0) + 1;
    }
  }

  const kindBreakdown = Object.entries(kindCounts)
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}${n === 1 ? "" : "s"}`)
    .join(", ");

  const status = approveAll ? "approved" : "pending";
  const lines = [
    `Imported ${created.length} entries from ${basename(filePath)} (${kindBreakdown}).`,
    `Status: ${status}.`,
  ];

  if (skipped.length > 0) {
    lines.push(`Skipped ${skipped.length} duplicate${skipped.length === 1 ? "" : "s"}.`);
  }
  if (failed.length > 0) {
    lines.push(`Failed: ${failed.length} entr${failed.length === 1 ? "y" : "ies"} (validation errors).`);
    for (const f of failed) {
      if (!f.outcome.ok) {
        lines.push(`  - "${f.candidate.title}": ${f.outcome.reason}`);
      }
    }
  }

  if (!approveAll && created.length > 0) {
    lines.push(`Review with: lore list-shared --status pending`);
  }

  return lines.join("\n");
};

const renderDryRunOutput = (
  candidates: ImportCandidate[],
  filePath: string,
): string => {
  const lines = [
    `Dry run: ${candidates.length} entries would be imported from ${basename(filePath)}`,
    "",
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const preview = c.content.length > 80
      ? `${c.content.slice(0, 77)}...`
      : c.content;
    lines.push(`${i + 1}. [${c.inferredKind}] ${c.title}`);
    lines.push(`   ${preview}`);
    if (c.tags.length > 0) {
      lines.push(`   tags: ${c.tags.join(", ")}`);
    }
  }

  return lines.join("\n");
};

const runImport = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
  filePath: string,
): Promise<void> => {
  const absolutePath = resolve(filePath);
  const raw = await readFile(absolutePath, "utf8");

  const kindOverride =
    typeof options.kind === "string" && isSharedKnowledgeKind(options.kind)
      ? (options.kind as SharedKnowledgeKind)
      : undefined;
  const tagPrefix =
    typeof options["tag-prefix"] === "string" ? options["tag-prefix"] : undefined;

  const candidates = parseMarkdownEntries(raw, { kindOverride, tagPrefix });

  if (candidates.length === 0) {
    await writeOutput(streams.stdout, "No importable entries found in file.");
    return;
  }

  const approveAll = options["approve-all"] === true;
  const dryRun = options["dry-run"] === true;

  if (dryRun) {
    await writeOutput(streams.stdout, renderDryRunOutput(candidates, absolutePath));
    return;
  }

  const { promoter } = createPromoter(options);
  const results = await importCandidates(
    promoter,
    candidates,
    absolutePath,
    approveAll,
  );

  await writeOutput(streams.stdout, renderImportSummary(results, absolutePath, approveAll));
};

const runResolve = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
  idA: string,
  idB: string,
): Promise<void> => {
  const { promoter, sharedStore, approvalStore, config } = createPromoter(options);
  const conflictStore = new FileConflictStore({
    storagePath: config.conflictStoragePath,
  });

  const conflict = await conflictStore.findByEntryIds(idA, idB);
  if (!conflict) {
    throw new Error(
      `No conflict found between ${idA} and ${idB}. Run \`lore list-shared --contradictions\` to see flagged entries.`,
    );
  }

  const entryA = await sharedStore.getById(idA);
  const entryB = await sharedStore.getById(idB);
  if (!entryA || !entryB) {
    throw new Error(`One or both entries not found: ${idA}, ${idB}`);
  }

  if (typeof options.keep === "string") {
    const keepId = options.keep;
    const demoteId = keepId === idA ? idB : idA;

    if (keepId !== idA && keepId !== idB) {
      throw new Error(`--keep must be one of: ${idA}, ${idB}`);
    }

    await approvalStore.append({
      knowledgeEntryId: keepId,
      action: "resolve",
      actor: "user",
      reason: `Resolved conflict: kept ${keepId}, demoted ${demoteId}`,
      metadata: {
        conflictId: conflict.id,
        resolution: keepId === idA ? "keep_a" : "keep_b",
        supersededEntryId: demoteId,
        supersessionReason: "superseded:user_correction",
      },
    });

    await promoter.demote(demoteId, `Superseded by ${keepId} (conflict resolution)`);

    await conflictStore.resolve(
      conflict.id,
      keepId === idA ? "keep_a" : "keep_b",
      `User kept ${keepId}`,
    );

    await writeOutput(
      streams.stdout,
      `Resolved: kept ${keepId}, demoted ${demoteId}.\n  Conflict ${conflict.id} marked resolved.`,
    );
    return;
  }

  if (options.dismiss === true) {
    await approvalStore.append({
      knowledgeEntryId: idA,
      action: "resolve",
      actor: "user",
      reason: "Conflict dismissed: user confirmed both entries are valid",
      metadata: {
        conflictId: conflict.id,
        resolution: "dismiss",
      },
    });

    await conflictStore.resolve(conflict.id, "dismiss", "User dismissed conflict");

    await sharedStore.update(idA, {
      contradictionCount: Math.max(0, (entryA.contradictionCount ?? 1) - 1),
    });
    await sharedStore.update(idB, {
      contradictionCount: Math.max(0, (entryB.contradictionCount ?? 1) - 1),
    });

    await writeOutput(
      streams.stdout,
      `Dismissed conflict between ${idA} and ${idB}.\n  Both entries remain as-is.`,
    );
    return;
  }

  if (typeof options.scope === "string" && typeof options.project === "string") {
    const scopeId = options.scope;
    const projectName = options.project;

    if (scopeId !== idA && scopeId !== idB) {
      throw new Error(`--scope must be one of: ${idA}, ${idB}`);
    }

    await sharedStore.update(scopeId, {
      tags: [...(scopeId === idA ? entryA : entryB).tags, `project:${projectName}`],
    });

    await approvalStore.append({
      knowledgeEntryId: scopeId,
      action: "resolve",
      actor: "user",
      reason: `Scoped ${scopeId} to project ${projectName}`,
      metadata: {
        conflictId: conflict.id,
        resolution: "scope",
        supersessionReason: "superseded:scope_narrowed",
      },
    });

    await conflictStore.resolve(
      conflict.id,
      "scope",
      `Scoped ${scopeId} to project ${projectName}`,
    );

    await writeOutput(
      streams.stdout,
      `Resolved: scoped ${scopeId} to project "${projectName}".\n  Both entries remain valid.`,
    );
    return;
  }

  if (options.merge === true) {
    const mergedContent = `${entryA.content}\n${entryB.content}`;
    const mergedTags = Array.from(new Set([...entryA.tags, ...entryB.tags]));

    const result = await promoter.promoteExplicit({
      kind: entryA.kind,
      title: `Merged: ${entryA.title}`,
      content: mergedContent,
      tags: mergedTags,
    });

    if (!result.ok) {
      throw new Error(`Merge failed: ${result.reason}`);
    }

    await promoter.demote(idA, `Merged into ${result.entry.id}`);
    await promoter.demote(idB, `Merged into ${result.entry.id}`);

    await approvalStore.append({
      knowledgeEntryId: result.entry.id,
      action: "resolve",
      actor: "user",
      reason: `Merged ${idA} and ${idB}`,
      metadata: {
        conflictId: conflict.id,
        resolution: "merge",
        supersededEntryId: `${idA},${idB}`,
        supersessionReason: "superseded:merged",
      },
    });

    await conflictStore.resolve(
      conflict.id,
      "merge",
      `Merged into ${result.entry.id}`,
    );

    await writeOutput(
      streams.stdout,
      `Resolved: merged ${idA} and ${idB} into ${result.entry.id}.\n  Original entries demoted.`,
    );
    return;
  }

  throw new Error(
    `Specify a resolution: --keep <id>, --scope <id> --project <name>, --merge, or --dismiss`,
  );
};

const runHistory = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
  entryId: string,
): Promise<void> => {
  const { sharedStore, approvalStore } = createPromoter(options);

  const entry = await sharedStore.getById(entryId);
  if (!entry) {
    throw new Error(`Entry not found: ${entryId}`);
  }

  const allLedger = await approvalStore.readAll();

  const superseded = allLedger.filter(
    (le) =>
      le.knowledgeEntryId === entryId &&
      le.metadata?.supersededEntryId,
  );

  const supersededBy = allLedger.filter(
    (le) =>
      le.metadata?.supersededEntryId === entryId ||
      (typeof le.metadata?.supersededEntryId === "string" &&
       le.metadata.supersededEntryId.split(",").includes(entryId)),
  );

  const lines = [
    `History for ${entryId}`,
    `  Kind: ${entry.kind}`,
    `  Title: ${entry.title}`,
    `  Status: ${entry.approvalStatus}`,
    `  Content: ${entry.content}`,
    "",
  ];

  if (supersededBy.length > 0) {
    lines.push("Superseded by:");
    for (const le of supersededBy) {
      const reason = le.metadata?.supersessionReason ?? "unknown";
      lines.push(`  ${le.knowledgeEntryId} (${reason}) at ${le.timestamp}`);
    }
    lines.push("");
  }

  if (superseded.length > 0) {
    lines.push("Supersedes:");
    for (const le of superseded) {
      const targetId = le.metadata?.supersededEntryId;
      const reason = le.metadata?.supersessionReason ?? "unknown";
      lines.push(`  ${targetId} (${reason}) at ${le.timestamp}`);
    }
    lines.push("");
  }

  const ledger = await approvalStore.list(entryId);
  lines.push("Ledger:");
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

const runDashboard = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
): Promise<void> => {
  const { sharedStore, approvalStore, config } = createPromoter(options);

  const approvedEntries = await sharedStore.list({ approvalStatus: "approved" });
  const pendingEntries = await sharedStore.list({ approvalStatus: "pending" });
  const rejectedEntries = await sharedStore.list({ approvalStatus: "rejected" });
  const demotedEntries = await sharedStore.list({ approvalStatus: "demoted" });
  const entries = [...approvedEntries, ...pendingEntries, ...rejectedEntries, ...demotedEntries];

  const ledgerEntries = await approvalStore.readAll();

  const data = aggregateDashboard(entries, ledgerEntries, {
    staleDaysThreshold: config.staleDaysThreshold,
    now: new Date().toISOString(),
  });

  const output = options.json === true
    ? JSON.stringify(data, null, 2)
    : renderDashboardText(data);

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
  const startedAt = Date.now();
  const runId = debugLoggingEnabled ? createRunId() : undefined;
  const log = (
    level: DebugLogLevel,
    event: string,
    data?: Record<string, unknown>,
    extras?: {
      ok?: boolean;
      summary?: string;
    },
  ): void => {
    if (!runId) {
      return;
    }

    dlog({
      level,
      component: "cli",
      event,
      hook: "CLI",
      runId,
      ok: extras?.ok,
      summary: extras?.summary,
      durationMs: Date.now() - startedAt,
      data,
    });
  };
  log("debug", "cli.command_started", {
    command: parsed.command,
    positionalCount: parsed.positional.length,
    optionKeys: Object.keys(parsed.options),
  }, {
    ok: true,
  });

  try {
    switch (parsed.command) {
      case "demo":
        await runDemo(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "serve":
        await runServe(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "memories":
        await runMemories(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "promote":
        await runPromote(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "list-shared":
        await runListShared(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "inspect": {
        const inspectId = parsed.positional[0];
        if (!inspectId) throw new Error("Missing entry ID for inspect command.");
        await runInspect(parsed.options, streams, inspectId);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      }
      case "demote": {
        const demoteId = parsed.positional[0];
        if (!demoteId) throw new Error("Missing entry ID for demote command.");
        await runDemote(parsed.options, streams, demoteId);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      }
      case "approve": {
        const approveId = parsed.positional[0];
        if (!approveId) throw new Error("Missing entry ID for approve command.");
        await runApprove(parsed.options, streams, approveId);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      }
      case "reject": {
        const rejectId = parsed.positional[0];
        if (!rejectId) throw new Error("Missing entry ID for reject command.");
        await runReject(parsed.options, streams, rejectId);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      }
      case "import": {
        const importPath = parsed.positional[0];
        if (!importPath) throw new Error("Missing file path for import command.");
        await runImport(parsed.options, streams, importPath);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      }
      case "init":
        await runInit(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "suggest":
        await runSuggest(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "dashboard":
        await runDashboard(parsed.options, streams);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      case "resolve": {
        const resolveIdA = parsed.positional[0];
        const resolveIdB = parsed.positional[1];
        if (!resolveIdA || !resolveIdB) {
          throw new Error("Usage: lore resolve <idA> <idB> --keep <id> | --scope <id> --project <name> | --merge | --dismiss");
        }
        await runResolve(parsed.options, streams, resolveIdA, resolveIdB);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      }
      case "history": {
        const historyId = parsed.positional[0];
        if (!historyId) throw new Error("Missing entry ID for history command.");
        await runHistory(parsed.options, streams, historyId);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
      default:
        await writeOutput(streams.stdout, helpText);
        log("info", "cli.command_succeeded", {
          command: parsed.command,
        }, {
          ok: true,
          summary: "Lore CLI command completed successfully.",
        });
        return 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", "cli.command_failed", {
      command: parsed.command,
      error: message,
    }, {
      ok: false,
      summary: "Lore CLI command failed.",
    });
    await writeOutput(streams.stderr, `Lore CLI error: ${message}`);
    return 1;
  }
};
