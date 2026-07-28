import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { StatePaths } from './paths.js'

const MAX_LOG_BYTES = 5 * 1024 * 1024
export const MAX_STDERR_TAIL_BYTES = 64 * 1024
const HEARTBEAT_INTERVAL_MS = 5_000

type DiagnosticDetails = Record<string, unknown>

type DaemonState = {
  status: 'running' | 'stopped' | 'failed'
  profile: StatePaths['profile']
  pid: number
  version: string
  started_at: string
  last_heartbeat_at: string
  finished_at?: string
}

export function diagnosticLogPath(paths: StatePaths): string {
  return join(paths.home, 'diagnostics.jsonl')
}

export function daemonStatePath(paths: StatePaths): string {
  return join(paths.home, 'daemon-state.json')
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/(<channel\b[^>]*>)[\s\S]*?(<\/channel>)/gi, '$1[REDACTED]$2')
    .replace(/((?:secret|token|authorization|api[_-]?key)\s*[=:]\s*)[^\s&,;]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
}

function sanitize(value: unknown, key = ''): unknown {
  if (/secret|token|authorization|api[_-]?key/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactDiagnosticText(value)
  if (Array.isArray(value)) return value.map(item => sanitize(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey),
      ]),
    )
  }
  return value
}

function ensureDiagnosticsDir(paths: StatePaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
}

function rotateLog(path: string): void {
  if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return
  const previous = `${path}.1`
  try {
    if (existsSync(previous)) unlinkSync(previous)
    renameSync(path, previous)
  } catch {}
}

export function appendDiagnostic(
  paths: StatePaths,
  event: string,
  details: DiagnosticDetails = {},
): void {
  try {
    ensureDiagnosticsDir(paths)
    const path = diagnosticLogPath(paths)
    rotateLog(path)
    const record = sanitize({
      timestamp: new Date().toISOString(),
      event,
      profile: paths.profile,
      router_pid: process.pid,
      ...details,
    })
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(path, 0o600) } catch {}
  } catch {}
}

export function diagnosticError(error: unknown): DiagnosticDetails {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack.slice(-MAX_STDERR_TAIL_BYTES) } : {}),
    }
  }
  return { message: String(error) }
}

function readDaemonState(paths: StatePaths): DaemonState | undefined {
  try {
    return JSON.parse(readFileSync(daemonStatePath(paths), 'utf8')) as DaemonState
  } catch {
    return undefined
  }
}

function writeDaemonState(paths: StatePaths, state: DaemonState): void {
  ensureDiagnosticsDir(paths)
  const path = daemonStatePath(paths)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporary, path)
  } catch {
    try { if (existsSync(path)) unlinkSync(path) } catch {}
    renameSync(temporary, path)
  }
  try { chmodSync(path, 0o600) } catch {}
}

export class DaemonDiagnostics {
  private state: DaemonState | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly paths: StatePaths,
    private readonly version: string,
  ) {}

  start(details: DiagnosticDetails = {}): void {
    const previous = readDaemonState(this.paths)
    if (previous?.status === 'running') {
      appendDiagnostic(this.paths, 'unclean_shutdown_detected', {
        previous_pid: previous.pid,
        previous_version: previous.version,
        previous_started_at: previous.started_at,
        previous_last_heartbeat_at: previous.last_heartbeat_at,
      })
    }

    const timestamp = new Date().toISOString()
    this.state = {
      status: 'running',
      profile: this.paths.profile,
      pid: process.pid,
      version: this.version,
      started_at: timestamp,
      last_heartbeat_at: timestamp,
    }
    try { writeDaemonState(this.paths, this.state) } catch {}
    appendDiagnostic(this.paths, 'daemon_started', { version: this.version, ...details })
    this.heartbeat = setInterval(() => this.writeHeartbeat(), HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref?.()
  }

  log(event: string, details: DiagnosticDetails = {}): void {
    appendDiagnostic(this.paths, event, details)
  }

  finish(status: 'stopped' | 'failed', details: DiagnosticDetails = {}): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    const timestamp = new Date().toISOString()
    if (this.state) {
      this.state = {
        ...this.state,
        status,
        last_heartbeat_at: timestamp,
        finished_at: timestamp,
      }
      try { writeDaemonState(this.paths, this.state) } catch {}
    }
    appendDiagnostic(this.paths, status === 'failed' ? 'daemon_failed' : 'daemon_stopped', details)
  }

  private writeHeartbeat(): void {
    if (!this.state || this.state.status !== 'running') return
    this.state = { ...this.state, last_heartbeat_at: new Date().toISOString() }
    try { writeDaemonState(this.paths, this.state) } catch {}
  }
}
