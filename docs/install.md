# Installation

## Runtime requirement

Only the platform executable is required. Do not install Node.js, Bun, npm packages, grammY, SQLite, or the MCP SDK on the target machine.

## 1. Install both profiles

Run the platform executable. The installer securely prompts for separate Claude
and Codex BotFather tokens, creates isolated profile state, installs launch
wrappers, registers the Claude MCP bridge, and enables automatic start.

```bash
./telegram-agent-router install --client both
```

Windows PowerShell:

```powershell
.\telegram-agent-router-windows-x64.exe install --client both
```

For unattended installation, set `TELEGRAM_BOT_TOKEN_CLAUDE` and
`TELEGRAM_BOT_TOKEN_CODEX` only for the install command. To inspect generated
actions without changing the machine, add `--dry-run`.

State is isolated by profile:

```text
~/.telegram-agent-router/
├── claude/
│   ├── .env
│   ├── config.json
│   ├── router.sqlite
│   └── daemon.pid
└── codex/
    ├── .env
    ├── config.json
    ├── router.sqlite
    └── daemon.pid
```

Override the root directory with `TELEGRAM_AGENT_ROUTER_HOME`.

## 2. Client transport and automatic start

Claude and Codex intentionally use different transports:

- Claude registers one dynamic user-scoped MCP bridge. Each interactive Claude
  process gets its own routable session.
- Codex does not use MCP. Its managed wrapper preserves the working directory
  and connects the real CLI through a single-use loopback-port proxy to the
  supervised Codex App Server WebSocket.

Automatic start is enabled by default:

- Windows: per-user Run entries launch hidden PowerShell processes at logon;
- macOS: per-user LaunchAgents are loaded immediately; and
- Linux: `systemd --user` services are enabled, with linger configured for
  headless hosts when permitted.

Use `--no-autostart` only when service registration is not wanted. A second
daemon for the same profile fails without terminating the live owner.

The two profile daemons are the automatic-start processes. Claude's MCP bridge
starts only when an interactive Claude session opens. The Codex profile daemon
starts and supervises the shared App Server; Codex CLI clients attach when
launched.

### Codex CLI updates

The managed wrapper lets Codex administrative commands, including
`codex update`, run directly. No router reinstall is needed afterward. The next
interactive launch:

1. resolves the recorded real Codex executable, falling back to an unmanaged
   `codex` on `PATH` if that path no longer exists. Standalone installs prefer
   `standalone/current/bin/codex` (`codex.exe` on Windows), and versioned
   `releases/<version>` settings migrate to that stable path automatically;
2. reports the stable configured path plus size and modification time. The
   router validates the junction target without replacing `current` with its
   versioned real path;
3. keeps the current App Server while any routed client or delivery is active;
4. otherwise initializes a candidate App Server on a separate loopback port
   before switching and persisting the new binary and port.

If candidate initialization fails, the existing App Server remains running. If
an older routed session blocks the switch, the new command runs as ordinary
Codex without Telegram routing and tells the user to close the older sessions
and launch it again.

Tokens may also be configured separately before installation:

```text
telegram-agent-router configure --profile claude
telegram-agent-router configure --profile codex
telegram-agent-router install --client both
```

## 3. Pair Telegram

DM either bot. It returns a six-character code. Approve it against the matching
profile from the local terminal:

```bash
./telegram-agent-router access pair ABC123 --profile codex
```

Pairing grants profile access by default. Optional session-specific grants are
available during manual allowlisting:

```bash
./telegram-agent-router access allow 123456789 --profile claude
./telegram-agent-router access grant 123456789 <session-id> --profile claude
```

## 4. Diagnose

```bash
./telegram-agent-router doctor --profile all
```

The command checks profile configuration, token presence, SQLite, installed
Claude/Codex CLIs, and the authenticated loopback health endpoints. For Codex,
it also detects when the installed binary identity differs from the build used
by the running App Server. The Codex App Server child does not inherit daemon
stdout or stderr, so conversation and tool output is not mirrored into an
automatic-start console.
