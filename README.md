# Telegram Agent Router

A standalone Telegram gateway for local AI coding sessions. One daemon owns the Telegram bot token and routes messages to connected Claude Code and Codex CLI sessions through a shared MCP channel bridge.

This project is vendor-neutral. It contains no product-specific models, paths, tools, or business logic.

## One download, no runtime dependencies

Release artifacts are single executables compiled with Bun. The executable embeds the Telegram client, MCP SDK, WebSocket server, SQLite, and runtime.

End users do not install Bun, Node.js, npm, grammY, SQLite, or separate Claude/Codex plugins.

```text
telegram-agent-router configure
telegram-agent-router daemon
telegram-agent-router install --client both --session my-project
telegram-agent-router access pair <code>
telegram-agent-router doctor
```

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

The daemon is the only Telegram `getUpdates` consumer. MCP bridge processes never receive the bot token. Duplicate bridge processes with the same session ID become standby connections and cannot steal inbound messages from the primary session.

## Quick start from a release binary

Set the bot token without placing it in shell history, then configure local state:

```powershell
$env:TELEGRAM_BOT_TOKEN = "<BotFather token>"
.\telegram-agent-router.exe configure
```

Start the central daemon in one terminal:

```powershell
.\telegram-agent-router.exe daemon
```

Register this same executable with both clients for a project:

```powershell
.\telegram-agent-router.exe install --client both --session my-project --label "My Project"
```

Restart Claude Code and Codex CLI after registration. Send the Telegram bot a DM. It returns a one-hour pairing code. Approve that code only from a trusted terminal:

```powershell
.\telegram-agent-router.exe access pair ABC123
```

Then use `/sessions`, `/use my-project`, and `/status` in Telegram.

See [docs/install.md](docs/install.md), [docs/architecture.md](docs/architecture.md), and [docs/security.md](docs/security.md).

## Development

Bun is required only for building the project:

```bash
bun install
bun test
bun x tsc --noEmit
bun run check
bun run build
```

## Status

Private MVP. Text messages and reply/reaction/edit tools are implemented. Attachments, service installation, and signed release publishing remain before a public release.
