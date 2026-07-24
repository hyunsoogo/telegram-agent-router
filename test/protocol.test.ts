import { describe, expect, test } from 'bun:test'
import { parseBridgeMessage } from '../src/protocol.js'

describe('bridge protocol validation', () => {
  test('accepts registration and action envelopes', () => {
    expect(parseBridgeMessage(JSON.stringify({
      type: 'register',
      session: { id: 'project', label: 'Project', client: 'codex', workspace: '/tmp', startedAt: 'now' },
    })).type).toBe('register')
    expect(parseBridgeMessage(JSON.stringify({
      type: 'action', requestId: 'r1', action: { kind: 'reply', chat_id: '1', text: 'ok' },
    })).type).toBe('action')
  })

  test('rejects malformed messages', () => {
    expect(() => parseBridgeMessage('{"type":"register"}')).toThrow('invalid bridge message')
    expect(() => parseBridgeMessage('{"type":"unknown"}')).toThrow('invalid bridge message')
  })
})
