# Telegram Agent Router

Route Telegram text messages to any live Claude Code or Codex CLI session on a
computer. Windows, macOS, and Linux servers are supported.

## Model

Each `(computer × agent kind)` has its own Telegram bot:

```text
workstation-claude bot → every Claude Code session on that workstation
workstation-codex bot  → every Codex CLI session on that workstation
server-claude bot      → every Claude Code session on that server
server-codex bot       → every Codex CLI session on that server
```

Within one bot, `/sessions` shows all live sessions with workspace, Git branch,
status, and a short task preview. Use `/use 2` or `/use <displayed-selector>` to
select where subsequent messages go. You can also reply to any earlier agent
answer; the router switches back to the session that produced that answer.

Claude uses its supported MCP channel notification. Codex uses the Codex App
Server (`turn/start` and `turn/steer`); the Codex MCP configuration is neither
used nor installed.

## Install

Prerequisites:

- Claude Code and/or Codex CLI already installed and logged in;
- [Bun](https://bun.sh/) when building from a Git checkout; and
- two different BotFather tokens for every computer, one for Claude and one for
  Codex.

The recommended bot username format is:

```text
hyunsoogo_<computer>_claude_bot
hyunsoogo_<computer>_codex_bot
```

For example, the `hp`, `mac`, and `erp` computers use six independent bots:

```text
hyunsoogo_hp_claude_bot       hyunsoogo_hp_codex_bot
hyunsoogo_mac_claude_bot      hyunsoogo_mac_codex_bot
hyunsoogo_erp_claude_bot      hyunsoogo_erp_codex_bot
```

### Windows

```powershell
git clone https://github.com/hyunsoogo/telegram-agent-router.git
cd telegram-agent-router
bun install --frozen-lockfile
bun run build:windows
.\release\telegram-agent-router-windows-x64.exe install --client both
telegram-agent-router doctor --profile all
```

Open a new terminal after installation so the updated user `PATH` is active.

### macOS

```bash
git clone https://github.com/hyunsoogo/telegram-agent-router.git
cd telegram-agent-router
bun install --frozen-lockfile
bun run build:macos

# Apple Silicon (M1/M2/M3/M4)
./release/telegram-agent-router-macos-arm64 install --client both

# Intel Mac: use this instead
# ./release/telegram-agent-router-macos-x64 install --client both

exec zsh -l
telegram-agent-router doctor --profile all
```

The macOS installer writes per-user LaunchAgents and loads them immediately.
No `sudo` is required.

### Linux and headless servers

```bash
git clone https://github.com/hyunsoogo/telegram-agent-router.git
cd telegram-agent-router
bun install --frozen-lockfile
bun run build:linux

# x86-64
./release/telegram-agent-router-linux-x64 install --client both

# ARM64 server: use this instead
# ./release/telegram-agent-router-linux-arm64 install --client both

exec "$SHELL" -l
telegram-agent-router doctor --profile all
```

Each installer asks for the Claude and Codex tokens separately with masked
terminal input. Enter the matching computer's two tokens. For unattended
installation, set `TELEGRAM_BOT_TOKEN_CLAUDE` and
`TELEGRAM_BOT_TOKEN_CODEX` only for the duration of the install command.

This command:

1. creates isolated `claude` and `codex` profile state;
2. registers one dynamic, user-scoped Claude MCP server;
3. installs `claude` and `codex` launch wrappers, recording both real binaries;
   the Claude wrapper automatically enables the `server:telegram-router`
   development channel;
4. registers and starts both router services; and
5. enables restart after reboot/login.

Claude Code currently classifies custom channels as a research-preview feature.
The wrapper supplies the required
`--dangerously-load-development-channels server:telegram-router` option, but
Claude Code itself asks you to confirm local-development use once whenever a
new interactive Claude session starts. Codex sessions do not require a similar
confirmation. Explicit `--channels` or
`--dangerously-load-development-channels` arguments are left unchanged.

Use `--no-autostart` only when service registration is not wanted. Use
`--dry-run --binary <compiled-router-path>` to inspect every generated action.

Tokens can also be configured separately:

```text
telegram-agent-router configure --profile claude
telegram-agent-router configure --profile codex
telegram-agent-router install --client both
```

Token values are stored only in the selected daemon profile and are never
passed to Claude or Codex sessions.

### Updating an existing installation

Pull and rebuild for the current platform, then run the same compiled
`install --client both` command again. Existing tokens, pairings, grants, and
route history are preserved; the versioned executable, wrappers, MCP
registration, and automatic-start entries are replaced.

The installer resolves `claude` and `codex` symlinks to their real executables
before replacing the links with managed wrappers. It refuses to overwrite an
unrecognized regular file at either wrapper path.

On Windows the wrappers are `.cmd` files, and `PATHEXT` ranks a native
`claude.exe` or `codex.exe` in the same `~/.local/bin` directory above them, so
a `.cmd` wrapper next to a native executable would never run. The installer
therefore also writes each wrapper to `~/.telegram-agent-router/shims` and puts
that directory first on the user `PATH`, which wins regardless of `PATHEXT` —
including when a native executable appears later (for example a native Claude
Code install after the router). `doctor` verifies that typing `claude` or
`codex` actually reaches a managed wrapper and reports the shadowing path when
it does not. Shell aliases and profile functions still take precedence over
`PATH`; remove any that point at the native executable directly.

## Automatic start

- Windows: per-user `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  entries at logon. Each entry launches its daemon through a hidden PowerShell
  process, so no terminal window remains open. Starting Claude/Codex also
  self-heals a stopped daemon.
- macOS: per-user LaunchAgents, loaded immediately.
- Linux: enabled `systemd --user` services.
- Headless Linux server: the installer checks and enables user linger. If the
  host requires administrator authorization it prints the exact
  `sudo loginctl enable-linger <user>` follow-up.

Profiles are independent. A revoked Claude token or failed Claude service does
not stop the Codex bot, and vice versa.

The two profile daemons are the automatic-start entries. Claude's MCP bridge is
not a separate persistent service; Claude starts one bridge for each interactive
session. The Codex profile daemon starts and supervises the shared Codex App
Server, while individual Codex clients connect only when launched.

## Pairing and use

The first Telegram message returns a one-hour pairing code. Approve it on the
same computer and profile shown in the bot response:

```text
telegram-agent-router access pair ABC123 --profile codex
```

Then:

```text
/sessions
/use 1
/status
```

If only one permitted session is online, it is selected automatically.
Replying to an agent answer selects the session that sent it before delivering
the new message. Answer-to-session mappings contain no message text and expire
after 30 days. This makes it possible to jump between sessions by replying to
their earlier answers without running `/use` each time.

`/sessions` uses this shape:

```text
1. Claude · a1b2c3d4 · KIP-AI · main · Reviewing router changes [active]
2. Claude · e5f6a7b8 · KIP-AI · main · started 09:24 [active]
```

The eight-character value is a unique selector, not a task name. Choose either
`/use 1` or `/use a1b2c3d4`. Claude updates the short task text through the
router MCP tool; Codex uses its thread name and preview. Until a task summary is
available, the session start time is shown.

Successful delivery is audited only after the Claude channel or Codex App
Server accepts the input. Disconnects and timeouts return an explicit Telegram
error instead of silently dropping the message.

## Session lifecycle

Claude session IDs are generated dynamically from the computer, workspace, and
Claude parent process, so multiple terminals in the same repository remain
separately selectable.

The installed Codex wrapper preserves the working directory and arguments,
ensures the Codex router is healthy, and runs the real CLI through a
single-use, loopback-only router proxy to the managed App Server:

```text
codex --remote ws://127.0.0.1:<profile-port> ...
```

Only root threads attached to a currently connected Codex CLI proxy become
Telegram sessions. Closing the CLI removes its thread from `/sessions`
immediately; persisted or merely loaded App Server threads are not listed.
Final assistant answers are sent back to the Telegram chat that supplied the
turn. Privileged approval and structured-input prompts are not auto-approved;
use the attached terminal for those interactions.

The managed App Server process does not inherit the router's standard output or
standard output, so conversation and tool output is not mirrored into an
automatic-start console. Its standard error is retained only as a bounded,
redacted tail for crash diagnostics. A router started manually in the foreground
may still write operational errors and session metadata to its own standard
error stream.

## Diagnostics

```text
telegram-agent-router doctor --profile all
telegram-agent-router doctor --profile claude
telegram-agent-router doctor --profile codex
```

Crash and lifecycle events are written as JSON Lines:

```text
~/.telegram-agent-router/codex/diagnostics.jsonl
~/.telegram-agent-router/codex/daemon-state.json
```

On PowerShell, inspect the latest events with:

```powershell
Get-Content "$HOME/.telegram-agent-router/codex/diagnostics.jsonl" -Tail 50
```

The log records graceful shutdown signals, router startup failures, App Server
PID/exit code/signal/uptime, reconnect attempts, and up to the last 64 KiB of
App Server standard error. A heartbeat state file lets the next launch report
`unclean_shutdown_detected` after a process kill, machine restart, or similar
termination where no shutdown hook ran. Credentials and Telegram channel bodies
are redacted. Logs rotate at 5 MiB with one backup file.

State:

```text
~/.telegram-agent-router/claude/
~/.telegram-agent-router/codex/
```

Local control ports bind to `127.0.0.1` only. See
[`docs/install.md`](docs/install.md) for standalone setup,
[`docs/architecture.md`](docs/architecture.md) for the compact component model,
[`docs/architecture-v2.md`](docs/architecture-v2.md) for lifecycle and failure
handling, and [`docs/security.md`](docs/security.md) for trust boundaries.

## Development

```text
bun install
bun test
bun x tsc --noEmit
bun run check
```

The live Codex multi-client smoke test is opt-in:

```powershell
$env:ROUTER_CODEX_INTEGRATION='1'
bun test test\codex-app-server.integration.test.ts
```

Release builds:

```text
bun run build:windows
bun run build:linux
bun run build:macos
bun run build:all
```
