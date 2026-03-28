import { createInterface } from "node:readline";

import { FileSharedStore } from "../core/file-shared-store";
import { resolveConfig } from "../config";
import { handleToolCall, toolDefinitions } from "./server";
import {
  createRunId,
  debugLoggingEnabled,
  dlog,
  type DebugLogLevel,
} from "../shared/debug-log";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
};

const makeResponse = (
  id: string | number,
  result: unknown,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

const makeError = (
  id: string | number,
  code: number,
  message: string,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const handleRequest = async (
  request: JsonRpcRequest,
  store: FileSharedStore,
  runId?: string,
): Promise<JsonRpcResponse> => {
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
      component: "mcp-stdio-transport",
      event,
      hook: "MCP",
      runId,
      ok: extras?.ok,
      summary: extras?.summary,
      data,
    });
  };

  try {
    log("debug", "mcp.request_received", {
      id: request.id,
      method: request.method,
    }, {
      ok: true,
    });
    if (request.method === "tools/list") {
      const response = makeResponse(request.id, {
        tools: toolDefinitions,
      });
      log("debug", "mcp.response_sent", {
        method: request.method,
        hasError: false,
      }, {
        ok: true,
      });
      return response;
    }

    if (request.method === "tools/call") {
      const toolName = request.params?.name as string | undefined;
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

      if (!toolName) {
        const response = makeError(request.id, -32602, "Missing tool name");
        log("warn", "mcp.tool_failed", {
          method: request.method,
          reason: "missing_tool_name",
        }, {
          ok: false,
          summary: "MCP tools/call request was missing a tool name.",
        });
        log("debug", "mcp.response_sent", {
          method: request.method,
          hasError: true,
        }, {
          ok: false,
        });
        return response;
      }

      log("debug", "mcp.tool_called", {
        toolName,
        argKeys: Object.keys(args),
      }, {
        ok: true,
      });
      const result = await handleToolCall(toolName, args, store);
      const response = makeResponse(request.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
      log("debug", "mcp.tool_succeeded", {
        toolName,
      }, {
        ok: true,
      });
      log("debug", "mcp.response_sent", {
        method: request.method,
        hasError: false,
      }, {
        ok: true,
      });
      return response;
    }

    const response = makeError(request.id, -32601, `Unknown method: ${request.method}`);
    log("warn", "mcp.tool_failed", {
      method: request.method,
      reason: "unknown_method",
    }, {
      ok: false,
      summary: "MCP request used an unknown method.",
    });
    log("debug", "mcp.response_sent", {
      method: request.method,
      hasError: true,
    }, {
      ok: false,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response = makeError(request.id, -32603, message);
    log("warn", "mcp.tool_failed", {
      method: request.method,
      error: message,
    }, {
      ok: false,
      summary: "MCP request failed while handling the tool call.",
    });
    log("debug", "mcp.response_sent", {
      method: request.method,
      hasError: true,
    }, {
      ok: false,
    });
    return response;
  }
};

export const runStdioTransport = async (
  configOverrides?: { sharedStoragePath?: string },
): Promise<void> => {
  const config = resolveConfig(configOverrides);
  const store = new FileSharedStore({
    storagePath: config.sharedStoragePath,
  });
  const runId = debugLoggingEnabled ? createRunId() : undefined;

  const reader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errorResponse = makeError(0, -32700, "Parse error");
      if (runId) {
        dlog({
          level: "warn",
          component: "mcp-stdio-transport",
          event: "mcp.parse_error",
          hook: "MCP",
          runId,
          ok: false,
          summary: "MCP transport received malformed JSON.",
        });
      }
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
      continue;
    }

    const response = await handleRequest(request, store, runId);
    process.stdout.write(JSON.stringify(response) + "\n");
  }
};

// Entry point when run directly
const isDirectRun =
  process.argv[1] && import.meta.url.endsWith(process.argv[1]);

if (isDirectRun) {
  const sharedStoragePath = process.env.LORE_SHARED_STORE_PATH;
  runStdioTransport(
    sharedStoragePath ? { sharedStoragePath } : undefined,
  );
}
