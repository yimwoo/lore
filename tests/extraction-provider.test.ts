import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractDraftCandidates,
  type DraftCandidate,
  type ExtractionProvider,
  type TurnArtifact,
} from "../src/extraction/extraction-provider";
import {
  consolidateDraftCandidates,
  type ConsolidatedEntry,
  type ConsolidationInput,
  type ConsolidationProvider,
} from "../src/extraction/consolidation-provider";
import { CodexExtractionProvider } from "../src/extraction/codex-extraction-provider";
import type { SharedKnowledgeEntry } from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

const makeTurnArtifact = (): TurnArtifact => ({
  sessionId: "session-1",
  projectId: "project-alpha",
  turnIndex: 4,
  turnTimestamp: "2026-03-28T19:55:00.000Z",
  userPrompt: "Please keep database columns snake_case.",
  assistantResponse: "I will follow the snake_case naming rule.",
  toolSummaries: ["migration succeeded"],
  files: ["src/db/migrate.ts"],
  recentToolNames: ["Bash", "Edit"],
});

const makeDraftCandidate = (): DraftCandidate => ({
  id: "draft-1",
  kind: "domain_rule",
  title: "Use snake_case for DB columns",
  content: "All database columns use snake_case naming.",
  confidence: 0.84,
  evidenceNote: "Observed after a user correction about naming.",
  sessionId: "session-1",
  projectId: "project-alpha",
  turnIndex: 4,
  timestamp: "2026-03-28T19:55:01.000Z",
  tags: ["database", "naming"],
});

const makePendingEntry = (): SharedKnowledgeEntry => ({
  id: "sk-pending-1",
  kind: "domain_rule",
  title: "Pending snake_case rule",
  content: "Use snake_case for columns.",
  confidence: 0.8,
  tags: ["database"],
  sourceProjectIds: ["project-alpha"],
  sourceMemoryIds: [],
  promotionSource: "suggested",
  createdBy: "system",
  approvalStatus: "pending",
  sessionCount: 3,
  projectCount: 1,
  lastSeenAt: "2026-03-28T19:40:00.000Z",
  contentHash: contentHash("Use snake_case for columns."),
  createdAt: "2026-03-28T19:40:00.000Z",
  updatedAt: "2026-03-28T19:40:00.000Z",
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("provider seams", () => {
  it("runs extraction through an injected stub provider", async () => {
    const turn = makeTurnArtifact();
    const drafts = [makeDraftCandidate()];
    const calls: TurnArtifact[] = [];

    const provider: ExtractionProvider = {
      extractCandidates: async (input: TurnArtifact): Promise<DraftCandidate[]> => {
        calls.push(input);
        return drafts;
      },
    };

    const result = await extractDraftCandidates(provider, turn);

    expect(result).toEqual(drafts);
    expect(calls).toEqual([turn]);
  });

  it("runs consolidation through an injected stub provider", async () => {
    const input: ConsolidationInput = {
      drafts: [makeDraftCandidate()],
      observations: [
        {
          contentHash: contentHash("All database columns use snake_case naming."),
          sessionCount: 4,
          projectCount: 2,
          lastSeenAt: "2026-03-28T19:55:01.000Z",
          confidence: 0.92,
          sampleProjectIds: ["project-alpha", "project-beta"],
        },
      ],
      existingPendingEntries: [makePendingEntry()],
    };
    const entries: ConsolidatedEntry[] = [
      {
        entry: makePendingEntry(),
        consumedEntryIds: ["sk-pending-2"],
      },
    ];
    const calls: ConsolidationInput[] = [];

    const provider: ConsolidationProvider = {
      consolidate: async (
        value: ConsolidationInput,
      ): Promise<{ entries: ConsolidatedEntry[] }> => {
        calls.push(value);
        return { entries };
      },
    };

    const result = await consolidateDraftCandidates(provider, input);

    expect(result.entries).toEqual(entries);
    expect(calls).toEqual([input]);
  });
});

describe("CodexExtractionProvider auth warnings", () => {
  it("warns once when the Responses API returns 401", async () => {
    const warnings: string[] = [];
    const writes: string[] = [];
    const provider = new CodexExtractionProvider({
      readFile: async (path: string): Promise<string> => {
        if (path.endsWith("/.codex/auth.json")) {
          return JSON.stringify({ OPENAI_API_KEY: "sk-test" });
        }
        if (path.endsWith("/.codex/config.toml")) {
          return 'base_url = "https://api.example.com/v1"\nmodel = "gpt-5.4"\n';
        }
        throw new Error("missing");
      },
      writeFile: async (path: string, content: string): Promise<void> => {
        writes.push(`${path}:${content}`);
      },
      mkdir: async (): Promise<string | undefined> => undefined,
      fetch: async (): Promise<Response> =>
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      now: () => "2026-03-28T21:00:00.000Z",
      warn: (message: string): void => {
        warnings.push(message);
      },
    });

    const result = await provider.extractCandidates(makeTurnArtifact());

    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("401");
    expect(warnings[0]).toContain("API key");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("lastAuthWarningAt");
  });

  it("rate-limits repeated auth warnings inside the cooldown window", async () => {
    const warnings: string[] = [];
    const writes: string[] = [];
    const provider = new CodexExtractionProvider({
      readFile: async (path: string): Promise<string> => {
        if (path.endsWith("/.codex/auth.json")) {
          return JSON.stringify({ OPENAI_API_KEY: "sk-test" });
        }
        if (path.endsWith("/.codex/config.toml")) {
          return 'base_url = "https://api.example.com/v1"\n';
        }
        if (path.endsWith("/.lore/auth-warning-state.json")) {
          return JSON.stringify({ lastAuthWarningAt: "2026-03-28T20:30:00.000Z" });
        }
        throw new Error("missing");
      },
      writeFile: async (path: string, content: string): Promise<void> => {
        writes.push(`${path}:${content}`);
      },
      mkdir: async (): Promise<string | undefined> => undefined,
      fetch: async (): Promise<Response> =>
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      now: () => "2026-03-28T21:00:00.000Z",
      warn: (message: string): void => {
        warnings.push(message);
      },
    });

    const result = await provider.extractCandidates(makeTurnArtifact());

    expect(result).toEqual([]);
    expect(warnings).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("does not warn for non-auth API failures", async () => {
    const warnings: string[] = [];
    const provider = new CodexExtractionProvider({
      readFile: async (path: string): Promise<string> => {
        if (path.endsWith("/.codex/auth.json")) {
          return JSON.stringify({ OPENAI_API_KEY: "sk-test" });
        }
        if (path.endsWith("/.codex/config.toml")) {
          return 'base_url = "https://api.example.com/v1"\n';
        }
        throw new Error("missing");
      },
      writeFile: async (): Promise<void> => undefined,
      mkdir: async (): Promise<string | undefined> => undefined,
      fetch: async (): Promise<Response> =>
        new Response(JSON.stringify({ error: "server" }), { status: 500 }),
      now: () => "2026-03-28T21:00:00.000Z",
      warn: (message: string): void => {
        warnings.push(message);
      },
    });

    const result = await provider.extractCandidates(makeTurnArtifact());

    expect(result).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it("emits trace events when extraction logging is enabled", async () => {
    vi.resetModules();
    vi.stubEnv("LORE_DEBUG", "trace");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const { CodexExtractionProvider: ExtractionProviderWithLogging } = await import(
      "../src/extraction/codex-extraction-provider"
    );
    const provider = new ExtractionProviderWithLogging({
      readFile: async (path: string): Promise<string> => {
        if (path.endsWith("/.codex/auth.json")) {
          return JSON.stringify({ OPENAI_API_KEY: "sk-test" });
        }
        if (path.endsWith("/.codex/config.toml")) {
          return 'base_url = "https://api.example.com/v1"\nmodel = "gpt-5.4"\n';
        }
        throw new Error("missing");
      },
      fetch: async (): Promise<Response> =>
        new Response(JSON.stringify({
          output_text: JSON.stringify([{
            kind: "domain_rule",
            title: "Use snake_case",
            content: "All database columns use snake_case naming.",
            confidence: 0.9,
          }]),
        }), { status: 200 }),
    });

    const result = await provider.extractCandidates(makeTurnArtifact());
    stderrSpy.mockRestore();

    expect(result).toHaveLength(1);
    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
    expect(lines.some((line) => line.event === "extraction.config_loaded")).toBe(true);
    expect(lines.some((line) => line.event === "extraction.llm_request_started")).toBe(true);
    expect(lines.some((line) => line.event === "extraction.candidates_parsed")).toBe(true);
  });

  it("emits a skip trace when extraction config is incomplete", async () => {
    vi.resetModules();
    vi.stubEnv("LORE_DEBUG", "trace");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const { CodexExtractionProvider: ExtractionProviderWithLogging } = await import(
      "../src/extraction/codex-extraction-provider"
    );
    const provider = new ExtractionProviderWithLogging({
      readFile: async (): Promise<string> => {
        throw new Error("missing");
      },
    });

    const result = await provider.extractCandidates(makeTurnArtifact());
    stderrSpy.mockRestore();

    expect(result).toEqual([]);
    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: { reason?: string } });
    expect(lines.some((line) => line.event === "extraction.llm_skipped")).toBe(true);
    expect(lines.some((line) => line.data?.reason === "missing_api_key")).toBe(true);
  });
});
