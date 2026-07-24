# Telegram Agent Router

A standalone Telegram gateway for local AI coding sessions. One daemon owns the Telegram bot token and routes messages to any connected Claude Code or Codex CLI session through a shared MCP channel bridge.

This project is vendor-neutral. It contains no KIP-AI-specific models, paths, tools, or business logic.

## Product shape

One compiled executable provides every runtime component:

```text
telegram-agent-router configure
telegram-agent-router daemon
telegram-agent-router mcp --client codex --session kip-ai
telegram-agent-router mcp --client claude --session another-project
telegram-agent-router access pair <code>
telegram-agent-router doctor
```

End users do not need Bun, Node.js, npm, grammY, SQLite, or the MCP SDK. Release binaries embed the runtime and dependencies.

## Architecture

```text
Telegram Bot API
       |
       v
router daemon (single long-poller + access control + SQLite)
       |
       +-- local WebSocket --> MCP bridge --> Claude Code session
       +-- local WebSocket --> MCP bridge --> Codex CLI session
```

The daemon is the only Telegram `getUpdates` consumer. MCP bridge processes never hold the bot token.

See [docs/architecture.md](docs/architecture.md) for routing and security decisions.

## Development

Requires Bun only for building the project:

```bash
bun install
bun test
bun run check
bun run build
```

## Status

Early private MVP. The protocol and state schema may change before the first release.
