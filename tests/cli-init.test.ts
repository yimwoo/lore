import { Readable, Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

import {
  ensureDirs,
  estimateRuleCount,
  scanForFiles,
  runInit,
} from "../src/cli/init";
import type { InitResult, ScanResult } from "../src/cli/init";
import { resolveConfig } from "../src/config";

const tempDirs: string[] = [];

const createWritable = (): { stream: Writable; read: () => string } => {
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

const createReadable = (data: string = ""): Readable => {
  const r = new Readable({
    read() {
      if (data) {
        this.push(data);
        data = "";
      } else {
        this.push(null);
      }
    },
  });
  return r;
};

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lore-init-test-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  vi.restoreAllMocks();
});

describe("scanForFiles", () => {
  it("returns empty array for empty directory", async () => {
    const dir = await makeTempDir();
    const results = await scanForFiles(dir);
    expect(results).toEqual([]);
  });

  it("returns CLAUDE.md and .cursorrules in priority order", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "CLAUDE.md"), "# Claude instructions");
    await writeFile(join(dir, ".cursorrules"), "cursor rules");

    const results = await scanForFiles(dir);
    expect(results).toHaveLength(2);
    expect(results[0]!.filename).toBe(".cursorrules");
    expect(results[1]!.filename).toBe("CLAUDE.md");
  });

  it("returns README.md with isReadmeOnly: true", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "README.md"), "# My Project");

    const results = await scanForFiles(dir);
    expect(results).toHaveLength(1);
    expect(results[0]!.filename).toBe("README.md");
    expect(results[0]!.isReadmeOnly).toBe(true);
  });

  it("returns .cursor/rules/*.mdc files as separate results at priority 2", async () => {
    const dir = await makeTempDir();
    const cursorRulesDir = join(dir, ".cursor", "rules");
    await mkdir(cursorRulesDir, { recursive: true });
    await writeFile(join(cursorRulesDir, "style.mdc"), "---\ntitle: style\n---\nrules");
    await writeFile(join(cursorRulesDir, "naming.mdc"), "---\ntitle: naming\n---\nrules");
    await writeFile(join(dir, "CLAUDE.md"), "# Claude");

    const results = await scanForFiles(dir);
    // .cursor/rules/*.mdc comes before CLAUDE.md in priority
    const filenames = results.map((r) => r.filename);
    expect(filenames).toContain(".cursor/rules/naming.mdc");
    expect(filenames).toContain(".cursor/rules/style.mdc");
    expect(filenames).toContain("CLAUDE.md");

    // .mdc files should come before CLAUDE.md
    const mdcIndex1 = filenames.indexOf(".cursor/rules/naming.mdc");
    const mdcIndex2 = filenames.indexOf(".cursor/rules/style.mdc");
    const claudeIndex = filenames.indexOf("CLAUDE.md");
    expect(mdcIndex1).toBeLessThan(claudeIndex);
    expect(mdcIndex2).toBeLessThan(claudeIndex);
  });

  it("returns all 9 file types in priority order", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".cursorrules"), "rules");
    const cursorRulesDir = join(dir, ".cursor", "rules");
    await mkdir(cursorRulesDir, { recursive: true });
    await writeFile(join(cursorRulesDir, "test.mdc"), "rules");
    await writeFile(join(dir, "CLAUDE.md"), "# Claude");
    await writeFile(join(dir, ".clinerules"), "rules");
    await writeFile(join(dir, ".windsurfrules"), "rules");
    await writeFile(join(dir, "AGENTS.md"), "# Agents");
    await writeFile(join(dir, "agents.md"), "# agents");
    await writeFile(join(dir, "CONVENTIONS.md"), "# Conventions");
    await writeFile(join(dir, "README.md"), "# README");

    const results = await scanForFiles(dir);
    const filenames = results.map((r) => r.filename);

    expect(filenames).toEqual([
      ".cursorrules",
      ".cursor/rules/test.mdc",
      "CLAUDE.md",
      ".clinerules",
      ".windsurfrules",
      "AGENTS.md",
      "agents.md",
      "CONVENTIONS.md",
      "README.md",
    ]);

    // Verify README is marked as readme-only
    const readme = results.find((r) => r.filename === "README.md");
    expect(readme!.isReadmeOnly).toBe(true);

    // Verify all others are not readme-only
    const importable = results.filter((r) => !r.isReadmeOnly);
    expect(importable).toHaveLength(8);
  });

  it("returns empty array for non-existent directory", async () => {
    const dir = join(tmpdir(), "lore-init-nonexistent-" + Date.now());
    const results = await scanForFiles(dir);
    expect(results).toEqual([]);
  });
});

describe("estimateRuleCount", () => {
  it("counts lines starting with dash", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "rules.md");
    await writeFile(filePath, "- rule 1\n- rule 2\n- rule 3\n- rule 4\n- rule 5\n");
    const count = await estimateRuleCount(filePath);
    expect(count).toBe(5);
  });

  it("counts lines starting with asterisk", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "rules.md");
    await writeFile(filePath, "* rule 1\n* rule 2\n* rule 3\n");
    const count = await estimateRuleCount(filePath);
    expect(count).toBe(3);
  });

  it("counts lines starting with ### and ####", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "rules.md");
    await writeFile(filePath, "# Title\n## Section\n### Rule 1\n#### Rule 2\n##### Rule 3\nSome text\n");
    const count = await estimateRuleCount(filePath);
    expect(count).toBe(3);
  });

  it("counts mixed content correctly", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "rules.md");
    await writeFile(filePath, "# Title\nSome text\n- rule 1\nMore text\n* rule 2\n### Heading\nParagraph\n");
    const count = await estimateRuleCount(filePath);
    expect(count).toBe(3);
  });

  it("returns 0 for empty file", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "empty.md");
    await writeFile(filePath, "");
    const count = await estimateRuleCount(filePath);
    expect(count).toBe(0);
  });

  it("returns 0 for non-existent file", async () => {
    const count = await estimateRuleCount("/nonexistent/file.md");
    expect(count).toBe(0);
  });
});

describe("ensureDirs", () => {
  it("creates all subdirectories and returns true when base dir does not exist", async () => {
    const dir = await makeTempDir();
    const baseDir = join(dir, "lore-new");

    const config = resolveConfig({
      sharedStoragePath: join(baseDir, "shared.json"),
      approvalLedgerPath: join(baseDir, "approval-ledger.json"),
      observationDir: join(baseDir, "observations"),
      draftDir: join(baseDir, "drafts"),
      projectMemoryDir: join(baseDir, "projects"),
      whisperStateDir: join(baseDir, "whisper-sessions"),
    });

    const created = await ensureDirs(config);
    expect(created).toBe(true);

    expect(existsSync(join(baseDir, "observations"))).toBe(true);
    expect(existsSync(join(baseDir, "drafts"))).toBe(true);
    expect(existsSync(join(baseDir, "projects"))).toBe(true);
    expect(existsSync(join(baseDir, "whisper-sessions"))).toBe(true);
  });

  it("returns false when base dir already exists", async () => {
    const dir = await makeTempDir();
    const baseDir = join(dir, "lore-existing");
    await mkdir(baseDir, { recursive: true });
    await mkdir(join(baseDir, "observations"), { recursive: true });
    await mkdir(join(baseDir, "drafts"), { recursive: true });
    await mkdir(join(baseDir, "projects"), { recursive: true });
    await mkdir(join(baseDir, "whisper-sessions"), { recursive: true });

    const config = resolveConfig({
      sharedStoragePath: join(baseDir, "shared.json"),
      approvalLedgerPath: join(baseDir, "approval-ledger.json"),
      observationDir: join(baseDir, "observations"),
      draftDir: join(baseDir, "drafts"),
      projectMemoryDir: join(baseDir, "projects"),
      whisperStateDir: join(baseDir, "whisper-sessions"),
    });

    const created = await ensureDirs(config);
    expect(created).toBe(false);
  });
});

describe("runInit", () => {
  it("imports files with --yes flag and shows progress", async () => {
    const projectDir = await makeTempDir();
    const sharedDir = await makeTempDir();

    // Create convention files with importable content
    await writeFile(
      join(projectDir, "CLAUDE.md"),
      "# Claude Instructions\n\n## Conventions\n\n### Use TypeScript strict mode\n\nAlways enable strict mode in tsconfig.json.\n\n### Use arrow functions\n\nPrefer arrow functions over function declarations.\n",
    );
    await writeFile(
      join(projectDir, ".cursorrules"),
      "# Cursor Rules\n\n### Always use ESM imports\n\nUse import/export syntax, not require/module.exports.\n",
    );

    const stdout = createWritable();
    const stderr = createWritable();

    await runInit(
      {
        yes: true,
        "project-dir": projectDir,
        "shared-dir": sharedDir,
      },
      {
        stdin: createReadable(),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const output = stdout.read();
    expect(output).toContain("Found 2 convention file");
    expect(output).toContain("Importing");
    expect(output).toContain("Lore is ready.");
  });

  it("prints guidance when no convention files found", async () => {
    const projectDir = await makeTempDir();
    const sharedDir = await makeTempDir();

    const stdout = createWritable();
    const stderr = createWritable();

    await runInit(
      {
        yes: true,
        "project-dir": projectDir,
        "shared-dir": sharedDir,
      },
      {
        stdin: createReadable(),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const output = stdout.read();
    expect(output).toContain("No convention files found.");
    expect(output).toContain("lore promote");
    expect(output).toContain("Lore is ready.");
  });

  it("outputs valid JSON with --json flag", async () => {
    const projectDir = await makeTempDir();
    const sharedDir = await makeTempDir();

    await writeFile(
      join(projectDir, "CLAUDE.md"),
      "# Instructions\n\n### Rule one\n\nDo this thing.\n",
    );

    const stdout = createWritable();
    const stderr = createWritable();

    await runInit(
      {
        yes: true,
        json: true,
        "project-dir": projectDir,
        "shared-dir": sharedDir,
      },
      {
        stdin: createReadable(),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const output = stdout.read().trim();
    const parsed = JSON.parse(output) as InitResult;
    expect(parsed.dirsCreated).toBeDefined();
    expect(typeof parsed.filesScanned).toBe("number");
    expect(Array.isArray(parsed.filesFound)).toBe(true);
    expect(Array.isArray(parsed.filesImported)).toBe(true);
    expect(typeof parsed.entriesCreated).toBe("number");
    expect(typeof parsed.byKind).toBe("object");
  });

  it("shows README.md in 'Also found' but does not import it", async () => {
    const projectDir = await makeTempDir();
    const sharedDir = await makeTempDir();

    await writeFile(join(projectDir, "README.md"), "# My Project\n\nThis is a readme.\n");

    const stdout = createWritable();
    const stderr = createWritable();

    await runInit(
      {
        yes: true,
        "project-dir": projectDir,
        "shared-dir": sharedDir,
      },
      {
        stdin: createReadable(),
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const output = stdout.read();
    expect(output).toContain("Also found:");
    expect(output).toContain("README.md");
    expect(output).toContain("not auto-imported");
    // Should show "No convention files found" because README is the only file
    expect(output).toContain("No convention files found.");
  });

  it("reports zero new entries on second run (idempotency)", async () => {
    const projectDir = await makeTempDir();
    const sharedDir = await makeTempDir();

    await writeFile(
      join(projectDir, "CLAUDE.md"),
      "# Instructions\n\n### Use strict mode\n\nAlways enable strict mode.\n",
    );

    const makeStreams = () => {
      const stdout = createWritable();
      const stderr = createWritable();
      return {
        streams: {
          stdin: createReadable(),
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
        stdout,
        stderr,
      };
    };

    // First run
    const first = makeStreams();
    await runInit(
      {
        yes: true,
        "project-dir": projectDir,
        "shared-dir": sharedDir,
      },
      first.streams,
    );

    // Second run
    const second = makeStreams();
    await runInit(
      {
        yes: true,
        "project-dir": projectDir,
        "shared-dir": sharedDir,
      },
      second.streams,
    );

    const secondOutput = second.stdout.read();
    // The second run should report 0 entries created because duplicates are skipped
    expect(secondOutput).toContain("Created 0");
  });
});
