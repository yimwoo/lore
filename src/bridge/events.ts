import type { SessionEvent, SessionEventKind } from "../shared/types";

export type RawSessionEvent =
  | {
      kind: "user_prompt_submitted";
      prompt: string;
      files?: string[];
    }
  | {
      kind: "assistant_response_completed";
      response: string;
      files?: string[];
    }
  | {
      kind: "tool_run_completed";
      toolName: string;
      summary: string;
      files?: string[];
    }
  | {
      kind: "tool_run_failed";
      toolName: string;
      summary: string;
      files?: string[];
    };

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const withOptionalFiles = <T extends RawSessionEvent>(
  value: T,
  files: unknown,
): T => {
  if (files === undefined) {
    return value;
  }

  if (!isStringArray(files)) {
    throw new Error("Expected `files` to be an array of strings.");
  }

  return { ...value, files };
};

export const parseRawSessionEvent = (value: unknown): RawSessionEvent => {
  if (!value || typeof value !== "object") {
    throw new Error("Expected a JSON object.");
  }

  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;

  if (kind === "user_prompt_submitted") {
    if (typeof candidate.prompt !== "string" || candidate.prompt.trim().length === 0) {
      throw new Error("`user_prompt_submitted` events require a non-empty `prompt`.");
    }

    return withOptionalFiles(
      {
        kind,
        prompt: candidate.prompt,
      },
      candidate.files,
    );
  }

  if (kind === "assistant_response_completed") {
    if (
      typeof candidate.response !== "string" ||
      candidate.response.trim().length === 0
    ) {
      throw new Error(
        "`assistant_response_completed` events require a non-empty `response`.",
      );
    }

    return withOptionalFiles(
      {
        kind,
        response: candidate.response,
      },
      candidate.files,
    );
  }

  if (kind === "tool_run_completed" || kind === "tool_run_failed") {
    if (
      typeof candidate.toolName !== "string" ||
      candidate.toolName.trim().length === 0
    ) {
      throw new Error(`\`${kind}\` events require a non-empty \`toolName\`.`);
    }

    if (
      typeof candidate.summary !== "string" ||
      candidate.summary.trim().length === 0
    ) {
      throw new Error(`\`${kind}\` events require a non-empty \`summary\`.`);
    }

    return withOptionalFiles(
      {
        kind,
        toolName: candidate.toolName,
        summary: candidate.summary,
      },
      candidate.files,
    );
  }

  throw new Error("Unknown event kind.");
};

type NormalizeOptions = {
  projectId: string;
  now?: () => string;
  createId?: () => string;
};

const eventSummaryByKind: Record<SessionEventKind, string> = {
  user_prompt_submitted: "User prompt submitted",
  assistant_response_completed: "Assistant response completed",
  tool_run_completed: "Tool run completed",
  tool_run_failed: "Tool run failed",
};

export const normalizeSessionEvent = (
  rawEvent: RawSessionEvent,
  options: NormalizeOptions,
): SessionEvent => {
  const timestamp = options.now?.() ?? new Date().toISOString();
  const id =
    options.createId?.() ?? `event-${Math.random().toString(36).slice(2, 10)}`;

  if (rawEvent.kind === "user_prompt_submitted") {
    return {
      id,
      projectId: options.projectId,
      timestamp,
      kind: rawEvent.kind,
      summary: eventSummaryByKind[rawEvent.kind],
      details: rawEvent.prompt,
      files: rawEvent.files,
    };
  }

  if (rawEvent.kind === "assistant_response_completed") {
    return {
      id,
      projectId: options.projectId,
      timestamp,
      kind: rawEvent.kind,
      summary: eventSummaryByKind[rawEvent.kind],
      details: rawEvent.response,
      files: rawEvent.files,
    };
  }

  return {
    id,
    projectId: options.projectId,
    timestamp,
    kind: rawEvent.kind,
    summary: eventSummaryByKind[rawEvent.kind],
    details: rawEvent.summary,
    files: rawEvent.files,
    metadata: {
      toolName: rawEvent.toolName,
      outcome: rawEvent.kind === "tool_run_failed" ? "failed" : "completed",
    },
  };
};
