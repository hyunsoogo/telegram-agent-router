import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export type RouterConfig = {
  profile: RouterProfile
  host: string
  port: number
  secret: string
  appServerPort?: number
  claudeBinary?: string
  codexBinary?: string
}

export type RouterProfile = 'claude' | 'codex'

export type StatePaths = {
  profile: RouterProfile
  root: string
  home: string
  config: string
  env: string
  database: string
  pid: string
}

export const DEFAULT_PORTS: Record<RouterProfile, number> = {
  claude: 47321,
  codex: 47322,
}

export function asProfile(value: string | undefined, fallback: RouterProfile = 'codex'): RouterProfile {
  const profile = value ?? fallback
  if (profile === 'claude' || profile === 'codex') return profile
  throw new Error(`invalid profile '${profile}'; expected claude or codex`)
}

export function statePaths(profile: RouterProfile = 'codex'): StatePaths {
  const root = resolve(process.env.TELEGRAM_AGENT_ROUTER_HOME ?? join(homedir(), '.telegram-agent-router'))
  const home = join(root, profile)
  return {
    profile,
    root,
    home,
    config: join(home, 'config.json'),
    env: join(home, '.env'),
    database: join(home, 'router.sqlite'),
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
  return {
    profile: parsed.profile ?? paths.profile,
    host: parsed.host,
    port: parsed.port!,
    secret: parsed.secret,
    ...(Number.isInteger(parsed.appServerPort) ? { appServerPort: parsed.appServerPort } : {}),
    ...(parsed.claudeBinary ? { claudeBinary: parsed.claudeBinary } : {}),
    ...(parsed.codexBinary ? { codexBinary: parsed.codexBinary } : {}),
  }
}

export function loadBotToken(paths = statePaths()): string {
  const profileToken = process.env[`TELEGRAM_BOT_TOKEN_${paths.profile.toUpperCase()}`]
  if (profileToken) return profileToken
  if (!existsSync(paths.env)) throw new Error(`Telegram token missing. Run configure first.`)
  for (const line of readFileSync(paths.env, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/)
    if (match?.[1]) return match[1].trim()
  }
  throw new Error(`TELEGRAM_BOT_TOKEN missing in ${paths.env}`)
}

export function configureState(options: {
  profile?: RouterProfile
  token?: string
  host?: string
  port?: number
  appServerPort?: number
  claudeBinary?: string
  codexBinary?: string
}): StatePaths {
  const paths = ensureStateDir(statePaths(options.profile))
  const existing = existsSync(paths.config)
    ? (JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<RouterConfig>)
    : {}
  const config: RouterConfig = {
    profile: paths.profile,
    host: options.host ?? existing.host ?? '127.0.0.1',
    port: options.port ?? existing.port ?? DEFAULT_PORTS[paths.profile],
    secret: existing.secret ?? randomBytes(32).toString('base64url'),
    ...(paths.profile === 'claude' && (options.claudeBinary ?? existing.claudeBinary)
      ? { claudeBinary: resolve(options.claudeBinary ?? existing.claudeBinary!) }
      : {}),
    ...(paths.profile === 'codex'
      ? {
          appServerPort: options.appServerPort ?? existing.appServerPort ?? 47323,
          ...(options.codexBinary ?? existing.codexBinary
            ? { codexBinary: resolve(options.codexBinary ?? existing.codexBinary!) }
            : {}),
        }
      : {}),
  }
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(paths.config, 0o600) } catch {}

  const token = options.token
    ?? process.env[`TELEGRAM_BOT_TOKEN_${paths.profile.toUpperCase()}`]
    ?? process.env.TELEGRAM_BOT_TOKEN
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
