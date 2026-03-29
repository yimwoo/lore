import { describe, expect, it } from "vitest";

import {
  normalizeForDedup,
  computeFingerprint,
  computeNormalizedHash,
  tokenSetJaccard,
  classifyDuplicate,
  STOPWORDS,
  NEAR_DUPLICATE_THRESHOLD,
  CANDIDATE_DUPLICATE_THRESHOLD,
} from "../src/shared/semantic-normalizer";
import type { DedupClassification } from "../src/shared/semantic-normalizer";

describe("normalizeForDedup", () => {
  describe("IMPERATIVE normalization", () => {
    it("normalizes 'always' and 'must' to the same form", () => {
      const a = normalizeForDedup("Always use snake_case");
      const b = normalizeForDedup("Must use snake_case");
      expect(a).toBe(b);
    });

    it("normalizes 'should' to IMPERATIVE", () => {
      const result = normalizeForDedup("should use snake_case");
      expect(result).toContain("IMPERATIVE");
    });

    it("normalizes 'shall' to IMPERATIVE", () => {
      const result = normalizeForDedup("shall use snake_case");
      expect(result).toContain("IMPERATIVE");
    });

    it("normalizes 'require' to IMPERATIVE", () => {
      const result = normalizeForDedup("require snake_case naming");
      expect(result).toContain("IMPERATIVE");
    });

    it("normalizes 'need to' to IMPERATIVE", () => {
      const result = normalizeForDedup("need to use snake_case");
      expect(result).toContain("IMPERATIVE");
    });
  });

  describe("NEGATION normalization", () => {
    it("normalizes 'never' and 'don't' to the same form", () => {
      const a = normalizeForDedup("Never use camelCase");
      const b = normalizeForDedup("Don't use camelCase");
      expect(a).toBe(b);
    });

    it("normalizes 'do not' to NEGATION", () => {
      const result = normalizeForDedup("do not use camelCase");
      expect(result).toContain("NEGATION");
    });

    it("normalizes 'must not' to NEGATION", () => {
      const result = normalizeForDedup("must not use camelCase");
      expect(result).toContain("NEGATION");
    });

    it("normalizes 'shall not' to NEGATION", () => {
      const result = normalizeForDedup("shall not use camelCase");
      expect(result).toContain("NEGATION");
    });

    it("normalizes 'avoid' to NEGATION", () => {
      const result = normalizeForDedup("avoid using camelCase");
      expect(result).toContain("NEGATION");
    });
  });

  describe("PREFERENCE normalization", () => {
    it("normalizes 'prefer' to contain PREFERENCE", () => {
      const result = normalizeForDedup("I prefer tabs");
      expect(result).toContain("PREFERENCE");
    });

    it("normalizes 'recommended' to contain PREFERENCE", () => {
      const result = normalizeForDedup("It's recommended to use tabs");
      expect(result).toContain("PREFERENCE");
    });
  });

  describe("quote and punctuation stripping", () => {
    it("removes double quotes", () => {
      const result = normalizeForDedup('use "snake_case" naming');
      expect(result).not.toContain('"');
    });

    it("removes single quotes", () => {
      const result = normalizeForDedup("use 'snake_case' naming");
      expect(result).not.toContain("'");
    });

    it("removes backticks", () => {
      const result = normalizeForDedup("use `snake_case` naming");
      expect(result).not.toContain("`");
    });

    it("removes punctuation marks", () => {
      const result = normalizeForDedup("use snake_case! Really? Yes; always: go (now) [done].");
      expect(result).not.toMatch(/[.,;:!?()[\]{}]/);
    });
  });
});

describe("computeFingerprint", () => {
  it("removes stopwords", () => {
    const normalized = normalizeForDedup("the quick fox");
    const fingerprint = computeFingerprint(normalized);
    expect(fingerprint).not.toContain("the");
  });

  it("removes all STOPWORDS", () => {
    for (const stopword of STOPWORDS) {
      const normalized = normalizeForDedup(`${stopword} test_token`);
      const fingerprint = computeFingerprint(normalized);
      const tokens = fingerprint.split(" ");
      expect(tokens).not.toContain(stopword);
    }
  });

  it("removes single-character tokens", () => {
    const normalized = normalizeForDedup("a b c test_token");
    const fingerprint = computeFingerprint(normalized);
    const tokens = fingerprint.split(" ");
    for (const token of tokens) {
      expect(token.length).toBeGreaterThan(1);
    }
  });

  it("deduplicates and sorts tokens", () => {
    const normalized = normalizeForDedup("use snake_case for columns");
    const fingerprint = computeFingerprint(normalized);
    const tokens = fingerprint.split(" ");
    const sorted = [...tokens].sort();
    expect(tokens).toEqual(sorted);
    // no duplicates
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("computeNormalizedHash", () => {
  it("returns a 16-char hex string", () => {
    const hash = computeNormalizedHash("Always use snake_case");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across multiple calls", () => {
    const a = computeNormalizedHash("Always use snake_case");
    const b = computeNormalizedHash("Always use snake_case");
    expect(a).toBe(b);
  });

  describe("fingerprint hash equivalence", () => {
    it("'Always use snake_case' equals 'Must use snake_case'", () => {
      expect(computeNormalizedHash("Always use snake_case")).toBe(
        computeNormalizedHash("Must use snake_case"),
      );
    });

    it("'Never use camelCase' equals 'Don't use camelCase'", () => {
      expect(computeNormalizedHash("Never use camelCase")).toBe(
        computeNormalizedHash("Don't use camelCase"),
      );
    });

    it("'Use snake_case for DB columns' equals 'DB columns should use snake_case'", () => {
      expect(computeNormalizedHash("Use snake_case for DB columns")).toBe(
        computeNormalizedHash("DB columns should use snake_case"),
      );
    });
  });
});

describe("tokenSetJaccard", () => {
  it("returns 1.0 for identity", () => {
    expect(tokenSetJaccard("use snake_case for columns", "use snake_case for columns")).toBe(1.0);
  });

  it("is symmetric", () => {
    const a = "Always use snake_case for columns";
    const b = "Columns must use snake_case";
    expect(tokenSetJaccard(a, b)).toBe(tokenSetJaccard(b, a));
  });

  it("returns 1.0 for both empty", () => {
    expect(tokenSetJaccard("", "")).toBe(1.0);
  });

  it("returns 0.0 for one empty", () => {
    expect(tokenSetJaccard("use snake_case", "")).toBe(0.0);
    expect(tokenSetJaccard("", "use snake_case")).toBe(0.0);
  });

  it("near-duplicate: 'Always use snake_case for columns' vs 'Columns must use snake_case' >= 0.85", () => {
    const similarity = tokenSetJaccard(
      "Always use snake_case for columns",
      "Columns must use snake_case",
    );
    expect(similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("distinct: 'Use PostgreSQL' vs 'Use MySQL' < 0.65", () => {
    const similarity = tokenSetJaccard("Use PostgreSQL", "Use MySQL");
    expect(similarity).toBeLessThan(0.65);
  });
});

describe("classifyDuplicate", () => {
  it("returns exact_duplicate for same normalized hash", () => {
    const result = classifyDuplicate(
      "Always use snake_case",
      "Must use snake_case",
    );
    expect(result.outcome).toBe("exact_duplicate");
  });

  it("returns near_duplicate for Jaccard >= 0.85 but different hashes", () => {
    // 7 shared tokens + 1 extra on one side = Jaccard 7/8 = 0.875
    const a = "enable strict typescript eslint prettier formatting rules additional";
    const b = "enable strict typescript eslint prettier formatting rules";
    const result = classifyDuplicate(a, b);
    expect(computeNormalizedHash(a)).not.toBe(computeNormalizedHash(b));
    expect(result.outcome).toBe("near_duplicate");
    if (result.outcome === "near_duplicate") {
      expect(result.similarity).toBeGreaterThanOrEqual(0.85);
    }
  });

  it("returns candidate_duplicate for 0.65 <= Jaccard < 0.85", () => {
    // 4 shared tokens + 1 unique per side = Jaccard 4/6 = 0.667
    const a = "enable strict typescript eslint prettier";
    const b = "enable strict typescript eslint linting";
    const result = classifyDuplicate(a, b);
    expect(computeNormalizedHash(a)).not.toBe(computeNormalizedHash(b));
    expect(result.outcome).toBe("candidate_duplicate");
    if (result.outcome === "candidate_duplicate") {
      expect(result.similarity).toBeGreaterThanOrEqual(0.65);
      expect(result.similarity).toBeLessThan(0.85);
    }
  });

  it("returns distinct for unrelated entries", () => {
    const result = classifyDuplicate(
      "Use PostgreSQL",
      "Use MySQL",
    );
    expect(result.outcome).toBe("distinct");
  });
});

describe("thresholds", () => {
  it("NEAR_DUPLICATE_THRESHOLD is 0.85", () => {
    expect(NEAR_DUPLICATE_THRESHOLD).toBe(0.85);
  });

  it("CANDIDATE_DUPLICATE_THRESHOLD is 0.65", () => {
    expect(CANDIDATE_DUPLICATE_THRESHOLD).toBe(0.65);
  });
});

describe("edge cases", () => {
  it("empty string", () => {
    const hash = computeNormalizedHash("");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("single-word content", () => {
    const hash = computeNormalizedHash("PostgreSQL");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("content that is all stopwords", () => {
    const hash = computeNormalizedHash("the a an is are for in to of and or but with");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("content with only special characters", () => {
    const hash = computeNormalizedHash("!@#$%^&*()");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("real-world convention pairs", () => {
  it("billing service PostgreSQL pair produces same normalized hash", () => {
    const a = computeNormalizedHash("Use PostgreSQL for the billing service");
    const b = computeNormalizedHash("The billing service should use PostgreSQL");
    expect(a).toBe(b);
  });

  it("tabs vs spaces preference pair", () => {
    const a = normalizeForDedup("I prefer tabs over spaces");
    const b = normalizeForDedup("It's recommended to use tabs over spaces");
    expect(a).toContain("PREFERENCE");
    expect(b).toContain("PREFERENCE");
  });
});

describe("DedupClassification type", () => {
  it("supports all four outcome variants", () => {
    const exact: DedupClassification = { outcome: "exact_duplicate" };
    const near: DedupClassification = { outcome: "near_duplicate", similarity: 0.9 };
    const candidate: DedupClassification = { outcome: "candidate_duplicate", similarity: 0.7 };
    const distinct: DedupClassification = { outcome: "distinct" };

    expect(exact.outcome).toBe("exact_duplicate");
    expect(near.outcome).toBe("near_duplicate");
    expect(candidate.outcome).toBe("candidate_duplicate");
    expect(distinct.outcome).toBe("distinct");
  });
});
