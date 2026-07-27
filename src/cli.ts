import { Bot } from 'grammy'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runMcpBridge, type BridgeOptions } from './bridge.js'
import { launchClaude } from './claude-launcher.js'
import { launchCodex } from './codex-launcher.js'
import {
  asProfile,
  configureState,
  loadBotToken,
  loadConfig,
  statePaths,
  type RouterProfile,
} from './paths.js'
import { runDaemon } from './router.js'
import {
  installClients,
  resolveClaudeBinaryPath,
  resolveCodexBinaryPath,
  type InstallTarget,
} from './installer.js'
import { RouterStore } from './store.js'
import { readSecret } from './secret-prompt.js'
import { VERSION } from './version.js'

export { VERSION }

export const HELP = `telegram-agent-router ${VERSION}

Telegram routing for multiple Claude Code and Codex CLI sessions.

Usage:
  telegram-agent-router configure --profile <claude|codex> --token <token> [--port <port>]
  telegram-agent-router install [--client <claude|codex|both>] [--claude-binary <path>] [--codex-binary <path>] [--no-autostart] [--dry-run]
  telegram-agent-router daemon --profile <claude|codex>
  telegram-agent-router mcp --profile claude
  telegram-agent-router launch claude -- [claude arguments]
  telegram-agent-router launch codex -- [codex arguments]
  telegram-agent-router access pair <code> --profile <claude|codex> [--session <id|*>]
  telegram-agent-router access allow <user-id> --profile <claude|codex> [--session <id|*>]
  telegram-agent-router access grant <user-id> <session-id> --profile <claude|codex>
  telegram-agent-router access list --profile <claude|codex>
  telegram-agent-router doctor [--profile <claude|codex|all>]

Install securely prompts for missing Claude and Codex tokens.
Automatic start is installed by default on Windows, macOS, and Linux.
`

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function asPort(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ${name}: ${value}`)
  return port
}

function selectedProfile(args: string[], fallback: RouterProfile = 'codex'): RouterProfile {
  return asProfile(option(args, '--profile'), fallback)
}

async function accessCommand(args: string[]): Promise<void> {
  const profile = selectedProfile(args)
  const paths = statePaths(profile)
  if (!existsSync(paths.config)) throw new Error(`${profile} router is not configured`)
  const store = new RouterStore(paths.database, profile)
  try {
    const subcommand = args[0]
    if (subcommand === 'pair') {
      const code = args[1]
      if (!code) throw new Error('pairing code required')
      const pairing = store.approvePairing(code, option(args, '--session') ?? '*')
      const bot = new Bot(loadBotToken(paths))
      await bot.api.sendMessage(pairing.chatId, 'Pairing approved. Use /sessions to choose a coding session.')
      process.stdout.write(`Approved Telegram user ${pairing.userId} for ${profile}.\n`)
      return
    }
    if (subcommand === 'allow') {
      const userId = args[1]
      if (!userId) throw new Error('Telegram user ID required')
      store.allowUser(userId, null, option(args, '--session') ?? '*')
      process.stdout.write(`Allowed Telegram user ${userId} for ${profile}.\n`)
      return
    }
    if (subcommand === 'grant') {
      const userId = args[1]
      const sessionId = args[2]
      if (!userId || !sessionId) throw new Error('usage: access grant <user-id> <session-id>')
      store.grantSession(userId, sessionId)
      process.stdout.write(`Granted ${userId} access to ${sessionId} on ${profile}.\n`)
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

async function doctorProfile(profile: RouterProfile): Promise<Array<[string, boolean, string]>> {
  const paths = statePaths(profile)
  const checks: Array<[string, boolean, string]> = []
  let config
  try {
    config = loadConfig(paths)
    checks.push([`${profile} config`, true, paths.config])
  } catch (error) {
    checks.push([`${profile} config`, false, String(error)])
  }
  try {
    loadBotToken(paths)
    checks.push([`${profile} Telegram token`, true, paths.env])
  } catch (error) {
    checks.push([`${profile} Telegram token`, false, String(error)])
  }
  try {
    const store = new RouterStore(paths.database, profile)
    store.close()
    checks.push([`${profile} sqlite`, true, paths.database])
  } catch (error) {
    checks.push([`${profile} sqlite`, false, String(error)])
  }
  if (config) {
    try {
      const health = new URL(`http://${config.host}:${config.port}/health`)
      health.searchParams.set('secret', config.secret)
      const response = await fetch(health, { signal: AbortSignal.timeout(1500) })
      if (!response.ok) {
        checks.push([`${profile} daemon`, false, `HTTP ${response.status}`])
      } else {
        const payload = await response.json() as { profile?: string; version?: string }
        const healthy = payload.profile === profile && payload.version === VERSION
        checks.push([
          `${profile} daemon`,
          healthy,
          healthy
            ? `${config.host}:${config.port} v${payload.version}`
            : `${payload.profile ?? 'unknown'} ${payload.version ?? 'legacy'} on ${config.host}:${config.port}`,
        ])
      }
    } catch (error) {
      checks.push([`${profile} daemon`, false, String(error)])
    }
  }
  if (profile === 'claude') checks.push(['Claude Code CLI', Boolean(config?.claudeBinary ?? Bun.which('claude')), config?.claudeBinary ?? Bun.which('claude') ?? 'not found'])
  if (profile === 'codex') checks.push(['Codex CLI', Boolean(config?.codexBinary ?? Bun.which('codex')), config?.codexBinary ?? Bun.which('codex') ?? 'not found'])
  return checks
}

async function doctor(args: string[]): Promise<void> {
  const value = option(args, '--profile') ?? 'all'
  const profiles: RouterProfile[] = value === 'all' ? ['claude', 'codex'] : [asProfile(value)]
  const checks = (await Promise.all(profiles.map(doctorProfile))).flat()
  for (const [name, ok, detail] of checks) process.stdout.write(`${ok ? 'OK' : 'FAIL'}  ${name}: ${detail}\n`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
}

function requireConfigured(profile: RouterProfile): void {
  const paths = statePaths(profile)
  if (!existsSync(paths.config) || !existsSync(paths.env)) {
    throw new Error(`${profile} is not configured; run configure --profile ${profile} --token <token>`)
  }
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
    const profile = selectedProfile(args)
    const environmentToken = process.env[`TELEGRAM_BOT_TOKEN_${profile.toUpperCase()}`]
    const token = option(args, '--token')
      ?? environmentToken
      ?? await readSecret(`${profile} Telegram bot token: `)
    const paths = configureState({
      profile,
      token,
      host: option(args, '--host'),
      port: asPort(option(args, '--port'), 'port'),
      appServerPort: asPort(option(args, '--app-server-port'), 'App Server port'),
      claudeBinary: option(args, '--claude-binary'),
      codexBinary: option(args, '--codex-binary'),
    })
    process.stdout.write(`Configured ${profile} router state in ${paths.home}.\n`)
    return
  }
  if (command === 'daemon') {
    await runDaemon(selectedProfile(args))
    return
  }
  if (command === 'mcp') {
    const options: BridgeOptions = {
      profile: selectedProfile(args, 'claude'),
      sessionId: option(args, '--session'),
      label: option(args, '--label'),
      workspace: resolve(option(args, '--workspace') ?? process.cwd()),
      summary: option(args, '--summary'),
    }
    await runMcpBridge(options)
    return
  }
  if (command === 'install') {
    const target = (option(args, '--client') ?? 'both') as InstallTarget
    if (!['claude', 'codex', 'both'].includes(target)) throw new Error('invalid install client; expected claude, codex, or both')
    const includesClaude = target === 'claude' || target === 'both'
    const includesCodex = target === 'codex' || target === 'both'
    let configuredClaudeBinary: string | undefined
    let configuredCodexBinary: string | undefined
    try { configuredClaudeBinary = loadConfig(statePaths('claude')).claudeBinary } catch {}
    try { configuredCodexBinary = loadConfig(statePaths('codex')).codexBinary } catch {}
    const claudeBinary = includesClaude
      ? resolveClaudeBinaryPath(option(args, '--claude-binary')
        ?? configuredClaudeBinary
        ?? Bun.which('claude')
        ?? undefined)
      : undefined
    const codexBinary = includesCodex
      ? resolveCodexBinaryPath(option(args, '--codex-binary')
        ?? configuredCodexBinary
        ?? Bun.which('codex')
        ?? undefined)
      : undefined
    const dryRun = args.includes('--dry-run')
    const claudeToken = option(args, '--claude-token') ?? process.env.TELEGRAM_BOT_TOKEN_CLAUDE
    const codexToken = option(args, '--codex-token') ?? process.env.TELEGRAM_BOT_TOKEN_CODEX
    if (includesClaude && (claudeToken || (!dryRun && !existsSync(statePaths('claude').env)))) {
      configureState({
        profile: 'claude',
        token: claudeToken ?? await readSecret('claude Telegram bot token: '),
        claudeBinary,
      })
    } else if (includesClaude && existsSync(statePaths('claude').config) && claudeBinary) {
      configureState({ profile: 'claude', claudeBinary })
    }
    if (includesCodex && (codexToken || (!dryRun && !existsSync(statePaths('codex').env)))) {
      configureState({
        profile: 'codex',
        token: codexToken ?? await readSecret('codex Telegram bot token: '),
        codexBinary,
      })
    } else if (includesCodex && existsSync(statePaths('codex').config) && codexBinary) {
      configureState({ profile: 'codex', codexBinary })
    }
    if (!dryRun) {
      if (includesClaude) requireConfigured('claude')
      if (includesCodex) requireConfigured('codex')
    }
    await installClients({
      target,
      binaryPath: option(args, '--binary'),
      claudeBinary,
      codexBinary,
      claudeScope: (option(args, '--scope') ?? 'user') as 'local' | 'user' | 'project',
      autostart: !args.includes('--no-autostart'),
    }, dryRun)
    return
  }
  if (command === 'launch' && (args[1] === 'claude' || args[1] === 'codex')) {
    const client = args[1]
    const paths = statePaths(client)
    const config = loadConfig(paths)
    const separator = args.indexOf('--')
    const clientArgs = separator >= 0 ? args.slice(separator + 1) : args.slice(2)
    if (client === 'claude') {
      if (!config.claudeBinary) throw new Error('real Claude binary is not configured; rerun install --client claude --claude-binary <path>')
      process.exitCode = await launchClaude(config.claudeBinary, clientArgs)
    } else {
      if (!config.codexBinary) throw new Error('real Codex binary is not configured; rerun install --client codex --codex-binary <path>')
      process.exitCode = await launchCodex(config.codexBinary, paths, config, clientArgs)
    }
    return
  }
  if (command === 'access') {
    await accessCommand(args.slice(1))
    return
  }
  if (command === 'doctor') {
    await doctor(args)
    return
  }
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
  process.exitCode = 2
}
