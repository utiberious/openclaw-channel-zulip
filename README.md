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

#### Production Mode (symlink)

```bash
# Clone the repo
git clone https://github.com/utiberious/openclaw-channel-zulip.git
cd openclaw-channel-zulip && bun install

# Symlink into Claude Code's plugin directory
ln -s "$(pwd)" ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/zulip

# Start Claude Code with the Zulip channel
claude --channels plugin:zulip@claude-plugins-official
```

#### Dev Mode (direct run)

```bash
# Clone and install
git clone https://github.com/utiberious/openclaw-channel-zulip.git
cd openclaw-channel-zulip && bun install

# Test the MCP server directly (stdin/stdout)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | bun run src/index.ts

# Or add to ~/.claude/mcp.json for standalone MCP testing
cat > ~/.claude/mcp.json << 'EOF'
{
  "mcpServers": {
    "zulip": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/openclaw-channel-zulip/src/index.ts"]
    }
  }
}
EOF
```

**Note:** `mcp.json` gives you the tools but NOT channel notifications (inbound messages). For full channel functionality (receiving Zulip messages as `notifications/claude/channel`), use `--channels plugin:zulip@...` which enables the channel protocol.

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
