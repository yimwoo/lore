import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import type { ConflictRecord, ConflictResolution } from "../shared/types";

export type ConflictStoreOptions = {
  storagePath: string;
  now?: () => string;
  createId?: () => string;
};

export class FileConflictStore {
  private readonly storagePath: string;
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(options: ConflictStoreOptions) {
    this.storagePath = options.storagePath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ??
      (() => `conf-${randomBytes(4).toString("hex")}`);
  }

  async list(filter?: { status?: "open" | "resolved" }): Promise<ConflictRecord[]> {
    const records = await this.readRecords();
    if (!filter?.status) return records;
    return records.filter((r) => r.status === filter.status);
  }

  async findByEntryIds(
    entryIdA: string,
    entryIdB: string,
  ): Promise<ConflictRecord | null> {
    const records = await this.readRecords();
    return records.find(
      (r) =>
        (r.entryIdA === entryIdA && r.entryIdB === entryIdB) ||
        (r.entryIdA === entryIdB && r.entryIdB === entryIdA),
    ) ?? null;
  }

  async add(
    conflict: Omit<ConflictRecord, "id" | "status" | "detectedAt">,
  ): Promise<ConflictRecord> {
    const records = await this.readRecords();

    // Duplicate prevention: check if a conflict for this pair already exists
    const existing = records.find(
      (r) =>
        (r.entryIdA === conflict.entryIdA && r.entryIdB === conflict.entryIdB) ||
        (r.entryIdA === conflict.entryIdB && r.entryIdB === conflict.entryIdA),
    );
    if (existing) return existing;

    const record: ConflictRecord = {
      ...conflict,
      id: this.createId(),
      status: "open",
      detectedAt: this.now(),
    };

    records.push(record);
    await this.writeRecords(records);
    return record;
  }

  async resolve(
    conflictId: string,
    resolution: ConflictResolution,
    reason: string,
  ): Promise<ConflictRecord> {
    const records = await this.readRecords();
    const index = records.findIndex((r) => r.id === conflictId);
    if (index === -1) {
      throw new Error(`Conflict not found: ${conflictId}`);
    }

    const updated: ConflictRecord = {
      ...records[index]!,
      status: "resolved",
      resolution,
      resolvedAt: this.now(),
      resolvedReason: reason,
    };

    records[index] = updated;
    await this.writeRecords(records);
    return updated;
  }

  async removeByEntryId(entryId: string): Promise<number> {
    const records = await this.readRecords();
    const before = records.length;
    const filtered = records.filter(
      (r) => r.entryIdA !== entryId && r.entryIdB !== entryId,
    );
    await this.writeRecords(filtered);
    return before - filtered.length;
  }

  private async readRecords(): Promise<ConflictRecord[]> {
    try {
      const content = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(content) as ConflictRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error: unknown) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeRecords(records: ConflictRecord[]): Promise<void> {
    const dir = dirname(this.storagePath);
    const tempPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;

    await mkdir(dir, { recursive: true });
    await writeFile(
      tempPath,
      `${JSON.stringify(records, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, this.storagePath);
  }
}
