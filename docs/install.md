# Installation

## Runtime requirement

Only the platform executable is required. Do not install Node.js, Bun, npm packages, grammY, SQLite, or the MCP SDK on the target machine.

## 1. Configure

Prefer an environment variable so the Telegram token does not appear in process listings or shell history.

```bash
TELEGRAM_BOT_TOKEN="..." ./telegram-agent-router configure
```

Windows PowerShell:

```powershell
$env:TELEGRAM_BOT_TOKEN = "..."
.\telegram-agent-router.exe configure
Remove-Item Env:TELEGRAM_BOT_TOKEN
```

State defaults to `~/.telegram-agent-router/`:

- `.env`: Telegram bot token
- `config.json`: loopback host, port, random bridge secret
- `router.db`: allowlist, session grants, selected routes, metadata-only audit events
- `daemon.pid`: single-daemon ownership

Override the directory with `TELEGRAM_AGENT_ROUTER_HOME`.

## 2. Start the daemon

```bash
./telegram-agent-router daemon
```

Only one daemon can own a state directory. A second daemon fails without terminating the first.

## 3. Register AI clients

Both clients:

```bash
./telegram-agent-router install --client both --session project-a --label "Project A"
```

Claude Code only:

```bash
./telegram-agent-router install --client claude --session project-a --scope user
```

Codex CLI only:

```bash
./telegram-agent-router install --client codex --session project-a
```

Inspect commands without changing client configuration:

```bash
./telegram-agent-router install --client both --session project-a --dry-run
```

The generated MCP command launches the same executable in `mcp` mode. No package manager command appears in client configuration.

## 4. Pair Telegram

DM the bot. It returns a six-character code. Approve from the local terminal:

```bash
./telegram-agent-router access pair ABC123
```

Pairing grants all sessions by default for single-user installations. Restrict a user during manual allowlisting:

```bash
./telegram-agent-router access allow 123456789 --session project-a
./telegram-agent-router access grant 123456789 project-b
```

## 5. Diagnose

```bash
./telegram-agent-router doctor
```

The command checks configuration, token presence, SQLite, installed Claude/Codex CLIs, and the authenticated loopback health endpoint.
