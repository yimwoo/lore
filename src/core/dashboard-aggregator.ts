import type {
  SharedKnowledgeEntry,
  ApprovalLedgerEntry,
  DashboardData,
  KindStatusCounts,
  TagCoverage,
  ActivityPeriod,
  HealthIndicator,
  SharedKnowledgeKind,
} from "../shared/types";
import { sharedKnowledgeKinds } from "../shared/types";

type AggregateOptions = {
  staleDaysThreshold: number;
  now: string;
};

const MS_PER_DAY = 86400000;

const computeKindCounts = (
  entries: SharedKnowledgeEntry[],
): KindStatusCounts[] =>
  sharedKnowledgeKinds.map((kind) => {
    const kindEntries = entries.filter((e) => e.kind === kind);
    return {
      kind,
      approved: kindEntries.filter((e) => e.approvalStatus === "approved").length,
      pending: kindEntries.filter((e) => e.approvalStatus === "pending").length,
      rejected: kindEntries.filter((e) => e.approvalStatus === "rejected").length,
      demoted: kindEntries.filter((e) => e.approvalStatus === "demoted").length,
    };
  });

const computeTagCoverage = (
  entries: SharedKnowledgeEntry[],
): TagCoverage[] => {
  const nonDemoted = entries.filter((e) => e.approvalStatus !== "demoted");
  const tagCounts = new Map<string, number>();

  for (const entry of nonDemoted) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const sorted = [...tagCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const top10 = sorted.slice(0, 10);

  return top10.map(([tag, count]) => {
    const strength: TagCoverage["strength"] =
      count >= 5 ? "strong" : count >= 3 ? "moderate" : "weak";
    return { tag, entryCount: count, strength };
  });
};

const getUtcDayStart = (iso: string): number => {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const computeActivity = (
  ledgerEntries: ApprovalLedgerEntry[],
  now: string,
): ActivityPeriod[] => {
  const nowDayStart = getUtcDayStart(now);
  const weekAgoStart = nowDayStart - 6 * MS_PER_DAY;

  const today: ActivityPeriod = { label: "Today", promotes: 0, approvals: 0, rejections: 0, demotions: 0 };
  const thisWeek: ActivityPeriod = { label: "This week", promotes: 0, approvals: 0, rejections: 0, demotions: 0 };

  for (const le of ledgerEntries) {
    const entryDayStart = getUtcDayStart(le.timestamp);

    const addToCount = (period: ActivityPeriod): void => {
      switch (le.action) {
        case "promote":
        case "merge":
          period.promotes += 1;
          break;
        case "approve":
          period.approvals += 1;
          break;
        case "reject":
          period.rejections += 1;
          break;
        case "demote":
          period.demotions += 1;
          break;
      }
    };

    if (entryDayStart === nowDayStart) {
      addToCount(today);
    }

    if (entryDayStart >= weekAgoStart && entryDayStart <= nowDayStart) {
      addToCount(thisWeek);
    }
  }

  return [today, thisWeek];
};

const computeHealth = (
  entries: SharedKnowledgeEntry[],
  options: AggregateOptions,
): HealthIndicator[] => {
  const nonDemoted = entries.filter((e) => e.approvalStatus !== "demoted");
  const nowMs = new Date(options.now).getTime();
  const indicators: HealthIndicator[] = [];

  const staleCount = nonDemoted.filter((e) => {
    const lastSeenMs = new Date(e.lastSeenAt).getTime();
    const diffDays = Math.floor((nowMs - lastSeenMs) / MS_PER_DAY);
    return diffDays >= options.staleDaysThreshold;
  }).length;

  if (staleCount > 0) {
    indicators.push({
      type: "stale_entries",
      count: staleCount,
      thresholdDays: options.staleDaysThreshold,
    });
  }

  const contradictionCount = nonDemoted.filter(
    (e) => (e.contradictionCount ?? 0) > 0,
  ).length;

  if (contradictionCount > 0) {
    indicators.push({ type: "contradictions", count: contradictionCount });
  }

  return indicators;
};

export const aggregateDashboard = (
  entries: SharedKnowledgeEntry[],
  ledgerEntries: ApprovalLedgerEntry[],
  options: AggregateOptions,
): DashboardData => ({
  totalEntries: entries.length,
  kindCounts: computeKindCounts(entries),
  tagCoverage: computeTagCoverage(entries),
  activity: computeActivity(ledgerEntries, options.now),
  health: computeHealth(entries, options),
  generatedAt: options.now,
});

const KIND_DISPLAY_NAMES: Record<SharedKnowledgeKind, string> = {
  domain_rule: "Domain Rules",
  architecture_fact: "Architecture Facts",
  glossary_term: "Glossary Terms",
  user_preference: "User Preferences",
  decision_record: "Decision Records",
};

export const renderDashboardText = (data: DashboardData): string => {
  if (data.totalEntries === 0) {
    return [
      "Lore Knowledge Dashboard",
      "========================",
      "",
      "No shared knowledge entries found.",
      "",
      "Get started:",
      '  lore promote --kind domain_rule --title "My rule" --content "Description"',
      "  lore list-shared",
    ].join("\n");
  }

  const lines: string[] = [
    "Lore Knowledge Dashboard",
    "========================",
    "",
  ];

  // Kind-status table
  const kindHeader = `${"Kind".padEnd(20)}| ${"Approved".padStart(8)} | ${"Pending".padStart(7)} | ${"Rejected".padStart(8)} | ${"Demoted".padStart(7)}`;
  lines.push(kindHeader);
  lines.push(`${"-".repeat(20)}|${"-".repeat(10)}|${"-".repeat(9)}|${"-".repeat(10)}|${"-".repeat(9)}`);

  for (const kc of data.kindCounts) {
    const name = KIND_DISPLAY_NAMES[kc.kind].padEnd(20);
    const approved = String(kc.approved).padStart(8);
    const pending = String(kc.pending).padStart(7);
    const rejected = String(kc.rejected).padStart(8);
    const demoted = String(kc.demoted).padStart(7);
    lines.push(`${name}| ${approved} | ${pending} | ${rejected} | ${demoted}`);
  }

  // Tag coverage
  if (data.tagCoverage.length > 0) {
    lines.push("");
    lines.push("Tag Coverage (top 10):");
    for (const tc of data.tagCoverage) {
      const noun = tc.entryCount === 1 ? "entry" : "entries";
      lines.push(`  ${tc.tag}  ${tc.entryCount} ${noun} (${tc.strength})`);
    }
  }

  // Activity
  lines.push("");
  lines.push("Recent Activity:");
  for (const ap of data.activity) {
    const parts: string[] = [];
    if (ap.promotes > 0) parts.push(`${ap.promotes} promotes`);
    if (ap.approvals > 0) parts.push(`${ap.approvals} ${ap.approvals === 1 ? "approval" : "approvals"}`);
    if (ap.rejections > 0) parts.push(`${ap.rejections} ${ap.rejections === 1 ? "rejection" : "rejections"}`);
    if (ap.demotions > 0) parts.push(`${ap.demotions} ${ap.demotions === 1 ? "demotion" : "demotions"}`);

    if (parts.length === 0) {
      lines.push(`  ${ap.label}:  no activity`);
    } else {
      lines.push(`  ${ap.label}:  ${parts.join(", ")}`);
    }
  }

  // Health
  lines.push("");
  lines.push("Health:");
  if (data.health.length === 0) {
    lines.push("  No issues detected.");
  } else {
    for (const h of data.health) {
      if (h.type === "stale_entries") {
        lines.push(
          `  ${h.count} ${h.count === 1 ? "entry" : "entries"} not seen in ${h.thresholdDays}+ days (consider reviewing with: lore list-shared --stale)`,
        );
      } else {
        lines.push(
          `  ${h.count} ${h.count === 1 ? "entry has" : "entries have"} contradictions flagged (review with: lore list-shared --contradictions)`,
        );
      }
    }
  }

  return lines.join("\n");
};
