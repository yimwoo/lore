import { describe, expect, it } from "vitest";

import { aggregateDashboard, renderDashboardText } from "../src/core/dashboard-aggregator";
import type {
  SharedKnowledgeEntry,
  ApprovalLedgerEntry,
  DashboardData,
  KindStatusCounts,
  TagCoverage,
} from "../src/shared/types";
import { contentHash } from "../src/shared/validators";

let idCounter = 0;

const makeEntry = (
  overrides?: Partial<SharedKnowledgeEntry>,
): SharedKnowledgeEntry => {
  idCounter += 1;
  const content = overrides?.content ?? `Content ${idCounter}`;
  return {
    id: `sk-${String(idCounter).padStart(4, "0")}`,
    kind: "domain_rule",
    title: `Entry ${idCounter}`,
    content,
    confidence: 0.9,
    tags: [],
    sourceProjectIds: ["proj-1"],
    sourceMemoryIds: ["mem-1"],
    promotionSource: "explicit",
    createdBy: "user",
    approvalStatus: "approved",
    sessionCount: 3,
    projectCount: 1,
    lastSeenAt: "2026-03-01T00:00:00Z",
    contentHash: contentHash(content),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
};

const makeLedgerEntry = (
  overrides?: Partial<ApprovalLedgerEntry>,
): ApprovalLedgerEntry => {
  idCounter += 1;
  return {
    id: `ledger-${String(idCounter).padStart(4, "0")}`,
    knowledgeEntryId: `sk-0001`,
    action: "promote",
    actor: "user",
    timestamp: "2026-03-29T12:00:00Z",
    ...overrides,
  };
};

const NOW = "2026-03-29T00:00:00Z";
const DEFAULT_OPTIONS = { staleDaysThreshold: 60, now: NOW };

describe("aggregateDashboard", () => {
  it("returns correct shape for empty input", () => {
    const result = aggregateDashboard([], [], DEFAULT_OPTIONS);

    expect(result.totalEntries).toBe(0);
    expect(result.kindCounts).toHaveLength(5);
    for (const kc of result.kindCounts) {
      expect(kc.approved).toBe(0);
      expect(kc.pending).toBe(0);
      expect(kc.rejected).toBe(0);
      expect(kc.demoted).toBe(0);
    }
    expect(result.tagCoverage).toEqual([]);
    expect(result.activity).toHaveLength(2);
    expect(result.activity[0]!.label).toBe("Today");
    expect(result.activity[1]!.label).toBe("This week");
    for (const ap of result.activity) {
      expect(ap.promotes).toBe(0);
      expect(ap.approvals).toBe(0);
      expect(ap.rejections).toBe(0);
      expect(ap.demotions).toBe(0);
    }
    expect(result.health).toEqual([]);
  });

  it("groups entries by kind and status", () => {
    const entries: SharedKnowledgeEntry[] = [
      makeEntry({ kind: "domain_rule", approvalStatus: "approved" }),
      makeEntry({ kind: "domain_rule", approvalStatus: "approved" }),
      makeEntry({ kind: "architecture_fact", approvalStatus: "pending" }),
    ];

    const result = aggregateDashboard(entries, [], DEFAULT_OPTIONS);

    const domainRule = result.kindCounts.find((k) => k.kind === "domain_rule")!;
    expect(domainRule.approved).toBe(2);
    expect(domainRule.pending).toBe(0);

    const archFact = result.kindCounts.find((k) => k.kind === "architecture_fact")!;
    expect(archFact.pending).toBe(1);
    expect(archFact.approved).toBe(0);

    const glossary = result.kindCounts.find((k) => k.kind === "glossary_term")!;
    expect(glossary.approved).toBe(0);
    expect(glossary.pending).toBe(0);
    expect(glossary.rejected).toBe(0);
    expect(glossary.demoted).toBe(0);
  });

  it("computes tag coverage with correct strengths", () => {
    const entries: SharedKnowledgeEntry[] = [
      makeEntry({ tags: ["billing"], approvalStatus: "approved" }),
      makeEntry({ tags: ["billing"], approvalStatus: "approved" }),
      makeEntry({ tags: ["billing"], approvalStatus: "approved" }),
      makeEntry({ tags: ["billing", "auth"], approvalStatus: "approved" }),
      makeEntry({ tags: ["billing", "auth"], approvalStatus: "approved" }),
      makeEntry({ tags: ["auth", "db"], approvalStatus: "pending" }),
    ];

    const result = aggregateDashboard(entries, [], DEFAULT_OPTIONS);

    const billing = result.tagCoverage.find((t) => t.tag === "billing")!;
    expect(billing.entryCount).toBe(5);
    expect(billing.strength).toBe("strong");

    const auth = result.tagCoverage.find((t) => t.tag === "auth")!;
    expect(auth.entryCount).toBe(3);
    expect(auth.strength).toBe("moderate");

    const db = result.tagCoverage.find((t) => t.tag === "db")!;
    expect(db.entryCount).toBe(1);
    expect(db.strength).toBe("weak");

    // Sorted by entryCount descending
    expect(result.tagCoverage[0]!.tag).toBe("billing");
    expect(result.tagCoverage[1]!.tag).toBe("auth");
    expect(result.tagCoverage[2]!.tag).toBe("db");
  });

  it("excludes demoted entries from tag coverage", () => {
    const entries: SharedKnowledgeEntry[] = [
      makeEntry({ tags: ["billing"], approvalStatus: "approved" }),
      makeEntry({ tags: ["billing"], approvalStatus: "demoted" }),
    ];

    const result = aggregateDashboard(entries, [], DEFAULT_OPTIONS);

    const billing = result.tagCoverage.find((t) => t.tag === "billing")!;
    expect(billing.entryCount).toBe(1);
  });

  it("counts today's activity from ledger", () => {
    const ledger: ApprovalLedgerEntry[] = [
      makeLedgerEntry({ action: "promote", timestamp: "2026-03-29T08:00:00Z" }),
      makeLedgerEntry({ action: "approve", timestamp: "2026-03-29T15:00:00Z" }),
      makeLedgerEntry({ action: "merge", timestamp: "2026-03-29T10:00:00Z" }),
    ];

    const result = aggregateDashboard([], ledger, DEFAULT_OPTIONS);

    const today = result.activity.find((a) => a.label === "Today")!;
    expect(today.promotes).toBe(2); // promote + merge
    expect(today.approvals).toBe(1);
  });

  it("counts this week's activity from ledger", () => {
    const ledger: ApprovalLedgerEntry[] = [
      makeLedgerEntry({ action: "promote", timestamp: "2026-03-29T08:00:00Z" }),
      makeLedgerEntry({ action: "reject", timestamp: "2026-03-25T10:00:00Z" }),
      makeLedgerEntry({ action: "demote", timestamp: "2026-03-23T10:00:00Z" }),
      // 8 days ago -- outside "this week"
      makeLedgerEntry({ action: "approve", timestamp: "2026-03-21T10:00:00Z" }),
    ];

    const result = aggregateDashboard([], ledger, DEFAULT_OPTIONS);

    const thisWeek = result.activity.find((a) => a.label === "This week")!;
    expect(thisWeek.promotes).toBe(1);
    expect(thisWeek.rejections).toBe(1);
    expect(thisWeek.demotions).toBe(1);
    // The one from March 21 (8 days ago) should NOT be counted
    expect(thisWeek.approvals).toBe(0);
  });

  it("reports stale entries in health indicators", () => {
    const entries: SharedKnowledgeEntry[] = [
      // 90 days before now = stale
      makeEntry({ lastSeenAt: "2025-12-29T00:00:00Z", approvalStatus: "approved" }),
      // 10 days before now = not stale
      makeEntry({ lastSeenAt: "2026-03-19T00:00:00Z", approvalStatus: "approved" }),
    ];

    const result = aggregateDashboard(entries, [], DEFAULT_OPTIONS);

    const stale = result.health.find((h) => h.type === "stale_entries");
    expect(stale).toBeDefined();
    expect(stale!.type === "stale_entries" && stale!.count).toBe(1);
    expect(stale!.type === "stale_entries" && stale!.thresholdDays).toBe(60);
  });

  it("excludes demoted entries from staleness", () => {
    const entries: SharedKnowledgeEntry[] = [
      makeEntry({ lastSeenAt: "2025-12-29T00:00:00Z", approvalStatus: "demoted" }),
    ];

    const result = aggregateDashboard(entries, [], DEFAULT_OPTIONS);

    const stale = result.health.find((h) => h.type === "stale_entries");
    expect(stale).toBeUndefined();
  });

  it("reports contradictions in health indicators", () => {
    const entries: SharedKnowledgeEntry[] = [
      makeEntry({ contradictionCount: 2, approvalStatus: "approved" }),
      makeEntry({ contradictionCount: 0, approvalStatus: "approved" }),
    ];

    const result = aggregateDashboard(entries, [], DEFAULT_OPTIONS);

    const contradictions = result.health.find((h) => h.type === "contradictions");
    expect(contradictions).toBeDefined();
    expect(contradictions!.type === "contradictions" && contradictions!.count).toBe(1);
  });

  it("excludes demoted entries from contradiction count", () => {
    const entries: SharedKnowledgeEntry[] = [
      makeEntry({ contradictionCount: 3, approvalStatus: "demoted" }),
    ];

    const result = aggregateDashboard(entries, [], DEFAULT_OPTIONS);

    const contradictions = result.health.find((h) => h.type === "contradictions");
    expect(contradictions).toBeUndefined();
  });

  it("sets generatedAt to the now parameter", () => {
    const result = aggregateDashboard([], [], DEFAULT_OPTIONS);
    expect(result.generatedAt).toBe(NOW);
  });
});

describe("renderDashboardText", () => {
  it("renders empty-state message with getting-started hints", () => {
    const data: DashboardData = {
      totalEntries: 0,
      kindCounts: [],
      tagCoverage: [],
      activity: [],
      health: [],
      generatedAt: NOW,
    };

    const text = renderDashboardText(data);

    expect(text).toContain("No shared knowledge entries found.");
    expect(text).toContain("lore promote");
    expect(text).toContain("lore list-shared");
  });

  it("renders kind-status table with column headers and display names", () => {
    const data = aggregateDashboard(
      [
        makeEntry({ kind: "domain_rule", approvalStatus: "approved" }),
        makeEntry({ kind: "architecture_fact", approvalStatus: "pending" }),
      ],
      [],
      DEFAULT_OPTIONS,
    );

    const text = renderDashboardText(data);

    expect(text).toContain("Lore Knowledge Dashboard");
    expect(text).toContain("Kind");
    expect(text).toContain("Approved");
    expect(text).toContain("Pending");
    expect(text).toContain("Rejected");
    expect(text).toContain("Demoted");
    expect(text).toContain("Domain Rules");
    expect(text).toContain("Architecture Facts");
    expect(text).toContain("Glossary Terms");
    expect(text).toContain("User Preferences");
    expect(text).toContain("Decision Records");
  });

  it("renders tag coverage section with singular/plural and strength labels", () => {
    const entries = [
      makeEntry({ tags: ["billing"], approvalStatus: "approved" }),
      makeEntry({ tags: ["billing"], approvalStatus: "approved" }),
      makeEntry({ tags: ["billing"], approvalStatus: "approved" }),
      makeEntry({ tags: ["solo"], approvalStatus: "approved" }),
    ];

    const data = aggregateDashboard(entries, [], DEFAULT_OPTIONS);
    const text = renderDashboardText(data);

    expect(text).toContain("Tag Coverage");
    expect(text).toContain("billing");
    expect(text).toContain("3 entries (moderate)");
    expect(text).toContain("1 entry (weak)");
  });

  it("renders activity section with non-zero counts and no activity fallback", () => {
    const ledger = [
      makeLedgerEntry({ action: "promote", timestamp: "2026-03-29T08:00:00Z" }),
      makeLedgerEntry({ action: "approve", timestamp: "2026-03-29T10:00:00Z" }),
    ];

    const entriesForCount = [makeEntry({ approvalStatus: "approved" })];
    const data = aggregateDashboard(entriesForCount, ledger, DEFAULT_OPTIONS);
    const text = renderDashboardText(data);

    expect(text).toContain("Recent Activity");
    expect(text).toContain("1 promotes");
    expect(text).toContain("1 approval");
  });

  it("shows no activity when period has zero counts", () => {
    const entriesForCount = [makeEntry({ approvalStatus: "approved" })];
    const data = aggregateDashboard(entriesForCount, [], DEFAULT_OPTIONS);
    const text = renderDashboardText(data);

    expect(text).toContain("no activity");
  });

  it("renders health section with remediation hints", () => {
    const entries = [
      makeEntry({ lastSeenAt: "2025-12-29T00:00:00Z", approvalStatus: "approved" }),
      makeEntry({ contradictionCount: 2, approvalStatus: "approved" }),
    ];

    const data = aggregateDashboard(entries, [], DEFAULT_OPTIONS);
    const text = renderDashboardText(data);

    expect(text).toContain("Health");
    expect(text).toContain("lore list-shared --stale");
    expect(text).toContain("lore list-shared --contradictions");
  });

  it("shows 'No issues detected.' when health is clean", () => {
    const entries = [
      makeEntry({ lastSeenAt: "2026-03-20T00:00:00Z", approvalStatus: "approved" }),
    ];

    const data = aggregateDashboard(entries, [], DEFAULT_OPTIONS);
    const text = renderDashboardText(data);

    expect(text).toContain("No issues detected.");
  });
});
