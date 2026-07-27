import { describe, expect, test } from 'bun:test'
import { createClaudeSession } from '../src/session-identity.js'

describe('dynamic Claude session identity', () => {
  test('two Claude parents in one workspace remain independently routable', () => {
    const first = createClaudeSession({ workspace: '/work/project', parentPid: 101 })
    const second = createClaudeSession({ workspace: '/work/project', parentPid: 202 })
    expect(first.id).not.toBe(second.id)
    expect(first.workspace).toBe(second.workspace)
    expect(first.client).toBe('claude')
  })
})
