import { describe, expect, it } from "vitest";

import type { ExtractionProvider } from "../src/extraction/extraction-provider";
import { applyStopUpdate, buildTurnArtifact, runStopObserver } from "../src/plugin/stop-observer";
import type { WhisperSessionState } from "../src/shared/types";
import { resolveConfig } from "../src/config";

const config = resolveConfig().whisper;

const makeState = (
  overrides?: Partial<WhisperSessionState>,
): WhisperSessionState => ({
  sessionKey: "test-key",
  turnIndex: 3,
  recentFiles: ["old-file.ts"],
  recentToolNames: ["Read"],
  whisperHistory: [],
  injectedContentHashes: ["hash-1"],
  ...overrides,
});

describe("applyStopUpdate", () => {
  it("increments turnIndex", () => {
    const updated = applyStopUpdate(makeState(), {});
    expect(updated.turnIndex).toBe(4);
  });

  it("updates recentFiles from files_modified + files_read", () => {
    const updated = applyStopUpdate(makeState(), {
      files_modified: ["src/new.ts"],
      files_read: ["src/read.ts"],
    });
    expect(updated.recentFiles).toContain("src/new.ts");
    expect(updated.recentFiles).toContain("src/read.ts");
    expect(updated.recentFiles).toContain("old-file.ts");
  });

  it("updates recentToolNames from tool_calls", () => {
    const updated = applyStopUpdate(makeState(), {
      tool_calls: [
        { tool_name: "Edit", file_path: "src/foo.ts" },
        { tool_name: "Bash" },
      ],
    });
    expect(updated.recentToolNames).toContain("Edit");
    expect(updated.recentToolNames).toContain("Bash");
    expect(updated.recentToolNames).toContain("Read");
  });

  it("keeps existing files when fields are missing", () => {
    const updated = applyStopUpdate(makeState(), {});
    expect(updated.recentFiles).toEqual(["old-file.ts"]);
  });

  it("keeps existing tool names when field is missing", () => {
    const updated = applyStopUpdate(makeState(), {});
    expect(updated.recentToolNames).toEqual(["Read"]);
  });

  it("deduplicates files", () => {
    const updated = applyStopUpdate(
      makeState({ recentFiles: ["src/foo.ts"] }),
      { files_modified: ["src/foo.ts", "src/bar.ts"] },
    );
    const fooCount = updated.recentFiles.filter(
      (f) => f === "src/foo.ts",
    ).length;
    expect(fooCount).toBe(1);
    expect(updated.recentFiles).toContain("src/bar.ts");
  });

  it("preserves whisperHistory and injectedContentHashes", () => {
    const state = makeState({
      whisperHistory: [
        {
          contentHash: "abc",
          kind: "domain_rule",
          source: "shared",
          topReason: "keyword",
          turnIndex: 2,
          whisperCount: 1,
        },
      ],
      injectedContentHashes: ["hash-1", "hash-2"],
    });

    const updated = applyStopUpdate(state, {
      files_modified: ["new.ts"],
    });

    expect(updated.whisperHistory).toHaveLength(1);
    expect(updated.injectedContentHashes).toEqual(["hash-1", "hash-2"]);
  });

  it("handles empty tool_calls array", () => {
    const updated = applyStopUpdate(makeState(), { tool_calls: [] });
    expect(updated.recentToolNames).toEqual(["Read"]);
  });
});

describe("buildTurnArtifact", () => {
  it("builds a turn artifact from stop-hook input and updated state", () => {
    const artifact = buildTurnArtifact(
      makeState({
        turnIndex: 4,
        recentToolNames: ["Read", "Edit"],
      }),
      {
        session_id: "session-1",
        cwd: "/tmp/workspaces/billing-service",
        prompt: "Please use snake_case.",
        assistant_response: "I will update the migration.",
        tool_calls: [{ tool_name: "Edit", file_path: "src/db/migrate.ts" }],
        files_modified: ["src/db/migrate.ts"],
        files_read: ["src/plugin/stop-observer.ts"],
      },
      "/tmp/workspaces/billing-service",
      "2026-03-28T20:00:00.000Z",
    );

    expect(artifact).toEqual({
      sessionId: "session-1",
      projectId: "billing-service",
      turnIndex: 4,
      turnTimestamp: "2026-03-28T20:00:00.000Z",
      userPrompt: "Please use snake_case.",
      assistantResponse: "I will update the migration.",
      toolSummaries: ["Edit src/db/migrate.ts"],
      files: ["src/db/migrate.ts", "src/plugin/stop-observer.ts"],
      recentToolNames: ["Read", "Edit"],
    });
  });
});

describe("runStopObserver extraction path", () => {
  it("invokes an injected extraction provider and draft writer", async () => {
    const written: string[] = [];
    const providerCalls: string[] = [];
    const provider: ExtractionProvider = {
      extractCandidates: async (turn) => {
        providerCalls.push(turn.projectId);
        return [
          {
            id: "draft-1",
            kind: "domain_rule",
            title: "Use snake_case",
            content: "All database columns use snake_case naming.",
            confidence: 0.83,
            evidenceNote: "Observed after an explicit correction.",
            sessionId: turn.sessionId,
            projectId: turn.projectId,
            turnIndex: turn.turnIndex,
            timestamp: turn.turnTimestamp,
            tags: ["database"],
          },
        ];
      },
    };

    await runStopObserver(
      JSON.stringify({
        session_id: "session-1",
        cwd: "/tmp/workspaces/billing-service",
        prompt: "Please use snake_case.",
      }),
      {
        config: resolveConfig(),
        provider,
        draftWriter: {
          append: async (entry) => {
            written.push(entry.id);
          },
        },
        readState: async () => makeState(),
        writeState: async () => undefined,
        now: () => "2026-03-28T20:00:00.000Z",
      },
    );

    expect(providerCalls).toEqual(["billing-service"]);
    expect(written).toEqual(["draft-1"]);
  });

  it("swallows extraction failures after writing whisper state", async () => {
    let writes = 0;
    const provider: ExtractionProvider = {
      extractCandidates: async () => {
        throw new Error("provider unavailable");
      },
    };

    await expect(
      runStopObserver(
        JSON.stringify({
          session_id: "session-1",
          cwd: "/tmp/workspaces/billing-service",
        }),
        {
          config: resolveConfig(),
          provider,
          readState: async () => makeState(),
          writeState: async () => {
            writes += 1;
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(writes).toBe(1);
  });

  it("swallows draft-writer failures after extraction", async () => {
    const provider: ExtractionProvider = {
      extractCandidates: async () => [
        {
          id: "draft-1",
          kind: "domain_rule",
          title: "Use snake_case",
          content: "All database columns use snake_case naming.",
          confidence: 0.83,
          evidenceNote: "Observed after an explicit correction.",
          sessionId: "session-1",
          projectId: "billing-service",
          turnIndex: 4,
          timestamp: "2026-03-28T20:00:00.000Z",
          tags: ["database"],
        },
      ],
    };

    await expect(
      runStopObserver(
        JSON.stringify({
          session_id: "session-1",
          cwd: "/tmp/workspaces/billing-service",
        }),
        {
          config: resolveConfig(),
          provider,
          draftWriter: {
            append: async () => {
              throw new Error("disk full");
            },
          },
          readState: async () => makeState(),
          writeState: async () => undefined,
          now: () => "2026-03-28T20:00:00.000Z",
        },
      ),
    ).resolves.toBeUndefined();
  });
});
