import type {
  SharedKnowledgeEntry,
  SharedKnowledgeKind,
} from "../shared/types";
import type { SharedKnowledgeStore } from "../core/shared-store";
import type { FileApprovalStore } from "./approval-store";
import type { PromotionCriteria } from "../config";
import {
  contentHash,
  validatePromotionInput,
} from "../shared/validators";
import { computeNormalizedHash } from "../shared/semantic-normalizer";
import { checkForbidPatterns, validateStateTransition } from "./policy";
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "../shared/debug-log";

export type PromoteImportInput = {
  kind: SharedKnowledgeKind;
  title: string;
  content: string;
  tags?: string[];
  sourceFilePath: string;
  approveAll: boolean;
};

export type PromoteImportResult =
  | { ok: true; entry: SharedKnowledgeEntry; action: "created" | "merged" | "skipped" }
  | { ok: false; reason: string };

export type PromoteInput = {
  kind: SharedKnowledgeKind;
  title: string;
  content: string;
  tags?: string[];
  sourceProjectId?: string;
  sourceMemoryId?: string;
};

export type PromoteResult =
  | { ok: true; entry: SharedKnowledgeEntry; action: "created" | "merged" | "upgraded" }
  | { ok: false; reason: string };

export type DemoteResult =
  | { ok: true; entry: SharedKnowledgeEntry }
  | { ok: false; reason: string };

export type ApproveResult =
  | { ok: true; entry: SharedKnowledgeEntry }
  | { ok: false; reason: string };

export type RejectResult =
  | { ok: true; entry: SharedKnowledgeEntry }
  | { ok: false; reason: string };

type PromoterOptions = {
  sharedStore: SharedKnowledgeStore;
  approvalStore: FileApprovalStore;
  policy: Record<SharedKnowledgeKind, PromotionCriteria>;
  now?: () => string;
  createId?: () => string;
};

export class Promoter {
  private readonly sharedStore: SharedKnowledgeStore;
  private readonly approvalStore: FileApprovalStore;
  private readonly policy: Record<SharedKnowledgeKind, PromotionCriteria>;
  private readonly now: () => string;
  private readonly createId: () => string;

  private readonly logRunId: string | undefined;

  constructor(options: PromoterOptions) {
    this.sharedStore = options.sharedStore;
    this.approvalStore = options.approvalStore;
    this.policy = options.policy;
    this.now = options.now ?? (() => new Date().toISOString());
    this.logRunId = debugLoggingEnabled ? createRunId() : undefined;
    this.createId =
      options.createId ??
      (() => `sk-${Math.random().toString(36).slice(2, 10)}`);
  }

  private log(
    level: DebugLogLevel,
    event: string,
    data?: Record<string, unknown>,
    extras?: {
      ok?: boolean;
      summary?: string;
    },
  ): void {
    if (!this.logRunId) {
      return;
    }

    dlog({
      level,
      component: "promoter",
      event,
      hook: "Core",
      runId: this.logRunId,
      ok: extras?.ok,
      summary: extras?.summary,
      data,
    });
  }

  async promoteExplicit(input: PromoteInput): Promise<PromoteResult> {
    const hash = contentHash(input.content);
    this.log("debug", "promotion.promote_requested", {
      kind: input.kind,
      title: input.title,
      contentHash: hash,
    }, {
      ok: true,
    });
    // 1. Validate input
    const validation = validatePromotionInput({
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags,
    });
    if (!validation.ok) {
      this.log("warn", "promotion.promote_rejected", {
        kind: input.kind,
        reason: validation.reason,
        contentHash: hash,
      }, {
        ok: false,
        summary: "Promotion was rejected during validation.",
      });
      return { ok: false, reason: validation.reason };
    }

    // 2. Check forbid patterns
    const forbidCheck = checkForbidPatterns(
      input.content,
      input.kind,
      this.policy,
    );
    if (!forbidCheck.ok) {
      this.log("warn", "promotion.promote_rejected", {
        kind: input.kind,
        reason: forbidCheck.reason,
        contentHash: hash,
      }, {
        ok: false,
        summary: "Promotion content matched a forbidden pattern.",
      });
      return { ok: false, reason: forbidCheck.reason };
    }

    const titleForbidCheck = checkForbidPatterns(
      input.title,
      input.kind,
      this.policy,
    );
    if (!titleForbidCheck.ok) {
      this.log("warn", "promotion.promote_rejected", {
        kind: input.kind,
        reason: titleForbidCheck.reason,
        contentHash: hash,
      }, {
        ok: false,
        summary: "Promotion title matched a forbidden pattern.",
      });
      return { ok: false, reason: titleForbidCheck.reason };
    }

    // 4. Check for existing entry with same contentHash or normalizedHash + kind
    const existing = await this.findExisting(hash, input.kind, computeNormalizedHash(input.content));

    if (existing) {
      if (
        existing.approvalStatus === "approved"
      ) {
        // Merge provenance
        const result = await this.mergeExisting(existing, input);
        if (result.ok) {
          this.log("info", "promotion.promote_merged", {
            entryId: result.entry.id,
            kind: result.entry.kind,
            contentHash: result.entry.contentHash,
          }, {
            ok: true,
            summary: "Promotion merged into an existing approved entry.",
          });
        }
        return result;
      }

      if (existing.approvalStatus === "pending") {
        // Upgrade to approved
        const result = await this.upgradeExisting(existing, input);
        if (result.ok) {
          this.log("info", "promotion.promote_upgraded", {
            entryId: result.entry.id,
            kind: result.entry.kind,
            contentHash: result.entry.contentHash,
          }, {
            ok: true,
            summary: "Promotion upgraded an existing pending entry to approved.",
          });
        }
        return result;
      }

      // rejected or demoted → create new entry (no resurrection)
    }

    // 5. Create new entry
    const result = await this.createNew(input, hash);
    if (result.ok) {
      this.log("info", "promotion.promote_created", {
        entryId: result.entry.id,
        kind: result.entry.kind,
        contentHash: result.entry.contentHash,
      }, {
        ok: true,
        summary: "Promotion created a new shared knowledge entry.",
      });
    } else {
      this.log("warn", "promotion.promote_rejected", {
        kind: input.kind,
        reason: result.reason,
        contentHash: hash,
      }, {
        ok: false,
        summary: "Promotion failed while saving the new entry.",
      });
    }
    return result;
  }

  async promoteImport(input: PromoteImportInput): Promise<PromoteImportResult> {
    const hash = contentHash(input.content);

    // 1. Validate input
    const validation = validatePromotionInput({
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags,
    });
    if (!validation.ok) {
      return { ok: false, reason: validation.reason };
    }

    // 2. Check forbid patterns on content and title
    const forbidCheck = checkForbidPatterns(input.content, input.kind, this.policy);
    if (!forbidCheck.ok) {
      return { ok: false, reason: forbidCheck.reason };
    }
    const titleForbidCheck = checkForbidPatterns(input.title, input.kind, this.policy);
    if (!titleForbidCheck.ok) {
      return { ok: false, reason: titleForbidCheck.reason };
    }

    // 3. Check for existing entry with same content hash or normalized hash
    const existing = await this.findExisting(hash, input.kind, computeNormalizedHash(input.content));
    if (existing) {
      if (existing.approvalStatus === "approved" || existing.approvalStatus === "pending") {
        return { ok: true, entry: existing, action: "skipped" };
      }
      // rejected or demoted -> allow re-import as new entry
    }

    // 4. Create new entry
    const timestamp = this.now();
    const id = this.createId();
    const approveAll = input.approveAll;

    const entry: SharedKnowledgeEntry = {
      id,
      kind: input.kind,
      title: input.title,
      content: input.content,
      confidence: 1.0,
      tags: input.tags ?? [],
      sourceProjectIds: [],
      sourceMemoryIds: [],
      promotionSource: "imported",
      createdBy: "user",
      approvalStatus: approveAll ? "approved" : "pending",
      approvalSource: approveAll ? "import:user_approved" : undefined,
      approvedAt: approveAll ? timestamp : undefined,
      statusReason: `Imported from ${input.sourceFilePath}`,
      sessionCount: 0,
      projectCount: 0,
      lastSeenAt: timestamp,
      contentHash: hash,
      normalizedHash: computeNormalizedHash(input.content),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Ledger first
    await this.approvalStore.append({
      knowledgeEntryId: id,
      action: "promote",
      actor: "user",
      actionSource: "imported",
      reason: `Imported from ${input.sourceFilePath}`,
    });

    // Approve ledger entry if --approve-all
    if (approveAll) {
      await this.approvalStore.append({
        knowledgeEntryId: id,
        action: "approve",
        actor: "user",
        actionSource: "imported",
        reason: "Bulk import with --approve-all",
      });
    }

    // Save to shared store
    const result = await this.sharedStore.save(entry);
    if (!result.ok) {
      return { ok: false, reason: result.reason ?? "Failed to save entry." };
    }

    return { ok: true, entry, action: "created" };
  }

  async demote(id: string, reason: string): Promise<DemoteResult> {
    this.log("debug", "promotion.demote_requested", {
      entryId: id,
      reason,
    }, {
      ok: true,
    });
    const entry = await this.sharedStore.getById(id);
    if (!entry) {
      this.log("warn", "promotion.demote_done", {
        entryId: id,
        reason: `Entry not found: ${id}`,
      }, {
        ok: false,
        summary: "Demotion failed because the entry was missing.",
      });
      return { ok: false, reason: `Entry not found: ${id}` };
    }

    const transition = validateStateTransition(
      entry.approvalStatus,
      "demoted",
    );
    if (!transition.ok) {
      this.log("warn", "promotion.demote_done", {
        entryId: id,
        reason: transition.reason,
      }, {
        ok: false,
        summary: "Demotion failed due to an invalid state transition.",
      });
      return { ok: false, reason: transition.reason };
    }

    // Ledger first
    await this.approvalStore.append({
      knowledgeEntryId: id,
      action: "demote",
      actor: "user",
      actionSource: "explicit",
      reason,
    });

    // Then update shared store
    const result = await this.sharedStore.update(id, {
      approvalStatus: "demoted",
      demotedAt: this.now(),
      statusReason: reason,
    });

    if (!result.ok) {
      this.log("warn", "promotion.demote_done", {
        entryId: id,
        reason: result.reason ?? "Failed to update entry.",
      }, {
        ok: false,
        summary: "Demotion failed while updating the shared store.",
      });
      return { ok: false, reason: result.reason ?? "Failed to update entry." };
    }

    const updated = await this.sharedStore.getById(id);
    this.log("info", "promotion.demote_done", {
      entryId: id,
      status: updated?.approvalStatus,
    }, {
      ok: true,
      summary: "Demotion completed.",
    });
    return { ok: true, entry: updated! };
  }

  async approve(id: string, reason?: string): Promise<ApproveResult> {
    const entry = await this.sharedStore.getById(id);
    if (!entry) {
      this.log("warn", "promotion.approve_done", {
        entryId: id,
        reason: `Entry not found: ${id}`,
      }, {
        ok: false,
        summary: "Approve failed because the entry was missing.",
      });
      return { ok: false, reason: `Entry not found: ${id}` };
    }

    const transition = validateStateTransition(
      entry.approvalStatus,
      "approved",
    );
    if (!transition.ok) {
      this.log("warn", "promotion.approve_done", {
        entryId: id,
        reason: transition.reason,
      }, {
        ok: false,
        summary: "Approve failed due to an invalid state transition.",
      });
      return { ok: false, reason: transition.reason };
    }

    await this.approvalStore.append({
      knowledgeEntryId: id,
      action: "approve",
      actor: "user",
      actionSource: "explicit",
      reason,
    });

    await this.sharedStore.update(id, {
      approvalStatus: "approved",
      approvedAt: this.now(),
      statusReason: reason,
    });

    const updated = await this.sharedStore.getById(id);
    this.log("info", "promotion.approve_done", {
      entryId: id,
      status: updated?.approvalStatus,
    }, {
      ok: true,
      summary: "Approve completed.",
    });
    return { ok: true, entry: updated! };
  }

  async reject(id: string, reason: string): Promise<RejectResult> {
    const entry = await this.sharedStore.getById(id);
    if (!entry) {
      this.log("warn", "promotion.reject_done", {
        entryId: id,
        reason: `Entry not found: ${id}`,
      }, {
        ok: false,
        summary: "Reject failed because the entry was missing.",
      });
      return { ok: false, reason: `Entry not found: ${id}` };
    }

    const transition = validateStateTransition(
      entry.approvalStatus,
      "rejected",
    );
    if (!transition.ok) {
      this.log("warn", "promotion.reject_done", {
        entryId: id,
        reason: transition.reason,
      }, {
        ok: false,
        summary: "Reject failed due to an invalid state transition.",
      });
      return { ok: false, reason: transition.reason };
    }

    await this.approvalStore.append({
      knowledgeEntryId: id,
      action: "reject",
      actor: "user",
      actionSource: "explicit",
      reason,
    });

    await this.sharedStore.update(id, {
      approvalStatus: "rejected",
      rejectedAt: this.now(),
      statusReason: reason,
    });

    const updated = await this.sharedStore.getById(id);
    this.log("info", "promotion.reject_done", {
      entryId: id,
      status: updated?.approvalStatus,
    }, {
      ok: true,
      summary: "Reject completed.",
    });
    return { ok: true, entry: updated! };
  }

  private async findExisting(
    hash: string,
    kind: SharedKnowledgeKind,
    normalizedHash?: string,
  ): Promise<SharedKnowledgeEntry | null> {
    const entries = await this.sharedStore.list({
      kind,
      approvalStatus: "approved",
    });
    const match = entries.find((e) => e.contentHash === hash);
    if (match) return match;

    if (normalizedHash) {
      const normalizedMatch = entries.find(
        (e) => e.normalizedHash === normalizedHash,
      );
      if (normalizedMatch) return normalizedMatch;
    }

    // Also check pending
    const pending = await this.sharedStore.list({
      kind,
      approvalStatus: "pending",
    });
    const pendingMatch = pending.find((e) => e.contentHash === hash);
    if (pendingMatch) return pendingMatch;

    if (normalizedHash) {
      const pendingNormalized = pending.find(
        (e) => e.normalizedHash === normalizedHash,
      );
      if (pendingNormalized) return pendingNormalized;
    }

    return null;
  }

  private async mergeExisting(
    existing: SharedKnowledgeEntry,
    input: PromoteInput,
  ): Promise<PromoteResult> {
    const mergedProjectIds = Array.from(
      new Set([
        ...existing.sourceProjectIds,
        ...(input.sourceProjectId ? [input.sourceProjectId] : []),
      ]),
    );
    const mergedMemoryIds = Array.from(
      new Set([
        ...existing.sourceMemoryIds,
        ...(input.sourceMemoryId ? [input.sourceMemoryId] : []),
      ]),
    );
    const mergedTags = Array.from(
      new Set([...existing.tags, ...(input.tags ?? [])]),
    );

    // Ledger first
    await this.approvalStore.append({
      knowledgeEntryId: existing.id,
      action: "promote",
      actor: "user",
      actionSource: "explicit",
      reason: "Merged with existing entry",
    });

    // Then update
    await this.sharedStore.update(existing.id, {
      sourceProjectIds: mergedProjectIds,
      sourceMemoryIds: mergedMemoryIds,
      tags: mergedTags,
      sessionCount: existing.sessionCount + 1,
      projectCount: mergedProjectIds.length,
      lastSeenAt: this.now(),
    });

    const updated = await this.sharedStore.getById(existing.id);
    return { ok: true, entry: updated!, action: "merged" };
  }

  private async upgradeExisting(
    existing: SharedKnowledgeEntry,
    input: PromoteInput,
  ): Promise<PromoteResult> {
    // Ledger first
    await this.approvalStore.append({
      knowledgeEntryId: existing.id,
      action: "approve",
      actor: "user",
      actionSource: "explicit",
      reason: "Upgraded from pending via explicit promotion",
    });

    // Then update
    await this.sharedStore.update(existing.id, {
      approvalStatus: "approved",
      approvedAt: this.now(),
      statusReason: "Upgraded from pending via explicit promotion",
      sourceProjectIds: Array.from(
        new Set([
          ...existing.sourceProjectIds,
          ...(input.sourceProjectId ? [input.sourceProjectId] : []),
        ]),
      ),
      tags: Array.from(
        new Set([...existing.tags, ...(input.tags ?? [])]),
      ),
    });

    const updated = await this.sharedStore.getById(existing.id);
    return { ok: true, entry: updated!, action: "upgraded" };
  }

  private async createNew(
    input: PromoteInput,
    hash: string,
  ): Promise<PromoteResult> {
    const timestamp = this.now();
    const id = this.createId();

    const entry: SharedKnowledgeEntry = {
      id,
      kind: input.kind,
      title: input.title,
      content: input.content,
      confidence: 1.0,
      tags: input.tags ?? [],
      sourceProjectIds: input.sourceProjectId ? [input.sourceProjectId] : [],
      sourceMemoryIds: input.sourceMemoryId ? [input.sourceMemoryId] : [],
      promotionSource: "explicit",
      createdBy: "user",
      approvalStatus: "approved",
      approvedAt: timestamp,
      sessionCount: 1,
      projectCount: input.sourceProjectId ? 1 : 0,
      lastSeenAt: timestamp,
      contentHash: hash,
      normalizedHash: computeNormalizedHash(input.content),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Ledger first
    await this.approvalStore.append({
      knowledgeEntryId: id,
      action: "promote",
      actor: "user",
      actionSource: "explicit",
    });

    // Then save to shared store
    const result = await this.sharedStore.save(entry);
    if (!result.ok) {
      return { ok: false, reason: result.reason ?? "Failed to save entry." };
    }

    return { ok: true, entry, action: "created" };
  }
}
