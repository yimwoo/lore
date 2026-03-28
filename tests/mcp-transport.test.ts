import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SharedKnowledgeEntry } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

let testDir: string;
let sharedStorePath: string;

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => {
  const content = overrides?.content ?? "Default test content";
  return {
    id: `sk-transport-${Math.random().toString(36).slice(2, 6)}`,
    kind: "domain_rule",
    title: "Transport test rule",
    content,
    confidence: 0.9,
    tags: ["test"],
    sourceProjectIds: ["proj-1"],
    sourceMemoryIds: [],
    promotionSource: "explicit",
    createdBy: "user",
    approvalStatus: "approved",
    approvedAt: "2026-01-01T00:00:00Z",
    sessionCount: 1,
    projectCount: 1,
    lastSeenAt: "2026-01-10T00:00:00Z",
    contentHash: contentHash(content),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-10T00:00:00Z",
    ...overrides,
  };
};

const sendToTransport = (
  input: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--import", "tsx", "src/mcp/stdio-transport.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write(input);
    child.stdin.end();

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    // Safety timeout
    setTimeout(() => {
      child.kill();
    }, 5000);
  });
};

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-transport-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  sharedStorePath = join(testDir, "shared.json");
  await mkdir(testDir, { recursive: true });

  // Seed store
  const entries = [
    makeEntry({
      title: "Use snake_case",
      content: "All DB columns must use snake_case",
      contentHash: contentHash("All DB columns must use snake_case"),
    }),
  ];
  await writeFile(sharedStorePath, JSON.stringify(entries, null, 2), "utf8");
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("STDIO transport", () => {
  it("returns tool list on tools/list", async () => {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    const { stdout } = await sendToTransport(
      request + "\n",
      { LORE_SHARED_STORE_PATH: sharedStorePath },
    );

    const response = JSON.parse(stdout.trim());
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result.tools).toHaveLength(4);

    const toolNames = response.result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(toolNames).toContain("lore.recall_rules");
    expect(toolNames).toContain("lore.recall_architecture");
    expect(toolNames).toContain("lore.recall_decisions");
    expect(toolNames).toContain("lore.search_knowledge");
  });

  it("returns recall results on tools/call", async () => {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lore.recall_rules",
        arguments: {},
      },
    });

    const { stdout } = await sendToTransport(
      request + "\n",
      { LORE_SHARED_STORE_PATH: sharedStorePath },
    );

    const response = JSON.parse(stdout.trim());
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(2);
    expect(response.result.content).toHaveLength(1);

    const result = JSON.parse(response.result.content[0].text);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe("Use snake_case");
  });

  it("returns error for malformed JSON", async () => {
    const { stdout } = await sendToTransport(
      "this is not json\n",
      { LORE_SHARED_STORE_PATH: sharedStorePath },
    );

    const response = JSON.parse(stdout.trim());
    expect(response.error).toBeTruthy();
    expect(response.error.code).toBe(-32700);
    expect(response.error.message).toBe("Parse error");
  });

  it("returns error for unknown method", async () => {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "unknown/method",
    });

    const { stdout } = await sendToTransport(
      request + "\n",
      { LORE_SHARED_STORE_PATH: sharedStorePath },
    );

    const response = JSON.parse(stdout.trim());
    expect(response.error).toBeTruthy();
    expect(response.error.code).toBe(-32601);
  });

  it("emits MCP trace events to stderr when debug logging is enabled", async () => {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "lore.recall_rules",
        arguments: {},
      },
    });

    const { stderr } = await sendToTransport(
      request + "\n",
      {
        LORE_SHARED_STORE_PATH: sharedStorePath,
        LORE_DEBUG: "trace",
      },
    );

    const lines = stderr
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
    expect(lines.some((line) => line.event === "mcp.request_received")).toBe(true);
    expect(lines.some((line) => line.event === "mcp.tool_called")).toBe(true);
    expect(lines.some((line) => line.event === "mcp.tool_succeeded")).toBe(true);
    expect(lines.some((line) => line.event === "mcp.response_sent")).toBe(true);
  });
});
