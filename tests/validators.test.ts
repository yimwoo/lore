import { describe, expect, it } from "vitest";

import {
  contentHash,
  normalizeContent,
  validateForbidPatterns,
  validateFilterInput,
  validatePromotionInput,
  validateSharedKnowledgeEntry,
} from "../src/shared/validators";
import { resolveConfig } from "../src/config";

describe("normalizeContent", () => {
  it("trims whitespace", () => {
    expect(normalizeContent("  hello  ")).toBe("hello");
  });

  it("collapses repeated spaces", () => {
    expect(normalizeContent("hello   world")).toBe("hello world");
  });

  it("lowercases", () => {
    expect(normalizeContent("Hello World")).toBe("hello world");
  });

  it("handles combined normalization", () => {
    expect(normalizeContent("  Hello   World  ")).toBe("hello world");
  });
});

describe("contentHash", () => {
  it("is deterministic", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("is case-insensitive after normalization", () => {
    expect(contentHash("Hello World")).toBe(contentHash("hello world"));
  });

  it("ignores extra whitespace", () => {
    expect(contentHash("  hello   world  ")).toBe(contentHash("hello world"));
  });

  it("produces different hashes for different content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });
});

describe("validateSharedKnowledgeEntry", () => {
  const validEntry = {
    kind: "domain_rule" as const,
    title: "Use snake_case for DB columns",
    content: "All database columns must use snake_case naming.",
    tags: ["naming", "database"],
    approvalStatus: "approved" as const,
  };

  it("passes for a valid entry", () => {
    expect(validateSharedKnowledgeEntry(validEntry)).toEqual({ ok: true });
  });

  it("rejects empty title", () => {
    const result = validateSharedKnowledgeEntry({ ...validEntry, title: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects whitespace-only title", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      title: "   ",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects title exceeding 200 characters", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      title: "a".repeat(201),
    });
    expect(result.ok).toBe(false);
  });

  it("accepts title at exactly 200 characters", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      title: "a".repeat(200),
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects empty content", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      content: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects content exceeding 2000 characters", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      content: "a".repeat(2001),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid kind", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      kind: "invalid_kind" as any,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects control characters in title", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      title: "hello\x00world",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects control characters in content", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      content: "hello\x07world",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects tags array exceeding 10 items", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects individual tag exceeding 50 characters", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      tags: ["a".repeat(51)],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string tags", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      tags: [42 as any],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid approval status", () => {
    const result = validateSharedKnowledgeEntry({
      ...validEntry,
      approvalStatus: "invalid" as any,
    });
    expect(result.ok).toBe(false);
  });
});

describe("validatePromotionInput", () => {
  const validInput = {
    kind: "domain_rule",
    title: "Use snake_case for DB columns",
    content: "All database columns must use snake_case naming.",
    tags: ["naming"],
  };

  it("passes for valid input", () => {
    expect(validatePromotionInput(validInput)).toEqual({ ok: true });
  });

  it("rejects invalid kind", () => {
    const result = validatePromotionInput({ ...validInput, kind: "bad" });
    expect(result.ok).toBe(false);
  });

  it("rejects empty title", () => {
    const result = validatePromotionInput({ ...validInput, title: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects empty content", () => {
    const result = validatePromotionInput({ ...validInput, content: "" });
    expect(result.ok).toBe(false);
  });
});

describe("validateForbidPatterns", () => {
  const config = resolveConfig();
  const policy = config.promotionPolicy;

  it("rejects content starting with file path", () => {
    const result = validateForbidPatterns(
      "/src/foo.ts",
      "domain_rule",
      policy,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects content ending with file extension", () => {
    const result = validateForbidPatterns(
      "Check config.json",
      "domain_rule",
      policy,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects content starting with branch name", () => {
    const result = validateForbidPatterns("main branch", "domain_rule", policy);
    expect(result.ok).toBe(false);
  });

  it("rejects master branch name", () => {
    const result = validateForbidPatterns(
      "master is protected",
      "domain_rule",
      policy,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects dev branch name", () => {
    const result = validateForbidPatterns(
      "dev environment only",
      "domain_rule",
      policy,
    );
    expect(result.ok).toBe(false);
  });

  it("passes for clean content", () => {
    const result = validateForbidPatterns(
      "Use snake_case for database columns",
      "domain_rule",
      policy,
    );
    expect(result).toEqual({ ok: true });
  });

  it("applies patterns per kind", () => {
    const result = validateForbidPatterns(
      "/absolute/path",
      "glossary_term",
      policy,
    );
    expect(result.ok).toBe(false);
  });
});

describe("validateFilterInput", () => {
  it("clamps limit to 1..25", () => {
    expect(validateFilterInput({ limit: 0 }).limit).toBe(1);
    expect(validateFilterInput({ limit: 100 }).limit).toBe(25);
    expect(validateFilterInput({ limit: 10 }).limit).toBe(10);
  });

  it("strips invalid kind", () => {
    expect(
      validateFilterInput({ kind: "invalid" as any }).kind,
    ).toBeUndefined();
  });

  it("keeps valid kind", () => {
    expect(validateFilterInput({ kind: "domain_rule" }).kind).toBe(
      "domain_rule",
    );
  });

  it("strips invalid approval status", () => {
    expect(
      validateFilterInput({ approvalStatus: "bad" as any }).approvalStatus,
    ).toBeUndefined();
  });

  it("keeps valid approval status", () => {
    expect(
      validateFilterInput({ approvalStatus: "approved" }).approvalStatus,
    ).toBe("approved");
  });

  it("passes through query and tags unchanged", () => {
    const filter = { query: "test", tags: ["a", "b"] };
    const result = validateFilterInput(filter);
    expect(result.query).toBe("test");
    expect(result.tags).toEqual(["a", "b"]);
  });
});
