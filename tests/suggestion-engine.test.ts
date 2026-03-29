import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SignalStrength } from "../src/shared/types";
import { FileSharedStore } from "../src/core/file-shared-store";
import {
  ObservationLogReader,
  ObservationLogWriter,
} from "../src/promotion/observation-log";
import { SuggestionEngine } from "../src/promotion/suggestion-engine";
import { resolveConfig } from "../src/config";
import { contentHash } from "../src/shared/validators";

let testDir: string;
let obsDir: string;
let sharedStorePath: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `lore-suggest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  obsDir = join(testDir, "observations");
  sharedStorePath = join(testDir, "shared.json");
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const seedObservations = async (
  entries: Array<{
    sessionId: string;
    projectId: string;
    content: string;
    kind: "decision" | "working_context" | "reminder";
    confidence: number;
  }>,
) => {
  for (const entry of entries) {
    const writer = new ObservationLogWriter({
      observationDir: obsDir,
      sessionId: entry.sessionId,
    });
    await writer.append({
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      contentHash: contentHash(entry.content),
      kind: entry.kind,
      confidence: entry.confidence,
      timestamp: "2026-01-10T00:00:00Z",
    });
  }
};

const makeEngine = () => {
  const reader = new ObservationLogReader({ observationDir: obsDir });
  const sharedStore = new FileSharedStore({ storagePath: sharedStorePath });
  const config = resolveConfig();
  return { engine: new SuggestionEngine({
    reader,
    sharedStore,
    policy: config.promotionPolicy,
  }), sharedStore };
};

describe("SuggestionEngine", () => {
  it("returns candidates meeting all criteria", async () => {
    // domain_rule needs: suggest_allowed, confidence>=0.9, sessionCount>=3, projectCount>=1
    await seedObservations([
      { sessionId: "s1", projectId: "p1", content: "Always validate inputs", kind: "reminder", confidence: 0.92 },
      { sessionId: "s2", projectId: "p1", content: "Always validate inputs", kind: "reminder", confidence: 0.92 },
      { sessionId: "s3", projectId: "p1", content: "Always validate inputs", kind: "reminder", confidence: 0.92 },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sessionCount).toBe(3);
    expect(candidates[0]!.projectCount).toBe(1);
  });

  it("excludes candidates below minConfidence", async () => {
    await seedObservations([
      { sessionId: "s1", projectId: "p1", content: "Low conf rule", kind: "reminder", confidence: 0.5 },
      { sessionId: "s2", projectId: "p1", content: "Low conf rule", kind: "reminder", confidence: 0.5 },
      { sessionId: "s3", projectId: "p1", content: "Low conf rule", kind: "reminder", confidence: 0.5 },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes candidates below minSessionCount", async () => {
    // domain_rule needs 3 sessions
    await seedObservations([
      { sessionId: "s1", projectId: "p1", content: "Few sessions", kind: "reminder", confidence: 0.95 },
      { sessionId: "s2", projectId: "p1", content: "Few sessions", kind: "reminder", confidence: 0.95 },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes candidates below minProjectCount", async () => {
    // architecture_fact needs projectCount>=2
    await seedObservations([
      { sessionId: "s1", projectId: "p1", content: "Single project arch", kind: "working_context", confidence: 0.95 },
      { sessionId: "s2", projectId: "p1", content: "Single project arch", kind: "working_context", confidence: 0.95 },
      { sessionId: "s3", projectId: "p1", content: "Single project arch", kind: "working_context", confidence: 0.95 },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes candidates already in shared store", async () => {
    const content = "Already shared rule";
    await seedObservations([
      { sessionId: "s1", projectId: "p1", content, kind: "reminder", confidence: 0.95 },
      { sessionId: "s2", projectId: "p1", content, kind: "reminder", confidence: 0.95 },
      { sessionId: "s3", projectId: "p1", content, kind: "reminder", confidence: 0.95 },
    ]);

    const { engine, sharedStore } = makeEngine();
    await sharedStore.save({
      id: "sk-existing",
      kind: "domain_rule",
      title: "Existing",
      content,
      confidence: 0.9,
      tags: [],
      sourceProjectIds: ["p1"],
      sourceMemoryIds: [],
      promotionSource: "explicit",
      createdBy: "user",
      approvalStatus: "approved",
      approvedAt: "2026-01-01T00:00:00Z",
      sessionCount: 1,
      projectCount: 1,
      lastSeenAt: "2026-01-01T00:00:00Z",
      contentHash: contentHash(content),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes decision kind (explicit_only eligibility)", async () => {
    await seedObservations([
      { sessionId: "s1", projectId: "p1", content: "Decision content", kind: "decision", confidence: 0.98 },
      { sessionId: "s2", projectId: "p2", content: "Decision content", kind: "decision", confidence: 0.98 },
      { sessionId: "s3", projectId: "p3", content: "Decision content", kind: "decision", confidence: 0.98 },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    // decision -> decision_record which is explicit_only
    expect(candidates).toHaveLength(0);
  });

  it("correctly counts distinct sessions and projects", async () => {
    await seedObservations([
      { sessionId: "s1", projectId: "p1", content: "Multi-project rule", kind: "reminder", confidence: 0.95 },
      { sessionId: "s1", projectId: "p1", content: "Multi-project rule", kind: "reminder", confidence: 0.95 },
      { sessionId: "s2", projectId: "p2", content: "Multi-project rule", kind: "reminder", confidence: 0.95 },
      { sessionId: "s3", projectId: "p1", content: "Multi-project rule", kind: "reminder", confidence: 0.95 },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sessionCount).toBe(3);
    expect(candidates[0]!.projectCount).toBe(2);
  });

  it("returns empty for empty observation log", async () => {
    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });
});

const seedObservationsWithSignal = async (
  entries: Array<{
    sessionId: string;
    projectId: string;
    content: string;
    kind: "decision" | "working_context" | "reminder";
    confidence: number;
    signalStrength?: SignalStrength;
  }>,
) => {
  for (const entry of entries) {
    const writer = new ObservationLogWriter({
      observationDir: obsDir,
      sessionId: entry.sessionId,
    });
    await writer.append({
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      contentHash: contentHash(entry.content),
      kind: entry.kind,
      confidence: entry.confidence,
      timestamp: "2026-01-10T00:00:00Z",
      signalStrength: entry.signalStrength,
    });
  }
};

describe("SuggestionEngine signal strength", () => {
  it("strong-signal observation bypasses minSessionCount", async () => {
    await seedObservationsWithSignal([
      { sessionId: "s1", projectId: "p1", content: "Always use snake_case", kind: "reminder", confidence: 0.9, signalStrength: "strong" },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sessionCount).toBe(1);
  });

  it("weak-signal observation respects minSessionCount", async () => {
    await seedObservationsWithSignal([
      { sessionId: "s1", projectId: "p1", content: "Always use snake_case weak", kind: "reminder", confidence: 0.9, signalStrength: "weak" },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("missing signalStrength treated as weak", async () => {
    await seedObservationsWithSignal([
      { sessionId: "s1", projectId: "p1", content: "Always use snake_case none", kind: "reminder", confidence: 0.9 },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("medium-signal observation respects minSessionCount", async () => {
    await seedObservationsWithSignal([
      { sessionId: "s1", projectId: "p1", content: "Always use snake_case med", kind: "reminder", confidence: 0.9, signalStrength: "medium" },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("mixed observations: strong upgrades aggregate", async () => {
    const content = "Always use snake_case mixed";
    await seedObservationsWithSignal([
      { sessionId: "s1", projectId: "p1", content, kind: "reminder", confidence: 0.9, signalStrength: "weak" },
      { sessionId: "s1", projectId: "p1", content, kind: "reminder", confidence: 0.9, signalStrength: "strong" },
    ]);

    const { engine } = makeEngine();
    const candidates = await engine.findCandidates();
    expect(candidates).toHaveLength(1);
  });
});
