/**
 * handlers.ts — Tool call handlers for reply, react, edit_message,
 * fetch_messages, download_attachment.
 * REQ-TOOL-REPLY-01..17, REQ-TOOL-REACT-01..04, REQ-TOOL-EDIT-01..03,
 * REQ-TOOL-FETCH-01..06, REQ-TOOL-DL-01..05, REQ-TOOL-UNK-01
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../log.js";
import type { AccessConfig } from "../access.js";
import type { ZulipClient } from "../zulip/client.js";
import {
  sendStreamMessage,
  sendPrivateMessage,
  uploadFile,
  addReaction,
  editMessage,
  fetchMessages as fetchZulipMessages,
  fetchSingleMessage,
} from "../zulip/client.js";
import { extractUploadUrls, downloadUpload } from "../zulip/uploads.js";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ParsedChatId =
  | { kind: "stream"; stream: string; topic: string }
  | { kind: "dm"; email: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

const STATE_DIR = path.join(os.homedir(), ".claude", "channels", "zulip");

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function parseChatId(chatId: string): ParsedChatId {
  if (chatId.startsWith("stream:")) {
    const rest = chatId.slice("stream:".length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) {
      return { kind: "stream", stream: rest, topic: "general" };
    }
    return {
      kind: "stream",
      stream: rest.slice(0, colonIdx),
      topic: rest.slice(colonIdx + 1),
    };
  }
  if (chatId.startsWith("dm:")) {
    return { kind: "dm", email: chatId.slice("dm:".length) };
  }
  throw new Error(`invalid chat_id format: ${chatId}`);
}

// ── Chunking (REQ-SEND-01..05) ──────────────────────────────────────────────

function chunkText(
  text: string,
  limit: number,
  mode: "length" | "newline",
): string[] {
  if (text.length <= limit) return [text];

  if (mode === "length") {
    // REQ-SEND-02
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += limit) {
      chunks.push(text.slice(i, i + limit));
    }
    return chunks;
  }

  // REQ-SEND-03 — newline mode
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Tool: reply ──────────────────────────────────────────────────────────────

async function handleReply(
  client: ZulipClient,
  access: AccessConfig,
  groups: AccessConfig["groups"],
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const chatId = params.chat_id as string;
  const text = params.text as string;
  const replyTo = params.reply_to as string | undefined;
  const files = params.files as string[] | undefined;
  const topicOverride = params.topic as string | undefined;

  if (!chatId) return err("chat_id is required");
  if (!text) return err("text is required");

  let target: ParsedChatId;
  try {
    target = parseChatId(chatId);
  } catch {
    return err(`invalid chat_id: ${chatId}`);
  }

  // REQ-TOOL-REPLY-16 — stream must be in configured groups
  if (target.kind === "stream") {
    const streamName = target.stream;
    if (!groups[streamName] && !groups["*"]) {
      return err(`channel ${chatId} is not in the configured groups`);
    }
  }

  // REQ-TOOL-REPLY-13 — max 10 files
  if (files && files.length > MAX_FILES) {
    return err("max 10 files per reply");
  }

  // Validate and upload files (REQ-TOOL-REPLY-11..15)
  let fileLinks = "";
  if (files?.length) {
    const links: string[] = [];
    for (const filePath of files) {
      // REQ-TOOL-REPLY-12 — reject state directory files
      const resolved = fs.realpathSync(filePath);
      if (resolved.startsWith(STATE_DIR)) {
        return err(`refusing to send channel state: ${filePath}`);
      }

      // REQ-TOOL-REPLY-14 — reject > 25MB
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) {
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
        return err(`file too large: ${filePath} (${sizeMb}MB, max 25MB)`);
      }

      const result = await uploadFile(client, filePath);
      const name = path.basename(filePath);
      links.push(`[${name}](${result.url})`);
    }
    fileLinks = "\n" + links.join("\n");
  }

  // Chunk text (REQ-SEND-01..05)
  const chunks = chunkText(text, access.textChunkLimit, access.chunkMode);
  // REQ-SEND-06 — file links on first chunk only
  if (fileLinks) chunks[0] = chunks[0] + fileLinks;

  let lastId = "";
  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i];
    try {
      let msgId: string;
      if (target.kind === "stream") {
        const topic = topicOverride ?? target.topic;
        msgId = await sendStreamMessage(client, {
          stream: target.stream,
          topic,
          content,
        });
      } else {
        msgId = await sendPrivateMessage(client, {
          to: target.email,
          content,
        });
      }
      lastId = msgId;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      // REQ-TOOL-REPLY-17
      if (chunks.length > 1) {
        return err(
          `reply failed after ${i} of ${chunks.length} chunk(s) sent: ${reason}`,
        );
      }
      return err(`reply failed: ${reason}`);
    }
  }

  // REQ-TOOL-REPLY-08
  return ok(lastId);
}

// ── Tool: react ──────────────────────────────────────────────────────────────

async function handleReact(
  client: ZulipClient,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const messageId = params.message_id as string;
  const emoji = params.emoji as string;

  if (!messageId) return err("message_id is required");
  if (!emoji) return err("emoji is required");

  try {
    await addReaction(client, {
      messageId,
      emojiName: emoji.replace(/^:+|:+$/g, ""),
    });
    return ok("ok");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // REQ-TOOL-REACT-04 — idempotent
    if (msg.includes("REACTION_ALREADY_EXISTS")) return ok("ok");
    return err(`react failed: ${msg}`);
  }
}

// ── Tool: edit_message ───────────────────────────────────────────────────────

async function handleEditMessage(
  client: ZulipClient,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const messageId = params.message_id as string;
  const text = params.text as string;

  if (!messageId) return err("message_id is required");
  if (!text) return err("text is required");

  try {
    await editMessage(client, { messageId, content: text });
    return ok("ok");
  } catch (e: unknown) {
    return err(`edit failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Tool: fetch_messages ─────────────────────────────────────────────────────

async function handleFetchMessages(
  client: ZulipClient,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const channel = params.channel as string;
  const topic = params.topic as string | undefined;
  const limit = Math.min(Math.max((params.limit as number) || 20, 1), 100);

  if (!channel) return err("channel is required");

  try {
    const messages = await fetchZulipMessages(client, {
      stream: channel,
      topic,
      limit,
    });

    if (!messages.length) return ok("(no messages)");

    // REQ-TOOL-FETCH-05
    const lines = messages.map((m) => {
      const ts = m.timestamp
        ? new Date(m.timestamp * 1000).toISOString()
        : "unknown";
      return `[${ts}] ${m.sender_full_name ?? "unknown"}: ${m.content ?? ""}  (id: ${m.id})`;
    });
    return ok(lines.join("\n"));
  } catch (e: unknown) {
    return err(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Tool: download_attachment ────────────────────────────────────────────────

async function handleDownloadAttachment(
  client: ZulipClient,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const messageId = params.message_id as string;

  if (!messageId) return err("message_id is required");

  try {
    // Fetch the specific message to get its content HTML
    const msg = await fetchSingleMessage(client, messageId);
    if (!msg) return err("message not found");

    const urls = extractUploadUrls(msg.contentHtml ?? msg.content ?? "", client.baseUrl);

    if (!urls.length) return err("message has no attachments");

    const paths: string[] = [];
    for (const url of urls) {
      const result = await downloadUpload(client, url, MAX_FILE_BYTES);
      const dir = path.join(os.tmpdir(), "zulip-downloads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, result.filename);
      fs.writeFileSync(filePath, result.buffer);
      paths.push(filePath);
    }

    return ok(paths.join("\n"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("too large")) return err(msg);
    return err(`download failed: ${msg}`);
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  params: Record<string, unknown>,
  client: ZulipClient,
  access: AccessConfig,
): Promise<ToolResult> {
  switch (name) {
    case "reply":
      return handleReply(client, access, access.groups, params);
    case "react":
      return handleReact(client, params);
    case "edit_message":
      return handleEditMessage(client, params);
    case "fetch_messages":
      return handleFetchMessages(client, params);
    case "download_attachment":
      return handleDownloadAttachment(client, params);
    default:
      // REQ-TOOL-UNK-01
      return err(`unknown tool: ${name}`);
  }
}
