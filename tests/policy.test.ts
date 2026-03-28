import { describe, expect, it } from "vitest";

import { checkForbidPatterns, validateStateTransition } from "../src/promotion/policy";
import { resolveConfig } from "../src/config";

describe("validateStateTransition", () => {
  it("allows approved → demoted", () => {
    expect(validateStateTransition("approved", "demoted")).toEqual({ ok: true });
  });

  it("allows pending → approved", () => {
    expect(validateStateTransition("pending", "approved")).toEqual({ ok: true });
  });

  it("allows pending → rejected", () => {
    expect(validateStateTransition("pending", "rejected")).toEqual({ ok: true });
  });

  it("rejects demoted → approved", () => {
    const result = validateStateTransition("demoted", "approved");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("demoted");
      expect(result.reason).toContain("approved");
    }
  });

  it("rejects demoted → demoted", () => {
    const result = validateStateTransition("demoted", "demoted");
    expect(result.ok).toBe(false);
  });

  it("rejects approved → approved", () => {
    const result = validateStateTransition("approved", "approved");
    expect(result.ok).toBe(false);
  });

  it("rejects rejected → approved", () => {
    const result = validateStateTransition("rejected", "approved");
    expect(result.ok).toBe(false);
  });

  it("rejects rejected → demoted", () => {
    const result = validateStateTransition("rejected", "demoted");
    expect(result.ok).toBe(false);
  });

  it("includes allowed transitions in error message", () => {
    const result = validateStateTransition("approved", "approved");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("demoted");
    }
  });

  it("shows 'none' for terminal states", () => {
    const result = validateStateTransition("demoted", "approved");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("none");
    }
  });
});

describe("checkForbidPatterns", () => {
  const config = resolveConfig();
  const policy = config.promotionPolicy;

  it("rejects file paths", () => {
    const result = checkForbidPatterns("/src/foo.ts", "domain_rule", policy);
    expect(result.ok).toBe(false);
  });

  it("rejects branch names", () => {
    const result = checkForbidPatterns("main branch fix", "domain_rule", policy);
    expect(result.ok).toBe(false);
  });

  it("rejects file extensions", () => {
    const result = checkForbidPatterns("update config.json", "glossary_term", policy);
    expect(result.ok).toBe(false);
  });

  it("passes clean content", () => {
    const result = checkForbidPatterns(
      "All database columns must use snake_case",
      "domain_rule",
      policy,
    );
    expect(result).toEqual({ ok: true });
  });

  it("checks against kind-specific patterns", () => {
    const result = checkForbidPatterns("/absolute/path", "architecture_fact", policy);
    expect(result.ok).toBe(false);
  });
});
