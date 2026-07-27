import { describe, expect, test } from 'bun:test'
import { CodexClientObserver, type CodexThread } from '../src/codex-client-observer.js'

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
