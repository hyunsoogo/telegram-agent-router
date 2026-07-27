import { expect, test } from 'bun:test'
import { CodexAppServer } from '../src/codex-app-server.js'

const integration = process.env.ROUTER_CODEX_INTEGRATION === '1' ? test : test.skip
const turnIntegration = process.env.ROUTER_CODEX_TURN_INTEGRATION === '1' ? test : test.skip

async function connectClient(url: string): Promise<{
  socket: WebSocket
  request(method: string, params: unknown): Promise<unknown>
}> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('test client connection failed')), { once: true })
  })
  let nextId = 1
  const pending = new Map<number, (result: unknown) => void>()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown }
    if (message.id !== undefined) pending.get(message.id)?.(message.result)
  })
  const request = (method: string, params: unknown): Promise<unknown> => new Promise(resolve => {
    const id = nextId++
    pending.set(id, result => {
      pending.delete(id)
      resolve(result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await request('initialize', {
    clientInfo: { name: 'router-integration-peer', version: '1.0.0' },
  })
  socket.send(JSON.stringify({ method: 'initialized' }))
  return { socket, request }
}

integration('connects to and initializes the installed Codex App Server', async () => {
  const binary = Bun.which('codex')
  expect(binary).toBeTruthy()
  const adapter = new CodexAppServer({
    profile: 'codex',
    host: '127.0.0.1',
    port: 47922,
    appServerPort: 47923,
    secret: 'integration-test',
    codexBinary: binary!,
  }, async () => {})
  let peer: Awaited<ReturnType<typeof connectClient>> | undefined
  let threadId: string | undefined
  try {
    await adapter.start()
    expect(adapter.list()).toBeArray()
    peer = await connectClient('ws://127.0.0.1:47923')
    const started = await peer.request('thread/start', {
      cwd: 'C:\\tmp',
      ephemeral: false,
    }) as { thread?: { id?: string } }
    threadId = started.thread?.id
    expect(threadId).toBeTruthy()
    for (let attempt = 0; attempt < 20 && !adapter.get(threadId!); attempt += 1) {
      await Bun.sleep(200)
    }
    expect(adapter.get(threadId!)).toMatchObject({
      client: 'codex',
      workspace: 'C:\\tmp',
    })
  } finally {
    if (peer && threadId) await peer.request('thread/delete', { threadId }).catch(() => {})
    peer?.socket.close()
    await adapter.stop()
  }
}, 30_000)

turnIntegration('injects a Telegram turn and receives the final Codex answer', async () => {
  const binary = Bun.which('codex')
  expect(binary).toBeTruthy()
  let resolveOutput!: (text: string) => void
  const output = new Promise<string>(resolve => { resolveOutput = resolve })
  const adapter = new CodexAppServer({
    profile: 'codex',
    host: '127.0.0.1',
    port: 47932,
    appServerPort: 47933,
    secret: 'turn-integration-test',
    codexBinary: binary!,
  }, async result => resolveOutput(result.text))
  let peer: Awaited<ReturnType<typeof connectClient>> | undefined
  let threadId: string | undefined
  try {
    await adapter.start()
    peer = await connectClient('ws://127.0.0.1:47933')
    const started = await peer.request('thread/start', {
      cwd: 'C:\\tmp',
      ephemeral: false,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    }) as { thread?: { id?: string } }
    threadId = started.thread?.id
    expect(threadId).toBeTruthy()
    for (let attempt = 0; attempt < 30 && !adapter.get(threadId!); attempt += 1) await Bun.sleep(200)
    await adapter.deliver(threadId!, {
      content: 'Reply with exactly ROUTER_SMOKE_OK and do nothing else.',
      meta: {
        chat_id: 'integration-chat',
        message_id: '1',
        user: 'integration',
        user_id: 'integration',
        ts: new Date().toISOString(),
      },
    })
    const text = await Promise.race([
      output,
      Bun.sleep(90_000).then(() => { throw new Error('Codex final answer timed out') }),
    ])
    expect(text).toContain('ROUTER_SMOKE_OK')
  } finally {
    if (peer && threadId) await peer.request('thread/delete', { threadId }).catch(() => {})
    peer?.socket.close()
    await adapter.stop()
  }
}, 120_000)
