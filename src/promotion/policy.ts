import type { ApprovalStatus, SharedKnowledgeKind } from "../shared/types";
import type { PromotionCriteria } from "../config";
import type { ValidationResult } from "../shared/validators";

export const checkForbidPatterns = (
  content: string,
  kind: SharedKnowledgeKind,
  policy: Record<SharedKnowledgeKind, PromotionCriteria>,
): ValidationResult => {
  const criteria = policy[kind];
  for (const pattern of criteria.forbidPatterns) {
    if (pattern.test(content)) {
      return {
        ok: false,
        reason: `Content matches forbidden pattern for kind "${kind}": ${pattern.source}`,
      };
    }
  }
  return { ok: true };
};

type StateTransitionResult =
  | { ok: true }
  | { ok: false; reason: string };

const VALID_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["demoted"],
  rejected: [],
  demoted: [],
};

export const validateStateTransition = (
  from: ApprovalStatus,
  to: ApprovalStatus,
): StateTransitionResult => {
  const allowed = VALID_TRANSITIONS[from];
  if (allowed.includes(to)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Invalid state transition: "${from}" → "${to}". Allowed transitions from "${from}": ${
      allowed.length > 0 ? allowed.join(", ") : "none"
    }.`,
  };
};
