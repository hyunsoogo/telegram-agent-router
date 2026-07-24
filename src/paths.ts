import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export type RouterConfig = {
  host: string
  port: number
  secret: string
}

export type StatePaths = {
  home: string
  config: string
  env: string
  database: string
  pid: string
}

export function statePaths(): StatePaths {
  const home = resolve(process.env.TELEGRAM_AGENT_ROUTER_HOME ?? join(homedir(), '.telegram-agent-router'))
  return {
    home,
    config: join(home, 'config.json'),
    env: join(home, '.env'),
    database: join(home, 'router.db'),
    pid: join(home, 'daemon.pid'),
  }
}

export function ensureStateDir(paths = statePaths()): StatePaths {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  return paths
}

export function loadConfig(paths = statePaths()): RouterConfig {
  const parsed = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<RouterConfig>
  if (!parsed.secret || !parsed.host || !Number.isInteger(parsed.port)) {
    throw new Error(`invalid router config: ${paths.config}`)
  }
  return parsed as RouterConfig
}

export function loadBotToken(paths = statePaths()): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  if (!existsSync(paths.env)) throw new Error(`Telegram token missing. Run configure first.`)
  for (const line of readFileSync(paths.env, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/)
    if (match?.[1]) return match[1].trim()
  }
  throw new Error(`TELEGRAM_BOT_TOKEN missing in ${paths.env}`)
}

export function configureState(options: { token?: string; host?: string; port?: number }): StatePaths {
  const paths = ensureStateDir()
  const existing = existsSync(paths.config)
    ? (JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<RouterConfig>)
    : {}
  const config: RouterConfig = {
    host: options.host ?? existing.host ?? '127.0.0.1',
    port: options.port ?? existing.port ?? 47321,
    secret: existing.secret ?? randomBytes(32).toString('base64url'),
  }
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(paths.config, 0o600) } catch {}

  const token = options.token ?? process.env.TELEGRAM_BOT_TOKEN
  if (token) {
    writeFileSync(paths.env, `TELEGRAM_BOT_TOKEN=${token.trim()}\n`, { mode: 0o600 })
    try { chmodSync(paths.env, 0o600) } catch {}
  } else if (!existsSync(paths.env)) {
    throw new Error('Telegram token missing. Pass --token or set TELEGRAM_BOT_TOKEN.')
  }
  return paths
}

export function bridgeUrl(config: RouterConfig): string {
  const url = new URL(`ws://${config.host}:${config.port}/bridge`)
  url.searchParams.set('secret', config.secret)
  return url.toString()
}
