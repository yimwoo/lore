import { join } from "node:path";
import { homedir } from "node:os";

import type {
  InjectionScoreWeights,
  SessionStartConfig,
  SharedKnowledgeKind,
} from "./shared/types";
import { defaultPerKindCaps } from "./shared/types";

export type PromotionCriteria = {
  eligibility: "explicit_only" | "suggest_allowed";
  minConfidence: number;
  minSessionCount: number;
  minProjectCount: number;
  requireApproval: boolean;
  forbidPatterns: RegExp[];
};

export type WhisperConfig = {
  whisperThreshold: number;
  maxBullets: number;
  maxSharedBullets: number;
  maxHintBullets: number;
  hardBlockTurns: number;
  recentFilesCapacity: number;
  recentToolNamesCapacity: number;
  whisperHistoryCapacity: number;
  hintConfidenceThreshold: number;
  keywordMinTokenLength: number;
};

export type LoreConfig = {
  sharedStoragePath: string;
  approvalLedgerPath: string;
  observationDir: string;
  draftDir: string;
  consolidationStatePath: string;
  projectMemoryDir: string;
  whisperStateDir: string;
  consolidationTimeoutMs: number;
  sessionStart: SessionStartConfig;
  whisper: WhisperConfig;
  promotionPolicy: Record<SharedKnowledgeKind, PromotionCriteria>;
  conflictStoragePath: string;
  staleDaysThreshold: number;
};

const DEFAULT_BASE_DIR = join(homedir(), ".lore");

const defaultWeights: InjectionScoreWeights = {
  confidence: 0.25,
  stability: 0.2,
  recency: 0.1,
  kindPriority: 0.15,
  relevance: 0.3,
};

const defaultWhisperConfig: WhisperConfig = {
  whisperThreshold: 0.35,
  maxBullets: 4,
  maxSharedBullets: 2,
  maxHintBullets: 2,
  hardBlockTurns: 2,
  recentFilesCapacity: 20,
  recentToolNamesCapacity: 10,
  whisperHistoryCapacity: 50,
  hintConfidenceThreshold: 0.7,
  keywordMinTokenLength: 3,
};

const defaultSessionStartConfig: SessionStartConfig = {
  maxItems: 10,
  maxTokenEstimate: 2000,
  minConfidenceForInjection: 0.7,
  weights: defaultWeights,
  perKindCaps: { ...defaultPerKindCaps },
};

const DEFAULT_CONSOLIDATION_TIMEOUT_MS = 3000;

const FILE_PATH_PATTERN = /^\//;
const FILE_EXTENSION_PATTERN = /\.(ts|js|json|yaml)$/i;
const BRANCH_NAME_PATTERN = /^(main|master|dev)\b/;

const defaultForbidPatterns: RegExp[] = [
  FILE_PATH_PATTERN,
  FILE_EXTENSION_PATTERN,
  BRANCH_NAME_PATTERN,
];

const defaultPromotionPolicy: Record<SharedKnowledgeKind, PromotionCriteria> = {
  domain_rule: {
    eligibility: "suggest_allowed",
    minConfidence: 0.9,
    minSessionCount: 3,
    minProjectCount: 1,
    requireApproval: true,
    forbidPatterns: [...defaultForbidPatterns],
  },
  glossary_term: {
    eligibility: "suggest_allowed",
    minConfidence: 0.85,
    minSessionCount: 2,
    minProjectCount: 1,
    requireApproval: true,
    forbidPatterns: [...defaultForbidPatterns],
  },
  architecture_fact: {
    eligibility: "suggest_allowed",
    minConfidence: 0.9,
    minSessionCount: 3,
    minProjectCount: 2,
    requireApproval: true,
    forbidPatterns: [...defaultForbidPatterns],
  },
  user_preference: {
    eligibility: "suggest_allowed",
    minConfidence: 0.92,
    minSessionCount: 5,
    minProjectCount: 2,
    requireApproval: true,
    forbidPatterns: [...defaultForbidPatterns],
  },
  decision_record: {
    eligibility: "explicit_only",
    minConfidence: 0.95,
    minSessionCount: 3,
    minProjectCount: 2,
    requireApproval: true,
    forbidPatterns: [...defaultForbidPatterns],
  },
};

export const resolveConfig = (
  overrides?: Partial<LoreConfig>,
): LoreConfig => {
  const baseDir = DEFAULT_BASE_DIR;

  return {
    sharedStoragePath:
      overrides?.sharedStoragePath ?? join(baseDir, "shared.json"),
    approvalLedgerPath:
      overrides?.approvalLedgerPath ?? join(baseDir, "approval-ledger.json"),
    observationDir:
      overrides?.observationDir ?? join(baseDir, "observations"),
    draftDir:
      overrides?.draftDir ?? join(baseDir, "drafts"),
    consolidationStatePath:
      overrides?.consolidationStatePath ?? join(baseDir, "consolidation-state.json"),
    projectMemoryDir:
      overrides?.projectMemoryDir ?? join(baseDir, "projects"),
    whisperStateDir:
      overrides?.whisperStateDir ?? join(baseDir, "whisper-sessions"),
    consolidationTimeoutMs:
      overrides?.consolidationTimeoutMs ?? DEFAULT_CONSOLIDATION_TIMEOUT_MS,
    sessionStart: overrides?.sessionStart ?? { ...defaultSessionStartConfig },
    whisper: overrides?.whisper ?? { ...defaultWhisperConfig },
    promotionPolicy: overrides?.promotionPolicy ?? defaultPromotionPolicy,
    conflictStoragePath:
      overrides?.conflictStoragePath ?? join(baseDir, "conflicts.json"),
    staleDaysThreshold: overrides?.staleDaysThreshold ?? 60,
  };
};
