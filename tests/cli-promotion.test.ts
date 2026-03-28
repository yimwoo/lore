import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli";

let testDir: string;

const createStreams = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutData = "";
  let stderrData = "";

  stdout.on("data", (chunk) => {
    stdoutData += chunk.toString();
  });
  stderr.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    getStdout: () => stdoutData,
    getStderr: () => stderrData,
  };
};

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-cli-promo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("CLI promote command", () => {
  it("promotes with --kind/--title/--content", async () => {
    const streams = createStreams();
    const code = await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "Use snake_case",
        "--content", "All DB columns must use snake_case",
        "--shared-dir", testDir,
      ],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("Promoted:");
    expect(streams.getStdout()).toContain("domain_rule");
  });

  it("promotes with tags", async () => {
    const streams = createStreams();
    const code = await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "Use snake_case",
        "--content", "All DB columns must use snake_case",
        "--tags", "naming,database",
        "--shared-dir", testDir,
      ],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("Promoted:");
  });

  it("fails with forbidden content", async () => {
    const streams = createStreams();
    const code = await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "Bad",
        "--content", "/src/foo.ts needs refactoring",
        "--shared-dir", testDir,
      ],
      streams,
    );

    expect(code).toBe(1);
    expect(streams.getStderr()).toContain("forbidden pattern");
  });

  it("fails without required options", async () => {
    const streams = createStreams();
    const code = await runCli(
      ["promote", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(1);
    expect(streams.getStderr()).toContain("Missing required option");
  });
});

describe("CLI list-shared command", () => {
  it("shows promoted entries", async () => {
    const streams1 = createStreams();
    await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "Use snake_case",
        "--content", "All DB columns must use snake_case",
        "--shared-dir", testDir,
      ],
      streams1,
    );

    const streams2 = createStreams();
    const code = await runCli(
      ["list-shared", "--shared-dir", testDir],
      streams2,
    );

    expect(code).toBe(0);
    expect(streams2.getStdout()).toContain("Use snake_case");
  });

  it("shows demoted entries with --status demoted", async () => {
    // Promote first
    const streams1 = createStreams();
    await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "Temp rule",
        "--content", "Temporary rule to demote",
        "--shared-dir", testDir,
      ],
      streams1,
    );

    // Extract ID from output
    const promoteOutput = streams1.getStdout();
    const idMatch = promoteOutput.match(/Promoted: (sk-\S+)/);
    const entryId = idMatch?.[1] ?? "";

    // Demote
    const streams2 = createStreams();
    await runCli(
      ["demote", entryId, "--reason", "outdated", "--shared-dir", testDir],
      streams2,
    );

    // List demoted
    const streams3 = createStreams();
    const code = await runCli(
      ["list-shared", "--status", "demoted", "--shared-dir", testDir],
      streams3,
    );

    expect(code).toBe(0);
    expect(streams3.getStdout()).toContain("Temp rule");
  });

  it("returns empty when no entries", async () => {
    const streams = createStreams();
    const code = await runCli(
      ["list-shared", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(0);
    expect(streams.getStdout()).toContain("No shared knowledge entries found");
  });

  it("supports --json output", async () => {
    const streams1 = createStreams();
    await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "JSON test",
        "--content", "Testing JSON output",
        "--shared-dir", testDir,
      ],
      streams1,
    );

    const streams2 = createStreams();
    await runCli(
      ["list-shared", "--json", "--shared-dir", testDir],
      streams2,
    );

    const parsed = JSON.parse(streams2.getStdout());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].title).toBe("JSON test");
  });
});

describe("CLI inspect command", () => {
  it("shows entry and ledger", async () => {
    const streams1 = createStreams();
    await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "Inspectable",
        "--content", "Content for inspection",
        "--shared-dir", testDir,
      ],
      streams1,
    );

    const idMatch = streams1.getStdout().match(/Promoted: (sk-\S+)/);
    const entryId = idMatch?.[1] ?? "";

    const streams2 = createStreams();
    const code = await runCli(
      ["inspect", entryId, "--shared-dir", testDir],
      streams2,
    );

    expect(code).toBe(0);
    const output = streams2.getStdout();
    expect(output).toContain(`Entry: ${entryId}`);
    expect(output).toContain("Inspectable");
    expect(output).toContain("Ledger:");
    expect(output).toContain("promote");
  });

  it("fails for nonexistent entry", async () => {
    const streams = createStreams();
    const code = await runCli(
      ["inspect", "nonexistent", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(1);
    expect(streams.getStderr()).toContain("not found");
  });
});

describe("CLI demote command", () => {
  it("demotes an entry", async () => {
    const streams1 = createStreams();
    await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "To demote",
        "--content", "Content to demote",
        "--shared-dir", testDir,
      ],
      streams1,
    );

    const idMatch = streams1.getStdout().match(/Promoted: (sk-\S+)/);
    const entryId = idMatch?.[1] ?? "";

    const streams2 = createStreams();
    const code = await runCli(
      ["demote", entryId, "--reason", "no longer needed", "--shared-dir", testDir],
      streams2,
    );

    expect(code).toBe(0);
    expect(streams2.getStdout()).toContain("Demoted:");
  });

  it("fails without --reason", async () => {
    const streams1 = createStreams();
    await runCli(
      [
        "promote",
        "--kind", "domain_rule",
        "--title", "No reason",
        "--content", "Missing reason test",
        "--shared-dir", testDir,
      ],
      streams1,
    );

    const idMatch = streams1.getStdout().match(/Promoted: (sk-\S+)/);
    const entryId = idMatch?.[1] ?? "";

    const streams2 = createStreams();
    const code = await runCli(
      ["demote", entryId, "--shared-dir", testDir],
      streams2,
    );

    expect(code).toBe(1);
    expect(streams2.getStderr()).toContain("Missing required option --reason");
  });

  it("fails without entry ID", async () => {
    const streams = createStreams();
    const code = await runCli(
      ["demote", "--reason", "test", "--shared-dir", testDir],
      streams,
    );

    expect(code).toBe(1);
    expect(streams.getStderr()).toContain("Missing entry ID");
  });
});
