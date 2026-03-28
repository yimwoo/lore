import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("plugin packaging", () => {
  it("bundles MCP servers from the plugin manifest", async () => {
    const manifestPath = join(repoRoot, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      mcpServers?: string;
      skills?: string;
    };

    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
  });

  it("defines a stdio MCP server for the bundled plugin", async () => {
    const configPath = join(repoRoot, ".mcp.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers?: Record<
        string,
        { command?: string; args?: string[]; transport?: string }
      >;
    };

    expect(config.mcpServers?.["lore"]).toEqual({
      command: "node",
      args: ["--import", "tsx", "./src/mcp/stdio-transport.ts"],
      transport: "stdio",
    });
  });
});
