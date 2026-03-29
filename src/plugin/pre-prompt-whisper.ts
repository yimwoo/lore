import { createInterface } from "node:readline";

import { FileSharedStore } from "../core/file-shared-store";
import { FileMemoryStore } from "../core/memory-store";
import { buildPreTurnHint } from "../core/hint-engine";
import { resolveConfig } from "../config";
import type { WhisperConfig } from "../config";
import { deriveSessionKey, readWhisperState, writeWhisperState } from "./whisper-state";
import {
  effectiveScore,
  frequencyPenalty,
  inferPromptTags,
  recentWhisperPenalty,
  tokenize,
  turnRelevance,
} from "./whisper-scorer";
import type {
  HintBullet,
  SharedKnowledgeEntry,
  WhisperRecord,
  WhisperSessionState,
} from "../shared/types";
import { whisperLabelMap } from "../shared/types";
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "../shared/debug-log";

type WhisperInput = {
  promptText: string;
  sessionKey: string;
  cwd: string;
};

export type LoreMicroCommand =
  | {
      action: "approve" | "dismiss";
      target?: string;
    };

type WhisperBullet = {
  label: string;
  text: string;
  contentHash: string;
  kind: string;
  source: "shared" | "hint";
  topReason: WhisperRecord["topReason"];
  score: number;
  displayMode?: "default" | "suggested";
  handle?: string;
  entryId?: string;
};

const HIGH_CONFIDENCE_HINT_THRESHOLD = 0.9;

const isWeakPrompt = (
  promptTokens: string[],
  promptTags: string[],
): boolean => promptTags.length === 0 && promptTokens.length <= 4;

const hasStrongSessionContext = (
  recentFileTags: string[],
  recentToolNames: string[],
): boolean => recentFileTags.length > 0 || recentToolNames.length > 0;

const summarizeSuppressionReason = (
  promptText: string,
  state: WhisperSessionState,
  sharedEntries: SharedKnowledgeEntry[],
  hintBullets: HintBullet[],
  config: WhisperConfig,
): string => {
  if (sharedEntries.length === 0 && hintBullets.length === 0) {
    return "no_candidates";
  }

  const injectedSet = new Set(state.injectedContentHashes);
  const approvedSharedEntries = sharedEntries.filter(
    (entry) => entry.approvalStatus === "approved",
  );
  if (
    approvedSharedEntries.length > 0 &&
    approvedSharedEntries.every((entry) => injectedSet.has(entry.contentHash))
  ) {
    return "already_injected";
  }

  const promptTokens = tokenize(promptText, config.keywordMinTokenLength);
  const promptTags = inferPromptTags(
    promptText,
    state.recentFiles,
    state.recentToolNames,
  );
  const recentFileTags = inferPromptTags("", state.recentFiles, state.recentToolNames);
  if (
    hintBullets.length > 0 &&
    isWeakPrompt(promptTokens, promptTags) &&
    !hasStrongSessionContext(recentFileTags, state.recentToolNames)
  ) {
    return "weak_prompt_and_no_strong_context";
  }

  return "below_threshold";
};

const assignVisibleHandle = (index: number): string => `@l${index + 1}`;

export const parseLoreMicroCommand = (
  promptText: string,
): LoreMicroCommand | null => {
  const trimmed = promptText.trim();
  const match = /^lore\s+(yes|no)(?:\s+(\S+))?$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  return {
    action: match[1]?.toLowerCase() === "yes" ? "approve" : "dismiss",
    target: match[2],
  };
};

export const selectWhisperBullets = (
  input: WhisperInput,
  state: WhisperSessionState,
  sharedEntries: SharedKnowledgeEntry[],
  hintBullets: HintBullet[],
  config: WhisperConfig,
): WhisperBullet[] => {
  const promptTokens = tokenize(input.promptText, config.keywordMinTokenLength);
  const promptTags = inferPromptTags(
    input.promptText,
    state.recentFiles,
    state.recentToolNames,
  );
  const recentFileTags = inferPromptTags("", state.recentFiles, state.recentToolNames);
  const currentProjectId =
    input.cwd.split("/").filter(Boolean).pop() ?? "unknown";

  const historyMap = new Map<string, WhisperRecord>();
  for (const record of state.whisperHistory) {
    historyMap.set(record.contentHash, record);
  }

  const injectedSet = new Set(state.injectedContentHashes);

  // Score shared entries
  const scoredShared: WhisperBullet[] = [];
  for (const entry of sharedEntries) {
    if (entry.approvalStatus !== "approved" && entry.approvalStatus !== "pending") {
      continue;
    }

    // Hard block: skip if whispered in last N turns
    const record = historyMap.get(entry.contentHash);
    const penalty = recentWhisperPenalty(
      record,
      state.turnIndex,
      config.hardBlockTurns,
    );
    if (penalty >= 1.0) continue;

    // Skip if already in SessionStart
    if (injectedSet.has(entry.contentHash)) continue;

    const rel = turnRelevance(entry, {
      promptTokens,
      promptTags,
      currentProjectId,
      recentFileTags,
    });

    const freqPen = frequencyPenalty(record);
    const effective = effectiveScore(rel.score, penalty, freqPen);

    if (effective >= config.whisperThreshold) {
      scoredShared.push({
        label: whisperLabelMap[entry.kind] ?? entry.kind,
        text: entry.content,
        contentHash: entry.contentHash,
        kind: entry.kind,
        source: "shared",
        topReason: rel.topReason,
        score: effective,
        displayMode:
          entry.approvalStatus === "pending" ? "suggested" : "default",
        entryId: entry.id,
      });
    }
  }

  // Sort shared by score descending, take top N
  scoredShared.sort((a, b) => b.score - a.score);
  const selectedShared = scoredShared
    .slice(0, config.maxSharedBullets)
    .map((bullet, index) => ({
      ...bullet,
      handle:
        bullet.displayMode === "suggested"
          ? assignVisibleHandle(index)
          : undefined,
    }));

  // Select hint bullets (risk, next_step, focus only — no recall)
  const selectedHintTexts = new Set(selectedShared.map((b) => b.text));
  const selectedHints: WhisperBullet[] = [];
  const weakPrompt = isWeakPrompt(promptTokens, promptTags);
  const strongSessionContext = hasStrongSessionContext(
    recentFileTags,
    state.recentToolNames,
  );

  for (const bullet of hintBullets) {
    if (selectedHints.length >= config.maxHintBullets) break;
    if (bullet.category === "recall") continue;
    if (bullet.confidence < config.hintConfidenceThreshold) continue;

    // Intra-payload dedup: skip if hint text matches a selected shared entry
    if (selectedHintTexts.has(bullet.text)) continue;

    const noSharedSelected = selectedShared.length === 0;
    const highConfidence = bullet.confidence >= HIGH_CONFIDENCE_HINT_THRESHOLD;
    const allowHint = highConfidence && (
      (noSharedSelected && (strongSessionContext || !weakPrompt)) ||
      (!noSharedSelected && strongSessionContext)
    );
    if (!allowHint) continue;

    selectedHints.push({
      label: bullet.category,
      text: bullet.text,
      contentHash: "",
      kind: "hint",
      source: "hint",
      topReason: "keyword",
      score: bullet.confidence,
    });
  }

  // Combine: shared first, then hints, cap total
  const combined = [...selectedShared, ...selectedHints].slice(
    0,
    config.maxBullets,
  );

  return combined;
};

export const formatWhisper = (bullets: WhisperBullet[]): string => {
  if (bullets.length === 0) return "";

  const standardBullets = bullets.filter(
    (bullet) => bullet.displayMode !== "suggested",
  );
  const suggestedBullets = bullets.filter(
    (bullet) => bullet.displayMode === "suggested",
  );
  const sections: string[] = [];

  if (standardBullets.length > 0) {
    const lines = ["[Lore]"];
    for (const bullet of standardBullets) {
      lines.push(`- **${bullet.label}**: ${bullet.text}`);
    }
    sections.push(lines.join("\n"));
  }

  for (const bullet of suggestedBullets) {
    const handle = bullet.handle ?? assignVisibleHandle(0);
    sections.push(
      `[Lore · suggested ${handle}]\n- **${bullet.label}**: ${bullet.text} (\`lore yes\` to keep, \`lore no\` to dismiss)`,
    );
  }

  return sections.join("\n\n");
};

export const updateWhisperHistory = (
  state: WhisperSessionState,
  bullets: WhisperBullet[],
): WhisperSessionState => {
  const historyMap = new Map<string, WhisperRecord>();
  for (const record of state.whisperHistory) {
    historyMap.set(record.contentHash, record);
  }

  for (const bullet of bullets) {
    if (bullet.source !== "shared" || !bullet.contentHash) continue;

    const existing = historyMap.get(bullet.contentHash);
    if (existing) {
      existing.turnIndex = state.turnIndex;
      existing.whisperCount += 1;
    } else {
      historyMap.set(bullet.contentHash, {
        contentHash: bullet.contentHash,
        kind: bullet.kind,
        source: bullet.source,
        topReason: bullet.topReason,
        turnIndex: state.turnIndex,
        whisperCount: 1,
      });
    }
  }

  return {
    ...state,
    whisperHistory: Array.from(historyMap.values()),
  };
};

const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    const reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => { data += line; });
    reader.on("close", () => { resolve(data); });
    setTimeout(() => { reader.close(); }, 100);
  });

export const runPrePromptWhisper = async (
  stdinData?: string,
): Promise<void> => {
  const startedAt = Date.now();
  const runId = debugLoggingEnabled ? createRunId() : undefined;
  const config = resolveConfig();
  const log = (
    level: DebugLogLevel,
    event: string,
    data?: Record<string, unknown>,
    extras?: {
      ok?: boolean;
      summary?: string;
      durationMs?: number;
      sessionId?: string;
      sessionKey?: string;
      projectId?: string;
    },
  ): void => {
    if (!runId) {
      return;
    }

    dlog({
      level,
      component: "pre-prompt-whisper",
      event,
      hook: "UserPromptSubmit",
      runId,
      sessionId: extras?.sessionId,
      sessionKey: extras?.sessionKey,
      projectId: extras?.projectId,
      ok: extras?.ok,
      summary: extras?.summary,
      durationMs: extras?.durationMs,
      data,
    });
  };
  const input = stdinData ?? (await readStdin());
  log("debug", "whisper.invoked", {
    hasStdinData: stdinData !== undefined,
    inputLength: input.length,
  });

  let parsed: Record<string, unknown> = {};
  try {
    if (input.trim().length > 0) {
      parsed = JSON.parse(input) as Record<string, unknown>;
    }
  } catch {
    log("warn", "whisper.suppressed", {
      reason: "unparseable_input",
      inputLength: input.length,
    }, {
      ok: false,
      durationMs: Date.now() - startedAt,
      summary: "Whisper input was malformed and was ignored.",
    });
    return; // unparseable → silent exit
  }

  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : process.cwd();
  const promptText = typeof parsed.prompt === "string" ? parsed.prompt : "";
  const projectId = cwd.split("/").filter(Boolean).pop() ?? "unknown";
  log("debug", "whisper.input_parsed", {
    cwd,
    promptLength: promptText.length,
    hasSessionId: sessionId !== undefined,
  }, {
    ok: true,
    sessionId,
    projectId,
  });

  if (!sessionId) {
    log("debug", "whisper.suppressed", {
      reason: "no_session_id",
    }, {
      ok: true,
      durationMs: Date.now() - startedAt,
      summary: "Whisper skipped because session_id was missing.",
      projectId,
    });
    return; // whispers disabled
  }

  const sessionKey = deriveSessionKey(sessionId, cwd);
  const state = await readWhisperState(sessionKey, config.whisperStateDir);
  log("trace", "whisper.state_loaded", {
    turnIndex: state.turnIndex,
    recentFileCount: state.recentFiles.length,
    recentToolCount: state.recentToolNames.length,
    whisperHistoryCount: state.whisperHistory.length,
    injectedContentHashCount: state.injectedContentHashes.length,
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
  });

  const sharedStore = new FileSharedStore({
    storagePath: config.sharedStoragePath,
  });
  const sharedEntries = await sharedStore.list({ approvalStatus: "approved" });
  log("debug", "whisper.shared_loaded", {
    sharedEntryCount: sharedEntries.length,
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
  });

  // Build hint bullets from project memories
  let hintBullets: HintBullet[] = [];
  try {
    const projectStore = new FileMemoryStore({
      storageDir: config.projectMemoryDir,
    });
    const projectId = cwd.split("/").filter(Boolean).pop() ?? "unknown";
    const memories = await projectStore.listByProject(projectId);
    const hint = buildPreTurnHint({
      projectId,
      recentEvents: [],
      memories,
    });
    if (hint) {
      hintBullets = hint.bullets;
    }
  } catch {
    // No project memories available
  }
  log("trace", "whisper.hint_candidates_built", {
    hintCount: hintBullets.length,
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
  });

  const bullets = selectWhisperBullets(
    { promptText, sessionKey, cwd },
    state,
    sharedEntries,
    hintBullets,
    config.whisper,
  );
  log("debug", "whisper.scored", {
    promptLength: promptText.length,
    selectedCount: bullets.length,
    sharedEntryCount: sharedEntries.length,
    hintCount: hintBullets.length,
    topScores: bullets.slice(0, 3).map((bullet) => ({
      contentHash: bullet.contentHash,
      kind: bullet.kind,
      score: bullet.score,
      source: bullet.source,
      topReason: bullet.topReason,
    })),
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
  });

  const output = formatWhisper(bullets);
  if (output) {
    process.stdout.write(output + "\n");
    log("info", "whisper.output_written", {
      bulletCount: bullets.length,
      outputLength: output.length,
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
    });
    log("debug", "whisper.selected", {
      bullets: bullets.map((bullet) => ({
        contentHash: bullet.contentHash,
        kind: bullet.kind,
        score: bullet.score,
        source: bullet.source,
        topReason: bullet.topReason,
      })),
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
    });
  } else {
    log("debug", "whisper.suppressed", {
      reason: summarizeSuppressionReason(
        promptText,
        state,
        sharedEntries,
        hintBullets,
        config.whisper,
      ),
      sharedEntryCount: sharedEntries.length,
      hintCount: hintBullets.length,
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
      durationMs: Date.now() - startedAt,
      summary: "No whisper output was emitted for this prompt.",
    });
  }

  // Record whisper decisions
  if (bullets.length > 0) {
    const updatedState = updateWhisperHistory(state, bullets);
    await writeWhisperState(updatedState, config.whisperStateDir, config.whisper);
    log("trace", "whisper.state_updated", {
      whisperHistoryCount: updatedState.whisperHistory.length,
    }, {
      ok: true,
      sessionId,
      sessionKey,
      projectId,
    });
  }

  log("info", "whisper.completed", {
    bulletCount: bullets.length,
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
    durationMs: Date.now() - startedAt,
    summary: "Whisper hook completed.",
  });
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runPrePromptWhisper();
}
