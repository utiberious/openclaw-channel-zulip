# openclaw-channel-zulip

Zulip channel plugin for Claude Code — MCP-based messaging bridge with access control, pairing, and permission relay.

## Prerequisites

- [Bun](https://bun.sh/) v1.3+
- A Zulip bot (create one in your Zulip org: **Settings → Bots → Add a new bot**)

## Setup

### 1. Credentials

Create the credentials file:

```bash
mkdir -p ~/.claude/channels/zulip
cat > ~/.claude/channels/zulip/.env << 'EOF'
ZULIP_URL=https://your-org.zulipchat.com
ZULIP_BOT_EMAIL=your-bot@your-org.zulipchat.com
ZULIP_API_KEY=your-api-key
EOF
chmod 600 ~/.claude/channels/zulip/.env
```

### 2. Access Control

Create `~/.claude/channels/zulip/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["your-email@example.com"],
  "groups": {
    "*": { "requireMention": true, "senderAllowlist": ["*"] }
  },
  "pending": {},
  "ackReaction": "eyes",
  "textChunkLimit": 4000,
  "chunkMode": "length"
}
```

- `dmPolicy`: `"pairing"` (default, requires code approval), `"allowlist"`, or `"disabled"`
- `allowFrom`: emails allowed to DM the bot and approve permissions
- `groups`: per-stream policies (`"*"` = default for all streams)
- `requireMention`: if `true`, bot only responds when @mentioned in streams

### 3. Install the Plugin

```bash
git clone https://github.com/utiberious/openclaw-channel-zulip.git
cd openclaw-channel-zulip && bun install
```

There are three ways to load the plugin, from simplest to most integrated.

#### Option A: `--plugin-dir` (recommended)

The simplest approach. No registration needed — just point Claude Code at the repo:

```bash
claude --plugin-dir /absolute/path/to/openclaw-channel-zulip
```

With other channels (e.g., Discord):

```bash
claude --channels plugin:discord@claude-plugins-official \
       --plugin-dir /absolute/path/to/openclaw-channel-zulip
```

The plugin loads synchronously at startup. Tools are available immediately.

> **Note:** `--resume` does not pick up new plugins added after session creation. If you add `--plugin-dir` to an existing session, start a fresh session first, then use `--resume` with that new session ID going forward.

#### Option B: Custom marketplace (full channel integration)

For full channel integration (inbound + outbound), you need **two flags** — one to start the MCP server, one to register for inbound notifications:

**1.** Clone and install the plugin:

```bash
git clone https://github.com/utiberious/openclaw-channel-zulip.git
cd openclaw-channel-zulip && bun install
```

**2.** Register the marketplace in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "utiberious": {
      "source": {
        "source": "git",
        "url": "https://github.com/utiberious/claude-plugins.git"
      }
    }
  },
  "enabledPlugins": {
    "zulip@utiberious": true
  }
}
```

**3.** Start Claude Code with both flags:

```bash
claude --plugin-dir /absolute/path/to/openclaw-channel-zulip \
       --dangerously-load-development-channels plugin:zulip@utiberious
```

With other channels (e.g., Discord from the official marketplace):

```bash
claude --channels plugin:discord@claude-plugins-official \
       --plugin-dir /absolute/path/to/openclaw-channel-zulip \
       --dangerously-load-development-channels plugin:zulip@utiberious
```

A confirmation dialog appears at startup for development channels.

> **Why two flags?** `--plugin-dir` starts the MCP server (tools). `--dangerously-load-development-channels` registers inbound channel notifications (bypasses the official-only allowlist). Neither works alone — `--plugin-dir` alone gives tools but no inbound messages; `--dangerously-load-development-channels` alone registers for notifications but doesn't start the server. The `--channels` flag only works for official marketplace plugins.

#### Option C: MCP-only (tools without channel notifications)

For standalone MCP testing or tools-only usage:

```bash
# Test the MCP server directly (stdin/stdout)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | bun run src/index.ts
```

Or add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "zulip": {
      "command": "bun",
      "args": ["run", "--cwd", "/absolute/path/to/openclaw-channel-zulip", "--silent", "src/index.ts"]
    }
  }
}
```

> **Note:** `mcp.json` gives you outbound tools (reply, react, etc.) but Claude Code won't process inbound `notifications/claude/channel` messages unless loaded via `--channels` or `--plugin-dir`.

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a message to a stream topic or DM |
| `react` | Add an emoji reaction |
| `edit_message` | Edit a previously sent message |
| `fetch_messages` | Retrieve stream message history |
| `download_attachment` | Download file attachments from a message |

## chat_id Format

- Stream messages: `stream:{name}:{topic}`
- Direct messages: `dm:{email}`

## Architecture

```
src/
├── index.ts          # Entry point — wires MCP + Zulip
├── config.ts         # .env credential loader
├── access.ts         # DM/stream access control + pairing
├── monitor.ts        # Zulip event queue polling
├── permissions.ts    # Permission relay (yes/no approval flow)
├── log.ts            # stderr logger
├── instructions.ts   # LLM instructions
├── mcp/
│   ├── server.ts     # MCP request router
│   ├── stdio.ts      # JSON-RPC stdio transport
│   └── types.ts      # MCP type definitions
├── tools/
│   ├── registry.ts   # Tool definitions (JSON Schema)
│   └── handlers.ts   # Tool call implementations
└── zulip/
    ├── client.ts     # Zulip REST API client
    └── uploads.ts    # File upload/download
```

## License

MIT
