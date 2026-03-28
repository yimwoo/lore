import { describe, expect, it } from "vitest";

import { applyStopUpdate } from "../src/plugin/stop-observer";
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
