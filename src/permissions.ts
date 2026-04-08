/**
 * permissions.ts — Permission relay subsystem.
 * Forwards host permission requests to allowlisted DM users,
 * collects yes/no replies, sends resolution back to host.
 * REQ-PERM-01..11
 */
import { log } from "./log.js";
import type { ZulipClient } from "./zulip/client.js";
import { sendPrivateMessage, addReaction } from "./zulip/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

type PendingPermission = {
  id: string;           // 5-char code from host
  toolName: string;
  description: string;
  timer: ReturnType<typeof setTimeout>;
};

type SendFn = (msg: unknown) => void;

// REQ-PERM-04 — accepted reply forms
const REPLY_PATTERN = /^(yes|y|no|n)\s+([a-zA-Z0-9]{5})\s*$/i;

const TIMEOUT_MS = 5 * 60 * 1000; // REQ-PERM-09

// ── Permission Manager ──────────────────────────────────────────────────────

export type PermissionManager = {
  handleRequest(params: {
    id: string;
    tool_name: string;
    description: string;
  }): Promise<void>;

  /** Returns true if message was a permission reply (should not be forwarded). */
  tryHandleReply(
    senderEmail: string,
    messageId: string,
    content: string,
  ): Promise<boolean>;

  shutdown(): void;
};

export function createPermissionManager(opts: {
  client: ZulipClient;
  send: SendFn;
  getAllowFrom: () => string[];
  isAllowedResponder: (email: string) => boolean;
}): PermissionManager {
  const { client, send, getAllowFrom, isAllowedResponder } = opts;
  const pending = new Map<string, PendingPermission>();

  async function handleRequest(params: {
    id: string;
    tool_name: string;
    description: string;
  }): Promise<void> {
    const { id, tool_name, description } = params;

    // REQ-PERM-09 — auto-deny after 5 minutes
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        log(`permissions: request ${id} timed out, denying`);
        resolve(id, false);
      }
    }, TIMEOUT_MS);

    pending.set(id, {
      id,
      toolName: tool_name,
      description,
      timer,
    });

    // REQ-PERM-02, REQ-PERM-10 — DM every allowFrom user
    const message =
      `Permission request: **${tool_name}** -- ${description} -- ` +
      `Reply: yes ${id} or no ${id}`;

    const allowFrom = getAllowFrom();
    for (const email of allowFrom) {
      if (email === "*") continue; // can't DM wildcard
      try {
        await sendPrivateMessage(client, { to: email, content: message });
      } catch (e) {
        log(`permissions: failed to DM ${email}: ${e}`);
      }
    }
  }

  async function tryHandleReply(
    senderEmail: string,
    messageId: string,
    content: string,
  ): Promise<boolean> {
    const match = content.trim().match(REPLY_PATTERN);
    if (!match) return false;

    const answer = match[1].toLowerCase();
    const code = match[2];

    // Check if this code corresponds to a pending request
    if (!pending.has(code)) return false;

    // REQ-PERM-05 — only allowlisted senders
    if (!isAllowedResponder(senderEmail)) return false;

    // REQ-PERM-07 — this is a permission reply, don't forward as channel notification
    const granted = answer === "yes" || answer === "y";
    const entry = pending.get(code)!;
    clearTimeout(entry.timer);
    pending.delete(code);

    // REQ-PERM-06 — ack reaction
    try {
      await addReaction(client, { messageId, emojiName: "check" });
    } catch (e) {
      log(`permissions: ack reaction failed: ${e}`);
    }

    // REQ-PERM-08 — send resolution to host
    resolve(code, granted);

    log(`permissions: ${code} resolved as ${granted ? "granted" : "denied"} by ${senderEmail}`);
    return true;
  }

  function resolve(id: string, granted: boolean): void {
    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission",
      params: { id, granted },
    });
  }

  function shutdown(): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      resolve(id, false);
    }
    pending.clear();
  }

  return { handleRequest, tryHandleReply, shutdown };
}
