# Architecture

## Goals

- One Telegram bot token supports many local AI coding sessions.
- Claude Code uses an MCP channel bridge; Codex CLI uses the Codex App Server
  WebSocket protocol.
- One standalone executable contains daemon, bridge, configuration, access control, diagnostics, and SQLite.
- Telegram users can only see and select sessions explicitly available to them.
- A short-lived reviewer or auxiliary CLI process cannot steal Telegram polling ownership.

## Non-goals

- Product-specific tools or domain models.
- Remote multi-tenant hosting in the first release.
- Exposing the router port beyond loopback.
- Treating Telegram messages as trusted configuration commands.

## Processes

### Router daemon

The daemon owns the Telegram token, performs long polling, authenticates users,
persists routing state, and maintains loopback WebSocket paths to Claude MCP
bridges or the managed Codex App Server.

### MCP bridge

Each Claude Code session launches the same binary in `mcp` mode. The bridge
registers `{sessionId, label, client, workspace}` with the daemon and translates
router events to the experimental MCP channel notification:

```text
notifications/claude/channel
```

The bridge also exposes outbound tools such as `reply`, `react`, and `edit_message`. Those tools call the daemon over the authenticated local connection. The bot token never enters the AI session process.

### Codex App Server adapter

The Codex profile daemon starts and supervises `codex app-server`, proxies each
interactive Codex client connection, and delivers Telegram turns with
`turn/start` or `turn/steer`. The proxy observes only the root thread started or
resumed by that client, so persisted App Server threads never appear as live
sessions. Codex does not install or use an MCP router entry.

## Routing

Each allowed Telegram user has a selected session. Commands:

- `/sessions`: list online sessions visible to the user.
- `/use <session>`: select a destination.
- `/status`: show the current destination and daemon health.

If exactly one visible session is online, the daemon may select it automatically. Otherwise it asks the user to choose.

## Local security boundary

- Bind only to `127.0.0.1` by default.
- Authenticate Claude MCP bridges with a random router secret stored in the state directory.
- Admit Codex client proxies with short-lived, single-use registration tickets.
- Store the Telegram token separately from SQLite.
- Require terminal-side approval for pairing. A Telegram message cannot approve itself.
- Do not broadcast inbound messages to every session.
- Keep an audit record of pairing, route changes, and delivery outcomes without storing message bodies by default.

## Distribution

Bun compiles the TypeScript entry point, npm dependencies, runtime, and
`bun:sqlite` into platform-specific executables. GitHub Actions produces Windows
x64, Linux x64/arm64, and macOS x64/arm64 artifacts.
