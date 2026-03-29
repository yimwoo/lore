import { describe, it, expect } from "vitest";

import {
  formatForAgentContext,
  formatForUserDisplay,
} from "../src/plugin/lore-item-renderer";
import type { LoreVisibleItem } from "../src/shared/types";

const PENDING_ITEM: LoreVisibleItem = {
  handle: "@l1",
  entryId: "entry-1",
  kind: "pending_suggestion",
  entryKind: "domain_rule",
  content: "Feature flags live in config/flags.ts.",
  actions: ["approve", "dismiss"],
  projectId: "my-project",
  turnIndex: 5,
  actionOnDismiss: "reject_pending",
  actionOnApprove: "approve_pending",
};

const RECEIPT_ITEM: LoreVisibleItem = {
  handle: "@l1",
  entryId: "entry-2",
  kind: "saved_receipt",
  entryKind: "user_preference",
  content: "Always use strict TypeScript.",
  actions: ["dismiss"],
  projectId: "my-project",
  turnIndex: 5,
  actionOnDismiss: "demote_undo_captured",
  actionOnApprove: "approve_pending",
};

describe("formatForAgentContext", () => {
  it("returns empty string for empty input", () => {
    expect(formatForAgentContext([])).toBe("");
  });

  it("renders pending_suggestion as [Lore · suggested] block", () => {
    const result = formatForAgentContext([PENDING_ITEM]);
    expect(result).toContain("[Lore · suggested @l1]");
    expect(result).toContain("**rule**");
    expect(result).toContain("Feature flags live in config/flags.ts.");
    expect(result).toContain("`lore yes` to keep");
    expect(result).toContain("`lore no` to dismiss");
  });

  it("renders saved_receipt as [Lore · saved] block", () => {
    const result = formatForAgentContext([RECEIPT_ITEM]);
    expect(result).toContain("[Lore · saved @l1]");
    expect(result).toContain("**preference**");
    expect(result).toContain("Always use strict TypeScript.");
    expect(result).toContain("`lore no` to undo");
  });

  it("renders a mix of pending and receipt items in stable order", () => {
    const result = formatForAgentContext([PENDING_ITEM, RECEIPT_ITEM]);
    const suggestedIdx = result.indexOf("[Lore · suggested");
    const savedIdx = result.indexOf("[Lore · saved");
    expect(suggestedIdx).toBeGreaterThanOrEqual(0);
    expect(savedIdx).toBeGreaterThan(suggestedIdx);
  });
});

describe("formatForUserDisplay", () => {
  it("returns empty string for empty input", () => {
    expect(formatForUserDisplay([])).toBe("");
  });

  it("renders pending_suggestion as [Lore · visible] block", () => {
    const result = formatForUserDisplay([PENDING_ITEM]);
    expect(result).toContain("[Lore · visible]");
    expect(result).toContain("@l1");
    expect(result).toContain("suggested");
    expect(result).toContain("**rule**");
    expect(result).toContain("Feature flags live in config/flags.ts.");
    expect(result).toContain("`lore yes` to keep");
    expect(result).toContain("`lore no` to dismiss");
  });

  it("renders saved_receipt as [Lore · visible] block", () => {
    const result = formatForUserDisplay([RECEIPT_ITEM]);
    expect(result).toContain("[Lore · visible]");
    expect(result).toContain("@l1");
    expect(result).toContain("saved");
    expect(result).toContain("**preference**");
    expect(result).toContain("Always use strict TypeScript.");
    expect(result).toContain("`lore no` to undo");
  });

  it("renders receipt before suggestion when both present", () => {
    const suggestion: LoreVisibleItem = { ...PENDING_ITEM, handle: "@l2" };
    const result = formatForUserDisplay([RECEIPT_ITEM, suggestion]);
    const receiptIdx = result.indexOf("@l1");
    const suggestionIdx = result.indexOf("@l2");
    expect(receiptIdx).toBeLessThan(suggestionIdx);
  });
});
