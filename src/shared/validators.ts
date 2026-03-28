import { createHash } from "node:crypto";

import type {
  SharedKnowledgeEntry,
  SharedKnowledgeFilter,
  SharedKnowledgeKind,
} from "./types";
import {
  isApprovalStatus,
  isSharedKnowledgeKind,
  sharedKnowledgeKinds,
} from "./types";
import type { PromotionCriteria } from "../config";

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export type PromotionInput = {
  kind: string;
  title: string;
  content: string;
  tags?: string[];
  sourceMemoryId?: string;
  sourceProjectId?: string;
};

const TITLE_MAX_LENGTH = 200;
const CONTENT_MAX_LENGTH = 2000;
const TAGS_MAX_COUNT = 10;
const TAG_MAX_LENGTH = 50;
const FILTER_LIMIT_MIN = 1;
const FILTER_LIMIT_MAX = 25;

const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export const normalizeContent = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

export const contentHash = (value: string): string =>
  createHash("sha256").update(normalizeContent(value)).digest("hex");

const validateTags = (tags: unknown): ValidationResult => {
  if (!Array.isArray(tags)) {
    return { ok: false, reason: "Tags must be an array." };
  }

  if (tags.length > TAGS_MAX_COUNT) {
    return {
      ok: false,
      reason: `Tags must not exceed ${TAGS_MAX_COUNT} items.`,
    };
  }

  for (const tag of tags) {
    if (typeof tag !== "string") {
      return { ok: false, reason: "Each tag must be a string." };
    }

    if (tag.length > TAG_MAX_LENGTH) {
      return {
        ok: false,
        reason: `Each tag must not exceed ${TAG_MAX_LENGTH} characters.`,
      };
    }
  }

  return { ok: true };
};

const validateTextContent = (
  value: string,
  fieldName: string,
  maxLength: number,
): ValidationResult => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `${fieldName} must be a non-empty string.` };
  }

  if (value.length > maxLength) {
    return {
      ok: false,
      reason: `${fieldName} must not exceed ${maxLength} characters.`,
    };
  }

  if (CONTROL_CHAR_PATTERN.test(value)) {
    return {
      ok: false,
      reason: `${fieldName} must not contain control characters.`,
    };
  }

  return { ok: true };
};

export const validateSharedKnowledgeEntry = (
  entry: Partial<SharedKnowledgeEntry>,
): ValidationResult => {
  if (!isSharedKnowledgeKind(entry.kind ?? "")) {
    return {
      ok: false,
      reason: `Kind must be one of: ${sharedKnowledgeKinds.join(", ")}.`,
    };
  }

  const titleResult = validateTextContent(
    entry.title ?? "",
    "Title",
    TITLE_MAX_LENGTH,
  );
  if (!titleResult.ok) return titleResult;

  const contentResult = validateTextContent(
    entry.content ?? "",
    "Content",
    CONTENT_MAX_LENGTH,
  );
  if (!contentResult.ok) return contentResult;

  if (entry.tags !== undefined) {
    const tagsResult = validateTags(entry.tags);
    if (!tagsResult.ok) return tagsResult;
  }

  if (
    entry.approvalStatus !== undefined &&
    !isApprovalStatus(entry.approvalStatus)
  ) {
    return {
      ok: false,
      reason: "Invalid approval status.",
    };
  }

  return { ok: true };
};

export const validatePromotionInput = (
  input: PromotionInput,
): ValidationResult => {
  if (!isSharedKnowledgeKind(input.kind)) {
    return {
      ok: false,
      reason: `Kind must be one of: ${sharedKnowledgeKinds.join(", ")}.`,
    };
  }

  const titleResult = validateTextContent(
    input.title,
    "Title",
    TITLE_MAX_LENGTH,
  );
  if (!titleResult.ok) return titleResult;

  const contentResult = validateTextContent(
    input.content,
    "Content",
    CONTENT_MAX_LENGTH,
  );
  if (!contentResult.ok) return contentResult;

  if (input.tags !== undefined) {
    const tagsResult = validateTags(input.tags);
    if (!tagsResult.ok) return tagsResult;
  }

  return { ok: true };
};

export const validateForbidPatterns = (
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

export const validateFilterInput = (
  filter: SharedKnowledgeFilter,
): SharedKnowledgeFilter => {
  const clamped = { ...filter };

  if (clamped.limit !== undefined) {
    clamped.limit = Math.max(
      FILTER_LIMIT_MIN,
      Math.min(FILTER_LIMIT_MAX, clamped.limit),
    );
  }

  if (clamped.kind !== undefined && !isSharedKnowledgeKind(clamped.kind)) {
    clamped.kind = undefined;
  }

  if (
    clamped.approvalStatus !== undefined &&
    !isApprovalStatus(clamped.approvalStatus)
  ) {
    clamped.approvalStatus = undefined;
  }

  return clamped;
};
