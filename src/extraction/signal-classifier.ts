import type { SignalStrength } from "../shared/types";

export type { SignalStrength } from "../shared/types";

export const signalStrengths = ["strong", "medium", "weak"] as const;

export type ClassificationResult = {
  signalStrength: SignalStrength;
  strongMatchCount: number;
  mediumMatchCount: number;
  weakDampenerCount: number;
};

const STRONG_INDICATORS: RegExp[] = [
  /\b(always|never|must|shall|required)\b/i,
  /\b(the rule is|our convention|we follow|we use|our standard)\b/i,
  /\b(don'?t|do not)\s+(ever|use|allow)\b/i,
  /\b(wrong|incorrect|that'?s not|should be|should not be)\b/i,
  /\b(every|all)\s+\w+\s+(must|should|need to)\b/i,
  /\b(make sure|ensure)\s+(to\s+)?(always|never)\b/i,
  /\b(remember that we|keep in mind that we)\b/i,
];

const MEDIUM_INDICATORS: RegExp[] = [
  /\b(prefer|like to|let'?s use|I usually)\b/i,
  /\b(better to|recommended|suggestion|I suggest)\b/i,
  /\b(we tend to|we typically|we generally|in general we)\b/i,
  /\b(my preference|our preference)\b/i,
  /\b(try to|aim to|strive to)\b/i,
];

const WEAK_DAMPENERS: RegExp[] = [
  /\b(just this once|for now|in this case|this time)\b/i,
  /\b(maybe|perhaps|might|could)\b/i,
  /\b(here|this file|this function|this component)\b/i,
  /\?$/,
];

export const STRONG_CONFIDENCE_FLOOR = 0.9;
export const MEDIUM_CONFIDENCE_FLOOR = 0.7;

export const classifySignal = (text: string): ClassificationResult => {
  const strongMatchCount = STRONG_INDICATORS.filter((re) => re.test(text)).length;
  const mediumMatchCount = MEDIUM_INDICATORS.filter((re) => re.test(text)).length;
  const weakDampenerCount = WEAK_DAMPENERS.filter((re) => re.test(text)).length;

  if (weakDampenerCount >= strongMatchCount + mediumMatchCount && weakDampenerCount > 0) {
    return { signalStrength: "weak", strongMatchCount, mediumMatchCount, weakDampenerCount };
  }

  if (strongMatchCount > 0) {
    return { signalStrength: "strong", strongMatchCount, mediumMatchCount, weakDampenerCount };
  }

  if (mediumMatchCount > 0) {
    return { signalStrength: "medium", strongMatchCount, mediumMatchCount, weakDampenerCount };
  }

  return { signalStrength: "weak", strongMatchCount, mediumMatchCount, weakDampenerCount };
};

export const adjustConfidence = (
  originalConfidence: number,
  signalStrength: SignalStrength,
): number => {
  if (signalStrength === "strong") {
    return Math.max(originalConfidence, STRONG_CONFIDENCE_FLOOR);
  }
  if (signalStrength === "medium") {
    return Math.max(originalConfidence, MEDIUM_CONFIDENCE_FLOOR);
  }
  return originalConfidence;
};
