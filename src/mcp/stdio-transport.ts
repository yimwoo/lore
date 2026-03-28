import { createInterface } from "node:readline";

import { FileSharedStore } from "../core/file-shared-store";
import { resolveConfig } from "../config";
import { handleToolCall, toolDefinitions } from "./server";

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
): Promise<JsonRpcResponse> => {
  try {
    if (request.method === "tools/list") {
      return makeResponse(request.id, {
        tools: toolDefinitions,
      });
    }

    if (request.method === "tools/call") {
      const toolName = request.params?.name as string | undefined;
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

      if (!toolName) {
        return makeError(request.id, -32602, "Missing tool name");
      }

      const result = await handleToolCall(toolName, args, store);
      return makeResponse(request.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    }

    return makeError(request.id, -32601, `Unknown method: ${request.method}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeError(request.id, -32603, message);
  }
};

export const runStdioTransport = async (
  configOverrides?: { sharedStoragePath?: string },
): Promise<void> => {
  const config = resolveConfig(configOverrides);
  const store = new FileSharedStore({
    storagePath: config.sharedStoragePath,
  });

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
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
      continue;
    }

    const response = await handleRequest(request, store);
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
