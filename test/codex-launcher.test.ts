import { describe, expect, test } from 'bun:test'
import { codexClientUrl, codexLaunchArgv, launchCodex, validateCodexClientUrl } from '../src/codex-launcher.js'

describe('Codex remote launcher', () => {
  test('forwards the invoking workspace to the managed App Server', () => {
    expect(codexLaunchArgv('codex', 'ws://127.0.0.1:47322/codex-client?ticket=test', 'C:\\Dev\\KIP-AI', [], true)).toEqual([
      'codex', '--remote', 'ws://127.0.0.1:47322/codex-client?ticket=test', '-C', 'C:\\Dev\\KIP-AI',
    ])
  })

  test('preserves an explicit cwd and bypasses administrative subcommands', () => {
    expect(codexLaunchArgv('codex', 'ws://router', '/work/default', ['-C', '/work/other'], true))
      .toEqual(['codex', '--remote', 'ws://router', '-C', '/work/other'])
    expect(codexLaunchArgv('codex', 'ws://router', '/work/default', ['login'], true))
      .toEqual(['codex', 'login'])
    expect(codexLaunchArgv('codex', 'ws://router', '/work/default', ['--version'], true))
      .toEqual(['codex', '--version'])
  })

  test('does not route non-interactive Codex invocations', () => {
    expect(codexLaunchArgv('codex', 'ws://router', '/work/default', ['exec', 'task'], false))
      .toEqual(['codex', 'exec', 'task'])
  })

  test('accepts only the host-and-port remote URL supported by Codex CLI', () => {
    expect(validateCodexClientUrl('ws://127.0.0.1:49152')).toBe('ws://127.0.0.1:49152')
    expect(() => validateCodexClientUrl('ws://127.0.0.1:47322/codex-client?ticket=test'))
      .toThrow('invalid client URL')
  })

  test('registers the real Codex binary identity with the daemon', async () => {
    let request: Request | undefined
    const url = await codexClientUrl({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      appServerPort: 47323,
      secret: 'test-secret',
    }, 'C:\\Codex\\codex.exe', async (input, init) => {
      request = new Request(input, init)
      return Response.json({ url: 'ws://127.0.0.1:49152' })
    })

    expect(url).toBe('ws://127.0.0.1:49152')
    expect(request?.headers.get('authorization')).toBe('Bearer test-secret')
    expect(await request?.json()).toEqual({ binaryPath: 'C:\\Codex\\codex.exe' })
  })

  test('explains why routing is deferred while older Codex sessions are active', async () => {
    await expect(codexClientUrl({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      appServerPort: 47323,
      secret: 'test-secret',
    }, 'codex.exe', async () => Response.json({ sessions: 2 }, { status: 409 })))
      .rejects.toThrow('close the older sessions')
  })

  test('launches plain Codex when client registration fails', async () => {
    let spawnedArgv: string[] | undefined
    const code = await launchCodex('C:\\Codex\\codex.exe', {
      profile: 'codex',
      root: 'C:\\state',
      home: 'C:\\state\\codex',
      config: 'C:\\state\\codex\\config.json',
      env: 'C:\\state\\codex\\.env',
      database: 'C:\\state\\codex\\router.sqlite',
      pid: 'C:\\state\\codex\\daemon.pid',
    }, {
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      appServerPort: 47323,
      secret: 'test-secret',
    }, ['chat'], {
      interactive: true,
      cwd: 'C:\\work',
      healthy: async () => true,
      clientUrl: async () => { throw new Error('registration unavailable') },
      spawn(argv) {
        spawnedArgv = argv
        return {
          exited: Promise.resolve(0),
          unref() {},
        }
      },
    })

    expect(code).toBe(0)
    expect(spawnedArgv).toEqual(['C:\\Codex\\codex.exe', 'chat'])
  })
})
