import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterStore } from '../src/store.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-agent-router-'))
  dirs.push(dir)
  return new RouterStore(join(dir, 'router.db'))
}

describe('RouterStore', () => {
  test('pairing approval allowlists the user without storing message content', () => {
    const db = store()
    const pending = db.createOrReusePairing({ userId: '1001', chatId: '1001', username: 'alice' })
    expect(pending.code).toHaveLength(6)
    expect(db.isAllowed('1001')).toBe(false)

    const approved = db.approvePairing(pending.code)
    expect(approved.userId).toBe('1001')
    expect(db.isAllowed('1001')).toBe(true)
    expect(db.visibleSession('1001', 'any-session')).toBe(true)
    db.close()
  })

  test('explicit grants isolate users to permitted sessions', () => {
    const db = store()
    db.allowUser('2002', 'bob', 'project-a')
    expect(db.visibleSession('2002', 'project-a')).toBe(true)
    expect(db.visibleSession('2002', 'project-b')).toBe(false)
    expect(() => db.setRoute('2002', 'project-b')).toThrow('not granted')
    db.grantSession('2002', 'project-b')
    db.setRoute('2002', 'project-b')
    expect(db.getRoute('2002')).toBe('project-b')
    db.close()
  })

  test('repeated messages reuse the same pending pairing code', () => {
    const db = store()
    const first = db.createOrReusePairing({ userId: '3003', chatId: '3003' })
    const second = db.createOrReusePairing({ userId: '3003', chatId: '3003' })
    expect(second.code).toBe(first.code)
    db.close()
  })

  test('bot answers retain the session needed for reply-based routing', () => {
    const db = store()
    db.rememberBotMessage('4004', '91', 'session-a')
    expect(db.sessionForBotMessage('4004', '91')).toBe('session-a')
    expect(db.sessionForBotMessage('different-chat', '91')).toBeNull()

    db.rememberBotMessage('4004', '91', 'session-b')
    expect(db.sessionForBotMessage('4004', '91')).toBe('session-b')
    db.close()
  })
})
