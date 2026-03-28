import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ConsolidatedEntry,
  ConsolidationInput,
  ConsolidationProvider,
  ConsolidationResult,
} from "./consolidation-provider";
import type { DraftCandidate } from "../shared/types";

const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CONFIG_PATH = join(homedir(), ".codex", "config.toml");

type CodexProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

const normalizeContent = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const contentHash = (value: string): string =>
  createHash("sha256").update(normalizeContent(value)).digest("hex");

const readCodexProviderConfig = async (): Promise<CodexProviderConfig> => {
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;

  try {
    const authContent = await readFile(AUTH_PATH, "utf8");
    const parsed = JSON.parse(authContent) as Record<string, unknown>;
    if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0) {
      apiKey = parsed.OPENAI_API_KEY;
    }
  } catch {
    // Missing auth is a valid degraded state.
  }

  try {
    const configContent = await readFile(CONFIG_PATH, "utf8");
    const baseUrlMatch = configContent.match(/base_url\s*=\s*"([^"]+)"/);
    const modelMatch = configContent.match(/^model\s*=\s*"([^"]+)"/m);
    baseUrl = baseUrlMatch?.[1];
    model = modelMatch?.[1];
  } catch {
    // Missing config is a valid degraded state.
  }

  return {
    apiKey,
    baseUrl,
    model: model ?? "gpt-5.4",
  };
};

const buildFallbackResult = (input: ConsolidationInput): ConsolidationResult => {
  const grouped = new Map<string, DraftCandidate[]>();

  for (const draft of input.drafts) {
    const key = `${draft.kind}:${normalizeContent(draft.content)}`;
    const current = grouped.get(key) ?? [];
    current.push(draft);
    grouped.set(key, current);
  }

  const entries: ConsolidatedEntry[] = [];

  for (const drafts of grouped.values()) {
    const primary = drafts[0]!;
    const matchingPending = input.existingPendingEntries.find(
      (entry) =>
        entry.kind === primary.kind &&
        normalizeContent(entry.content) === normalizeContent(primary.content),
    );
    const observation = input.observations.find(
      (candidate) => candidate.contentHash === contentHash(primary.content),
    );

    entries.push({
      entry: {
        id: matchingPending?.id ?? "",
        kind: primary.kind,
        title: primary.title,
        content: primary.content,
        confidence: Math.max(
          primary.confidence,
          observation?.confidence ?? primary.confidence,
          matchingPending?.confidence ?? 0,
        ),
        tags: Array.from(
          new Set([
            ...primary.tags,
            ...(matchingPending?.tags ?? []),
          ]),
        ),
        evidenceSummary:
          observation
            ? `Observed across ${observation.sessionCount} sessions and ${drafts.length} contributing turns.`
            : `Observed across ${drafts.length} contributing turns.`,
        contradictionCount: 0,
        sourceTurnCount: drafts.length,
        sourceProjectIds: Array.from(
          new Set([
            primary.projectId,
            ...(observation?.sampleProjectIds ?? []),
            ...(matchingPending?.sourceProjectIds ?? []),
          ]),
        ),
        sourceMemoryIds: matchingPending?.sourceMemoryIds ?? [],
        promotionSource: "suggested",
        createdBy: "system",
        approvalStatus: "pending",
        sessionCount: observation?.sessionCount ?? drafts.length,
        projectCount: observation?.projectCount ?? 1,
        lastSeenAt:
          observation?.lastSeenAt ??
          drafts.reduce(
            (latest, draft) => (draft.timestamp > latest ? draft.timestamp : latest),
            primary.timestamp,
          ),
        contentHash: contentHash(primary.content),
        createdAt: matchingPending?.createdAt ?? primary.timestamp,
        updatedAt: primary.timestamp,
      },
      consumedEntryIds: drafts
        .map((draft) => draft.id)
        .filter((draftId) => draftId !== matchingPending?.id),
    });
  }

  return { entries };
};

export class CodexConsolidationProvider implements ConsolidationProvider {
  async consolidate(input: ConsolidationInput): Promise<ConsolidationResult> {
    const config = await readCodexProviderConfig();
    if (!config.apiKey || !config.baseUrl) {
      return buildFallbackResult(input);
    }

    // Keep a deterministic fallback until the live model prompt is tuned.
    return buildFallbackResult(input);
  }
}
