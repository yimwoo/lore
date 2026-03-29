import { createHash } from "node:crypto";

export const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "for", "in", "to", "of", "and", "or", "but", "with", "that",
  "this", "it", "its", "on", "at", "by", "from",
]);

export const normalizeForDedup = (content: string): string =>
  content
    .toLowerCase()
    // Negation patterns with compound forms first (before IMPERATIVE catches must/shall)
    .replace(/\b(must not|shall not|need not|never|don'?t|do not|avoid)\b/g, "NEGATION")
    .replace(/\b(always|must|should|shall|require|need to|use)\b/g, "IMPERATIVE")
    .replace(/\b(prefer|like to|recommended|better to)\b/g, "PREFERENCE")
    .replace(/['"`\u201C\u201D\u2018\u2019]/g, "")
    .replace(/[.,;:!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const computeFingerprint = (normalized: string): string => {
  const tokens = normalized
    .split(/\s+/)
    .filter((t) => !STOPWORDS.has(t) && t.length > 1);
  const unique = [...new Set(tokens)].sort();
  return unique.join(" ");
};

export const computeNormalizedHash = (content: string): string => {
  const normalized = normalizeForDedup(content);
  const fingerprint = computeFingerprint(normalized);
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
};

export const tokenSetJaccard = (contentA: string, contentB: string): number => {
  const fpA = computeFingerprint(normalizeForDedup(contentA));
  const fpB = computeFingerprint(normalizeForDedup(contentB));
  const setA = new Set(fpA.split(/\s+/).filter((t) => t.length > 0));
  const setB = new Set(fpB.split(/\s+/).filter((t) => t.length > 0));
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
};

export type DedupClassification =
  | { outcome: "exact_duplicate" }
  | { outcome: "near_duplicate"; similarity: number }
  | { outcome: "candidate_duplicate"; similarity: number }
  | { outcome: "distinct" };

export const NEAR_DUPLICATE_THRESHOLD = 0.85;
export const CANDIDATE_DUPLICATE_THRESHOLD = 0.65;

export const classifyDuplicate = (
  contentA: string,
  contentB: string,
): DedupClassification => {
  const hashA = computeNormalizedHash(contentA);
  const hashB = computeNormalizedHash(contentB);
  if (hashA === hashB) {
    return { outcome: "exact_duplicate" };
  }

  const similarity = tokenSetJaccard(contentA, contentB);
  if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
    return { outcome: "near_duplicate", similarity };
  }
  if (similarity >= CANDIDATE_DUPLICATE_THRESHOLD) {
    return { outcome: "candidate_duplicate", similarity };
  }
  return { outcome: "distinct" };
};
