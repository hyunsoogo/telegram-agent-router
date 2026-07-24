import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDaemonLock } from '../src/lock.js'

describe('daemon ownership lock', () => {
  test('a second daemon cannot replace a live owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-router-lock-'))
    const pid = join(dir, 'daemon.pid')
    const release = acquireDaemonLock(pid)
    try {
      expect(() => acquireDaemonLock(pid)).toThrow(`router daemon already running with pid ${process.pid}`)
    } finally {
      release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
