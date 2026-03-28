import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { MemoryCandidate, MemoryEntry } from "../shared/types";

type StoreResult = {
  ok: boolean;
  saved: MemoryEntry[];
  reason?: string;
};

type FileMemoryStoreOptions = {
  storageDir: string;
  now?: () => string;
  createId?: () => string;
};

const normalizeContent = (content: string): string =>
  content.trim().toLowerCase().replace(/\s+/g, " ");

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_ATTEMPTS = 80;

const projectFileStem = (projectId: string): string =>
  createHash("sha256").update(projectId).digest("hex");

const sortByUpdatedAtDesc = (entries: MemoryEntry[]): MemoryEntry[] =>
  [...entries].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );

export class FileMemoryStore {
  private readonly storageDir: string;
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(options: FileMemoryStoreOptions) {
    this.storageDir = options.storageDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId =
      options.createId ??
      (() => `memory-${Math.random().toString(36).slice(2, 10)}`);
  }

  async listByProject(projectId: string): Promise<MemoryEntry[]> {
    const memories = await this.readProjectFile(projectId);
    return sortByUpdatedAtDesc(memories ?? []);
  }

  async saveCandidates(candidates: MemoryCandidate[]): Promise<StoreResult> {
    if (candidates.length === 0) {
      return { ok: true, saved: [] };
    }

    const groupedByProject = new Map<string, MemoryCandidate[]>();
    for (const candidate of candidates) {
      const current = groupedByProject.get(candidate.projectId) ?? [];
      current.push(candidate);
      groupedByProject.set(candidate.projectId, current);
    }

    const saved: MemoryEntry[] = [];

    for (const [projectId, projectCandidates] of groupedByProject) {
      const lock = await this.acquireProjectLock(projectId);
      if (!lock.ok) {
        return { ok: false, saved, reason: lock.reason };
      }

      try {
        const loadResult = await this.readProjectFile(projectId);
        if (loadResult === null) {
          return {
            ok: false,
            saved,
            reason: `Storage unavailable for project ${projectId}.`,
          };
        }

        const entries = [...loadResult];

        for (const candidate of projectCandidates) {
          const existing = entries.find(
            (entry) =>
              entry.projectId === candidate.projectId &&
              entry.kind === candidate.kind &&
              normalizeContent(entry.content) === normalizeContent(candidate.content),
          );

          if (existing) {
            existing.sourceEventIds = Array.from(
              new Set([...existing.sourceEventIds, ...candidate.sourceEventIds]),
            );
            existing.tags = Array.from(new Set([...existing.tags, ...candidate.tags]));
            existing.confidence = Math.max(existing.confidence, candidate.confidence);
            existing.updatedAt = this.now();
            saved.push(existing);
            continue;
          }

          const timestamp = this.now();
          const entry: MemoryEntry = {
            id: this.createId(),
            projectId: candidate.projectId,
            kind: candidate.kind,
            content: candidate.content,
            sourceEventIds: Array.from(new Set(candidate.sourceEventIds)),
            confidence: candidate.confidence,
            createdAt: timestamp,
            updatedAt: timestamp,
            tags: Array.from(new Set(candidate.tags)),
          };
          entries.push(entry);
          saved.push(entry);
        }

        const persisted = await this.writeProjectFile(projectId, entries);
        if (!persisted.ok) {
          return { ok: false, saved, reason: persisted.reason };
        }
      } finally {
        await lock.release?.();
      }
    }

    return { ok: true, saved: sortByUpdatedAtDesc(saved) };
  }

  private projectPath(projectId: string): string {
    return join(this.storageDir, `${projectFileStem(projectId)}.json`);
  }

  private projectLockPath(projectId: string): string {
    return join(this.storageDir, `${projectFileStem(projectId)}.lock`);
  }

  private async acquireProjectLock(
    projectId: string,
  ): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; reason: string }> {
    try {
      await mkdir(this.storageDir, { recursive: true });
    } catch {
      return {
        ok: false,
        reason: `Storage unavailable for project ${projectId}.`,
      };
    }

    const lockPath = this.projectLockPath(projectId);

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
          return {
            ok: false,
            reason: `Storage unavailable for project ${projectId}.`,
          };
        }

        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    return {
      ok: false,
      reason: `Timed out waiting for storage lock for project ${projectId}.`,
    };
  }

  private async readProjectFile(projectId: string): Promise<MemoryEntry[] | null> {
    try {
      await mkdir(this.storageDir, { recursive: true });
      const path = this.projectPath(projectId);
      const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return "[]";
        }
        throw error;
      });

      const parsed = JSON.parse(content) as MemoryEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return null;
    }
  }

  private async writeProjectFile(
    projectId: string,
    entries: MemoryEntry[],
  ): Promise<{ ok: boolean; reason?: string }> {
    const tempPath = `${this.projectPath(projectId)}.${process.pid}.${Date.now()}.tmp`;

    try {
      await mkdir(this.storageDir, { recursive: true });
      await writeFile(
        tempPath,
        `${JSON.stringify(sortByUpdatedAtDesc(entries), null, 2)}\n`,
        "utf8",
      );
      await rename(tempPath, this.projectPath(projectId));
      return { ok: true };
    } catch {
      await rm(tempPath, { force: true }).catch(() => undefined);
      return {
        ok: false,
        reason: `Storage unavailable for project ${projectId}.`,
      };
    }
  }
}
