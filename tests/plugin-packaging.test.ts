import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("plugin packaging", () => {
  it("bundles MCP servers from the plugin manifest", async () => {
    const manifestPath = join(repoRoot, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      author?: { name?: string; url?: string };
      homepage?: string;
      hooks?: string;
      interface?: {
        brandColor?: string;
        capabilities?: string[];
        composerIcon?: string;
        defaultPrompt?: string[];
        developerName?: string;
        displayName?: string;
        logo?: string;
        screenshots?: string[];
        shortDescription?: string;
        websiteURL?: string;
      };
      keywords?: string[];
      mcpServers?: string;
      repository?: string;
      skills?: string;
    };

    expect(manifest.skills).toBe("./skills/");
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.author?.name).toBe("Yiming Wu");
    expect(manifest.author?.url).toBe("https://github.com/yimwoo");
    expect(manifest.homepage).toBe("https://github.com/yimwoo/lore");
    expect(manifest.repository).toBe("https://github.com/yimwoo/lore");
    expect(manifest.keywords).toContain("memory");
    expect(manifest.keywords).toContain("whisper");
    expect(manifest.interface?.displayName).toBe("Lore");
    expect(manifest.interface?.shortDescription).toBe(
      "Cross-project memory — rules, decisions, and context that persist across sessions.",
    );
    expect(manifest.interface?.developerName).toBe("Yiming Wu");
    expect(manifest.interface?.capabilities).toEqual([
      "Interactive",
      "Read",
      "Write",
    ]);
    expect(manifest.interface?.defaultPrompt).toEqual([
      "What domain rules apply to this codebase?",
      "Recall architecture decisions relevant to this task",
      "Search Lore for conventions I should follow here",
    ]);
    expect(manifest.interface?.websiteURL).toBe(
      "https://github.com/yimwoo/lore",
    );
    expect(manifest.interface?.brandColor).toBe("#534AB7");
    expect(manifest.interface?.composerIcon).toBe("./assets/lore-icon.png");
    expect(manifest.interface?.logo).toBe("./assets/lore-logo.png");
    expect(manifest.interface?.screenshots).toEqual([
      "./assets/lore-social-preview.png",
    ]);
  });

  it("ships plugin presentation assets referenced by the manifest", async () => {
    await access(join(repoRoot, "assets", "lore-icon.png"));
    await access(join(repoRoot, "assets", "lore-logo.png"));
    await access(join(repoRoot, "assets", "lore-social-preview.png"));
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

  it("registers the user-global Codex plugin with a relative source path", async () => {
    const installScriptPath = join(repoRoot, "install.sh");
    const installScript = await readFile(installScriptPath, "utf8");

    expect(installScript).toContain(
      'MARKETPLACE_PLUGIN_PATH="./.codex/plugins/lore-source"',
    );
    expect(installScript).toContain(
      'CODEX_PLUGIN_CACHE_ROOT="$HOME/.codex/plugins/cache/codex-plugins/lore"',
    );
    expect(installScript).toContain("refresh_codex_plugin_cache");
  });
});
