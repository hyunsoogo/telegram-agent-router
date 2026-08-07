import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveClientBinaryPath } from './client-binary.js'

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
  let codexBinary = parsed.codexBinary
  if (paths.profile === 'codex' && codexBinary) {
    let migrated: string | undefined
    try {
      migrated = resolveClientBinaryPath(codexBinary, 'codex')
    } catch {}
    if (migrated && migrated !== codexBinary) {
      persistConfigPatch({ codexBinary: migrated }, paths)
      codexBinary = migrated
    }
  }
  return {
    profile: parsed.profile ?? paths.profile,
    host: parsed.host,
    port: parsed.port!,
    secret: parsed.secret,
    ...(Number.isInteger(parsed.appServerPort) ? { appServerPort: parsed.appServerPort } : {}),
    ...(parsed.claudeBinary ? { claudeBinary: parsed.claudeBinary } : {}),
    ...(codexBinary ? { codexBinary } : {}),
  }
}

const CONFIG_LOCK_TIMEOUT_MS = 2_000
const CONFIG_LOCK_STALE_MS = 30_000
const CONFIG_LOCK_WAIT_MS = 10
const configLockWaiter = new Int32Array(new SharedArrayBuffer(4))

function withConfigLock<T>(paths: StatePaths, update: () => T): T {
  const lockPath = `${paths.config}.lock`
  const token = randomBytes(16).toString('hex')
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, token)
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch {}
        descriptor = undefined
        try { unlinkSync(lockPath) } catch {}
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > CONFIG_LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe
        continue
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting to update router config: ${paths.config}`)
      Atomics.wait(configLockWaiter, 0, 0, CONFIG_LOCK_WAIT_MS)
    }
  }
  try {
    return update()
  } finally {
    try { closeSync(descriptor) } catch {}
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath)
    } catch {}
  }
}

export function persistConfigPatch(
  patch: Partial<RouterConfig>,
  paths = statePaths(),
): void {
  withConfigLock(paths, () => {
    const existing = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<RouterConfig>
    const temporary = `${paths.config}.new-${process.pid}-${Date.now()}`
    writeFileSync(temporary, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, { mode: 0o600 })
    try { chmodSync(temporary, 0o600) } catch {}
    try {
      renameSync(temporary, paths.config)
    } catch (error) {
      try { unlinkSync(temporary) } catch {}
      throw error
    }
    try { chmodSync(paths.config, 0o600) } catch {}
  })
}

export function persistAppServerPort(port: number, paths = statePaths('codex')): void {
  persistConfigPatch({ appServerPort: port }, paths)
}

export function persistCodexBinary(codexBinary: string, paths = statePaths('codex')): void {
  persistConfigPatch({ codexBinary: resolve(codexBinary) }, paths)
}

export function persistCodexRuntime(
  codexBinary: string,
  appServerPort: number,
  paths = statePaths('codex'),
): void {
  persistConfigPatch({
    codexBinary: resolve(codexBinary),
    appServerPort,
  }, paths)
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
