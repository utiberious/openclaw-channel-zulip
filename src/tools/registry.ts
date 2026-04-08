import type { McpToolDefinition, McpToolsListResult } from "../mcp/types.js";

const tools: McpToolDefinition[] = [
  {
    name: "reply",
    description: "Send a message to a Zulip stream topic or direct message",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "Target: stream:{name}:{topic} or dm:{email}",
        },
        text: {
          type: "string",
          description: "Message body in Zulip Markdown",
        },
        reply_to: {
          type: "string",
          description: "Message ID to quote-reply (optional)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of absolute local file paths to attach (optional)",
        },
        topic: {
          type: "string",
          description:
            "Override the topic derived from chat_id (streams only, optional)",
        },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a Zulip message",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "Context identifier",
        },
        message_id: {
          type: "string",
          description: "ID of the message to react to",
        },
        emoji: {
          type: "string",
          description: 'Zulip emoji name (e.g. "eyes", "thumbs_up", "check")',
        },
      },
      required: ["chat_id", "message_id", "emoji"],
    },
  },
  {
    name: "edit_message",
    description: "Replace the content of a message the bot previously sent",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "Context identifier",
        },
        message_id: {
          type: "string",
          description: "ID of the bot message to edit",
        },
        text: {
          type: "string",
          description: "New message content",
        },
      },
      required: ["chat_id", "message_id", "text"],
    },
  },
  {
    name: "fetch_messages",
    description: "Retrieve recent message history from a Zulip stream",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Stream name",
        },
        topic: {
          type: "string",
          description: "Topic filter (optional)",
        },
        limit: {
          type: "integer",
          description: "Number of messages, 1-100 (default: 20)",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "download_attachment",
    description:
      "Download all file attachments from a specific Zulip message to local disk",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "Context identifier",
        },
        message_id: {
          type: "string",
          description: "ID of the message containing attachments",
        },
      },
      required: ["chat_id", "message_id"],
    },
  },
];

export function getToolsList(): McpToolsListResult {
  return { tools };
}
