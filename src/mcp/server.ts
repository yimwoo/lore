import type {
  SharedKnowledgeEntry,
  SharedKnowledgeFilter,
  SharedKnowledgeKind,
} from "../shared/types";
import { isSharedKnowledgeKind } from "../shared/types";
import { validateFilterInput } from "../shared/validators";
import type { SharedKnowledgeStore } from "../core/shared-store";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type RecallResponseEntry = {
  id: string;
  kind: SharedKnowledgeKind;
  title: string;
  content: string;
  confidence: number;
  tags: string[];
  projectCount: number;
  lastSeenAt: string;
};

export type RecallResponse = {
  entries: RecallResponseEntry[];
  count: number;
  query?: string;
};

const toResponseEntry = (entry: SharedKnowledgeEntry): RecallResponseEntry => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  content: entry.content,
  confidence: entry.confidence,
  tags: entry.tags,
  projectCount: entry.projectCount,
  lastSeenAt: entry.lastSeenAt,
});

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "lore.recall_rules",
    description:
      "Recall shared domain rules, coding standards, and glossary terms that apply across projects.",
    inputSchema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
        query: {
          type: "string",
          description: "Substring search across title and content",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10)",
        },
      },
    },
  },
  {
    name: "lore.recall_architecture",
    description:
      "Recall shared architecture facts and platform assumptions — service patterns, data stores, infrastructure conventions.",
    inputSchema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
        query: {
          type: "string",
          description: "Substring search across title and content",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10)",
        },
      },
    },
  },
  {
    name: "lore.recall_decisions",
    description:
      "Recall past architectural and design decisions with rationale — why we chose approach A over B.",
    inputSchema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
        query: {
          type: "string",
          description: "Substring search across title and content",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10)",
        },
      },
    },
  },
  {
    name: "lore.search_knowledge",
    description:
      "Search all shared knowledge across all kinds — domain rules, architecture, decisions, preferences, glossary.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Required. Search across title, content, and tags.",
        },
        kind: {
          type: "string",
          enum: [
            "domain_rule",
            "architecture_fact",
            "decision_record",
            "user_preference",
            "glossary_term",
          ],
        },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        minConfidence: { type: "number" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
];

type ToolArgs = Record<string, unknown>;

const parseStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
};

const parseNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const parseString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const scoreRelevance = (
  entry: SharedKnowledgeEntry,
  query: string,
): number => {
  const q = query.toLowerCase();
  const titleLower = entry.title.toLowerCase();
  const contentLower = entry.content.toLowerCase();
  const tagsLower = entry.tags.map((t) => t.toLowerCase());

  // Exact title match
  if (titleLower === q) return 100;
  // Title substring
  if (titleLower.includes(q)) return 80;
  // Tag match
  if (tagsLower.some((t) => t.includes(q))) return 60;
  // Content substring
  if (contentLower.includes(q)) return 40;

  return 0;
};

const handleRecallByKinds = async (
  store: SharedKnowledgeStore,
  kinds: SharedKnowledgeKind[],
  args: ToolArgs,
): Promise<RecallResponse> => {
  const tags = parseStringArray(args.tags);
  const query = parseString(args.query);
  const limit = parseNumber(args.limit);

  const allEntries: SharedKnowledgeEntry[] = [];
  for (const kind of kinds) {
    const filter = validateFilterInput({
      kind,
      approvalStatus: "approved",
      tags,
      query,
      limit: undefined,
    });
    const entries = await store.list(filter);
    allEntries.push(...entries);
  }

  const clampedLimit = Math.max(1, Math.min(25, limit ?? 10));
  const limited = allEntries.slice(0, clampedLimit);

  return {
    entries: limited.map(toResponseEntry),
    count: limited.length,
    query,
  };
};

const handleSearch = async (
  store: SharedKnowledgeStore,
  args: ToolArgs,
): Promise<RecallResponse> => {
  const query = parseString(args.query);
  if (!query || query.trim().length === 0) {
    throw new Error("query is required for lore.search_knowledge");
  }

  const kind = parseString(args.kind);
  const tags = parseStringArray(args.tags);
  const minConfidence = parseNumber(args.minConfidence);
  const limit = parseNumber(args.limit);

  const filter = validateFilterInput({
    kind: kind && isSharedKnowledgeKind(kind) ? kind : undefined,
    approvalStatus: "approved",
    tags,
    minConfidence,
    query,
  });

  const entries = await store.list(filter);

  // Sort by relevance score (deterministic ordering)
  const scored = entries.map((entry) => ({
    entry,
    relevance: scoreRelevance(entry, query),
  }));
  scored.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    // Tiebreaker: confidence descending
    return b.entry.confidence - a.entry.confidence;
  });

  const clampedLimit = Math.max(1, Math.min(25, limit ?? 10));
  const limited = scored.slice(0, clampedLimit);

  return {
    entries: limited.map((s) => toResponseEntry(s.entry)),
    count: limited.length,
    query,
  };
};

export const handleToolCall = async (
  toolName: string,
  args: ToolArgs,
  store: SharedKnowledgeStore,
): Promise<RecallResponse> => {
  switch (toolName) {
    case "lore.recall_rules":
      return handleRecallByKinds(store, ["domain_rule", "glossary_term"], args);
    case "lore.recall_architecture":
      return handleRecallByKinds(store, ["architecture_fact"], args);
    case "lore.recall_decisions":
      return handleRecallByKinds(store, ["decision_record"], args);
    case "lore.search_knowledge":
      return handleSearch(store, args);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
};
