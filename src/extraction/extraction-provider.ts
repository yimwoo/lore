import type { DraftCandidate } from "../shared/types";
export type { DraftCandidate } from "../shared/types";

export type TurnArtifact = {
  sessionId: string;
  projectId: string;
  turnIndex: number;
  turnTimestamp: string;
  userPrompt?: string;
  assistantResponse?: string;
  toolSummaries: string[];
  files: string[];
  recentToolNames: string[];
};

export type ExtractionProvider = {
  extractCandidates: (turn: TurnArtifact) => Promise<DraftCandidate[]>;
};

export const extractDraftCandidates = async (
  provider: ExtractionProvider,
  turn: TurnArtifact,
): Promise<DraftCandidate[]> => provider.extractCandidates(turn);
