import { describe, expect, test } from 'bun:test'
import { codexLaunchArgv, validateCodexClientUrl } from '../src/codex-launcher.js'

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
})
