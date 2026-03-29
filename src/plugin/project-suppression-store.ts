import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProjectSuppressionRecord } from "../shared/types";

type FileProjectSuppressionStoreOptions = {
  storagePath: string;
  now?: () => string;
};

const isMissingFileError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );

const suppressionKey = (
  entryId: string,
  projectId: string,
): string => `${entryId}::${projectId}`;

export class FileProjectSuppressionStore {
  private readonly storagePath: string;
  private readonly now: () => string;

  constructor(options: FileProjectSuppressionStoreOptions) {
    this.storagePath = options.storagePath;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async add(record: ProjectSuppressionRecord): Promise<void> {
    const current = await this.readAll();
    const key = suppressionKey(record.entryId, record.projectId);
    if (current.some((item) => suppressionKey(item.entryId, item.projectId) === key)) {
      return;
    }

    await this.writeAll([
      ...current,
      {
        ...record,
        createdAt: record.createdAt ?? this.now(),
      },
    ]);
  }

  async remove(entryId: string, projectId: string): Promise<void> {
    const current = await this.readAll();
    const filtered = current.filter(
      (item) => !(item.entryId === entryId && item.projectId === projectId),
    );

    if (filtered.length === current.length) {
      return;
    }

    await this.writeAll(filtered);
  }

  async isSuppressed(entryId: string, projectId: string): Promise<boolean> {
    const current = await this.readAll();
    return current.some(
      (item) => item.entryId === entryId && item.projectId === projectId,
    );
  }

  async listByProject(projectId: string): Promise<ProjectSuppressionRecord[]> {
    const current = await this.readAll();
    return current.filter((item) => item.projectId === projectId);
  }

  async readAll(): Promise<ProjectSuppressionRecord[]> {
    try {
      const content = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(content) as ProjectSuppressionRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeAll(records: ProjectSuppressionRecord[]): Promise<void> {
    const directory = dirname(this.storagePath);
    const tempPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;

    await mkdir(directory, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tempPath, this.storagePath);
  }
}
