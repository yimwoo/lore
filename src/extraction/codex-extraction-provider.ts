import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  DraftCandidate,
  ExtractionProvider,
  TurnArtifact,
} from "./extraction-provider";
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "../shared/debug-log";
import { classifySignal, adjustConfidence } from "./signal-classifier";

type CodexProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type AuthWarningState = {
  lastAuthWarningAt?: string;
};

type CodexExtractionProviderDependencies = {
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: string) => Promise<string>;
  writeFile?: (path: string, content: string, encoding: string) => Promise<void>;
  mkdir?: (path: string, options: { recursive: true }) => Promise<string | undefined>;
  now?: () => string;
  warn?: (message: string) => void;
};

const AUTH_WARNING_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const getAuthPath = (): string => join(homedir(), ".codex", "auth.json");
const getConfigPath = (): string => join(homedir(), ".codex", "config.toml");
const getAuthWarningStatePath = (): string => join(homedir(), ".lore", "auth-warning-state.json");

const defaultReadFile = (path: string, encoding: string): Promise<string> =>
  readFile(path, encoding as BufferEncoding);

const defaultWriteFile = (
  path: string,
  content: string,
  encoding: string,
): Promise<void> => writeFile(path, content, encoding as BufferEncoding);

const defaultMkdir = (
  path: string,
  options: { recursive: true },
): Promise<string | undefined> => mkdir(path, options);

const readCodexProviderConfig = async (
  readTextFile: (path: string, encoding: string) => Promise<string>,
): Promise<CodexProviderConfig> => {
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;

  try {
    const authContent = await readTextFile(getAuthPath(), "utf8");
    const parsed = JSON.parse(authContent) as Record<string, unknown>;
    if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0) {
      apiKey = parsed.OPENAI_API_KEY;
    }
  } catch {
    // Missing auth is a valid degraded state.
  }

  try {
    const configContent = await readTextFile(getConfigPath(), "utf8");
    const baseUrlMatch = configContent.match(/base_url\s*=\s*"([^"]+)"/);
    const modelMatch = configContent.match(/^model\s*=\s*"([^"]+)"/m);
    baseUrl = baseUrlMatch?.[1];
    model = modelMatch?.[1];
  } catch {
    // Missing config is also a valid degraded state.
  }

  return {
    apiKey,
    baseUrl,
    model: model ?? "gpt-5.4",
  };
};

const buildExtractionPrompt = (turn: TurnArtifact): string => JSON.stringify({
  instruction:
    "Extract explicit, candidate shared knowledge from this coding turn. Return a JSON array. Draft only domain_rule, glossary_term, architecture_fact, or explicit user_preference. Never draft decision_record. If nothing is explicit enough, return [].",
  turn,
});

const parseDraftCandidates = (
  text: string,
  turn: TurnArtifact,
): { candidates: DraftCandidate[]; parseFailed: boolean } => {
  try {
    const parsed = JSON.parse(text) as Array<Partial<DraftCandidate>>;
    if (!Array.isArray(parsed)) {
      return {
        candidates: [],
        parseFailed: true,
      };
    }

    return {
      candidates: parsed.flatMap((candidate, index) => {
      if (
        typeof candidate.kind !== "string" ||
        typeof candidate.title !== "string" ||
        typeof candidate.content !== "string" ||
        typeof candidate.confidence !== "number"
      ) {
        return [];
      }

      return [{
        id: candidate.id ?? `draft-${turn.sessionId}-${turn.turnIndex}-${index}`,
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        confidence: candidate.confidence,
        evidenceNote:
          typeof candidate.evidenceNote === "string"
            ? candidate.evidenceNote
            : "Observed from a coding turn.",
        sessionId: turn.sessionId,
        projectId: turn.projectId,
        turnIndex: turn.turnIndex,
        timestamp: turn.turnTimestamp,
        tags: Array.isArray(candidate.tags)
          ? candidate.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      }];
      }),
      parseFailed: false,
    };
  } catch {
    return {
      candidates: [],
      parseFailed: true,
    };
  }
};

const writeWarning = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const shouldWarnForStatus = (status: number): boolean => status === 401 || status === 403;

const warnOnAuthFailure = async (
  status: number,
  dependencies: Required<Pick<
    CodexExtractionProviderDependencies,
    "readFile" | "writeFile" | "mkdir" | "now" | "warn"
  >>,
): Promise<void> => {
  if (!shouldWarnForStatus(status)) {
    return;
  }

  const statePath = getAuthWarningStatePath();
  let state: AuthWarningState = {};

  try {
    const raw = await dependencies.readFile(statePath, "utf8");
    state = JSON.parse(raw) as AuthWarningState;
  } catch {
    // Missing state is expected on first warning.
  }

  const nowIso = dependencies.now();
  const nowMs = Date.parse(nowIso);
  const lastWarnMs = state.lastAuthWarningAt ? Date.parse(state.lastAuthWarningAt) : Number.NaN;

  if (Number.isFinite(lastWarnMs) && Number.isFinite(nowMs)) {
    if (nowMs - lastWarnMs < AUTH_WARNING_COOLDOWN_MS) {
      return;
    }
  }

  dependencies.warn(
    `Lore reminder: LLM ingestion received ${status} from the configured Responses API. Check your Codex API key and endpoint settings if automatic extraction has stopped working.`,
  );

  try {
    await dependencies.mkdir(join(homedir(), ".lore"), { recursive: true });
    await dependencies.writeFile(
      statePath,
      `${JSON.stringify({ lastAuthWarningAt: nowIso }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Warning state persistence is best-effort only.
  }
};

export class CodexExtractionProvider implements ExtractionProvider {
  private readonly fetchImpl: typeof fetch;

  private readonly readFileImpl: (path: string, encoding: string) => Promise<string>;

  private readonly writeFileImpl: (
    path: string,
    content: string,
    encoding: string,
  ) => Promise<void>;

  private readonly mkdirImpl: (
    path: string,
    options: { recursive: true },
  ) => Promise<string | undefined>;

  private readonly now: () => string;

  private readonly warn: (message: string) => void;

  constructor(dependencies?: CodexExtractionProviderDependencies) {
    this.fetchImpl = dependencies?.fetch ?? fetch;
    this.readFileImpl = dependencies?.readFile ?? defaultReadFile;
    this.writeFileImpl = dependencies?.writeFile ?? defaultWriteFile;
    this.mkdirImpl = dependencies?.mkdir ?? defaultMkdir;
    this.now = dependencies?.now ?? (() => new Date().toISOString());
    this.warn = dependencies?.warn ?? writeWarning;
  }

  async extractCandidates(turn: TurnArtifact): Promise<DraftCandidate[]> {
    const runId = debugLoggingEnabled ? createRunId() : undefined;
    const log = (
      level: DebugLogLevel,
      event: string,
      data?: Record<string, unknown>,
      extras?: {
        ok?: boolean;
        summary?: string;
      },
    ): void => {
      if (!runId) {
        return;
      }

      dlog({
        level,
        component: "codex-extraction-provider",
        event,
        hook: "Core",
        runId,
        sessionId: turn.sessionId,
        projectId: turn.projectId,
        ok: extras?.ok,
        summary: extras?.summary,
        data,
      });
    };
    const config = await readCodexProviderConfig(this.readFileImpl);
    log("trace", "extraction.config_loaded", {
      hasApiKey: config.apiKey !== undefined,
      hasBaseUrl: config.baseUrl !== undefined,
      model: config.model,
      turnIndex: turn.turnIndex,
    }, {
      ok: true,
    });
    if (!config.apiKey || !config.baseUrl) {
      log("debug", "extraction.llm_skipped", {
        reason: !config.apiKey ? "missing_api_key" : "missing_base_url",
        turnIndex: turn.turnIndex,
      }, {
        ok: true,
        summary: "Extraction skipped because Codex LLM config is incomplete.",
      });
      return [];
    }

    try {
      log("debug", "extraction.llm_request_started", {
        model: config.model,
        turnIndex: turn.turnIndex,
      }, {
        ok: true,
      });
      const response = await this.fetchImpl(`${config.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          input: buildExtractionPrompt(turn),
        }),
      });
      if (!response.ok) {
        log("warn", "extraction.llm_response_received", {
          responseStatus: response.status,
          turnIndex: turn.turnIndex,
        }, {
          ok: false,
          summary: "Extraction request returned a non-success HTTP status.",
        });
        await warnOnAuthFailure(response.status, {
          readFile: this.readFileImpl,
          writeFile: this.writeFileImpl,
          mkdir: this.mkdirImpl,
          now: this.now,
          warn: this.warn,
        });
        if (shouldWarnForStatus(response.status)) {
          log("warn", "extraction.llm_auth_warning", {
            responseStatus: response.status,
          }, {
            ok: false,
            summary: "Extraction hit an auth-related Responses API status.",
          });
        }
        return [];
      }

      const payload = await response.json() as { output_text?: string };
      const parsed = parseDraftCandidates(payload.output_text ?? "[]", turn);
      log("debug", "extraction.llm_response_received", {
        responseStatus: response.status,
        outputTextLength: (payload.output_text ?? "").length,
      }, {
        ok: true,
      });
      if (parsed.parseFailed) {
        log("warn", "extraction.llm_parse_failed", {
          turnIndex: turn.turnIndex,
        }, {
          ok: false,
          summary: "Extraction response could not be parsed into draft candidates.",
        });
      }
      log("debug", "extraction.candidates_parsed", {
        candidateCount: parsed.candidates.length,
        candidateKinds: parsed.candidates.map((candidate) => candidate.kind),
      }, {
        ok: true,
      });
      const classification = turn.userPrompt
        ? classifySignal(turn.userPrompt)
        : { signalStrength: "weak" as const, strongMatchCount: 0, mediumMatchCount: 0, weakDampenerCount: 0 };
      const classifiedCandidates = parsed.candidates.map((candidate) => ({
        ...candidate,
        signalStrength: classification.signalStrength,
        confidence: adjustConfidence(candidate.confidence, classification.signalStrength),
      }));
      log("debug", "extraction.signal_classified", {
        signalStrength: classification.signalStrength,
        strongMatchCount: classification.strongMatchCount,
        mediumMatchCount: classification.mediumMatchCount,
        weakDampenerCount: classification.weakDampenerCount,
        candidateCount: classifiedCandidates.length,
      }, {
        ok: true,
      });
      return classifiedCandidates;
    } catch (error) {
      log("warn", "extraction.llm_response_received", {
        error: error instanceof Error ? error.message : String(error),
      }, {
        ok: false,
        summary: "Extraction request failed before a usable response was received.",
      });
      return [];
    }
  }
}
