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
3. installs the `codex` launch wrapper and records the real Codex binary;
4. registers and starts both router services; and
5. enables restart after reboot/login.

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

The installer resolves a `codex` symlink to its real executable before replacing
the link with the managed wrapper. It refuses to overwrite an unrecognized
regular file at the wrapper path.

## Automatic start

- Windows: per-user `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  entries at logon. Starting Claude/Codex also self-heals a stopped daemon.
- macOS: per-user LaunchAgents, loaded immediately.
- Linux: enabled `systemd --user` services.
- Headless Linux server: the installer checks and enables user linger. If the
  host requires administrator authorization it prints the exact
  `sudo loginctl enable-linger <user>` follow-up.

Profiles are independent. A revoked Claude token or failed Claude service does
not stop the Codex bot, and vice versa.

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
ensures the Codex router is healthy, and runs the real CLI against the managed
App Server:

```text
codex --remote ws://127.0.0.1:<profile-port> ...
```

Loaded App Server threads become Telegram sessions. Their final assistant
answer is sent back to the Telegram chat that supplied the turn. Privileged
approval and structured-input prompts are not auto-approved; use the attached
terminal for those interactions.

## Diagnostics

```text
telegram-agent-router doctor --profile all
telegram-agent-router doctor --profile claude
telegram-agent-router doctor --profile codex
```

State:

```text
~/.telegram-agent-router/claude/
~/.telegram-agent-router/codex/
```

Local control ports bind to `127.0.0.1` only. See
[`docs/architecture-v2.md`](docs/architecture-v2.md) for lifecycle, failure
handling, and security boundaries.

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
