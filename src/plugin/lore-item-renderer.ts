import type { LoreVisibleItem } from "../shared/types";
import { whisperLabelMap } from "../shared/types";
import type { SharedKnowledgeKind } from "../shared/types";

const labelFor = (entryKind: SharedKnowledgeKind): string =>
  whisperLabelMap[entryKind] ?? entryKind;

export const formatForAgentContext = (items: LoreVisibleItem[]): string => {
  if (items.length === 0) return "";

  const pendingItems = items.filter((item) => item.kind === "pending_suggestion");
  const receiptItems = items.filter((item) => item.kind === "saved_receipt");

  const sections: string[] = [];

  // Each pending suggestion gets its own [Lore · suggested] block
  for (const item of pendingItems) {
    sections.push(
      `[Lore · suggested ${item.handle}]\n- **${labelFor(item.entryKind)}**: ${item.content} (\`lore yes\` to keep, \`lore no\` to dismiss)`,
    );
  }

  // Each saved receipt gets its own [Lore · saved] block
  for (const item of receiptItems) {
    sections.push(
      `[Lore · saved ${item.handle}]\n- **${labelFor(item.entryKind)}**: ${item.content} (\`lore no\` to undo)`,
    );
  }

  return sections.join("\n\n");
};

export const formatForUserDisplay = (items: LoreVisibleItem[]): string => {
  const actionableItems = items.filter(
    (item) => item.kind === "pending_suggestion" || item.kind === "saved_receipt",
  );

  if (actionableItems.length === 0) return "";

  const lines = ["[Lore · visible]"];

  for (const item of actionableItems) {
    const label = labelFor(item.entryKind);
    if (item.kind === "saved_receipt") {
      lines.push(
        `- ${item.handle} · saved · **${label}**: ${item.content} (\`lore no\` to undo)`,
      );
    } else {
      lines.push(
        `- ${item.handle} · suggested · **${label}**: ${item.content} (\`lore yes\` to keep · \`lore no\` to dismiss)`,
      );
    }
  }

  return lines.join("\n");
};
