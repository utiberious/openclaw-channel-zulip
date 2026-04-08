/**
 * monitor.ts — Zulip event queue polling and inbound message processing.
 * REQ-RECV-01..13, REQ-REACT-01..04, REQ-LIFE-04..09
 */
import { log } from "./log.js";
import type { AccessManager } from "./access.js";
import type { PermissionManager } from "./permissions.js";
import type { ZulipClient, ZulipMessage } from "./zulip/client.js";
import {
  fetchMe,
  registerQueue,
  getEvents,
  addReaction,
} from "./zulip/client.js";
import { extractUploadUrls } from "./zulip/uploads.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type BotIdentity = {
  botUserId: string;
  botEmail: string;
  botFullName: string;
};

export type ChannelNotification = {
  jsonrpc: "2.0";
  method: "notifications/claude/channel";
  params: {
    source: "zulip";
    chat_id: string;
    message_id: string;
    user: string;
    user_id: string;
    ts: string;
    content: string;
    attachment_count?: number;
    attachments?: string;
  };
};

type SendFn = (msg: unknown) => void;

// ── Monitor ──────────────────────────────────────────────────────────────────

export async function startMonitor(opts: {
  client: ZulipClient;
  access: AccessManager;
  permissions: PermissionManager;
  send: SendFn;
  signal: AbortSignal;
}): Promise<BotIdentity> {
  const { client, access, permissions, send, signal } = opts;

  // REQ-LIFE-04, REQ-LIFE-05 — verify bot identity
  const me = await fetchMe(client);
  const identity: BotIdentity = {
    botUserId: String(me.id ?? me.user_id),
    botEmail: me.email ?? "",
    botFullName: me.full_name ?? "",
  };
  log(`zulip channel: connected as ${identity.botEmail}`); // REQ-LIFE-08

  // REQ-LIFE-06
  access.reload();
  access.startWatching();

  // Start polling in background
  pollLoop(client, identity, access, permissions, send, signal).catch((e) => {
    if (!signal.aborted) {
      log(`monitor: fatal poll error: ${e}`);
    }
  });

  return identity;
}

async function pollLoop(
  client: ZulipClient,
  identity: BotIdentity,
  access: AccessManager,
  permissions: PermissionManager,
  send: SendFn,
  signal: AbortSignal,
): Promise<void> {
  let queueId: string | undefined;
  let lastEventId = -1;
  let backoff = 1000;
  const MAX_BACKOFF = 60000;

  while (!signal.aborted) {
    // Register queue if needed (REQ-RECV-01)
    if (!queueId) {
      try {
        const reg = await registerQueue(client, ["message"]);
        queueId = reg.queue_id;
        lastEventId = reg.last_event_id ?? -1;
        backoff = 1000;
        log("monitor: event queue registered");
      } catch (e) {
        log(`monitor: register failed: ${e}, retrying in ${backoff}ms`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        continue;
      }
    }

    // Poll events (REQ-RECV-02, REQ-RECV-03)
    try {
      const result = await getEvents(client, {
        queueId: queueId!,
        lastEventId,
      });
      const events = result;

      backoff = 1000;

      for (const event of events) {
        // REQ-RECV-08 — track last_event_id, skip duplicates
        if (event.id <= lastEventId) continue;
        lastEventId = event.id;

        if (event.type === "message" && event.message) {
          await processMessage(
            client,
            identity,
            access,
            permissions,
            send,
            event.message,
          );
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      // REQ-RECV-04 — re-register on BAD_EVENT_QUEUE_ID
      if (msg.includes("BAD_EVENT_QUEUE_ID")) {
        log("monitor: queue expired, re-registering");
        queueId = undefined;
        continue;
      }

      // REQ-RECV-05 — rate limit
      const retryMatch = msg.match(/retry-after[:\s]+(\d+)/i);
      if (msg.includes("RATE_LIMIT") || msg.includes("429")) {
        const waitSec = retryMatch ? Number(retryMatch[1]) : 10;
        log(`monitor: rate limited, waiting ${waitSec}s`);
        await sleep(waitSec * 1000, signal);
        continue;
      }

      // REQ-RECV-06, REQ-RECV-07 — exponential backoff
      log(`monitor: poll error: ${msg}, retrying in ${backoff}ms`);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }

  // Cleanup
  if (queueId) {
    try {
      const { deleteQueue } = await import("./zulip/client.js");
      await deleteQueue(client, queueId);
    } catch {
      // best effort
    }
  }
  access.stopWatching();
}

async function processMessage(
  client: ZulipClient,
  identity: BotIdentity,
  access: AccessManager,
  permissions: PermissionManager,
  send: SendFn,
  msg: ZulipMessage,
): Promise<void> {
  // REQ-RECV-10 — filter own messages
  if (String(msg.sender_id) === identity.botUserId) return;

  const senderEmail = msg.sender_email ?? "";
  const senderName = msg.sender_full_name ?? senderEmail;
  const rawContent = msg.content ?? "";
  const messageId = String(msg.id);
  const timestamp = msg.timestamp
    ? new Date(msg.timestamp * 1000).toISOString()
    : new Date().toISOString();

  // Determine message type and build chat_id
  const isStream = msg.type === "stream" || msg.type === "channel";
  const streamName =
    typeof msg.display_recipient === "string"
      ? msg.display_recipient
      : undefined;
  const topic = msg.subject ?? "general";

  let chatId: string;
  if (isStream && streamName) {
    chatId = `stream:${streamName}:${topic}`; // REQ-CID-01
  } else {
    chatId = `dm:${senderEmail}`; // REQ-CID-02
  }

  // Access check
  if (isStream && streamName) {
    const mentionPattern = `@**${identity.botFullName}**`;
    const mentionsBotName = rawContent.includes(mentionPattern);
    if (!access.checkStream(streamName, senderEmail, mentionsBotName)) return;
  } else {
    const result = access.checkDm(senderEmail);
    if (result.action === "drop") return;
    if (result.action === "pairing") {
      // Reply with pairing message
      try {
        const { sendPrivateMessage } = await import("./zulip/client.js");
        await sendPrivateMessage(client, {
          to: senderEmail,
          content: result.reply,
        });
      } catch (e) {
        log(`monitor: pairing reply failed: ${e}`);
      }
      return;
    }
  }

  // REQ-PERM-07 — check if DM is a permission reply (don't forward)
  if (!isStream) {
    const handled = await permissions.tryHandleReply(
      senderEmail,
      messageId,
      rawContent,
    );
    if (handled) return;
  }

  // REQ-REACT-01..04 — ack reaction
  const ackEmoji = access.config().ackReaction;
  try {
    await addReaction(client, {
      messageId,
      emojiName: ackEmoji,
    });
  } catch (e) {
    log(`monitor: ack reaction failed: ${e}`); // REQ-REACT-04
  }

  // REQ-RECV-09 — strip bot mention
  let content = rawContent;
  const mentionSyntax = `@**${identity.botFullName}**`;
  content = content.replaceAll(mentionSyntax, "").trim();

  // REQ-RECV-13 — detect attachments
  const uploadUrls = extractUploadUrls(
    msg.contentHtml ?? rawContent,
    client.baseUrl,
  );

  // REQ-RECV-11, REQ-RECV-12 — build and send notification
  const notification: ChannelNotification = {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: {
      source: "zulip",
      chat_id: chatId,
      message_id: messageId,
      user: senderName,
      user_id: String(msg.sender_id ?? ""),
      ts: timestamp,
      content,
    },
  };

  if (uploadUrls.length > 0) {
    notification.params.attachment_count = uploadUrls.length;
    notification.params.attachments = uploadUrls
      .map((url) => {
        const name = url.split("/").pop() ?? "file";
        return `${name} (${url})`;
      })
      .join("; ");
  }

  send(notification);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
