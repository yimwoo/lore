import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConsolidationState, DraftCandidate } from "../shared/types";

type DraftStoreWriterOptions = {
  draftDir: string;
  sessionId: string;
};

export class DraftStoreWriter {
  private readonly draftDir: string;
  private readonly filePath: string;
  private initialized = false;

  constructor(options: DraftStoreWriterOptions) {
    this.draftDir = options.draftDir;
    this.filePath = join(options.draftDir, `${options.sessionId}.jsonl`);
  }

  async append(entry: DraftCandidate): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.draftDir, { recursive: true });
      this.initialized = true;
    }

    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

type DraftStoreReaderOptions = {
  draftDir: string;
};

export class DraftStoreReader {
  private readonly draftDir: string;

  constructor(options: DraftStoreReaderOptions) {
    this.draftDir = options.draftDir;
  }

  async readAll(): Promise<DraftCandidate[]> {
    return this.readSince();
  }

  async readSince(timestamp?: string): Promise<DraftCandidate[]> {
    let files: string[];
    try {
      const entries = await readdir(this.draftDir);
      files = entries.filter((entry) => entry.endsWith(".jsonl"));
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

    const drafts: DraftCandidate[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(join(this.draftDir, file), "utf8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as DraftCandidate;
          if (!timestamp || parsed.timestamp > timestamp) {
            drafts.push(parsed);
          }
        } catch {
          // Skip malformed lines from partial writes.
        }
      }
    }

    return drafts;
  }
}

export const readConsolidationState = async (
  statePath: string,
): Promise<ConsolidationState> => {
  try {
    const content = await readFile(statePath, "utf8");
    const parsed = JSON.parse(content) as ConsolidationState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
    if (code === "ENOENT") {
      return {};
    }
    return {};
  }
};

export const writeConsolidationState = async (
  statePath: string,
  state: ConsolidationState,
): Promise<void> => {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};
