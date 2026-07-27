import { describe, expect, test } from 'bun:test'
import { codexLaunchArgv } from '../src/codex-launcher.js'

describe('Codex remote launcher', () => {
  test('forwards the invoking workspace to the managed App Server', () => {
    expect(codexLaunchArgv('codex', 47323, 'C:\\Dev\\KIP-AI', [])).toEqual([
      'codex', '--remote', 'ws://127.0.0.1:47323', '-C', 'C:\\Dev\\KIP-AI',
    ])
  })

  test('preserves an explicit cwd and bypasses administrative subcommands', () => {
    expect(codexLaunchArgv('codex', 47323, '/work/default', ['-C', '/work/other']))
      .toEqual(['codex', '--remote', 'ws://127.0.0.1:47323', '-C', '/work/other'])
    expect(codexLaunchArgv('codex', 47323, '/work/default', ['login']))
      .toEqual(['codex', 'login'])
  })
})
