import { createInterface } from "node:readline";

import { FileSharedStore } from "../core/file-shared-store";
import { FileMemoryStore } from "../core/memory-store";
import { buildPreTurnHint } from "../core/hint-engine";
import { resolveConfig } from "../config";
import type { WhisperConfig } from "../config";
import { FileApprovalStore } from "../promotion/approval-store";
import { Promoter } from "../promotion/promoter";
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
  LoreVisibleItem,
  SharedKnowledgeEntry,
  WhisperRecord,
  WhisperSessionState,
} from "../shared/types";
import { isSharedKnowledgeKind, whisperLabelMap } from "../shared/types";
import {
  formatForAgentContext,
  formatForUserDisplay,
} from "./lore-item-renderer";
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

const buildVisibleItems = (
  bullets: WhisperBullet[],
  projectId: string,
  turnIndex: number,
): LoreVisibleItem[] =>
  bullets
    .filter(
      (bullet): bullet is WhisperBullet & { entryId: string } =>
        typeof bullet.entryId === "string" &&
        isSharedKnowledgeKind(bullet.kind) &&
        bullet.displayMode === "suggested",
    )
    .map((bullet) => ({
      handle: bullet.handle ?? "",
      entryId: bullet.entryId,
      kind: "pending_suggestion" as const,
      entryKind: bullet.kind as import("../shared/types").SharedKnowledgeKind,
      content: bullet.text,
      actions: ["approve", "dismiss"] as const,
      projectId,
      turnIndex,
      actionOnDismiss: "reject_pending" as const,
      actionOnApprove: "approve_pending" as const,
    }));

const findMicroCommandTarget = (
  command: LoreMicroCommand,
  state: WhisperSessionState,
): LoreVisibleItem | null => {
  if (command.target) {
    return (
      state.visibleItems?.find((item) => item.handle === command.target) ?? null
    );
  }

  // Bare dismiss: receipt wins over suggestion
  if (command.action === "dismiss") {
    const receipt = state.visibleItems?.find(
      (item) => item.kind === "saved_receipt",
    );
    if (receipt) return receipt;
  }

  // Bare approve or fallback dismiss: first pending suggestion
  return (
    state.visibleItems?.find((item) => item.kind === "pending_suggestion") ?? null
  );
};

const formatSavedReceipt = (
  handle: string,
  entry: SharedKnowledgeEntry,
): string =>
  `[Lore · saved ${handle}]\n- **${whisperLabelMap[entry.kind]}**: ${entry.content} (\`lore no\` to undo)`;

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

  // Receipt expiry check: clear stale receipts before building items
  const activeReceipt =
    state.activeReceipt &&
    state.turnIndex <= state.activeReceipt.expiresAfterTurn
      ? state.activeReceipt
      : undefined;

  const sharedStore = new FileSharedStore({
    storagePath: config.sharedStoragePath,
  });
  const approvalStore = new FileApprovalStore({
    ledgerPath: config.approvalLedgerPath,
    sharedStore,
  });
  const promoter = new Promoter({
    sharedStore,
    approvalStore,
    policy: config.promotionPolicy,
  });
  const [approvedEntries, pendingEntries] = await Promise.all([
    sharedStore.list({ approvalStatus: "approved" }),
    sharedStore.list({ approvalStatus: "pending" }),
  ]);
  const sharedEntries = [...approvedEntries, ...pendingEntries];
  log("debug", "whisper.shared_loaded", {
    sharedEntryCount: sharedEntries.length,
    approvedCount: approvedEntries.length,
    pendingCount: pendingEntries.length,
  }, {
    ok: true,
    sessionId,
    sessionKey,
    projectId,
  });

  const microCommand = parseLoreMicroCommand(promptText);
  if (microCommand) {
    const currentState: WhisperSessionState = {
      ...state,
      activeReceipt,
      visibleItems: (state.visibleItems ?? []).filter((item) =>
        item.kind === "pending_suggestion" ||
        (item.kind === "saved_receipt" && activeReceipt?.entryId === item.entryId),
      ),
    };
    const target = findMicroCommandTarget(microCommand, currentState);
    if (!target) {
      log("debug", "whisper.micro_command_ignored", {
        action: microCommand.action,
        reason: "no_visible_target",
      }, {
        ok: true,
        sessionId,
        sessionKey,
        projectId,
      });
      return;
    }

    if (microCommand.action === "approve" && target.kind === "pending_suggestion") {
      const result = await promoter.approve(target.entryId);
      if (!result.ok) {
        log("warn", "whisper.micro_command_failed", {
          action: microCommand.action,
          entryId: target.entryId,
          reason: result.reason,
        }, {
          ok: false,
          sessionId,
          sessionKey,
          projectId,
          summary: "Lore approval micro-command failed.",
        });
        return;
      }

      const nextState: WhisperSessionState = {
        ...state,
        activeReceipt: {
          sessionKey,
          entryId: result.entry.id,
          kind: "saved",
          createdAt: result.entry.approvedAt ?? new Date().toISOString(),
          expiresAfterTurn: state.turnIndex + 1,
          undoCommand: "lore no",
        },
        visibleItems: [],
      };
      await writeWhisperState(nextState, config.whisperStateDir, config.whisper);
      process.stdout.write(`${formatSavedReceipt(target.handle, result.entry)}\n`);
      log("info", "whisper.micro_command_completed", {
        action: microCommand.action,
        entryId: result.entry.id,
      }, {
        ok: true,
        sessionId,
        sessionKey,
        projectId,
        summary: "Lore approval micro-command completed.",
      });
      return;
    }

    if (microCommand.action === "dismiss" && target.kind === "pending_suggestion") {
      const result = await promoter.reject(
        target.entryId,
        "Dismissed from Lore suggestion.",
      );
      if (!result.ok) {
        log("warn", "whisper.micro_command_failed", {
          action: microCommand.action,
          entryId: target.entryId,
          reason: result.reason,
        }, {
          ok: false,
          sessionId,
          sessionKey,
          projectId,
          summary: "Lore dismiss micro-command failed.",
        });
        return;
      }

      await writeWhisperState({
        ...state,
        visibleItems: [],
      }, config.whisperStateDir, config.whisper);
      log("info", "whisper.micro_command_completed", {
        action: microCommand.action,
        entryId: result.entry.id,
      }, {
        ok: true,
        sessionId,
        sessionKey,
        projectId,
        summary: "Lore dismiss micro-command completed.",
      });
      return;
    }

    if (microCommand.action === "dismiss" && target.kind === "saved_receipt") {
      const result = await promoter.demote(
        target.entryId,
        "User undid a saved Lore entry.",
      );
      if (!result.ok) {
        log("warn", "whisper.micro_command_failed", {
          action: microCommand.action,
          entryId: target.entryId,
          reason: result.reason,
        }, {
          ok: false,
          sessionId,
          sessionKey,
          projectId,
          summary: "Lore undo micro-command failed.",
        });
        return;
      }

      await writeWhisperState({
        ...state,
        activeReceipt: undefined,
        visibleItems: [],
      }, config.whisperStateDir, config.whisper);
      log("info", "whisper.micro_command_completed", {
        action: microCommand.action,
        entryId: result.entry.id,
      }, {
        ok: true,
        sessionId,
        sessionKey,
        projectId,
        summary: "Lore undo micro-command completed.",
      });
      return;
    }
  }

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

  // Build LoreVisibleItem[] from scored bullets
  const loreItems = buildVisibleItems(bullets, projectId, state.turnIndex);

  // Construct receipt LoreVisibleItem and prepend if active
  if (activeReceipt) {
    const receiptEntry = sharedEntries.find(
      (entry) => entry.id === activeReceipt.entryId,
    );
    if (receiptEntry) {
      loreItems.unshift({
        handle: "",
        entryId: receiptEntry.id,
        kind: "saved_receipt",
        entryKind: receiptEntry.kind,
        content: receiptEntry.content,
        actions: ["dismiss"],
        projectId,
        turnIndex: state.turnIndex,
        actionOnDismiss: "demote_undo_captured",
        actionOnApprove: "approve_pending",
      });
    }
  }

  // Assign turn-local handles: receipt first (@l1), then suggestions
  let handleIndex = activeReceipt ? 1 : 0;
  for (const bullet of bullets) {
    if (bullet.displayMode === "suggested") {
      bullet.handle = assignVisibleHandle(handleIndex);
      handleIndex += 1;
    }
  }
  handleIndex = 0;
  for (const item of loreItems) {
    if (item.kind === "pending_suggestion" || item.kind === "saved_receipt") {
      item.handle = assignVisibleHandle(handleIndex);
      handleIndex += 1;
    }
  }

  // Render both outputs
  const standardAgentContext = formatWhisper(
    bullets.filter((bullet) => bullet.displayMode !== "suggested"),
  );
  const actionableAgentContext = formatForAgentContext(loreItems);
  const userDisplay = formatForUserDisplay(loreItems);
  const output = [
    standardAgentContext,
    actionableAgentContext,
    userDisplay,
  ].filter(Boolean).join("\n\n");

  if (output) {
    process.stdout.write(output + "\n");
    log("info", "whisper.output_written", {
      bulletCount: bullets.length,
      loreItemCount: loreItems.length,
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
    await writeWhisperState({
      ...state,
      visibleItems: [],
    }, config.whisperStateDir, config.whisper);
  }

  // Record whisper decisions
  if (bullets.length > 0) {
    const updatedState: WhisperSessionState = {
      ...updateWhisperHistory(state, bullets),
      visibleItems: loreItems,
    };
    await writeWhisperState(updatedState, config.whisperStateDir, config.whisper);
    log("trace", "whisper.state_updated", {
      whisperHistoryCount: updatedState.whisperHistory.length,
      visibleItemCount: updatedState.visibleItems?.length ?? 0,
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
