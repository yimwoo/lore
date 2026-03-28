import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ObservationEntry } from "../shared/types";

type ObservationLogWriterOptions = {
  observationDir: string;
  sessionId: string;
};

export class ObservationLogWriter {
  private readonly filePath: string;
  private readonly observationDir: string;
  private initialized = false;

  constructor(options: ObservationLogWriterOptions) {
    this.observationDir = options.observationDir;
    this.filePath = join(options.observationDir, `${options.sessionId}.jsonl`);
  }

  async append(entry: ObservationEntry): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.observationDir, { recursive: true });
      this.initialized = true;
    }

    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(this.filePath, line, "utf8");
  }
}

type ObservationLogReaderOptions = {
  observationDir: string;
};

export class ObservationLogReader {
  private readonly observationDir: string;

  constructor(options: ObservationLogReaderOptions) {
    this.observationDir = options.observationDir;
  }

  async readAll(): Promise<ObservationEntry[]> {
    let files: string[];
    try {
      const dirEntries = await readdir(this.observationDir);
      files = dirEntries.filter((f) => f.endsWith(".jsonl"));
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: ObservationEntry[] = [];

    for (const file of files) {
      const filePath = join(this.observationDir, file);
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as ObservationEntry;
          entries.push(parsed);
        } catch {
          // Skip malformed lines (e.g., partial writes from concurrent sessions)
        }
      }
    }

    return entries;
  }

  async cleanup(retentionDays: number = 90): Promise<number> {
    let files: string[];
    try {
      const dirEntries = await readdir(this.observationDir);
      files = dirEntries.filter((f) => f.endsWith(".jsonl"));
    } catch {
      return 0;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const file of files) {
      const filePath = join(this.observationDir, file);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoff) {
          await rm(filePath, { force: true });
          removed += 1;
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return removed;
  }
}
