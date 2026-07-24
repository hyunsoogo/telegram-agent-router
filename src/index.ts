#!/usr/bin/env bun

const VERSION = '0.1.0'

const help = `telegram-agent-router ${VERSION}

Standalone Telegram router and MCP bridge for Claude Code and Codex CLI.

Usage:
  telegram-agent-router configure
  telegram-agent-router daemon
  telegram-agent-router mcp --client <codex|claude> --session <id>
  telegram-agent-router access <command>
  telegram-agent-router doctor
`

const command = process.argv[2]
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(help)
} else if (command === '--version' || command === 'version') {
  process.stdout.write(`${VERSION}\n`)
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${help}`)
  process.exitCode = 2
}
