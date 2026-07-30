import { describe, expect, test } from 'bun:test'
import {
  CodexClientObserver,
  persistentCodexClientMessage,
  type CodexThread,
} from '../src/codex-client-observer.js'

function thread(id: string, parentThreadId?: string): CodexThread {
  return {
    id,
    preview: `thread ${id}`,
    cwd: '/work/project',
    createdAt: 1,
    ...(parentThreadId ? { parentThreadId } : {}),
    status: { type: 'idle' },
  }
}

describe('Codex client observer', () => {
  test('makes client-created threads persistent without changing their identity or settings', () => {
    const forwarded = persistentCodexClientMessage(JSON.stringify({
      id: 'start-1',
      method: 'thread/start',
      params: {
        cwd: '/work/project',
        ephemeral: true,
        sandbox: 'workspace-write',
      },
    }))

    expect(JSON.parse(forwarded)).toEqual({
      id: 'start-1',
      method: 'thread/start',
      params: {
        cwd: '/work/project',
        ephemeral: false,
        sandbox: 'workspace-write',
      },
    })
  })

  test('adds persistence when the client omits the ephemeral setting', () => {
    const forwarded = persistentCodexClientMessage(JSON.stringify({
      id: 1,
      method: 'thread/start',
      params: { cwd: '/work/project' },
    }))

    expect(JSON.parse(forwarded).params.ephemeral).toBe(false)
  })

  test('does not rewrite unrelated or malformed client messages', () => {
    const unrelated = ' { "id": 1, "method": "thread/resume", "params": { "threadId": "saved" } } '
    expect(persistentCodexClientMessage(unrelated)).toBe(unrelated)
    expect(persistentCodexClientMessage('not json')).toBe('not json')
    expect(persistentCodexClientMessage('null')).toBe('null')
  })

  test('tracks only thread lifecycle responses initiated by that client', () => {
    const observer = new CodexClientObserver()
    observer.observeClientMessage(JSON.stringify({ id: 1, method: 'thread/read', params: { threadId: 'history' } }))
    observer.observeClientMessage(JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: '/work/project' } }))

    expect(observer.observeServerMessage(JSON.stringify({
      id: 1,
      result: { thread: thread('history') },
    }))).toBeUndefined()
    expect(observer.observeServerMessage(JSON.stringify({
      id: 2,
      result: { thread: thread('live') },
    }))).toEqual(thread('live'))
  })

  test('recognizes resumed root threads and ignores spawned child threads', () => {
    const observer = new CodexClientObserver()
    observer.observeClientMessage(JSON.stringify({ id: 1, method: 'thread/resume' }))

    expect(observer.observeServerMessage(JSON.stringify({
      method: 'thread/started',
      params: { thread: thread('child', 'parent') },
    }))).toBeUndefined()
    expect(observer.observeServerMessage(JSON.stringify({
      method: 'thread/started',
      params: { thread: thread('root') },
    }))).toEqual(thread('root'))
  })

  test('ignores thread notifications initiated by a different App Server client', () => {
    const observer = new CodexClientObserver()
    expect(observer.observeServerMessage(JSON.stringify({
      method: 'thread/started',
      params: { thread: thread('other-client') },
    }))).toBeUndefined()
  })

  test('does not retain failed or malformed requests', () => {
    const observer = new CodexClientObserver()
    observer.observeClientMessage('not json')
    observer.observeClientMessage(JSON.stringify({ id: 'resume', method: 'thread/resume' }))

    expect(observer.observeServerMessage(JSON.stringify({
      id: 'resume',
      error: { message: 'missing thread' },
    }))).toBeUndefined()
    expect(observer.observeServerMessage(JSON.stringify({
      id: 'resume',
      result: { thread: thread('late') },
    }))).toBeUndefined()
  })
})
