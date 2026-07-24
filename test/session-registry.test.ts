import { describe, expect, test } from 'bun:test'
import { SessionRegistry, type SessionSocket } from '../src/session-registry.js'
import type { SessionDescriptor } from '../src/protocol.js'

class FakeSocket implements SessionSocket {
  sent: string[] = []
  send(data: string) { this.sent.push(data) }
  close() {}
}

function session(id: string, client: 'claude' | 'codex' = 'codex'): SessionDescriptor {
  return { id, client, label: id, workspace: `/work/${id}`, startedAt: new Date(0).toISOString() }
}

describe('SessionRegistry', () => {
  test('a duplicate auxiliary process cannot steal the primary session', () => {
    const registry = new SessionRegistry<FakeSocket>()
    const primary = new FakeSocket()
    const reviewer = new FakeSocket()

    expect(registry.register(primary, session('project'))).toBe('primary')
    expect(registry.register(reviewer, session('project'))).toBe('standby')
    expect(registry.get('project')?.socket).toBe(primary)
    expect(registry.role(reviewer)).toBe('standby')
  })

  test('oldest standby is promoted when the primary disconnects', () => {
    const registry = new SessionRegistry<FakeSocket>()
    const primary = new FakeSocket()
    const firstStandby = new FakeSocket()
    const secondStandby = new FakeSocket()
    registry.register(primary, session('project'))
    registry.register(firstStandby, session('project', 'claude'))
    registry.register(secondStandby, session('project'))

    const result = registry.unregister(primary)
    expect(result.promoted?.socket).toBe(firstStandby)
    expect(registry.get('project')?.socket).toBe(firstStandby)
    expect(registry.role(secondStandby)).toBe('standby')
  })

  test('different session IDs remain independently routable', () => {
    const registry = new SessionRegistry<FakeSocket>()
    const codex = new FakeSocket()
    const claude = new FakeSocket()
    registry.register(codex, session('codex-project', 'codex'))
    registry.register(claude, session('claude-project', 'claude'))
    expect(registry.list().map(item => item.id)).toEqual(['claude-project', 'codex-project'])
  })
})
