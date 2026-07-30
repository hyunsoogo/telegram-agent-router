import { describe, expect, test } from 'bun:test'
import {
  CodexRegistrationLock,
  handleCodexClientRegistration,
  isLoopbackAddress,
  telegramTextChunks,
} from '../src/router.js'

describe('Telegram response formatting', () => {
  test('splits long Claude answers without losing text', () => {
    const text = 'x'.repeat(8_001)
    const chunks = telegramTextChunks(text)
    expect(chunks).toHaveLength(3)
    expect(chunks.every(chunk => chunk.length <= 4_000)).toBe(true)
    expect(chunks.join('')).toBe(text)
    expect(telegramTextChunks('')).toEqual([])
  })
})

function registrationRequest(body: unknown, secret = 'test-secret'): Request {
  return new Request('http://127.0.0.1:47322/codex-client/register', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('Codex client registration', () => {
  test('accepts only authenticated loopback requests with a binary path', async () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.10')).toBe(false)

    const codex = {
      prepareBinary: async () => ({ status: 'ready' as const, changed: false }),
    }
    const base = {
      secret: 'test-secret',
      loopback: true,
      codex,
      lock: new CodexRegistrationLock(),
      proxyCount: () => 0,
      createProxy: () => 'ws://127.0.0.1:49152',
    }
    expect((await handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'C:\\Codex\\codex.exe' }),
      base,
    )).status).toBe(200)
    expect((await handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'C:\\Codex\\codex.exe' }),
      { ...base, loopback: false },
    )).status).toBe(403)
    expect((await handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'C:\\Codex\\codex.exe' }, 'wrong'),
      base,
    )).status).toBe(401)
    expect((await handleCodexClientRegistration(
      registrationRequest({}),
      base,
    )).status).toBe(400)
  })

  test('maps busy, preparation failure, and proxy failure to stable responses', async () => {
    const base = {
      secret: 'test-secret',
      loopback: true,
      lock: new CodexRegistrationLock(),
      proxyCount: () => 2,
      createProxy: () => 'ws://127.0.0.1:49152',
    }
    const busy = await handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'codex.exe' }),
      {
        ...base,
        codex: {
          prepareBinary: async () => ({ status: 'busy' as const, sessions: 2 }),
        },
      },
    )
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({
      code: 'codex_binary_change_pending',
      sessions: 2,
    })

    const failed = await handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'codex.exe' }),
      {
        ...base,
        codex: {
          prepareBinary: async () => { throw new Error('private path detail') },
        },
      },
    )
    expect(failed.status).toBe(503)
    expect(JSON.stringify(await failed.json())).not.toContain('private path detail')

    const proxyFailed = await handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'codex.exe' }),
      {
        ...base,
        codex: {
          prepareBinary: async () => ({ status: 'ready' as const, changed: false }),
        },
        createProxy: () => { throw new Error('bind failed') },
      },
    )
    expect(proxyFailed.status).toBe(503)
  })

  test('serializes preparation and proxy reservation across concurrent registrations', async () => {
    let releaseFirst!: () => void
    const firstPreparation = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    let proxies = 0
    const lock = new CodexRegistrationLock()
    const codex = {
      async prepareBinary(_binaryPath: string, connectedProxies: number) {
        calls += 1
        if (calls === 1) {
          await firstPreparation
          return { status: 'ready' as const, changed: false }
        }
        return connectedProxies > 0
          ? { status: 'busy' as const, sessions: connectedProxies }
          : { status: 'ready' as const, changed: true }
      },
    }
    const options = {
      secret: 'test-secret',
      loopback: true,
      codex,
      lock,
      proxyCount: () => proxies,
      createProxy: () => {
        proxies += 1
        return `ws://127.0.0.1:${49152 + proxies}`
      },
    }
    const first = handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'codex-old.exe' }),
      options,
    )
    await Bun.sleep(0)
    const second = handleCodexClientRegistration(
      registrationRequest({ binaryPath: 'codex-new.exe' }),
      options,
    )
    await Bun.sleep(0)
    expect(calls).toBe(1)

    releaseFirst()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(409)
    expect(proxies).toBe(1)
  })
})
