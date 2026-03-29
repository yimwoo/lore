import { describe, expect, it } from "vitest";

import { renderSessionStartTemplate } from "../src/plugin/session-start-template";
import type {
  ConflictTemplateEntry,
  ConflictType,
  LoreCapabilities,
  SelectedEntry,
  SharedKnowledgeKind,
} from "../src/shared/types";

const makeSelectedEntry = (
  overrides?: Partial<SelectedEntry>,
): SelectedEntry => ({
  id: `sk-${Math.random().toString(36).slice(2, 6)}`,
  kind: "domain_rule",
  title: "Test rule",
  content: "Test content for the rule",
  contentHash: "abc123",
  ...overrides,
});

const NO_CAPABILITIES: LoreCapabilities = {
  recall: false,
  promote: false,
  demote: false,
  cliAvailable: false,
  visibleLoreBlocks: false,
};

const RECALL_ONLY: LoreCapabilities = {
  recall: true,
  promote: false,
  demote: false,
  cliAvailable: false,
  visibleLoreBlocks: false,
};

const FULL_CAPABILITIES: LoreCapabilities = {
  recall: true,
  promote: true,
  demote: true,
  cliAvailable: true,
  visibleLoreBlocks: true,
};

const CLI_ONLY: LoreCapabilities = {
  recall: false,
  promote: false,
  demote: false,
  cliAvailable: true,
  visibleLoreBlocks: false,
};

describe("renderSessionStartTemplate", () => {
  it("returns null for empty entries array", () => {
    const result = renderSessionStartTemplate({
      entries: [],
      capabilities: FULL_CAPABILITIES,
    });
    expect(result).toBeNull();
  });

  it("renders pending digest even when session entries are empty", () => {
    const result = renderSessionStartTemplate({
      entries: [],
      capabilities: RECALL_ONLY,
      pendingCount: 3,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Lore has 3 pending suggestions.");
    expect(result).toContain("lore list-shared --status pending");
  });

  describe("no capabilities", () => {
    it("contains no tool names when all capabilities are false", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      });
      expect(result).not.toBeNull();
      const output = result!;
      expect(output).not.toContain("lore.recall_rules");
      expect(output).not.toContain("lore.recall_architecture");
      expect(output).not.toContain("lore.recall_decisions");
      expect(output).not.toContain("lore.search_knowledge");
      expect(output).not.toContain("lore.promote");
      expect(output).not.toContain("lore.demote");
      expect(output).not.toContain("lore demote");
    });

    it("does not contain promotion section", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).not.toContain("### Support inline promotion");
    });

    it("does not contain recall section", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).not.toContain("### Use recall tools for deeper questions");
    });

    it("says two ways in the intro", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).toContain("two ways");
      expect(result).not.toContain("three ways");
    });
  });

  describe("recall only", () => {
    it("contains recall tool names", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: RECALL_ONLY,
      })!;
      expect(result).toContain("lore.recall_rules");
      expect(result).toContain("lore.recall_architecture");
      expect(result).toContain("lore.recall_decisions");
      expect(result).toContain("lore.search_knowledge");
    });

    it("does not contain promote/demote tool names", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: RECALL_ONLY,
      })!;
      expect(result).not.toContain("lore.promote");
      expect(result).not.toContain("lore.demote");
    });

    it("says three ways in the intro", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: RECALL_ONLY,
      })!;
      expect(result).toContain("three ways");
    });
  });

  describe("full capabilities", () => {
    it("contains all sections", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: FULL_CAPABILITIES,
      })!;
      expect(result).toContain("# Lore — Cross-Project Knowledge");
      expect(result).toContain("## How to use Lore context");
      expect(result).toContain("### Use recall tools for deeper questions");
      expect(result).toContain("### Support inline corrections");
      expect(result).toContain("### Support inline promotion");
      expect(result).toContain("### Conflict resolution");
      expect(result).toContain("## Session Knowledge");
      expect(result).not.toContain("## Pending Suggestions");
      expect(result).toContain("## Whisper Format Reference");
      expect(result).toContain("## Behavior Summary Table");
      expect(result).toContain("## Configuration Notes");
    });

    it("contains all tool names", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: FULL_CAPABILITIES,
      })!;
      expect(result).toContain("lore.recall_rules");
      expect(result).toContain("lore.demote");
      expect(result).toContain("lore.promote");
    });

    it("documents conversational Lore tags", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: FULL_CAPABILITIES,
      })!;
      expect(result).toContain("[lore:capture kind=<kind>]");
      expect(result).toContain("[lore:approve]");
      expect(result).toContain("[lore:dismiss]");
    });
  });

  describe("correction section", () => {
    it("always contains base correction guidance regardless of capabilities", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).toContain("### Support inline corrections");
      expect(result).toContain(
        "Acknowledge the correction and stop applying that rule",
      );
    });

    it("includes demote tool offer when demote capability is true", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: { ...NO_CAPABILITIES, demote: true },
      })!;
      expect(result).toContain("lore.demote");
      expect(result).toContain("demote the entry immediately");
    });

    it("includes CLI fallback when cliAvailable is true and demote is false", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: CLI_ONLY,
      })!;
      expect(result).toContain("lore demote <id>");
      expect(result).not.toContain("lore.demote");
    });

    it("includes neither demote tool nor CLI when both are false", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).not.toContain("lore.demote");
      expect(result).not.toContain("lore demote");
    });
  });

  describe("behavior table", () => {
    it("omits recall row when recall is false", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).not.toContain("lore.recall_*");
    });

    it("includes recall row when recall is true", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: RECALL_ONLY,
      })!;
      expect(result).toContain("lore.recall_*");
    });

    it("omits promote row when promote is false", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).not.toContain("Offer to promote");
    });

    it("includes promote row when promote is true", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: FULL_CAPABILITIES,
      })!;
      expect(result).toContain("Offer to promote");
    });

    it("shows demote offer when demote is true", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: FULL_CAPABILITIES,
      })!;
      expect(result).toContain("offer to demote");
    });

    it("shows CLI demote text when cliAvailable and demote is false", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: CLI_ONLY,
      })!;
      expect(result).toContain("`lore demote <id>`");
    });

    it("shows stop-applying text when no demote or CLI", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).toContain("stop applying for this session");
    });
  });

  describe("section order", () => {
    it("sections appear in spec order", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: FULL_CAPABILITIES,
      })!;

      const headings = [
        "# Lore — Cross-Project Knowledge",
        "## How to use Lore context",
        "### Use recall tools for deeper questions",
        "### Support inline corrections",
        "### Support inline promotion",
        "### Conflict resolution",
        "## Session Knowledge",
        "## Whisper Format Reference",
        "## Behavior Summary Table",
        "## Configuration Notes",
      ];

      let lastIndex = -1;
      for (const heading of headings) {
        const index = result.indexOf(heading);
        expect(index).toBeGreaterThan(lastIndex);
        lastIndex = index;
      }
    });
  });

  describe("session knowledge grouping", () => {
    it("groups entries by kind with correct headers", () => {
      const entries = [
        makeSelectedEntry({ kind: "domain_rule", title: "Rule A", content: "Content A" }),
        makeSelectedEntry({ kind: "architecture_fact", title: "Arch B", content: "Content B" }),
        makeSelectedEntry({ kind: "domain_rule", title: "Rule C", content: "Content C" }),
      ];
      const result = renderSessionStartTemplate({
        entries,
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).toContain("### Domain Rules");
      expect(result).toContain("### Architecture");
      expect(result).toContain("- **Rule A**: Content A");
      expect(result).toContain("- **Arch B**: Content B");
      expect(result).toContain("- **Rule C**: Content C");
    });

    it("omits empty kind groups", () => {
      const entries = [
        makeSelectedEntry({ kind: "glossary_term", title: "Term X", content: "Def X" }),
      ];
      const result = renderSessionStartTemplate({
        entries,
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).toContain("### Glossary");
      expect(result).not.toContain("### Domain Rules");
      expect(result).not.toContain("### Architecture");
      expect(result).not.toContain("### Preferences");
      expect(result).not.toContain("### Decisions");
    });

    it("includes the session knowledge heading and explanatory text", () => {
      const result = renderSessionStartTemplate({
        entries: [makeSelectedEntry()],
        capabilities: NO_CAPABILITIES,
      })!;
      expect(result).toContain("## Session Knowledge");
      expect(result).toContain("high-confidence, user-approved facts");
    });

    it("renders multiple kinds in correct kind order", () => {
      const entries = [
        makeSelectedEntry({ kind: "decision_record", title: "Dec 1", content: "D" }),
        makeSelectedEntry({ kind: "domain_rule", title: "Rule 1", content: "R" }),
        makeSelectedEntry({ kind: "user_preference", title: "Pref 1", content: "P" }),
      ];
      const result = renderSessionStartTemplate({
        entries,
        capabilities: NO_CAPABILITIES,
      })!;

      const ruleIdx = result.indexOf("### Domain Rules");
      const prefIdx = result.indexOf("### Preferences");
      const decIdx = result.indexOf("### Decisions");

      expect(ruleIdx).toBeGreaterThan(-1);
      expect(prefIdx).toBeGreaterThan(ruleIdx);
      expect(decIdx).toBeGreaterThan(prefIdx);
    });
  });

  it("places pending digest after session knowledge", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: RECALL_ONLY,
      pendingCount: 2,
    })!;
    expect(result.indexOf("## Session Knowledge")).toBeLessThan(
      result.indexOf("## Pending Suggestions"),
    );
  });

  it("renders a one-turn saved receipt when provided", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: RECALL_ONLY,
      savedReceipt: {
        handle: "@l1",
        kind: "domain_rule",
        content: "DB columns use snake_case across services.",
        undoCommand: "lore no",
      },
    })!;

    expect(result).toContain("[Lore · saved @l1]");
    expect(result).toContain("DB columns use snake_case across services.");
    expect(result).toContain("lore no");
  });
});

const makeConflict = (overrides?: Partial<ConflictTemplateEntry>): ConflictTemplateEntry => ({
  conflictId: "conf-001",
  entryA: {
    id: "sk-a",
    kind: "domain_rule",
    content: "Always use snake_case for DB columns",
    confidence: 0.92,
    lastSeenAt: "2026-03-27T10:00:00Z",
  },
  entryB: {
    id: "sk-b",
    kind: "domain_rule",
    content: "Use camelCase for all column names",
    confidence: 0.85,
    lastSeenAt: "2026-03-14T10:00:00Z",
  },
  conflictType: "direct_negation",
  suggestedWinnerId: "sk-a",
  explanation: "Direct contradiction",
  ...overrides,
});

describe("conflict rendering", () => {
  it("renders conflict block when conflicts contains one entry", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
      conflicts: [makeConflict()],
    })!;
    expect(result).toContain("[Lore - conflict detected]");
    expect(result).toContain("sk-a");
    expect(result).toContain("sk-b");
  });

  it("does not render conflict block when conflicts is undefined", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
    })!;
    expect(result).not.toContain("[Lore - conflict detected]");
  });

  it("does not render conflict block when conflicts is empty", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
      conflicts: [],
    })!;
    expect(result).not.toContain("[Lore - conflict detected]");
  });

  it("renders at most one conflict block when conflicts has three entries", () => {
    const conflicts = [
      makeConflict({ conflictId: "conf-1" }),
      makeConflict({ conflictId: "conf-2", conflictType: "scope_mismatch" }),
      makeConflict({ conflictId: "conf-3", conflictType: "ambiguous" }),
    ];
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
      conflicts,
    })!;
    const count = result.split("[Lore - conflict detected]").length - 1;
    expect(count).toBe(1);
  });

  it("renders the direct_negation conflict when both direct_negation and ambiguous are present", () => {
    const conflicts = [
      makeConflict({
        conflictId: "conf-ambiguous",
        conflictType: "ambiguous",
        entryA: {
          id: "sk-x",
          kind: "domain_rule",
          content: "Ambiguous entry A",
          confidence: 0.8,
          lastSeenAt: "2026-03-27T10:00:00Z",
        },
        entryB: {
          id: "sk-y",
          kind: "domain_rule",
          content: "Ambiguous entry B",
          confidence: 0.7,
          lastSeenAt: "2026-03-27T10:00:00Z",
        },
      }),
      makeConflict({
        conflictId: "conf-negation",
        conflictType: "direct_negation",
        entryA: {
          id: "sk-p",
          kind: "domain_rule",
          content: "Direct negation entry A",
          confidence: 0.9,
          lastSeenAt: "2026-03-27T10:00:00Z",
        },
        entryB: {
          id: "sk-q",
          kind: "domain_rule",
          content: "Direct negation entry B",
          confidence: 0.85,
          lastSeenAt: "2026-03-27T10:00:00Z",
        },
      }),
    ];
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
      conflicts,
    })!;
    expect(result).toContain("sk-p");
    expect(result).toContain("sk-q");
    expect(result).not.toContain("sk-x");
    expect(result).not.toContain("sk-y");
  });

  it("renders 'Default winner:' when suggestedWinnerId is set", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
      conflicts: [makeConflict({ suggestedWinnerId: "sk-a" })],
    })!;
    expect(result).toContain("Default winner:");
  });

  it("renders 'No clear winner' when suggestedWinnerId is null", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
      conflicts: [makeConflict({ suggestedWinnerId: null })],
    })!;
    expect(result).toContain("No clear winner");
  });

  it("renders a lore resolve command string with both entry IDs", () => {
    const result = renderSessionStartTemplate({
      entries: [makeSelectedEntry()],
      capabilities: NO_CAPABILITIES,
      conflicts: [makeConflict()],
    })!;
    expect(result).toContain("lore resolve sk-a sk-b");
  });
});
