import type {
  SharedKnowledgeEntry,
  WhisperRecord,
  WhisperTopReason,
} from "../shared/types";
import { kindPriorityScore } from "../shared/types";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "and", "or",
  "but", "if", "then", "else", "when", "at", "by", "for", "with", "about",
  "from", "to", "in", "on", "of", "it", "its", "this", "that", "these",
  "those", "not", "no", "so", "up", "out", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "only", "own", "same",
  "than", "too", "very", "just", "also",
]);

export const tokenize = (
  text: string,
  minLength: number = 3,
): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= minLength && !STOPWORDS.has(t));

export const keywordScore = (
  promptTokens: string[],
  entryTokens: string[],
): number => {
  if (promptTokens.length === 0 || entryTokens.length === 0) return 0;

  const promptSet = new Set(promptTokens);
  const matching = entryTokens.filter((t) => promptSet.has(t)).length;

  return (
    0.5 * (matching / promptTokens.length) +
    0.5 * (matching / entryTokens.length)
  );
};

const EXTENSION_TAG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".sql": "database",
  ".json": "config",
  ".yaml": "config",
  ".yml": "config",
  ".toml": "config",
  ".css": "frontend",
  ".html": "frontend",
  ".go": "golang",
  ".rs": "rust",
};

const COMMAND_TAG_MAP: Record<string, string> = {
  "npm": "testing",
  "vitest": "testing",
  "jest": "testing",
  "pytest": "testing",
  "git": "version-control",
  "docker": "infrastructure",
  "kubectl": "infrastructure",
  "psql": "database",
  "redis": "cache",
};

const DOMAIN_KEYWORDS = new Set([
  "billing", "auth", "authentication", "authorization", "migration",
  "security", "payment", "encryption", "api", "database", "schema",
  "deployment", "monitoring", "logging", "testing", "performance",
  "cache", "queue", "event", "webhook",
]);

export const inferPromptTags = (
  promptText: string,
  recentFiles: string[],
): string[] => {
  const tags = new Set<string>();

  // File extensions from prompt
  const extMatches = promptText.match(/\.\w+/g) ?? [];
  for (const ext of extMatches) {
    const tag = EXTENSION_TAG_MAP[ext.toLowerCase()];
    if (tag) tags.add(tag);
  }

  // File extensions from recent files
  for (const file of recentFiles) {
    const dotIdx = file.lastIndexOf(".");
    if (dotIdx >= 0) {
      const ext = file.slice(dotIdx).toLowerCase();
      const tag = EXTENSION_TAG_MAP[ext];
      if (tag) tags.add(tag);
    }
  }

  // Command names
  const words = promptText.toLowerCase().split(/\s+/);
  for (const word of words) {
    const tag = COMMAND_TAG_MAP[word];
    if (tag) tags.add(tag);
  }

  // Domain keywords
  for (const word of words) {
    if (DOMAIN_KEYWORDS.has(word)) {
      tags.add(word);
    }
  }

  return Array.from(tags);
};

export const tagScore = (
  promptTags: string[],
  entryTags: string[],
): number => {
  if (promptTags.length === 0 || entryTags.length === 0) return 0;

  const promptSet = new Set(promptTags);
  const entrySet = new Set(entryTags);
  const intersection = promptTags.filter((t) => entrySet.has(t));
  const union = new Set([...promptSet, ...entrySet]);

  return union.size > 0 ? intersection.length / union.size : 0;
};

export const sessionAffinityScore = (
  entry: SharedKnowledgeEntry,
  currentProjectId: string,
  recentFileTags: string[],
): number => {
  const projectMatch = entry.sourceProjectIds.includes(currentProjectId)
    ? 1.0
    : 0.0;

  const entryTagSet = new Set(entry.tags);
  const recentSet = new Set(recentFileTags);
  const intersection = recentFileTags.filter((t) => entryTagSet.has(t));
  const union = new Set([...entryTagSet, ...recentSet]);
  const affinity = union.size > 0 ? intersection.length / union.size : 0;

  return Math.max(0, Math.min(1, 0.5 * projectMatch + 0.5 * affinity));
};

type TurnRelevanceInput = {
  promptTokens: string[];
  promptTags: string[];
  currentProjectId: string;
  recentFileTags: string[];
};

export const turnRelevance = (
  entry: SharedKnowledgeEntry,
  input: TurnRelevanceInput,
): { score: number; topReason: WhisperTopReason } => {
  const entryTokens = tokenize(
    `${entry.title} ${entry.content}`,
  );

  const kw = keywordScore(input.promptTokens, entryTokens);
  const tg = tagScore(input.promptTags, entry.tags);
  const sa = sessionAffinityScore(
    entry,
    input.currentProjectId,
    input.recentFileTags,
  );
  const kp = kindPriorityScore[entry.kind] ?? 0;

  const score = 0.4 * kw + 0.3 * tg + 0.2 * sa + 0.1 * kp;

  // Determine top reason
  const dimensions: [number, WhisperTopReason][] = [
    [0.4 * kw, "keyword"],
    [0.3 * tg, "tag"],
    [0.2 * sa, "session_affinity"],
    [0.1 * kp, "kind_priority"],
  ];
  dimensions.sort((a, b) => b[0] - a[0]);
  const topReason = dimensions[0]![1];

  return { score, topReason };
};

export const recentWhisperPenalty = (
  record: WhisperRecord | undefined,
  currentTurn: number,
  hardBlockTurns: number,
): number => {
  if (!record) return 0;
  const turnsSince = currentTurn - record.turnIndex;
  if (turnsSince <= hardBlockTurns) return 1.0; // hard block
  if (turnsSince <= 5) return 0.4;
  if (turnsSince <= 10) return 0.15;
  return 0;
};

export const frequencyPenalty = (
  record: WhisperRecord | undefined,
): number => {
  if (!record) return 0;
  return Math.min(0.3, record.whisperCount * 0.08);
};

export const effectiveScore = (
  relevance: number,
  whisperPenalty: number,
  freqPenalty: number,
): number => relevance - whisperPenalty - freqPenalty;
