import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  SharedKnowledgeEntry,
  SharedKnowledgeFilter,
  StoreResult,
} from "../shared/types";
import type { SharedKnowledgeStore } from "./shared-store";

type FileSharedStoreOptions = {
  storagePath: string;
  now?: () => string;
  createId?: () => string;
};

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_ATTEMPTS = 80;

const matchesFilter = (
  entry: SharedKnowledgeEntry,
  filter: SharedKnowledgeFilter,
): boolean => {
  if (filter.kind !== undefined && entry.kind !== filter.kind) {
    return false;
  }

  if (
    filter.approvalStatus !== undefined &&
    entry.approvalStatus !== filter.approvalStatus
  ) {
    return false;
  }

  if (
    filter.minConfidence !== undefined &&
    entry.confidence < filter.minConfidence
  ) {
    return false;
  }

  if (filter.tags !== undefined && filter.tags.length > 0) {
    const entryTagSet = new Set(entry.tags);
    if (!filter.tags.some((tag) => entryTagSet.has(tag))) {
      return false;
    }
  }

  if (filter.query !== undefined && filter.query.length > 0) {
    const q = filter.query.toLowerCase();
    const inTitle = entry.title.toLowerCase().includes(q);
    const inContent = entry.content.toLowerCase().includes(q);
    const inTags = entry.tags.some((tag) => tag.toLowerCase().includes(q));
    if (!inTitle && !inContent && !inTags) {
      return false;
    }
  }

  return true;
};

const sortByUpdatedAtDesc = (
  entries: SharedKnowledgeEntry[],
): SharedKnowledgeEntry[] =>
  [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export class FileSharedStore implements SharedKnowledgeStore {
  private readonly storagePath: string;
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(options: FileSharedStoreOptions) {
    this.storagePath = options.storagePath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId =
      options.createId ??
      (() => `sk-${Math.random().toString(36).slice(2, 10)}`);
  }

  async list(filter?: SharedKnowledgeFilter): Promise<SharedKnowledgeEntry[]> {
    const entries = await this.readFile();
    const effectiveFilter: SharedKnowledgeFilter = {
      ...filter,
    };

    if (effectiveFilter.approvalStatus === undefined) {
      const filtered = entries.filter(
        (e) => e.approvalStatus !== "demoted",
      );
      const matched = filter
        ? filtered.filter((e) => matchesFilter(e, effectiveFilter))
        : filtered;
      const sorted = sortByUpdatedAtDesc(matched);
      return effectiveFilter.limit
        ? sorted.slice(0, effectiveFilter.limit)
        : sorted;
    }

    const matched = entries.filter((e) => matchesFilter(e, effectiveFilter));
    const sorted = sortByUpdatedAtDesc(matched);
    return effectiveFilter.limit
      ? sorted.slice(0, effectiveFilter.limit)
      : sorted;
  }

  async getById(id: string): Promise<SharedKnowledgeEntry | null> {
    const entries = await this.readFile();
    return entries.find((e) => e.id === id) ?? null;
  }

  async save(entry: SharedKnowledgeEntry): Promise<StoreResult> {
    const lock = await this.acquireLock();
    if (!lock.ok) {
      return { ok: false, reason: lock.reason };
    }

    try {
      const entries = await this.readFile();
      const existing = entries.find(
        (e) =>
          e.contentHash === entry.contentHash &&
          e.kind === entry.kind &&
          e.approvalStatus !== "demoted" &&
          e.approvalStatus !== "rejected",
      );

      if (existing) {
        existing.sourceProjectIds = Array.from(
          new Set([...existing.sourceProjectIds, ...entry.sourceProjectIds]),
        );
        existing.sourceMemoryIds = Array.from(
          new Set([...existing.sourceMemoryIds, ...entry.sourceMemoryIds]),
        );
        existing.tags = Array.from(
          new Set([...existing.tags, ...entry.tags]),
        );
        existing.confidence = Math.max(existing.confidence, entry.confidence);
        existing.sessionCount = Math.max(
          existing.sessionCount,
          entry.sessionCount,
        );
        existing.projectCount = Math.max(
          existing.projectCount,
          entry.projectCount,
        );
        existing.updatedAt = this.now();
        await this.writeFile(entries);
        return { ok: true, saved: [existing] };
      }

      const newEntry: SharedKnowledgeEntry = {
        ...entry,
        id: entry.id || this.createId(),
        createdAt: entry.createdAt || this.now(),
        updatedAt: this.now(),
      };
      entries.push(newEntry);
      await this.writeFile(entries);
      return { ok: true, saved: [newEntry] };
    } finally {
      await lock.release?.();
    }
  }

  async update(
    id: string,
    patch: Partial<SharedKnowledgeEntry>,
  ): Promise<StoreResult> {
    const lock = await this.acquireLock();
    if (!lock.ok) {
      return { ok: false, reason: lock.reason };
    }

    try {
      const entries = await this.readFile();
      const entry = entries.find((e) => e.id === id);
      if (!entry) {
        return { ok: false, reason: `Entry not found: ${id}` };
      }

      Object.assign(entry, patch, { updatedAt: this.now() });
      await this.writeFile(entries);
      return { ok: true, saved: [entry] };
    } finally {
      await lock.release?.();
    }
  }

  async remove(id: string): Promise<StoreResult> {
    return this.update(id, {
      approvalStatus: "demoted",
      demotedAt: this.now(),
    });
  }

  async deletePending(id: string): Promise<StoreResult> {
    const lock = await this.acquireLock();
    if (!lock.ok) {
      return { ok: false, reason: lock.reason };
    }

    try {
      const entries = await this.readFile();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return { ok: false, reason: `Entry not found: ${id}` };
      }

      if (entries[index]!.approvalStatus !== "pending") {
        return { ok: false, reason: `Only pending entries can be deleted: ${id}` };
      }

      const [removed] = entries.splice(index, 1);
      await this.writeFile(entries);
      return { ok: true, saved: removed ? [removed] : [] };
    } finally {
      await lock.release?.();
    }
  }

  private lockPath(): string {
    return `${this.storagePath}.lock`;
  }

  private async acquireLock(): Promise<
    | { ok: true; release: () => Promise<void> }
    | { ok: false; reason: string }
  > {
    const dir = dirname(this.storagePath);
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      return { ok: false, reason: "Storage directory unavailable." };
    }

    const lockPath = this.lockPath();

    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.close();
        return {
          ok: true,
          release: async () => {
            await rm(lockPath, { force: true });
          },
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as NodeJS.ErrnoException).code)
            : "";

        if (code !== "EEXIST") {
          return { ok: false, reason: "Storage unavailable." };
        }

        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    return { ok: false, reason: "Timed out waiting for storage lock." };
  }

  private async readFile(): Promise<SharedKnowledgeEntry[]> {
    const dir = dirname(this.storagePath);
    try {
      await mkdir(dir, { recursive: true });
      const content = await readFile(this.storagePath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return "[]";
          }
          throw error;
        },
      );

      const parsed = JSON.parse(content) as SharedKnowledgeEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeFile(entries: SharedKnowledgeEntry[]): Promise<void> {
    const dir = dirname(this.storagePath);
    const tempPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;

    await mkdir(dir, { recursive: true });
    await writeFile(
      tempPath,
      `${JSON.stringify(sortByUpdatedAtDesc(entries), null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, this.storagePath);
  }
}
