import { describe, expect, it } from "vitest";

import {
  classifySignal,
  adjustConfidence,
  STRONG_CONFIDENCE_FLOOR,
  MEDIUM_CONFIDENCE_FLOOR,
} from "../src/extraction/signal-classifier";

describe("classifySignal", () => {
  // Strong indicators
  it("classifies 'we always use snake_case' as strong", () => {
    const result = classifySignal("we always use snake_case");
    expect(result.signalStrength).toBe("strong");
  });

  it("classifies 'our convention is camelCase for variables' as strong", () => {
    const result = classifySignal("our convention is camelCase for variables");
    expect(result.signalStrength).toBe("strong");
  });

  it("classifies 'that's wrong, it should be camelCase' as strong", () => {
    const result = classifySignal("that's wrong, it should be camelCase");
    expect(result.signalStrength).toBe("strong");
  });

  it("classifies 'the rule is no default exports' as strong", () => {
    const result = classifySignal("the rule is no default exports");
    expect(result.signalStrength).toBe("strong");
  });

  it("classifies 'don't ever use class components' as strong", () => {
    const result = classifySignal("don't ever use class components");
    expect(result.signalStrength).toBe("strong");
  });

  it("classifies 'every component must have a test' as strong", () => {
    const result = classifySignal("every component must have a test");
    expect(result.signalStrength).toBe("strong");
  });

  it("classifies 'make sure to always run lint' as strong", () => {
    const result = classifySignal("make sure to always run lint");
    expect(result.signalStrength).toBe("strong");
  });

  it("classifies 'remember that we use ESM modules' as strong", () => {
    const result = classifySignal("remember that we use ESM modules");
    expect(result.signalStrength).toBe("strong");
  });

  // Medium indicators
  it("classifies 'I prefer tabs over spaces' as medium", () => {
    const result = classifySignal("I prefer tabs over spaces");
    expect(result.signalStrength).toBe("medium");
  });

  it("classifies 'we tend to use vitest' as medium", () => {
    const result = classifySignal("we tend to use vitest");
    expect(result.signalStrength).toBe("medium");
  });

  it("classifies 'it's better to use named exports' as medium", () => {
    const result = classifySignal("it's better to use named exports");
    expect(result.signalStrength).toBe("medium");
  });

  it("classifies 'try to keep functions pure' as medium", () => {
    const result = classifySignal("try to keep functions pure");
    expect(result.signalStrength).toBe("medium");
  });

  // Weak / no indicators
  it("classifies 'use a for loop here' as weak (no strong/medium indicators)", () => {
    const result = classifySignal("use a for loop here");
    expect(result.signalStrength).toBe("weak");
  });

  // Dampener overrides
  it("classifies 'let's use pnpm here' as weak (dampener overrides medium)", () => {
    const result = classifySignal("let's use pnpm here");
    expect(result.signalStrength).toBe("weak");
  });

  it("classifies 'maybe use pnpm just this once' as weak (dampeners override medium)", () => {
    const result = classifySignal("maybe use pnpm just this once");
    expect(result.signalStrength).toBe("weak");
  });

  it("classifies 'let's use pnpm just this once for now' as weak (multiple dampeners)", () => {
    const result = classifySignal("let's use pnpm just this once for now");
    expect(result.signalStrength).toBe("weak");
  });

  it("classifies 'add a button to the navbar' as weak (no indicators)", () => {
    const result = classifySignal("add a button to the navbar");
    expect(result.signalStrength).toBe("weak");
  });

  // Match count checks
  it("returns correct match counts for strong text", () => {
    const result = classifySignal("we always use snake_case and our convention is camelCase");
    expect(result.strongMatchCount).toBeGreaterThanOrEqual(2);
    expect(result.signalStrength).toBe("strong");
  });

  it("returns correct match counts for dampened text", () => {
    const result = classifySignal("let's use pnpm here");
    expect(result.mediumMatchCount).toBeGreaterThanOrEqual(1);
    expect(result.weakDampenerCount).toBeGreaterThanOrEqual(1);
    expect(result.signalStrength).toBe("weak");
  });
});

describe("adjustConfidence", () => {
  it("raises low confidence to STRONG_CONFIDENCE_FLOOR for strong signal", () => {
    expect(adjustConfidence(0.6, "strong")).toBe(STRONG_CONFIDENCE_FLOOR);
  });

  it("does not lower confidence above STRONG_CONFIDENCE_FLOOR for strong signal", () => {
    expect(adjustConfidence(0.95, "strong")).toBe(0.95);
  });

  it("raises low confidence to MEDIUM_CONFIDENCE_FLOOR for medium signal", () => {
    expect(adjustConfidence(0.5, "medium")).toBe(MEDIUM_CONFIDENCE_FLOOR);
  });

  it("does not lower confidence above MEDIUM_CONFIDENCE_FLOOR for medium signal", () => {
    expect(adjustConfidence(0.8, "medium")).toBe(0.8);
  });

  it("does not adjust confidence for weak signal (0.5)", () => {
    expect(adjustConfidence(0.5, "weak")).toBe(0.5);
  });

  it("does not adjust confidence for weak signal (0.3)", () => {
    expect(adjustConfidence(0.3, "weak")).toBe(0.3);
  });
});
