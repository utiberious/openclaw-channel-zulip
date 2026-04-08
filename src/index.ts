/**
 * index.ts — Entry point for the Zulip MCP channel plugin.
 * REQ-LIFE-01..11: MCP stdio runs immediately; Zulip connects concurrently.
 */
import { createStdioTransport } from "./mcp/stdio.js";
import { createServer } from "./mcp/server.js";
import { loadConfig } from "./config.js";
import { createAccessManager } from "./access.js";
import { createZulipClient } from "./zulip/client.js";
import { handleToolCall } from "./tools/handlers.js";
import { startMonitor } from "./monitor.js";
import { createPermissionManager, type PermissionManager } from "./permissions.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  log("zulip channel: starting");

  const abortController = new AbortController();

  // REQ-LIFE-01 — MCP stdio starts immediately
  const transport = createStdioTransport();
  const server = createServer();

  transport.onMessage(async (req) => {
    const response = server.handleRequest(req);
    const resolved = response instanceof Promise ? await response : response;
    if (resolved) {
      transport.send(resolved);
    }
  });

  // REQ-LIFE-09 — Zulip setup runs concurrently with MCP
  connectZulip(server, transport, abortController).catch((e) => {
    log(`zulip channel: fatal startup error: ${e}`);
    process.exit(1);
  });

  // REQ-LIFE-10, REQ-LIFE-11 — shutdown
  const shutdown = () => {
    log("zulip channel: shutting down");
    abortController.abort();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function connectZulip(
  server: ReturnType<typeof createServer>,
  transport: ReturnType<typeof createStdioTransport>,
  abortController: AbortController,
): Promise<void> {
  // REQ-LIFE-03 — load credentials
  const config = loadConfig();

  // REQ-CFG-04 — static mode
  const staticMode = process.env.ZULIP_ACCESS_MODE === "static";

  // REQ-LIFE-06 — load access.json
  const access = createAccessManager(staticMode);

  // Create Zulip client
  const client = createZulipClient({
    baseUrl: config.baseUrl,
    email: config.email,
    apiKey: config.apiKey,
  });

  const sendToHost = (msg: unknown) => transport.send(msg);

  // Permission relay (REQ-PERM-01..11)
  const permissions = createPermissionManager({
    client,
    send: sendToHost,
    getAllowFrom: () => access.config().allowFrom,
    isAllowedResponder: (email) => access.isAllowedPermissionResponder(email),
  });

  // Handle permission request notifications from host
  server.setNotificationHandler(
    "notifications/claude/channel/permission_request",
    async (params) => {
      await permissions.handleRequest(params as {
        id: string;
        tool_name: string;
        description: string;
      });
    },
  );

  // Wire tool handler (REQ-TOOL-*)
  server.setToolCallHandler(async (name, args) => {
    return handleToolCall(name, args, client, access.config());
  });

  // REQ-LIFE-04..08 — connect, verify identity, start polling
  await startMonitor({
    client,
    access,
    permissions,
    send: sendToHost,
    signal: abortController.signal,
  });
}

main();
