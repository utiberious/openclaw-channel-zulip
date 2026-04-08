// JSON-RPC 2.0

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// MCP Initialize

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: Record<string, never>;
    experimental: {
      "claude/channel": Record<string, never>;
      "claude/channel/permission": Record<string, never>;
    };
  };
  serverInfo: {
    name: string;
    version: string;
  };
  instructions: string;
}

// MCP Tools

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface McpToolsCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolsCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// MCP Channel Notification

export interface McpChannelNotification {
  source: "zulip";
  chat_id: string;
  message_id: string;
  user: string;
  user_id: string;
  ts: string;
  content: string;
  attachment_count?: number;
  attachments?: string;
}
