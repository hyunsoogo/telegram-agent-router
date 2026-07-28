import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DaemonDiagnostics,
  appendDiagnostic,
  daemonStatePath,
  diagnosticLogPath,
  redactDiagnosticText,
} from '../src/diagnostics.js'
import type { StatePaths } from '../src/paths.js'

function temporaryPaths(): { root: string; paths: StatePaths } {
  const root = mkdtempSync(join(tmpdir(), 'telegram-router-diagnostics-'))
  const home = join(root, 'codex')
  mkdirSync(home)
  return {
    root,
    paths: {
      profile: 'codex',
      root,
      home,
      config: join(home, 'config.json'),
      env: join(home, '.env'),
      database: join(home, 'router.sqlite'),
      pid: join(home, 'daemon.pid'),
    },
  }
}

describe('router diagnostics', () => {
  test('writes structured JSONL and redacts secrets and channel bodies', () => {
    const { root, paths } = temporaryPaths()
    try {
      appendDiagnostic(paths, 'test_event', {
        secret: 'do-not-log',
        detail: 'authorization=abc Bearer xyz <channel source="telegram">private text</channel>',
      })
      const record = JSON.parse(readFileSync(diagnosticLogPath(paths), 'utf8')) as Record<string, unknown>
      expect(record.event).toBe('test_event')
      expect(record.secret).toBe('[REDACTED]')
      expect(String(record.detail)).not.toContain('abc')
      expect(String(record.detail)).not.toContain('xyz')
      expect(String(record.detail)).not.toContain('private text')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('detects a daemon that stopped without clearing its running marker', () => {
    const { root, paths } = temporaryPaths()
    try {
      writeFileSync(daemonStatePath(paths), JSON.stringify({
        status: 'running',
        profile: 'codex',
        pid: 1234,
        version: '0.2.9',
        started_at: '2026-07-28T01:00:00.000Z',
        last_heartbeat_at: '2026-07-28T01:00:05.000Z',
      }))
      const diagnostics = new DaemonDiagnostics(paths, '0.2.10')
      diagnostics.start({ port: 47322 })
      diagnostics.finish('stopped', { reason: 'test' })

      const events = readFileSync(diagnosticLogPath(paths), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { event: string })
      expect(events.map(event => event.event)).toEqual([
        'unclean_shutdown_detected',
        'daemon_started',
        'daemon_stopped',
      ])
      expect(JSON.parse(readFileSync(daemonStatePath(paths), 'utf8')).status).toBe('stopped')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('redacts common credential formats without erasing useful errors', () => {
    const value = redactDiagnosticText('panic at worker.ts:10 secret=abc token:xyz')
    expect(value).toContain('panic at worker.ts:10')
    expect(value).not.toContain('abc')
    expect(value).not.toContain('xyz')
  })
})
