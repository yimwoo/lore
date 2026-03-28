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

type WhisperInput = {
  promptText: string;
  sessionKey: string;
  cwd: string;
};

type WhisperBullet = {
  label: string;
  text: string;
  contentHash: string;
  kind: string;
  source: "shared" | "hint";
  topReason: WhisperRecord["topReason"];
  score: number;
};

export const selectWhisperBullets = (
  input: WhisperInput,
  state: WhisperSessionState,
  sharedEntries: SharedKnowledgeEntry[],
  hintBullets: HintBullet[],
  config: WhisperConfig,
): WhisperBullet[] => {
  const promptTokens = tokenize(input.promptText, config.keywordMinTokenLength);
  const promptTags = inferPromptTags(input.promptText, state.recentFiles);
  const recentFileTags = inferPromptTags("", state.recentFiles);
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
    if (entry.approvalStatus !== "approved") continue;

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
      });
    }
  }

  // Sort shared by score descending, take top N
  scoredShared.sort((a, b) => b.score - a.score);
  const selectedShared = scoredShared.slice(0, config.maxSharedBullets);

  // Select hint bullets (risk, next_step, focus only — no recall)
  const selectedHintTexts = new Set(selectedShared.map((b) => b.text));
  const selectedHints: WhisperBullet[] = [];

  for (const bullet of hintBullets) {
    if (selectedHints.length >= config.maxHintBullets) break;
    if (bullet.category === "recall") continue;
    if (bullet.confidence < config.hintConfidenceThreshold) continue;

    // Intra-payload dedup: skip if hint text matches a selected shared entry
    if (selectedHintTexts.has(bullet.text)) continue;

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

  const lines = ["[Lore]"];
  for (const bullet of bullets) {
    lines.push(`- **${bullet.label}**: ${bullet.text}`);
  }

  return lines.join("\n");
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
  const config = resolveConfig();
  const input = stdinData ?? (await readStdin());

  let parsed: Record<string, unknown> = {};
  try {
    if (input.trim().length > 0) {
      parsed = JSON.parse(input) as Record<string, unknown>;
    }
  } catch {
    return; // unparseable → silent exit
  }

  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : process.cwd();
  const promptText = typeof parsed.prompt === "string" ? parsed.prompt : "";

  if (!sessionId) return; // whispers disabled

  const sessionKey = deriveSessionKey(sessionId, cwd);
  const state = await readWhisperState(sessionKey, config.whisperStateDir);

  const sharedStore = new FileSharedStore({
    storagePath: config.sharedStoragePath,
  });
  const sharedEntries = await sharedStore.list({ approvalStatus: "approved" });

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

  const bullets = selectWhisperBullets(
    { promptText, sessionKey, cwd },
    state,
    sharedEntries,
    hintBullets,
    config.whisper,
  );

  const output = formatWhisper(bullets);
  if (output) {
    process.stdout.write(output + "\n");
  }

  // Record whisper decisions
  if (bullets.length > 0) {
    const updatedState = updateWhisperHistory(state, bullets);
    await writeWhisperState(updatedState, config.whisperStateDir, config.whisper);
  }
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runPrePromptWhisper();
}
