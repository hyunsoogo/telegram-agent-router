import { Bot } from 'grammy'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runMcpBridge, type BridgeOptions } from './bridge.js'
import { configureState, loadBotToken, loadConfig, statePaths } from './paths.js'
import { runDaemon } from './router.js'
import { installClients, type InstallTarget } from './installer.js'
import { RouterStore } from './store.js'
import type { ClientKind } from './protocol.js'

export const VERSION = '0.1.0'

export const HELP = `telegram-agent-router ${VERSION}

Standalone Telegram router and MCP bridge for Claude Code and Codex CLI.

Usage:
  telegram-agent-router configure [--token <token>] [--port <port>]
  telegram-agent-router daemon
  telegram-agent-router mcp --client <codex|claude> --session <id> [--label <label>]
  telegram-agent-router install --client <codex|claude|both> --session <id> [--dry-run]
  telegram-agent-router access pair <code> [--session <id|*>]
  telegram-agent-router access allow <user-id> [--session <id|*>]
  telegram-agent-router access grant <user-id> <session-id>
  telegram-agent-router access list
  telegram-agent-router doctor
`

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requireOption(args: string[], name: string): string {
  const value = option(args, name)
  if (!value) throw new Error(`missing required option ${name}`)
  return value
}

function asClient(value: string): ClientKind {
  if (value === 'claude' || value === 'codex' || value === 'other') return value
  throw new Error(`invalid client '${value}'; expected claude, codex, or other`)
}

async function accessCommand(args: string[]): Promise<void> {
  const paths = statePaths()
  if (!existsSync(paths.config)) throw new Error('router is not configured')
  const store = new RouterStore(paths.database)
  try {
    const subcommand = args[0]
    if (subcommand === 'pair') {
      const code = args[1]
      if (!code) throw new Error('pairing code required')
      const pairing = store.approvePairing(code, option(args, '--session') ?? '*')
      const bot = new Bot(loadBotToken(paths))
      await bot.api.sendMessage(pairing.chatId, 'Pairing approved. Use /sessions to choose a coding session.')
      process.stdout.write(`Approved Telegram user ${pairing.userId}.\n`)
      return
    }
    if (subcommand === 'allow') {
      const userId = args[1]
      if (!userId) throw new Error('Telegram user ID required')
      store.allowUser(userId, null, option(args, '--session') ?? '*')
      process.stdout.write(`Allowed Telegram user ${userId}.\n`)
      return
    }
    if (subcommand === 'grant') {
      const userId = args[1]
      const sessionId = args[2]
      if (!userId || !sessionId) throw new Error('usage: access grant <user-id> <session-id>')
      store.grantSession(userId, sessionId)
      process.stdout.write(`Granted ${userId} access to ${sessionId}.\n`)
      return
    }
    if (subcommand === 'list') {
      const users = store.listAllowedUsers()
      process.stdout.write(users.length
        ? `${users.map(user => `${user.userId}${user.username ? ` @${user.username}` : ''}`).join('\n')}\n`
        : 'No allowed users.\n')
      return
    }
    throw new Error('unknown access command')
  } finally {
    store.close()
  }
}

async function doctor(): Promise<void> {
  const paths = statePaths()
  const checks: Array<[string, boolean, string]> = []
  let config
  try {
    config = loadConfig(paths)
    checks.push(['config', true, paths.config])
  } catch (error) {
    checks.push(['config', false, String(error)])
  }
  try {
    loadBotToken(paths)
    checks.push(['telegram token', true, paths.env])
  } catch (error) {
    checks.push(['telegram token', false, String(error)])
  }
  try {
    const store = new RouterStore(paths.database)
    store.close()
    checks.push(['sqlite', true, paths.database])
  } catch (error) {
    checks.push(['sqlite', false, String(error)])
  }
  checks.push(['Claude Code CLI', Boolean(Bun.which('claude')), Bun.which('claude') ?? 'not found'])
  checks.push(['Codex CLI', Boolean(Bun.which('codex')), Bun.which('codex') ?? 'not found'])
  if (config) {
    try {
      const health = new URL(`http://${config.host}:${config.port}/health`)
      health.searchParams.set('secret', config.secret)
      const response = await fetch(health, { signal: AbortSignal.timeout(1500) })
      checks.push(['daemon', response.ok, response.ok ? `${config.host}:${config.port}` : `HTTP ${response.status}`])
    } catch (error) {
      checks.push(['daemon', false, String(error)])
    }
  }
  for (const [name, ok, detail] of checks) process.stdout.write(`${ok ? 'OK' : 'FAIL'}  ${name}: ${detail}\n`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0]
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return
  }
  if (command === '--version' || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (command === 'configure') {
    const portText = option(args, '--port')
    const paths = configureState({
      token: option(args, '--token'),
      host: option(args, '--host'),
      ...(portText ? { port: Number.parseInt(portText, 10) } : {}),
    })
    process.stdout.write(`Configured router state in ${paths.home}.\n`)
    return
  }
  if (command === 'daemon') {
    await runDaemon()
    return
  }
  if (command === 'mcp') {
    const sessionId = requireOption(args, '--session')
    const options: BridgeOptions = {
      client: asClient(requireOption(args, '--client')),
      sessionId,
      label: option(args, '--label') ?? sessionId,
      workspace: resolve(option(args, '--workspace') ?? process.cwd()),
    }
    await runMcpBridge(options)
    return
  }
  if (command === 'install') {
    const target = requireOption(args, '--client') as InstallTarget
    if (!['claude', 'codex', 'both'].includes(target)) throw new Error('invalid install client; expected claude, codex, or both')
    const sessionId = requireOption(args, '--session')
    await installClients({
      target,
      sessionId,
      label: option(args, '--label') ?? sessionId,
      workspace: resolve(option(args, '--workspace') ?? process.cwd()),
      binaryPath: option(args, '--binary'),
      claudeScope: (option(args, '--scope') ?? 'user') as 'local' | 'user' | 'project',
    }, args.includes('--dry-run'))
    return
  }
  if (command === 'access') {
    await accessCommand(args.slice(1))
    return
  }
  if (command === 'doctor') {
    await doctor()
    return
  }
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
  process.exitCode = 2
}
