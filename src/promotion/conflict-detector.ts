import type { ConflictType } from "../shared/types";
import { conflictTypes } from "../shared/types";

export { conflictTypes };
export type { ConflictType };

export const NEGATION_TRIGGERS: RegExp[] = [
  /\b(never|don'?t|do not|must not|shall not|avoid|prohibit|disallow|not)\b/i,
];

export const IMPERATIVE_TRIGGERS: RegExp[] = [
  /\b(always|must|should|shall|require|use|prefer|ensure)\b/i,
];

export type Polarity = "positive" | "negative" | "neutral";

export const detectPolarity = (content: string): Polarity => {
  const hasNegation = NEGATION_TRIGGERS.some((re) => re.test(content));
  const hasImperative = IMPERATIVE_TRIGGERS.some((re) => re.test(content));
  if (hasNegation && !hasImperative) return "negative";
  if (hasNegation && hasImperative) return "negative";
  if (hasImperative) return "positive";
  return "neutral";
};

export type SubjectScope = {
  action: string;
  subject: string[];
  scope: string[];
};

const SCOPE_PREPOSITIONS = /\b(for|in|when|during|within|across|inside|under)\b/i;

export const extractSubjectScope = (content: string): SubjectScope => {
  const cleaned = content
    .replace(/\b(always|must|should|shall|require|never|don'?t|do not|must not|shall not|avoid|use|prefer|ensure)\b/gi, "")
    .replace(/[.,;:!?()[\]{}'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const scopeMatch = cleaned.match(SCOPE_PREPOSITIONS);
  let subjectPart: string;
  let scopePart: string;

  if (scopeMatch && scopeMatch.index !== undefined) {
    subjectPart = cleaned.slice(0, scopeMatch.index).trim();
    scopePart = cleaned.slice(scopeMatch.index + scopeMatch[0].length).trim();
  } else {
    subjectPart = cleaned;
    scopePart = "";
  }

  const subject = subjectPart
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const scope = scopePart
    .split(/\s+/)
    .filter((t) => t.length > 1);

  return { action: "", subject, scope };
};

export const tokenJaccard = (tokensA: string[], tokensB: string[]): number => {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
};

export type ConflictClassification =
  | { isConflict: false; reason: string }
  | {
      isConflict: true;
      conflictType: ConflictType;
      subjectOverlap: number;
      scopeOverlap: number;
      suggestedWinnerId: string | null;
      explanation: string;
    };

export const SUBJECT_OVERLAP_THRESHOLD = 0.5;
export const TEMPORAL_GAP_DAYS = 60;

export const classifyConflict = (
  entryA: { id: string; kind: string; content: string; confidence: number; lastSeenAt: string },
  entryB: { id: string; kind: string; content: string; confidence: number; lastSeenAt: string },
): ConflictClassification => {
  // Step 1: Same kind?
  if (entryA.kind !== entryB.kind) {
    return { isConflict: false, reason: "Different knowledge kinds rarely contradict." };
  }

  // Step 2: Overlapping subject tokens?
  const ssA = extractSubjectScope(entryA.content);
  const ssB = extractSubjectScope(entryB.content);
  const subjectOverlap = tokenJaccard(ssA.subject, ssB.subject);

  if (subjectOverlap < SUBJECT_OVERLAP_THRESHOLD) {
    return { isConflict: false, reason: "Subjects do not overlap sufficiently." };
  }

  // Step 3: Same polarity?
  const polarityA = detectPolarity(entryA.content);
  const polarityB = detectPolarity(entryB.content);

  if (polarityA === polarityB) {
    return { isConflict: false, reason: "Same polarity; potential duplicate, not conflict." };
  }

  if (polarityA === "neutral" || polarityB === "neutral") {
    return { isConflict: false, reason: "Neutral polarity; cannot determine conflict." };
  }

  // Step 4: Overlapping scope?
  const scopeOverlap = tokenJaccard(ssA.scope, ssB.scope);
  const aHasScope = ssA.scope.length > 0;
  const bHasScope = ssB.scope.length > 0;

  if (aHasScope && bHasScope && scopeOverlap < SUBJECT_OVERLAP_THRESHOLD) {
    // Disjoint scopes -- specialization, not contradiction
    const moreSpecific = ssA.scope.length > ssB.scope.length ? entryA.id : entryB.id;
    return {
      isConflict: true,
      conflictType: "specialization",
      subjectOverlap,
      scopeOverlap,
      suggestedWinnerId: null,
      explanation: `Both entries are valid in different scopes. Entry ${moreSpecific} is more specific.`,
    };
  }

  // Step 5: Temporal gap?
  const msA = new Date(entryA.lastSeenAt).getTime();
  const msB = new Date(entryB.lastSeenAt).getTime();
  const gapDays = Math.abs(msA - msB) / (1000 * 60 * 60 * 24);

  if (gapDays >= TEMPORAL_GAP_DAYS) {
    const newer = msA > msB ? entryA : entryB;
    const older = msA > msB ? entryB : entryA;
    return {
      isConflict: true,
      conflictType: "temporal_supersession",
      subjectOverlap,
      scopeOverlap,
      suggestedWinnerId: newer.id,
      explanation: `Entry ${newer.id} is ${Math.round(gapDays)} days more recent than ${older.id}. The newer entry likely supersedes the older one.`,
    };
  }

  // Both universal or overlapping scope, opposing polarity, within temporal window
  if (!aHasScope && !bHasScope) {
    // Both universal scope -- direct contradiction
    const winner = entryA.confidence > entryB.confidence ? entryA
      : entryB.confidence > entryA.confidence ? entryB
      : msA > msB ? entryA : entryB;
    return {
      isConflict: true,
      conflictType: "direct_negation",
      subjectOverlap,
      scopeOverlap,
      suggestedWinnerId: winner.id,
      explanation: `Direct contradiction: same subject, universal scope, opposing directives. Default winner: ${winner.id} (${entryA.confidence > entryB.confidence ? "higher confidence" : "more recent"}).`,
    };
  }

  if ((!aHasScope && bHasScope) || (aHasScope && !bHasScope)) {
    // One universal, one scoped -- the scoped rule overrides in its scope
    const scoped = aHasScope ? entryA : entryB;
    return {
      isConflict: true,
      conflictType: "scope_mismatch",
      subjectOverlap,
      scopeOverlap,
      suggestedWinnerId: null,
      explanation: `Entry ${scoped.id} has a narrower scope and overrides the universal entry in its context. Both may be valid.`,
    };
  }

  // Overlapping scopes with opposing polarity
  const winner = entryA.confidence > entryB.confidence ? entryA
    : entryB.confidence > entryA.confidence ? entryB
    : msA > msB ? entryA : entryB;

  // When scopes are essentially identical, treat as direct negation
  if (scopeOverlap >= 1.0) {
    return {
      isConflict: true,
      conflictType: "direct_negation",
      subjectOverlap,
      scopeOverlap,
      suggestedWinnerId: winner.id,
      explanation: `Direct contradiction: same subject, same scope, opposing directives. Default winner: ${winner.id} (${entryA.confidence > entryB.confidence ? "higher confidence" : "more recent"}).`,
    };
  }

  return {
    isConflict: true,
    conflictType: "ambiguous",
    subjectOverlap,
    scopeOverlap,
    suggestedWinnerId: winner.id,
    explanation: `Overlapping scopes with opposing directives. Cannot determine clear winner. Default: ${winner.id} (${entryA.confidence > entryB.confidence ? "higher confidence" : "more recent"}).`,
  };
};

export type ConflictPair = {
  entryIdA: string;
  entryIdB: string;
  classification: ConflictClassification & { isConflict: true };
};

export const detectConflicts = (
  entries: Array<{ id: string; kind: string; content: string; confidence: number; lastSeenAt: string }>,
): ConflictPair[] => {
  const conflicts: ConflictPair[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const result = classifyConflict(entries[i]!, entries[j]!);
      if (result.isConflict) {
        conflicts.push({
          entryIdA: entries[i]!.id,
          entryIdB: entries[j]!.id,
          classification: result,
        });
      }
    }
  }

  return conflicts;
};
