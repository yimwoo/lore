import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ApprovalLedgerEntry } from "../shared/types";
import type { SharedKnowledgeStore } from "../core/shared-store";

type FileApprovalStoreOptions = {
  ledgerPath: string;
  sharedStore: SharedKnowledgeStore;
  now?: () => string;
  createId?: () => string;
};

export class FileApprovalStore {
  private readonly ledgerPath: string;
  private readonly sharedStore: SharedKnowledgeStore;
  private readonly now: () => string;
  private readonly createId: () => string;
  private reconciled = false;

  constructor(options: FileApprovalStoreOptions) {
    this.ledgerPath = options.ledgerPath;
    this.sharedStore = options.sharedStore;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId =
      options.createId ??
      (() => `ledger-${Math.random().toString(36).slice(2, 10)}`);
  }

  async reconcile(): Promise<void> {
    if (this.reconciled) return;
    this.reconciled = true;

    const ledgerEntries = await this.readLedger();
    if (ledgerEntries.length === 0) return;

    for (const entry of ledgerEntries) {
      const current = await this.sharedStore.getById(entry.knowledgeEntryId);
      if (!current) continue;

      if (entry.action === "demote" && current.approvalStatus !== "demoted") {
        await this.sharedStore.update(entry.knowledgeEntryId, {
          approvalStatus: "demoted",
          demotedAt: entry.timestamp,
          statusReason: entry.reason,
        });
      }

      if (entry.action === "approve" && current.approvalStatus === "pending") {
        await this.sharedStore.update(entry.knowledgeEntryId, {
          approvalStatus: "approved",
          approvedAt: entry.timestamp,
          statusReason: entry.reason,
        });
      }

      if (entry.action === "reject" && current.approvalStatus === "pending") {
        await this.sharedStore.update(entry.knowledgeEntryId, {
          approvalStatus: "rejected",
          rejectedAt: entry.timestamp,
          statusReason: entry.reason,
        });
      }
    }
  }

  async append(entry: Omit<ApprovalLedgerEntry, "id" | "timestamp">): Promise<ApprovalLedgerEntry> {
    await this.ensureReconciled();

    const fullEntry: ApprovalLedgerEntry = {
      ...entry,
      id: this.createId(),
      timestamp: this.now(),
    };

    const entries = await this.readLedger();
    entries.push(fullEntry);
    await this.writeLedger(entries);

    return fullEntry;
  }

  async list(knowledgeEntryId?: string): Promise<ApprovalLedgerEntry[]> {
    await this.ensureReconciled();
    const entries = await this.readLedger();

    if (knowledgeEntryId) {
      return entries.filter((e) => e.knowledgeEntryId === knowledgeEntryId);
    }

    return entries;
  }

  async readAll(): Promise<ApprovalLedgerEntry[]> {
    return this.readLedger();
  }

  private async ensureReconciled(): Promise<void> {
    if (!this.reconciled) {
      await this.reconcile();
    }
  }

  private async readLedger(): Promise<ApprovalLedgerEntry[]> {
    const dir = dirname(this.ledgerPath);
    try {
      await mkdir(dir, { recursive: true });
      const content = await readFile(this.ledgerPath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "[]";
          throw error;
        },
      );
      const parsed = JSON.parse(content) as ApprovalLedgerEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeLedger(entries: ApprovalLedgerEntry[]): Promise<void> {
    const dir = dirname(this.ledgerPath);
    const tempPath = `${this.ledgerPath}.${process.pid}.${Date.now()}.tmp`;

    await mkdir(dir, { recursive: true });
    await writeFile(
      tempPath,
      `${JSON.stringify(entries, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, this.ledgerPath);
  }
}
