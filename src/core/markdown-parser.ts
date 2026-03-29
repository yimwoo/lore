import type { SharedKnowledgeKind } from "../shared/types";

export type ImportCandidate = {
  title: string;
  content: string;
  inferredKind: SharedKnowledgeKind;
  tags: string[];
};

export type MarkdownParserOptions = {
  kindOverride?: SharedKnowledgeKind;
  tagPrefix?: string;
};

const TITLE_MAX_LENGTH = 200;
const CONTENT_MAX_LENGTH = 2000;
const PREAMBLE_TITLE_MAX_LENGTH = 100;
const TAG_MAX_LENGTH = 50;

const KIND_PATTERNS: Array<{ kind: SharedKnowledgeKind; patterns: RegExp[] }> = [
  {
    kind: "glossary_term",
    patterns: [
      /\b(means|refers to|is defined as|definition|abbreviation|acronym)\b/i,
      /^[A-Z][A-Za-z]+:/,
    ],
  },
  {
    kind: "architecture_fact",
    patterns: [
      /\b(architecture|system design|service|module|component|layer|schema|database|infrastructure)\b/i,
      /\b(depends on|communicates with|connects to|deployed|hosted)\b/i,
    ],
  },
  {
    kind: "user_preference",
    patterns: [
      /\b(prefer|like to|I usually|my preference|style)\b/i,
    ],
  },
  {
    kind: "decision_record",
    patterns: [
      /\b(decided|decision|chose|rationale|trade-?off|ADR)\b/i,
    ],
  },
];

const HEADING_REGEX = /^(#{2,4})\s+(.+)$/;
const FENCED_CODE_START = /^```/;
const BULLET_REGEX = /^[-*+]\s+/;

const stripMarkdownFormatting = (text: string): string =>
  text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();

const truncate = (text: string, maxLength: number, suffix = ""): string => {
  if (text.length <= maxLength) return text;
  const cutLength = maxLength - suffix.length;
  return text.slice(0, cutLength) + suffix;
};

const normalizeTag = (heading: string): string => {
  const normalized = heading
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return normalized.slice(0, TAG_MAX_LENGTH);
};

const inferKind = (content: string): SharedKnowledgeKind => {
  for (const { kind, patterns } of KIND_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return kind;
      }
    }
  }
  return "domain_rule";
};

type RawSection = {
  headingLevel: number;
  headingText: string;
  bodyLines: string[];
  parentH2Heading?: string;
};

const splitIntoSections = (markdown: string): RawSection[] => {
  const lines = markdown.split("\n");
  const sections: RawSection[] = [];
  let currentSection: RawSection | null = null;
  let inCodeBlock = false;
  let currentH2Heading: string | undefined;

  for (const line of lines) {
    // Track fenced code blocks
    if (FENCED_CODE_START.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      if (currentSection) {
        currentSection.bodyLines.push(line);
      } else {
        // Preamble code block line
        if (!currentSection) {
          currentSection = {
            headingLevel: 0,
            headingText: "",
            bodyLines: [line],
          };
        }
      }
      continue;
    }

    if (inCodeBlock) {
      if (currentSection) {
        currentSection.bodyLines.push(line);
      } else {
        currentSection = {
          headingLevel: 0,
          headingText: "",
          bodyLines: [line],
        };
      }
      continue;
    }

    const headingMatch = HEADING_REGEX.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();

      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }

      if (level === 2) {
        currentH2Heading = text;
      }

      currentSection = {
        headingLevel: level,
        headingText: text,
        bodyLines: [],
        parentH2Heading: level > 2 ? currentH2Heading : undefined,
      };
      continue;
    }

    // Content line
    if (currentSection) {
      currentSection.bodyLines.push(line);
    } else {
      // Preamble content (before any heading)
      currentSection = {
        headingLevel: 0,
        headingText: "",
        bodyLines: [line],
      };
    }
  }

  // Push last section
  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
};

const isExclusivelyBulletList = (bodyLines: string[]): boolean => {
  const nonEmpty = bodyLines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return false;

  // Each non-empty line must be a bullet or a continuation (indented line after bullet)
  let inBullet = false;
  for (const line of nonEmpty) {
    if (BULLET_REGEX.test(line)) {
      inBullet = true;
    } else if (inBullet && /^\s+/.test(line)) {
      // Continuation of a bullet
    } else {
      return false;
    }
  }
  return true;
};

const extractTopLevelBullets = (bodyLines: string[]): string[] => {
  const bullets: string[] = [];
  let current: string | null = null;

  for (const line of bodyLines) {
    if (BULLET_REGEX.test(line)) {
      if (current !== null) {
        bullets.push(current);
      }
      current = line.replace(BULLET_REGEX, "").trim();
    } else if (current !== null && /^\s+/.test(line) && line.trim().length > 0) {
      current += " " + line.trim();
    }
  }

  if (current !== null) {
    bullets.push(current);
  }

  return bullets;
};

const synthesizeTitleFromContent = (
  content: string,
  maxLength: number,
): string => {
  const firstLine = content.split("\n")[0] ?? content;
  const cleaned = stripMarkdownFormatting(firstLine);
  return truncate(cleaned, maxLength);
};

const buildEntry = (
  title: string,
  content: string,
  tags: string[],
  options?: MarkdownParserOptions,
): ImportCandidate | null => {
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) return null;

  const finalContent =
    trimmedContent.length > CONTENT_MAX_LENGTH
      ? truncate(trimmedContent, CONTENT_MAX_LENGTH, "[truncated]")
      : trimmedContent;

  const cleanTitle = stripMarkdownFormatting(title);
  const finalTitle = truncate(cleanTitle, TITLE_MAX_LENGTH);

  const kind = options?.kindOverride ?? inferKind(finalContent);

  const finalTags = [...tags];
  if (options?.tagPrefix && !finalTags.includes(options.tagPrefix)) {
    finalTags.unshift(options.tagPrefix);
  }

  return {
    title: finalTitle,
    content: finalContent,
    inferredKind: kind,
    tags: finalTags,
  };
};

export const parseMarkdownEntries = (
  markdown: string,
  options?: MarkdownParserOptions,
): ImportCandidate[] => {
  const sections = splitIntoSections(markdown);
  const entries: ImportCandidate[] = [];

  for (const section of sections) {
    const body = section.bodyLines.join("\n").trim();

    // Build tags from parent heading
    const tags: string[] = [];
    if (section.parentH2Heading) {
      tags.push(normalizeTag(section.parentH2Heading));
    }

    // Preamble (no heading)
    if (section.headingLevel === 0) {
      if (isExclusivelyBulletList(section.bodyLines)) {
        const bullets = extractTopLevelBullets(section.bodyLines);
        for (const bullet of bullets) {
          const title = synthesizeTitleFromContent(
            bullet,
            PREAMBLE_TITLE_MAX_LENGTH,
          );
          const entry = buildEntry(title, bullet, [...tags], options);
          if (entry) entries.push(entry);
        }
      } else if (body.length > 0) {
        // Non-bullet preamble as a single entry
        const title = synthesizeTitleFromContent(
          body,
          PREAMBLE_TITLE_MAX_LENGTH,
        );
        const entry = buildEntry(title, body, [...tags], options);
        if (entry) entries.push(entry);
      }
      continue;
    }

    // Heading section with exclusively bullets -> split into per-bullet entries
    if (isExclusivelyBulletList(section.bodyLines)) {
      const bullets = extractTopLevelBullets(section.bodyLines);
      for (const bullet of bullets) {
        const headingPrefix = stripMarkdownFormatting(section.headingText);
        const bulletTitle = synthesizeTitleFromContent(bullet, TITLE_MAX_LENGTH - headingPrefix.length - 3);
        const title = `${headingPrefix}: ${bulletTitle}`;
        const entry = buildEntry(title, bullet, [...tags], options);
        if (entry) entries.push(entry);
      }
      continue;
    }

    // Regular heading section
    const entry = buildEntry(section.headingText, body, [...tags], options);
    if (entry) entries.push(entry);
  }

  return entries;
};
