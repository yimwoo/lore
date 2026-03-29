import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { resolveConfig } from "../config";
import type { LoreConfig } from "../config";
import { Promoter } from "../promotion/promoter";
import type { PromoteImportResult } from "../promotion/promoter";
import { FileSharedStore } from "../core/file-shared-store";
import { FileApprovalStore } from "../promotion/approval-store";
import { parseMarkdownEntries } from "../core/markdown-parser";
import type { ImportCandidate } from "../core/markdown-parser";

type CliStreams = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
};

export type InitOptions = {
  yes: boolean;
  approveAll: boolean;
  projectDir: string;
  json: boolean;
};

export type InitResult = {
  dirsCreated: boolean;
  filesScanned: number;
  filesFound: string[];
  filesImported: string[];
  entriesCreated: number;
  byKind: Record<string, number>;
};

export type ScanResult = {
  filename: string;
  fullPath: string;
  sizeBytes: number;
  isReadmeOnly: boolean;
};

const writeOutput = (
  stream: Writable,
  content: string,
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    stream.write(`${content}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });

export const ensureDirs = async (config?: LoreConfig): Promise<boolean> => {
  const resolvedConfig = config ?? resolveConfig();
  const baseDir = dirname(resolvedConfig.sharedStoragePath);

  let baseExisted = true;
  try {
    await stat(baseDir);
  } catch {
    baseExisted = false;
  }

  const dirs = [
    baseDir,
    resolvedConfig.observationDir,
    resolvedConfig.draftDir,
    resolvedConfig.projectMemoryDir,
    resolvedConfig.whisperStateDir,
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  return !baseExisted;
};

const SCAN_FILES: Array<{ filename: string; isReadmeOnly: boolean }> = [
  { filename: ".cursorrules", isReadmeOnly: false },
  { filename: "CLAUDE.md", isReadmeOnly: false },
  { filename: ".clinerules", isReadmeOnly: false },
  { filename: ".windsurfrules", isReadmeOnly: false },
  { filename: "AGENTS.md", isReadmeOnly: false },
  { filename: "agents.md", isReadmeOnly: false },
  { filename: "CONVENTIONS.md", isReadmeOnly: false },
  { filename: "README.md", isReadmeOnly: true },
];

export const scanForFiles = async (projectDir: string): Promise<ScanResult[]> => {
  const results: ScanResult[] = [];

  for (const entry of SCAN_FILES) {
    if (entry.filename === "CLAUDE.md") {
      // Before CLAUDE.md (priority 2), check .cursor/rules/*.mdc
      const cursorRulesDir = join(projectDir, ".cursor", "rules");
      try {
        const dirEntries = await readdir(cursorRulesDir);
        const mdcFiles = dirEntries.filter((f) => f.endsWith(".mdc")).sort();
        for (const mdcFile of mdcFiles) {
          const fullPath = join(cursorRulesDir, mdcFile);
          try {
            const fileStat = await stat(fullPath);
            results.push({
              filename: `.cursor/rules/${mdcFile}`,
              fullPath,
              sizeBytes: fileStat.size,
              isReadmeOnly: false,
            });
          } catch {
            // File disappeared between readdir and stat; skip
          }
        }
      } catch {
        // .cursor/rules/ does not exist; skip
      }
    }

    const fullPath = join(projectDir, entry.filename);
    try {
      const fileStat = await stat(fullPath);
      results.push({
        filename: entry.filename,
        fullPath,
        sizeBytes: fileStat.size,
        isReadmeOnly: entry.isReadmeOnly,
      });
    } catch {
      // File does not exist; skip
    }
  }

  return results;
};

export const estimateRuleCount = async (filePath: string): Promise<number> => {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");
    let count = 0;
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || /^#{3,}\s/.test(trimmed)) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB`;
};

const presentScanResults = async (
  projectDir: string,
  results: ScanResult[],
  streams: CliStreams,
): Promise<void> => {
  await writeOutput(streams.stdout, `Scanning ${projectDir} for convention files...`);
  await writeOutput(streams.stdout, "");

  const importable = results.filter((r) => !r.isReadmeOnly);
  const readmeResult = results.find((r) => r.isReadmeOnly);

  if (importable.length === 0) {
    await writeOutput(streams.stdout, "No convention files found.");
    await writeOutput(streams.stdout, "");
    await writeOutput(streams.stdout, `Lore will learn from your coding sessions automatically. You can also:
  - lore promote --kind domain_rule --title "..." --content "..."
    to add rules manually
  - Create a CLAUDE.md or CONVENTIONS.md and run lore init again
  - Tell your coding agent "remember that we always use snake_case"
    and Lore will capture it via the conversational flow`);

    if (readmeResult) {
      await writeOutput(streams.stdout, "");
      await writeOutput(streams.stdout, "Also found:");
      await writeOutput(
        streams.stdout,
        `  - README.md (not auto-imported — run \`lore import README.md\` manually if desired)`,
      );
    }
    return;
  }

  await writeOutput(streams.stdout, `Found ${importable.length} convention file${importable.length === 1 ? "" : "s"}:`);
  for (let i = 0; i < importable.length; i++) {
    const file = importable[i]!;
    const sizeStr = formatSize(file.sizeBytes);
    const paddedName = file.filename.padEnd(20);
    await writeOutput(streams.stdout, `  ${i + 1}. ${paddedName}(${sizeStr})`);
  }

  if (readmeResult) {
    await writeOutput(streams.stdout, "");
    await writeOutput(streams.stdout, "Also found:");
    await writeOutput(
      streams.stdout,
      `  - README.md (not auto-imported — run \`lore import README.md\` manually if desired)`,
    );
  }
};

const promptForImport = async (
  file: ScanResult,
  ruleEstimate: number,
  streams: CliStreams,
): Promise<boolean> => {
  const stdinStream = streams.stdin as NodeJS.ReadStream;
  if (!stdinStream.isTTY) {
    await writeOutput(streams.stderr, "Warning: interactive prompts unavailable (stdin is not a TTY). Importing all files.");
    return true;
  }

  const ask = async (attempt: number): Promise<boolean> => {
    await writeOutput(streams.stdout, `Import ${file.filename}? (~${ruleEstimate} potential rules) [y/N] `);

    const rl = createInterface({ input: streams.stdin, terminal: false });
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.once("line", (line: string) => {
        rl.close();
        resolveAnswer(line.trim().toLowerCase());
      });
    });

    if (answer === "y") {
      return true;
    }
    if (answer === "n" || answer === "") {
      return false;
    }
    // Unrecognized input: re-prompt once, then treat as skip
    if (attempt === 0) {
      return ask(1);
    }
    return false;
  };

  return ask(0);
};

type FileImportResult = {
  ok: true;
  file: string;
  entriesCreated: number;
  byKind: Record<string, number>;
} | {
  ok: false;
  file: string;
  reason: string;
};

const importFile = async (
  filePath: string,
  approveAll: boolean,
  sharedDir?: string,
): Promise<FileImportResult> => {
  try {
    const absolutePath = resolve(filePath);
    const raw = await readFile(absolutePath, "utf8");
    const candidates = parseMarkdownEntries(raw, {});

    if (candidates.length === 0) {
      return {
        ok: false,
        file: filePath,
        reason: "file could not be parsed (empty or unrecognized format)",
      };
    }

    const config = resolveConfig(
      sharedDir
        ? {
            sharedStoragePath: join(sharedDir, "shared.json"),
            approvalLedgerPath: join(sharedDir, "approval-ledger.json"),
            observationDir: join(sharedDir, "observations"),
          }
        : undefined,
    );

    const sharedStore = new FileSharedStore({
      storagePath: config.sharedStoragePath,
    });
    const approvalStore = new FileApprovalStore({
      ledgerPath: config.approvalLedgerPath,
      sharedStore,
    });
    const promoter = new Promoter({
      sharedStore,
      approvalStore,
      policy: config.promotionPolicy,
    });

    const byKind: Record<string, number> = {};
    let entriesCreated = 0;

    for (const candidate of candidates) {
      const outcome = await promoter.promoteImport({
        kind: candidate.inferredKind,
        title: candidate.title,
        content: candidate.content,
        tags: candidate.tags,
        sourceFilePath: basename(absolutePath),
        approveAll,
      });

      if (outcome.ok && outcome.action === "created") {
        entriesCreated += 1;
        const k = outcome.entry.kind;
        byKind[k] = (byKind[k] ?? 0) + 1;
      }
    }

    return {
      ok: true,
      file: filePath,
      entriesCreated,
      byKind,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      file: filePath,
      reason: message,
    };
  }
};

const ORIENTATION_TEXT = `Lore is ready.

How Lore delivers knowledge to your coding agent:
  1. Session start   — approved rules are injected when a session begins
  2. Whispers        — relevant rules surface before each prompt, based on context
  3. MCP tools       — the agent can recall rules on demand via lore.recall_*

Next steps:
  lore list-shared                     View your knowledge base
  lore list-shared --status pending    Review pending entries
  lore approve <id>                    Approve a pending entry
  lore dashboard                       See knowledge base overview`;

export const runInit = async (
  options: Record<string, string | boolean>,
  streams: CliStreams,
): Promise<void> => {
  const yes = options["yes"] === true;
  const approveAll = options["approve-all"] === true;
  const projectDir = typeof options["project-dir"] === "string"
    ? resolve(options["project-dir"])
    : process.cwd();
  const jsonOutput = options["json"] === true;
  const sharedDir = typeof options["shared-dir"] === "string"
    ? options["shared-dir"]
    : undefined;

  const config = resolveConfig(
    sharedDir
      ? {
          sharedStoragePath: join(sharedDir, "shared.json"),
          approvalLedgerPath: join(sharedDir, "approval-ledger.json"),
          observationDir: join(sharedDir, "observations"),
        }
      : undefined,
  );

  // Verify project directory exists
  try {
    await stat(projectDir);
  } catch {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  // Step 2: Ensure directory structure
  const dirsCreated = await ensureDirs(config);

  if (!jsonOutput) {
    if (dirsCreated) {
      await writeOutput(streams.stdout, "Created ~/.lore/ directory structure.");
    } else {
      await writeOutput(streams.stdout, "~/.lore/ directory structure already exists.");
    }
    await writeOutput(streams.stdout, "");
  }

  // Step 3: Scan for convention files
  const scanResults = await scanForFiles(projectDir);

  // Step 4: Present scan results
  if (!jsonOutput) {
    await presentScanResults(projectDir, scanResults, streams);
    await writeOutput(streams.stdout, "");
  }

  const importable = scanResults.filter((r) => !r.isReadmeOnly);

  // Step 5 & 6: Prompt and import
  const filesImported: string[] = [];
  let totalEntriesCreated = 0;
  const totalByKind: Record<string, number> = {};

  for (const file of importable) {
    let shouldImport = false;

    if (jsonOutput || yes) {
      shouldImport = true;
    } else {
      const ruleEstimate = await estimateRuleCount(file.fullPath);
      shouldImport = await promptForImport(file, ruleEstimate, streams);
    }

    if (!shouldImport) {
      continue;
    }

    if (!jsonOutput) {
      await writeOutput(streams.stdout, `Importing ${file.filename}...`);
    }

    const result = await importFile(file.fullPath, approveAll, sharedDir);

    if (result.ok) {
      filesImported.push(file.filename);
      totalEntriesCreated += result.entriesCreated;
      for (const [kind, count] of Object.entries(result.byKind)) {
        totalByKind[kind] = (totalByKind[kind] ?? 0) + count;
      }

      if (!jsonOutput) {
        const status = approveAll ? "approved" : "pending";
        const kindBreakdown = Object.entries(result.byKind)
          .map(([k, n]) => `${n} ${k}`)
          .join(", ");
        await writeOutput(
          streams.stdout,
          `  Created ${result.entriesCreated} ${status} entries (${kindBreakdown})`,
        );
      }
    } else {
      if (!jsonOutput) {
        await writeOutput(streams.stdout, `  Skipped: ${result.reason}`);
      }
    }
  }

  // Step 7: Summary
  if (!jsonOutput && filesImported.length > 0) {
    await writeOutput(streams.stdout, "");
    const status = approveAll ? "approved" : "pending";
    const kindBreakdown = Object.entries(totalByKind)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");

    await writeOutput(
      streams.stdout,
      `Import complete:\n  ${totalEntriesCreated} ${status} entries created from ${filesImported.length} file${filesImported.length === 1 ? "" : "s"}\n  Breakdown: ${kindBreakdown}`,
    );
    await writeOutput(streams.stdout, "");

    if (approveAll) {
      await writeOutput(streams.stdout, `View approved entries:\n  lore list-shared --status approved`);
    } else {
      await writeOutput(streams.stdout, `Review imported entries:\n  lore list-shared --status pending`);
    }
  }

  // Step 8: Orientation
  if (jsonOutput) {
    const initResult: InitResult = {
      dirsCreated,
      filesScanned: scanResults.length,
      filesFound: scanResults.filter((r) => !r.isReadmeOnly).map((r) => r.filename),
      filesImported,
      entriesCreated: totalEntriesCreated,
      byKind: totalByKind,
    };
    await writeOutput(streams.stdout, JSON.stringify(initResult, null, 2));
  } else {
    await writeOutput(streams.stdout, "");
    await writeOutput(streams.stdout, ORIENTATION_TEXT);
  }
};
