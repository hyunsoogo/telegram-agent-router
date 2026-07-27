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
    expect(parseBridgeMessage(JSON.stringify({
      type: 'inbound_result', deliveryId: 'd1', ok: true,
    })).type).toBe('inbound_result')
    expect(parseBridgeMessage(JSON.stringify({
      type: 'update_session', patch: { summary: 'Reviewing Q2 report' },
    })).type).toBe('update_session')
  })

  test('rejects malformed messages and unsafe session IDs', () => {
    expect(() => parseBridgeMessage('{"type":"register"}')).toThrow('invalid bridge message')
    expect(() => parseBridgeMessage('{"type":"unknown"}')).toThrow('invalid bridge message')
    expect(() => parseBridgeMessage(JSON.stringify({
      type: 'register',
      session: { id: '../bad', client: 'codex', label: 'bad', workspace: '/', startedAt: 'now' },
    }))).toThrow('invalid bridge message')
    expect(() => parseBridgeMessage(JSON.stringify({
      type: 'update_session', patch: { summary: 'x'.repeat(161) },
    }))).toThrow('invalid bridge message')
    expect(() => parseBridgeMessage(JSON.stringify({
      type: 'action', requestId: 'r1', action: { kind: 'reply', chat_id: '1' },
    }))).toThrow('invalid bridge message')
  })
})
