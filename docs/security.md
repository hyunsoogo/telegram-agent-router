# Security model

## Trust boundaries

- Telegram is an untrusted input channel.
- The local terminal is the only authority for pairing and session grants.
- Claude Code and Codex CLI sessions are distinct execution principals even when they share a session ID.
- The router daemon is the only process that receives the Telegram bot token.

## Controls

### Loopback only

The daemon binds to `127.0.0.1` by default. Bridge and health endpoints require a random secret stored with mode `0600` where supported.

### One daemon

`daemon.pid` is acquired without replacing a live process. This prevents a second CLI or reviewer process from taking Telegram polling ownership.

### Primary and standby Claude sessions

The first Claude MCP bridge registered for a session ID is primary. Later
bridges with the same ID are standby and receive no inbound messages. When the
primary disconnects, the oldest standby is promoted. Codex sessions instead map
directly to App Server threads.

### Terminal-side pairing

Unknown Telegram users receive a short-lived pairing code. The code must be approved with the local executable. Telegram messages cannot approve their own sender, modify allowlists, or grant sessions.

### Explicit routing

Messages go to one selected session, never broadcast. Session grants are checked both when selecting a route and when delivering a message.

### Minimal persistence

The database stores identities, grants, routes, pairing state, and metadata-only audit events. Message bodies are not persisted by default.

### Background process privacy

Windows automatic-start entries launch each daemon in a hidden process. The
managed Codex App Server does not inherit stdout or stderr, preventing
conversation and tool streams from appearing in an automatic-start console.
Operational router errors and session metadata can still appear when the router
is deliberately run in the foreground.

## Known MVP limitations

- Local users who can read the state directory can impersonate a bridge.
- The bot token is stored in a local `.env` file, not an OS keychain.
- Executables are not yet code-signed.
- Attachments are not yet implemented.
- Automatic start is supported through per-user Windows Run entries, macOS
  LaunchAgents, and Linux `systemd --user` services. These are user-level
  mechanisms rather than privileged system services.
