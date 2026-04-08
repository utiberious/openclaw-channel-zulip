import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpInitializeResult,
  McpToolsCallParams,
  McpToolsCallResult,
} from "./types.js";
import { buildInstructions } from "../instructions.js";
import { getToolsList } from "../tools/registry.js";
import { log } from "../log.js";

export type ToolCallHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpToolsCallResult>;

export type NotificationHandler = (params: unknown) => Promise<void>;

export interface McpServer {
  handleRequest(req: JsonRpcRequest): JsonRpcResponse | Promise<JsonRpcResponse> | null;
  setToolCallHandler(handler: ToolCallHandler): void;
  setNotificationHandler(method: string, handler: NotificationHandler): void;
}

export function createServer(): McpServer {
  let initialized = false;
  let toolHandler: ToolCallHandler | null = null;
  const notifHandlers = new Map<string, NotificationHandler>();

  function handleInitialize(id: string | number): JsonRpcResponse {
    const result: McpInitializeResult = {
      protocolVersion: "2025-03-26",
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
      serverInfo: {
        name: "zulip",
        version: "1.0.0",
      },
      instructions: buildInstructions(),
    };

    return { jsonrpc: "2.0", id, result };
  }

  function handleToolsList(id: string | number): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result: getToolsList() };
  }

  async function handleToolsCall(
    id: string | number,
    params: McpToolsCallParams,
  ): Promise<JsonRpcResponse> {
    if (toolHandler) {
      const result = await toolHandler(params.name, params.arguments ?? {});
      return { jsonrpc: "2.0", id, result };
    }

    const result: McpToolsCallResult = {
      content: [{ type: "text", text: "zulip client not ready" }],
      isError: true,
    };
    return { jsonrpc: "2.0", id, result };
  }

  function handleRequest(req: JsonRpcRequest): JsonRpcResponse | Promise<JsonRpcResponse> | null {
    switch (req.method) {
      case "initialize":
        return handleInitialize(req.id!);

      case "notifications/initialized":
        initialized = true;
        log("client initialized");
        return null;

      case "tools/list":
        return handleToolsList(req.id!);

      case "tools/call":
        return handleToolsCall(
          req.id!,
          req.params as unknown as McpToolsCallParams,
        );

      default: {
        // Notifications (no id) — check for registered handlers
        if (req.id == null) {
          const handler = notifHandlers.get(req.method);
          if (handler) {
            handler(req.params).catch((e) =>
              log(`notification handler error (${req.method}): ${e}`),
            );
          } else {
            log(`ignoring notification: ${req.method}`);
          }
          return null;
        }

        // Unknown method with id -> JSON-RPC error
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: {
            code: -32601,
            message: `method not found: ${req.method}`,
          },
        };
      }
    }
  }

  function setToolCallHandler(handler: ToolCallHandler): void {
    toolHandler = handler;
  }

  function setNotificationHandler(method: string, handler: NotificationHandler): void {
    notifHandlers.set(method, handler);
  }

  return { handleRequest, setToolCallHandler, setNotificationHandler };
}
