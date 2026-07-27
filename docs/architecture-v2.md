# Multi-profile architecture

## Goal

Telegram Agent Router treats every `(machine, agent kind)` pair as one isolated
Telegram endpoint. A machine can therefore run one Claude bot and one Codex bot,
each with a different token. Every live session of that agent on the machine is
listed by the same bot and can be selected with `/use`.

The supported hosts are Windows, macOS, and Linux, including headless servers.

## What already exists

The v1 implementation already provides:

- a private, loopback-only WebSocket bridge;
- Telegram pairing, allowlists, per-session grants, routes, and an audit log;
- `/sessions`, `/use`, and `/status`;
- a Claude-compatible MCP channel bridge; and
- SQLite state with a single-process lock.

V2 keeps those pieces and changes profile isolation, session identity, delivery
acknowledgement, Codex transport, and installation/lifecycle management.

## Process and data layout

Each profile owns its token, database, lock, configuration, and local port:

```text
~/.telegram-agent-router/
├── claude/
│   ├── config.json
│   ├── .env
│   ├── router.sqlite
│   └── daemon.pid
└── codex/
    ├── config.json
    ├── .env
    ├── router.sqlite
    └── daemon.pid
```

Default loopback ports are 47321 for Claude, 47322 for the Codex router, and
47323 for the managed Codex App Server. Ports remain configurable.

```text
Claude bot token                         Codex bot token
       │                                        │
       ▼                                        ▼
┌─────────────────┐                    ┌─────────────────┐
│ Claude profile  │                    │ Codex profile   │
│ router daemon   │                    │ router daemon   │
└────────┬────────┘                    └────────┬────────┘
         │ authenticated WS                      │ JSON-RPC WS
    ┌────┴────┐                             ┌────┴─────────┐
    ▼         ▼                             ▼              ▼
 Claude A  Claude B                  Codex App Server   Telegram
 (MCP)     (MCP)                          │
                                      ┌───┴───┐
                                      ▼       ▼
                                  Codex A  Codex B
                                 (--remote clients)
```

Tokens are read only by their profile daemon. Claude MCP bridges receive a
loopback URL and profile secret. Codex clients receive a host-and-port-only
single-use proxy URL; the router forwards that connection to the managed App
Server and tracks the root thread chosen on that exact socket. Neither receives
a Telegram token.

## Session model

Claude MCP bridges create a unique session ID from the machine name, workspace,
and parent Claude process identity. Two Claude processes in the same directory
therefore remain independently selectable. The descriptor contains:

- stable ID for the lifetime of the process;
- agent kind;
- workspace and display label;
- Git branch when available;
- optional task summary; and
- start time.

Codex sessions correspond one-to-one with connected CLI proxy sockets and their
current root App Server threads. The router reads thread ID, name, preview,
current directory, Git branch, and status from the App Server. Closing a proxy
socket removes that session immediately; persisted and unowned loaded threads
remain resumable by Codex but are excluded from `/sessions`. Thread IDs are not
exposed as the primary UI: `/sessions` shows a short, unique selector plus
human-readable context. `/use` accepts the full ID, a unique prefix or suffix,
the workspace label, or the displayed list number. Replying to an earlier bot
answer also selects the session that produced it.

Example:

```text
1. api-fix · KIP-AI · main · Fixing cache invalidation [active]
2. report · KIP-AI · quarterly-report · Reviewing Q2 report [idle]

/use 1
```

Offline routes are retained so a restarted session can be recognized, but text
is never silently queued to a nonexistent process.

For reply-based routing, the store retains only `(chat ID, bot message ID,
session ID, timestamp)`. It never stores the answer text. Mappings older than 30
days are pruned, and a reply to an offline or unauthorized session fails
explicitly instead of falling back to a different route.

## Message delivery

### Claude

```text
Telegram text
  → router validates user and selected route
  → router sends `inbound` with delivery ID
  → MCP bridge awaits `notifications/claude/channel`
  → bridge returns `inbound_result`
  → router records `message_delivered`
```

The acknowledgement has a timeout. Rejection, disconnect, or timeout records
`message_failed` and sends a concise error back to Telegram. A successful
WebSocket write alone is not considered delivery.

### Codex

The Codex profile starts and supervises `codex app-server --listen ws://...`.
The router initializes one JSON-RPC adapter connection. Each Codex CLI connects
through a ticketed router proxy that records the root thread started or resumed
on that socket.

- idle thread: `turn/start`;
- active thread with a known turn: `turn/steer`;
- final assistant output: accumulated from agent message events and sent to the
  Telegram chat associated with that turn;
- App Server process exit: restart with bounded exponential backoff and require
  Codex clients to reconnect before their threads are listed again.

Command/file approvals and structured user-input requests must not hang
silently. Unsupported prompts are rejected with an explicit Telegram notice;
the terminal client remains the authority for interactive approval.

## CLI launch behavior

Installation registers the Claude MCP server at user scope. The MCP command has
no fixed session name, so every Claude process registers dynamically.

Installation also places a thin `codex` wrapper before the real executable on
the user's path. It preserves arguments and working directory, ensures the
Codex profile daemon is healthy, requests a short-lived single-use loopback
port, and invokes the real binary with the router proxy's host-and-port-only
`--remote` URL. The resolved real Codex path is stored at install time to
prevent wrapper recursion.

Explicit commands remain available for diagnostics:

```text
telegram-agent-router daemon --profile claude
telegram-agent-router daemon --profile codex
telegram-agent-router mcp --profile claude
telegram-agent-router launch codex -- <codex arguments>
telegram-agent-router doctor --profile all
```

## Installation and automatic start

`telegram-agent-router install` configures both profiles and automatic start by
default. `--no-autostart` is the opt-out.

| Host | Registration | Reboot behavior |
| --- | --- | --- |
| Windows | Per-user HKCU Run entries launching hidden PowerShell processes | Starts after user logon without a visible terminal; agent launch self-heals |
| macOS | `~/Library/LaunchAgents` | Starts at login and is loaded immediately |
| Linux desktop/server | `systemd --user` | Enabled immediately |
| Headless Linux server | `systemd --user` plus linger | Starts at boot without an interactive login |

If enabling Linux linger needs administrator permission, the installer leaves
the service enabled, reports that boot-without-login is not yet active, and
prints the exact `loginctl enable-linger <user>` follow-up. Installation never
claims success for an autostart registration it could not verify.

An update replaces the versioned executable and restarts the managed service.
Windows stops the authenticated profile PID before starting the new binary,
macOS replaces the LaunchAgent job, and Linux performs a user-service restart.
Health is accepted only when the reported profile and binary version match the
version being installed.

Each profile is a separate service so a bad token or transport failure in one
agent cannot take down the other.

## Lifecycle and failure handling

```text
install
  → configure isolated profiles
  → register Claude MCP and Codex wrapper
  → write OS service definitions
  → enable/start services
  → probe authenticated /health for the expected profile and version

host reboot
  → OS service manager starts profile daemons
  → Telegram polling begins
  → Claude sessions appear when Claude starts
  → Codex App Server is supervised by the Codex daemon
  → Codex sessions appear when Codex clients connect
```

Expected failure behavior:

- invalid/revoked token: only that profile is unhealthy; `doctor` reports the
  Telegram API error;
- port collision: daemon exits with the exact port and owning-profile hint;
- duplicate daemon: lock prevents a second poller;
- bridge disconnect during delivery: failure is audited and returned to user;
- App Server crash: bounded restart, health degradation during recovery;
- stale selected session: `/status` shows offline and Telegram asks for a new
  selection;
- ambiguous `/use` selector: no route changes; matching sessions are listed;
- service registration failure: install exits non-zero and preserves generated
  files for inspection.

The managed Codex App Server does not inherit the daemon's stdout or stderr, so
conversation and tool streams are not copied into an automatic-start console.
A manually foregrounded router can still emit operational errors and session
metadata on its own stderr.

## Security boundaries

- all local control sockets bind to `127.0.0.1` by default;
- bridge authentication uses a random per-profile secret;
- the health endpoint requires the same per-profile secret;
- tokens and secrets are stored with user-only permissions where supported;
- Telegram access remains opt-in through pairing and per-profile allowlists;
- service definitions refer to token files and never embed token values; and
- logs redact tokens and authenticated WebSocket query strings.

## Not in scope for the first V2 release

- Telegram attachments or media;
- group-chat routing;
- exposing the router or App Server beyond loopback;
- cross-machine aggregation into one bot;
- unattended approval of command/file changes; and
- migrating live in-flight agent turns during upgrade.

These boundaries keep the initial release focused on reliable text routing,
session selection, restart behavior, and three-OS installation.
