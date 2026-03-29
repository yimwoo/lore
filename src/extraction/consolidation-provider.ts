import type { SharedKnowledgeEntry } from "../shared/types";

import type { DraftCandidate } from "./extraction-provider";

export type ConsolidationObservation = {
  contentHash: string;
  sessionCount: number;
  projectCount: number;
  contextKeyCount?: number;
  lastSeenAt: string;
  confidence: number;
  sampleProjectIds: string[];
};

export type ConsolidationInput = {
  drafts: DraftCandidate[];
  observations: ConsolidationObservation[];
  existingPendingEntries: SharedKnowledgeEntry[];
};

export type ConsolidatedEntry = {
  entry: SharedKnowledgeEntry;
  consumedEntryIds: string[];
};

export type ConsolidationResult = {
  entries: ConsolidatedEntry[];
};

export type ConsolidationProvider = {
  consolidate: (input: ConsolidationInput) => Promise<ConsolidationResult>;
};

export const consolidateDraftCandidates = async (
  provider: ConsolidationProvider,
  input: ConsolidationInput,
): Promise<ConsolidationResult> => provider.consolidate(input);
