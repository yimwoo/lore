import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtractionProvider } from "../src/extraction/extraction-provider";
import {
  applyStopUpdate,
  buildTurnArtifact,
  parseLoreDirectives,
  resolveLoreDirectiveTarget,
  runStopObserver,
} from "../src/plugin/stop-observer";
import type { LoreVisibleItem, WhisperSessionState } from "../src/shared/types";
import { resolveConfig } from "../src/config";

const config = resolveConfig().whisper;
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const makeState = (
  overrides?: Partial<WhisperSessionState>,
): WhisperSessionState => ({
  sessionKey: "test-key",
  turnIndex: 3,
  recentFiles: ["old-file.ts"],
  recentToolNames: ["Read"],
  whisperHistory: [],
  injectedContentHashes: ["hash-1"],
  activeReceipt: undefined,
  visibleItems: [],
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

  it("preserves activeReceipt and visibleItems", () => {
    const state = makeState({
      activeReceipt: {
        sessionKey: "test-key",
        entryId: "sk-0001",
        kind: "saved",
        createdAt: "2026-01-01T00:00:00Z",
        expiresAfterTurn: 4,
        undoCommand: "lore no",
      },
      visibleItems: [
        {
          handle: "@l1",
          entryId: "sk-0001",
          kind: "saved_receipt",
          entryKind: "domain_rule",
          content: "test content",
          actions: ["dismiss"],
          projectId: "proj-a",
          turnIndex: 3,
          actionOnDismiss: "demote_undo_captured",
          actionOnApprove: "approve_pending",
        },
      ],
    });

    const updated = applyStopUpdate(state, {});
    expect(updated.activeReceipt?.entryId).toBe("sk-0001");
    expect(updated.visibleItems?.[0]?.handle).toBe("@l1");
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

describe("parseLoreDirectives", () => {
  it("parses capture directives with explicit kind", () => {
    expect(
      parseLoreDirectives(
        "Done.\n[lore:capture kind=domain_rule] DB columns use snake_case.",
      ),
    ).toEqual([
      {
        type: "capture",
        kind: "domain_rule",
        content: "DB columns use snake_case.",
      },
    ]);
  });

  it("parses approve and dismiss directives", () => {
    expect(
      parseLoreDirectives("[lore:approve id=@l2]\n[lore:dismiss]"),
    ).toEqual([
      { type: "approve", id: "@l2" },
      { type: "dismiss" },
    ]);
  });
});

describe("resolveLoreDirectiveTarget", () => {
  const visibleItems: LoreVisibleItem[] = [
    {
      handle: "@l1",
      entryId: "sk-0001",
      kind: "saved_receipt",
      entryKind: "domain_rule",
      content: "Always use snake_case.",
      actions: ["dismiss"],
      projectId: "proj-a",
      turnIndex: 4,
      actionOnDismiss: "demote_undo_captured",
      actionOnApprove: "approve_pending",
    },
    {
      handle: "@l2",
      entryId: "sk-0002",
      kind: "pending_suggestion",
      entryKind: "domain_rule",
      content: "Feature flags live in config/flags.ts.",
      actions: ["approve", "dismiss"],
      projectId: "proj-a",
      turnIndex: 4,
      actionOnDismiss: "reject_pending",
      actionOnApprove: "approve_pending",
    },
  ];

  it("prefers the receipt for bare dismiss", () => {
    expect(
      resolveLoreDirectiveTarget({ type: "dismiss" }, visibleItems),
    ).toMatchObject({ handle: "@l1" });
  });

  it("targets the first suggested item for bare approve", () => {
    expect(
      resolveLoreDirectiveTarget({ type: "approve" }, visibleItems),
    ).toMatchObject({ handle: "@l2" });
  });

  it("resolves explicit handles directly", () => {
    expect(
      resolveLoreDirectiveTarget({ type: "dismiss", id: "@l2" }, visibleItems),
    ).toMatchObject({ handle: "@l2" });
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

  it("emits a skip trace when no provider is configured", async () => {
    vi.resetModules();
    vi.stubEnv("LORE_DEBUG", "trace");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    const { runStopObserver: runStop } = await import("../src/plugin/stop-observer");
    await runStop(
      JSON.stringify({
        session_id: "session-1",
        cwd: "/tmp/workspaces/billing-service",
      }),
      {
        config: resolveConfig(),
        readState: async () => makeState(),
        writeState: async () => undefined,
      },
    );

    stderrSpy.mockRestore();

    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: { reason?: string } });
    expect(lines.some((line) => line.event === "stop.extraction.skipped")).toBe(true);
    expect(lines.some((line) => line.data?.reason === "no_provider_configured")).toBe(true);
  });

  it("emits extraction trace events when a provider is configured", async () => {
    vi.resetModules();
    vi.stubEnv("LORE_DEBUG", "trace");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

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

    const { runStopObserver: runStop } = await import("../src/plugin/stop-observer");
    await runStop(
      JSON.stringify({
        session_id: "session-1",
        cwd: "/tmp/workspaces/billing-service",
      }),
      {
        config: resolveConfig(),
        provider,
        draftWriter: {
          append: async () => undefined,
        },
        readState: async () => makeState(),
        writeState: async () => undefined,
        now: () => "2026-03-28T20:00:00.000Z",
      },
    );

    stderrSpy.mockRestore();

    const lines = stderrWrites
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
    expect(lines.some((line) => line.event === "stop.extraction.begin")).toBe(true);
    expect(lines.some((line) => line.event === "stop.extraction.done")).toBe(true);
    expect(lines.some((line) => line.event === "stop.drafts_written")).toBe(true);
    expect(lines.some((line) => line.event === "stop.completed")).toBe(true);
  });
});

describe("runStopObserver directive execution", () => {
  const makeTempLoreConfig = async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "lore-stop-observer-"));
    tempDirs.push(baseDir);
    return resolveConfig({
      sharedStoragePath: join(baseDir, "shared.json"),
      approvalLedgerPath: join(baseDir, "approval-ledger.json"),
      observationDir: join(baseDir, "observations"),
      draftDir: join(baseDir, "drafts"),
      consolidationStatePath: join(baseDir, "consolidation-state.json"),
      projectMemoryDir: join(baseDir, "projects"),
      whisperStateDir: join(baseDir, "whisper-sessions"),
    });
  };

  it("captures through the promoter flow so forbidden content is rejected and valid content is ledgered", async () => {
    const loreConfig = await makeTempLoreConfig();
    let finalState: WhisperSessionState | undefined;

    await runStopObserver(
      JSON.stringify({
        session_id: "session-capture-1",
        cwd: "/tmp/workspaces/billing-service",
        assistant_response: [
          "[lore:capture kind=domain_rule] main branch naming is canonical",
          "[lore:capture kind=domain_rule] DB columns use snake_case across services.",
        ].join("\n"),
      }),
      {
        config: loreConfig,
        readState: async () => makeState(),
        writeState: async (state) => {
          finalState = state;
        },
      },
    );

    const sharedEntries = JSON.parse(
      await readFile(loreConfig.sharedStoragePath, "utf8"),
    ) as Array<{ content: string; approvalStatus: string; sourceProjectIds: string[] }>;
    expect(sharedEntries).toHaveLength(1);
    expect(sharedEntries[0]?.content).toBe("DB columns use snake_case across services.");
    expect(sharedEntries[0]?.approvalStatus).toBe("approved");
    expect(sharedEntries[0]?.sourceProjectIds).toContain("billing-service");

    const ledgerEntries = JSON.parse(
      await readFile(loreConfig.approvalLedgerPath, "utf8"),
    ) as Array<{ action: string; actor: string; actionSource: string }>;
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({
      action: "promote",
      actor: "user",
      actionSource: "explicit",
    });

    expect(finalState?.activeReceipt?.entryId).toBeTruthy();
    expect(finalState?.visibleItems).toEqual([]);
  });

  it("approves the currently visible pending suggestion and writes a receipt", async () => {
    const loreConfig = await makeTempLoreConfig();
    await mkdir(dirname(loreConfig.sharedStoragePath), { recursive: true });
    await writeFile(
      loreConfig.sharedStoragePath,
      `${JSON.stringify([
        {
          id: "sk-pending-1",
          kind: "domain_rule",
          title: "Snake case columns",
          content: "DB columns use snake_case across services.",
          confidence: 0.95,
          tags: [],
          sourceProjectIds: ["billing-service"],
          sourceMemoryIds: [],
          promotionSource: "suggested",
          createdBy: "system",
          approvalStatus: "pending",
          sessionCount: 3,
          projectCount: 1,
          lastSeenAt: "2026-03-28T20:00:00.000Z",
          contentHash: "hash-pending-1",
          createdAt: "2026-03-28T20:00:00.000Z",
          updatedAt: "2026-03-28T20:00:00.000Z",
        },
      ], null, 2)}\n`,
      "utf8",
    );

    let finalState: WhisperSessionState | undefined;
    await runStopObserver(
      JSON.stringify({
        session_id: "session-approve-1",
        cwd: "/tmp/workspaces/billing-service",
        assistant_response: "[lore:approve]",
      }),
      {
        config: loreConfig,
        readState: async () =>
          makeState({
            visibleItems: [
              {
                handle: "@l1",
                entryId: "sk-pending-1",
                kind: "pending_suggestion",
                entryKind: "domain_rule",
                content: "DB columns use snake_case across services.",
                actions: ["approve", "dismiss"],
                projectId: "billing-service",
                turnIndex: 3,
                actionOnDismiss: "reject_pending",
                actionOnApprove: "approve_pending",
              },
            ],
          }),
        writeState: async (state) => {
          finalState = state;
        },
      },
    );

    const sharedEntries = JSON.parse(
      await readFile(loreConfig.sharedStoragePath, "utf8"),
    ) as Array<{ approvalStatus: string; approvedAt?: string }>;
    expect(sharedEntries[0]?.approvalStatus).toBe("approved");
    expect(sharedEntries[0]?.approvedAt).toBeTruthy();
    expect(finalState?.activeReceipt?.entryId).toBe("sk-pending-1");
    expect(finalState?.visibleItems).toEqual([]);
  });

  it("dismisses the currently visible pending suggestion", async () => {
    const loreConfig = await makeTempLoreConfig();
    await mkdir(dirname(loreConfig.sharedStoragePath), { recursive: true });
    await writeFile(
      loreConfig.sharedStoragePath,
      `${JSON.stringify([
        {
          id: "sk-pending-1",
          kind: "domain_rule",
          title: "Snake case columns",
          content: "DB columns use snake_case across services.",
          confidence: 0.95,
          tags: [],
          sourceProjectIds: ["billing-service"],
          sourceMemoryIds: [],
          promotionSource: "suggested",
          createdBy: "system",
          approvalStatus: "pending",
          sessionCount: 3,
          projectCount: 1,
          lastSeenAt: "2026-03-28T20:00:00.000Z",
          contentHash: "hash-pending-1",
          createdAt: "2026-03-28T20:00:00.000Z",
          updatedAt: "2026-03-28T20:00:00.000Z",
        },
      ], null, 2)}\n`,
      "utf8",
    );

    let finalState: WhisperSessionState | undefined;
    await runStopObserver(
      JSON.stringify({
        session_id: "session-dismiss-1",
        cwd: "/tmp/workspaces/billing-service",
        assistant_response: "[lore:dismiss]",
      }),
      {
        config: loreConfig,
        readState: async () =>
          makeState({
            visibleItems: [
              {
                handle: "@l1",
                entryId: "sk-pending-1",
                kind: "pending_suggestion",
                entryKind: "domain_rule",
                content: "DB columns use snake_case across services.",
                actions: ["approve", "dismiss"],
                projectId: "billing-service",
                turnIndex: 3,
                actionOnDismiss: "reject_pending",
                actionOnApprove: "approve_pending",
              },
            ],
          }),
        writeState: async (state) => {
          finalState = state;
        },
      },
    );

    const sharedEntries = JSON.parse(
      await readFile(loreConfig.sharedStoragePath, "utf8"),
    ) as Array<{ approvalStatus: string; rejectedAt?: string }>;
    expect(sharedEntries[0]?.approvalStatus).toBe("rejected");
    expect(sharedEntries[0]?.rejectedAt).toBeTruthy();
    expect(finalState?.visibleItems).toEqual([]);
  });
});
