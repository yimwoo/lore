import { describe, expect, it } from "vitest";

import { parseMarkdownEntries } from "../src/core/markdown-parser";
import type { ImportCandidate } from "../src/core/markdown-parser";

describe("parseMarkdownEntries", () => {
  describe("heading-based splitting", () => {
    it("splits markdown with ## headings into one entry per section", () => {
      const md = `## Rule One

Use snake_case for DB columns.

## Rule Two

Always validate input.
`;
      const result: ImportCandidate[] = parseMarkdownEntries(md);
      expect(result).toHaveLength(2);
      expect(result[0]!.title).toBe("Rule One");
      expect(result[0]!.content).toBe("Use snake_case for DB columns.");
      expect(result[1]!.title).toBe("Rule Two");
      expect(result[1]!.content).toBe("Always validate input.");
    });

    it("splits markdown with ### headings into entries", () => {
      const md = `## Parent

### Child One

First child content.

### Child Two

Second child content.
`;
      const result = parseMarkdownEntries(md);
      expect(result.length).toBeGreaterThanOrEqual(2);
      const childOne = result.find((e) => e.title === "Child One");
      const childTwo = result.find((e) => e.title === "Child Two");
      expect(childOne).toBeDefined();
      expect(childTwo).toBeDefined();
      expect(childOne!.content).toBe("First child content.");
      expect(childTwo!.content).toBe("Second child content.");
    });
  });

  describe("bullet list splitting", () => {
    it("splits heading section with only bullets into per-bullet entries", () => {
      const md = `## Naming Conventions

- Use camelCase for variables
- Use PascalCase for types
- Use SCREAMING_SNAKE for constants
`;
      const result = parseMarkdownEntries(md);
      expect(result).toHaveLength(3);
      expect(result[0]!.title).toContain("Naming Conventions");
      expect(result[0]!.content).toContain("camelCase");
      expect(result[1]!.content).toContain("PascalCase");
      expect(result[2]!.content).toContain("SCREAMING_SNAKE");
    });

    it("prefixes heading text to each bullet's synthesized title", () => {
      const md = `## Style Rules

- Indent with 2 spaces
- No trailing whitespace
`;
      const result = parseMarkdownEntries(md);
      for (const entry of result) {
        expect(entry.title).toMatch(/^Style Rules/);
      }
    });
  });

  describe("preamble handling", () => {
    it("produces entries from bullet points before first heading", () => {
      const md = `- Always use strict mode
- Never use var
- Prefer const over let

## Actual Section

Some content here.
`;
      const result = parseMarkdownEntries(md);
      expect(result.length).toBeGreaterThanOrEqual(3);
      const strictEntry = result.find((e) => e.content.includes("strict mode"));
      expect(strictEntry).toBeDefined();
    });

    it("synthesizes titles from first line truncated to 100 chars", () => {
      const longLine =
        "A".repeat(120) + " is a very long rule that should be truncated";
      const md = `- ${longLine}\n`;
      const result = parseMarkdownEntries(md);
      expect(result).toHaveLength(1);
      expect(result[0]!.title.length).toBeLessThanOrEqual(100);
    });
  });

  describe("fenced code block preservation", () => {
    it("preserves code blocks in entry content", () => {
      const md = `## Code Example

Here is how to do it:

\`\`\`ts
const x = 42;
\`\`\`

More explanation.
`;
      const result = parseMarkdownEntries(md);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toContain("```ts");
      expect(result[0]!.content).toContain("const x = 42;");
      expect(result[0]!.content).toContain("```");
    });

    it("does not split on headings inside fenced code blocks", () => {
      const md = `## Actual Section

Some text.

\`\`\`md
## This is inside a code block
Not a real heading.
\`\`\`

Still part of Actual Section.
`;
      const result = parseMarkdownEntries(md);
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("Actual Section");
      expect(result[0]!.content).toContain("## This is inside a code block");
    });
  });

  describe("title generation", () => {
    it("strips markdown formatting from heading text", () => {
      const md = `## **Bold** and *italic* and \`code\` title

Content here.
`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.title).toBe("Bold and italic and code title");
    });

    it("truncates titles to 200 characters", () => {
      const longTitle = "A".repeat(250);
      const md = `## ${longTitle}\n\nContent.`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.title.length).toBeLessThanOrEqual(200);
    });
  });

  describe("content truncation", () => {
    it("truncates content exceeding 2000 characters with [truncated] suffix", () => {
      const longContent = "X".repeat(2100);
      const md = `## Long Section\n\n${longContent}`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.content.length).toBeLessThanOrEqual(2000);
      expect(result[0]!.content).toContain("[truncated]");
    });
  });

  describe("empty entry filtering", () => {
    it("drops entries with whitespace-only content", () => {
      const md = `## Non-empty

Real content.

## Empty Section



## Another Non-empty

More real content.
`;
      const result = parseMarkdownEntries(md);
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.content.trim().length > 0)).toBe(true);
    });
  });

  describe("kind inference", () => {
    it("infers glossary_term for content with 'means' or 'defined as'", () => {
      const md = `## API Key

An API key means a unique identifier for authentication.
`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.inferredKind).toBe("glossary_term");
    });

    it("infers architecture_fact for content with 'architecture' or 'module'", () => {
      const md = `## System Layout

The architecture uses a layered module design.
`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.inferredKind).toBe("architecture_fact");
    });

    it("infers user_preference for content with 'prefer'", () => {
      const md = `## Formatting

I prefer tabs over spaces.
`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.inferredKind).toBe("user_preference");
    });

    it("infers decision_record for content with 'decided'", () => {
      const md = `## DB Choice

We decided to use PostgreSQL for the main store.
`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.inferredKind).toBe("decision_record");
    });

    it("defaults to domain_rule for generic content", () => {
      const md = `## General Rule

All functions must have return types.
`;
      const result = parseMarkdownEntries(md);
      expect(result[0]!.inferredKind).toBe("domain_rule");
    });
  });

  describe("kind override", () => {
    it("forces all entries to the specified kind", () => {
      const md = `## Rule One

Some rule content.

## Rule Two

The architecture uses modules.
`;
      const result = parseMarkdownEntries(md, {
        kindOverride: "glossary_term",
      });
      expect(result).toHaveLength(2);
      for (const entry of result) {
        expect(entry.inferredKind).toBe("glossary_term");
      }
    });
  });

  describe("tag extraction", () => {
    it("adds normalized ## heading as tag to ### subsection entries", () => {
      const md = `## TypeScript Style Rules

### Imports

Use named imports only.

### Types

Use explicit return types.
`;
      const result = parseMarkdownEntries(md);
      const importsEntry = result.find((e) => e.title === "Imports");
      expect(importsEntry).toBeDefined();
      expect(importsEntry!.tags).toContain("typescript-style-rules");
    });

    it("normalizes tags: lowercased, spaces to hyphens, non-alphanumeric stripped, truncated to 50 chars", () => {
      const longHeading = "A".repeat(60) + " Section";
      const md = `## ${longHeading}\n\n### Sub\n\nContent.`;
      const result = parseMarkdownEntries(md);
      const subEntry = result.find((e) => e.title === "Sub");
      expect(subEntry).toBeDefined();
      for (const tag of subEntry!.tags) {
        expect(tag.length).toBeLessThanOrEqual(50);
        expect(tag).toBe(tag.toLowerCase());
        expect(tag).not.toMatch(/[^a-z0-9-]/);
      }
    });
  });

  describe("tagPrefix option", () => {
    it("prepends tagPrefix to every entry's tag array", () => {
      const md = `## Rule One

Content one.

## Rule Two

Content two.
`;
      const result = parseMarkdownEntries(md, { tagPrefix: "claude-md" });
      for (const entry of result) {
        expect(entry.tags).toContain("claude-md");
      }
    });
  });
});
