export const sessionEventKinds = [
  "user_prompt_submitted",
  "assistant_response_completed",
  "tool_run_completed",
  "tool_run_failed",
] as const;

export type SessionEventKind = (typeof sessionEventKinds)[number];

export type SessionEvent = {
  id: string;
  projectId: string;
  timestamp: string;
  kind: SessionEventKind;
  summary: string;
  details?: string;
  files?: string[];
  metadata?: Record<string, string | number | boolean | null>;
};

export const memoryKinds = ["decision", "working_context", "reminder"] as const;

export type MemoryKind = (typeof memoryKinds)[number];

export type MemoryEntry = {
  id: string;
  projectId: string;
  kind: MemoryKind;
  content: string;
  sourceEventIds: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type MemoryCandidate = Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">;

export const hintCategories = ["recall", "risk", "focus", "next_step"] as const;

export type HintCategory = (typeof hintCategories)[number];

export type HintSource = "project" | "shared";

export type HintBullet = {
  category: HintCategory;
  text: string;
  confidence: number;
  relatedMemoryIds: string[];
  source?: HintSource;
};

export type Hint = {
  projectId: string;
  bullets: HintBullet[];
  createdAt: string;
  promotedAt?: string;
  sourceEventIds: string[];
};

export type SidecarActivity =
  | {
      type: "event_ingested";
      eventId: string;
      projectId: string;
      createdAt: string;
      message: string;
    }
  | {
      type: "memory_saved";
      memoryId: string;
      projectId: string;
      createdAt: string;
      message: string;
    }
  | {
      type: "hint_promoted";
      projectId: string;
      createdAt: string;
      message: string;
    };

export const HINT_MAX_BULLETS = 4;
export const DEFAULT_HINT_CONFIDENCE_THRESHOLD = 0.6;

export const isSessionEventKind = (value: string): value is SessionEventKind =>
  sessionEventKinds.includes(value as SessionEventKind);

export const isMemoryKind = (value: string): value is MemoryKind =>
  memoryKinds.includes(value as MemoryKind);

export const isHintCategory = (value: string): value is HintCategory =>
  hintCategories.includes(value as HintCategory);

// --- Shared Knowledge Types (Plugin v2) ---

export const sharedKnowledgeKinds = [
  "domain_rule",
  "architecture_fact",
  "decision_record",
  "user_preference",
  "glossary_term",
] as const;

export type SharedKnowledgeKind = (typeof sharedKnowledgeKinds)[number];

export const approvalStatuses = [
  "pending",
  "approved",
  "rejected",
  "demoted",
] as const;

export type ApprovalStatus = (typeof approvalStatuses)[number];

export type PromotionSource = "explicit" | "suggested" | "imported";

export const approvalSources = [
  "manual",
  "implicit:user_stated",
  "auto:convergence",
  "import:user_approved",
] as const;

export type ApprovalSource = (typeof approvalSources)[number];

export type SharedKnowledgeEntry = {
  id: string;
  kind: SharedKnowledgeKind;
  title: string;
  content: string;
  confidence: number;
  tags: string[];
  evidenceSummary?: string;
  contradictionCount?: number;
  sourceTurnCount?: number;

  sourceProjectIds: string[];
  sourceMemoryIds: string[];
  promotionSource: PromotionSource;
  createdBy: "user" | "system";

  approvalStatus: ApprovalStatus;
  approvalSource?: ApprovalSource;
  statusReason?: string;
  approvedAt?: string;
  rejectedAt?: string;
  demotedAt?: string;

  sessionCount: number;
  projectCount: number;
  lastSeenAt: string;
  contentHash: string;
  normalizedHash?: string;

  createdAt: string;
  updatedAt: string;
};

// --- Capability & Template Types (SessionStart Template) ---

export type LoreCapabilities = {
  recall: boolean;
  promote: boolean;
  demote: boolean;
  cliAvailable: boolean;
  visibleLoreBlocks: boolean;
};

export type SelectedEntry = {
  id: string;
  kind: SharedKnowledgeKind;
  title: string;
  content: string;
  contentHash: string;
};

export type ContextBuilderResult = {
  selectedEntries: SelectedEntry[];
  injectedContentHashes: string[];
};

export type ConflictTemplateEntry = {
  conflictId: string;
  entryA: { id: string; kind: SharedKnowledgeKind; content: string; confidence: number; lastSeenAt: string };
  entryB: { id: string; kind: SharedKnowledgeKind; content: string; confidence: number; lastSeenAt: string };
  conflictType: ConflictType;
  suggestedWinnerId: string | null;
  explanation: string;
};

export type SessionStartTemplateInput = {
  entries: SelectedEntry[];
  capabilities: LoreCapabilities;
  pendingCount?: number;
  savedReceipt?: {
    handle: string;
    kind: SharedKnowledgeKind;
    content: string;
    undoCommand: "lore no";
  };
  conflicts?: ConflictTemplateEntry[];
};

export type SharedKnowledgeFilter = {
  kind?: SharedKnowledgeKind;
  approvalStatus?: ApprovalStatus;
  minConfidence?: number;
  tags?: string[];
  query?: string;
  limit?: number;
};

export type StoreResult = {
  ok: boolean;
  saved?: SharedKnowledgeEntry[];
  reason?: string;
};

export const conflictTypes = [
  "direct_negation",
  "scope_mismatch",
  "temporal_supersession",
  "specialization",
  "ambiguous",
] as const;

export type ConflictType = (typeof conflictTypes)[number];

export const conflictResolutions = [
  "keep_a",
  "keep_b",
  "scope",
  "merge",
  "dismiss",
] as const;

export type ConflictResolution = (typeof conflictResolutions)[number];

export type ConflictRecord = {
  id: string;
  entryIdA: string;
  entryIdB: string;
  conflictType: ConflictType;
  subjectOverlap: number;
  scopeOverlap: number;
  suggestedWinnerId: string | null;
  explanation: string;
  status: "open" | "resolved";
  resolution?: ConflictResolution;
  resolvedAt?: string;
  resolvedReason?: string;
  detectedAt: string;
};

export const supersessionReasons = [
  "superseded:user_correction",
  "superseded:scope_narrowed",
  "superseded:updated",
  "superseded:merged",
] as const;

export type SupersessionReason = (typeof supersessionReasons)[number];

export const ledgerActions = ["promote", "approve", "reject", "demote", "merge", "resolve"] as const;

export type LedgerAction = (typeof ledgerActions)[number];

export type ApprovalLedgerEntry = {
  id: string;
  knowledgeEntryId: string;
  action: LedgerAction;
  actor: "user" | "system";
  actionSource?: PromotionSource;
  reason?: string;
  metadata?: Record<string, string | string[]>;
  timestamp: string;
};

export const signalStrengths = ["strong", "medium", "weak"] as const;

export type SignalStrength = (typeof signalStrengths)[number];

export const isSignalStrength = (value: string): value is SignalStrength =>
  signalStrengths.includes(value as SignalStrength);

export type ObservationEntry = {
  sessionId: string;
  projectId: string;
  contentHash: string;
  kind: MemoryKind;
  confidence: number;
  timestamp: string;
  contextKey?: string;
  signalStrength?: SignalStrength;
};

export type DraftCandidate = {
  id: string;
  kind: SharedKnowledgeKind;
  title: string;
  content: string;
  confidence: number;
  evidenceNote: string;
  sessionId: string;
  projectId: string;
  turnIndex: number;
  timestamp: string;
  tags: string[];
  signalStrength?: SignalStrength;
};

export type ConsolidationState = {
  lastConsolidatedAt?: string;
  lastAttemptedAt?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
};

export type InjectionScoreWeights = {
  confidence: number;
  stability: number;
  recency: number;
  kindPriority: number;
  relevance: number;
};

export type SessionStartConfig = {
  maxItems: number;
  maxTokenEstimate: number;
  minConfidenceForInjection: number;
  weights: InjectionScoreWeights;
  perKindCaps: Record<SharedKnowledgeKind, number>;
};

export const defaultPerKindCaps: Record<SharedKnowledgeKind, number> = {
  domain_rule: 4,
  glossary_term: 2,
  architecture_fact: 3,
  user_preference: 2,
  decision_record: 1,
};

export const kindPriorityScore: Record<SharedKnowledgeKind, number> = {
  domain_rule: 1.0,
  glossary_term: 0.9,
  architecture_fact: 0.8,
  user_preference: 0.6,
  decision_record: 0.5,
};

export const isSharedKnowledgeKind = (
  value: string,
): value is SharedKnowledgeKind =>
  sharedKnowledgeKinds.includes(value as SharedKnowledgeKind);

export const isApprovalStatus = (value: string): value is ApprovalStatus =>
  approvalStatuses.includes(value as ApprovalStatus);

export const isApprovalSource = (value: string): value is ApprovalSource =>
  approvalSources.includes(value as ApprovalSource);

// --- Whisper Types ---

export type WhisperTopReason = "keyword" | "tag" | "session_affinity" | "kind_priority";

export type WhisperRecord = {
  contentHash: string;
  kind: string;
  source: "shared" | "hint";
  topReason: WhisperTopReason;
  turnIndex: number;
  whisperCount: number;
};

export type VisibleLoreItemDismissAction =
  | "demote_undo_captured"
  | "suppress_project"
  | "reject_pending";

export type VisibleLoreItemApproveAction = "approve_pending";

export type VisibleLoreItem = {
  handle: string;
  entryId: string;
  itemType: "receipt" | "suggested";
  projectId: string;
  turnIndex: number;
  actionOnDismiss: VisibleLoreItemDismissAction;
  actionOnApprove: VisibleLoreItemApproveAction;
};

// --- Lore Visible Item Types (Visibility Layer v2) ---

export const loreItemKinds = [
  "pending_suggestion",
  "saved_receipt",
] as const;

export type LoreItemKind = (typeof loreItemKinds)[number];

export type LoreItemAction = "approve" | "dismiss";

export type LoreVisibleItem = {
  handle: string;
  entryId: string;
  kind: LoreItemKind;
  entryKind: SharedKnowledgeKind;
  content: string;
  actions: readonly LoreItemAction[];
  projectId: string;
  turnIndex: number;
  actionOnDismiss: VisibleLoreItemDismissAction;
  actionOnApprove: VisibleLoreItemApproveAction;
};

export type ReceiptRecord = {
  sessionKey: string;
  entryId: string;
  kind: "saved";
  createdAt: string;
  expiresAfterTurn: number;
  undoCommand: "lore no";
};

export type ProjectSuppressionRecord = {
  entryId: string;
  projectId: string;
  createdAt: string;
  reason: "user:dismissed";
};

export type WhisperSessionState = {
  sessionKey: string;
  turnIndex: number;
  recentFiles: string[];
  recentToolNames: string[];
  whisperHistory: WhisperRecord[];
  injectedContentHashes: string[];
  activeReceipt?: ReceiptRecord;
  visibleItems?: LoreVisibleItem[];
};

export const whisperLabelMap: Record<SharedKnowledgeKind, string> = {
  domain_rule: "rule",
  architecture_fact: "architecture",
  decision_record: "decision",
  user_preference: "preference",
  glossary_term: "term",
};

// --- Dashboard Types ---

export type KindStatusCounts = {
  kind: SharedKnowledgeKind;
  approved: number;
  pending: number;
  rejected: number;
  demoted: number;
};

export type TagCoverage = {
  tag: string;
  entryCount: number;
  strength: "strong" | "moderate" | "weak";
};

export type ActivityPeriod = {
  label: string;
  promotes: number;
  approvals: number;
  rejections: number;
  demotions: number;
};

export type HealthIndicator =
  | { type: "stale_entries"; count: number; thresholdDays: number }
  | { type: "contradictions"; count: number };

export type DashboardData = {
  totalEntries: number;
  kindCounts: KindStatusCounts[];
  tagCoverage: TagCoverage[];
  activity: ActivityPeriod[];
  health: HealthIndicator[];
  generatedAt: string;
};
