import { describe, expect, test } from 'bun:test'
import { claudeLaunchArgv } from '../src/claude-launcher.js'

describe('Claude channel launcher', () => {
  test('enables the development Telegram channel for interactive sessions', () => {
    expect(claudeLaunchArgv('claude', [], true))
      .toEqual([
        'claude',
        '--dangerously-load-development-channels',
        'server:telegram-router',
      ])
    expect(claudeLaunchArgv('claude', ['--resume', 'session-id'], true))
      .toEqual([
        'claude',
        '--dangerously-load-development-channels',
        'server:telegram-router',
        '--resume',
        'session-id',
      ])
  })

  test('preserves an explicitly selected channel mode', () => {
    expect(claudeLaunchArgv('claude', ['--channels', 'plugin:telegram@example'], true))
      .toEqual(['claude', '--channels', 'plugin:telegram@example'])
    expect(claudeLaunchArgv(
      'claude',
      ['--dangerously-load-development-channels', 'plugin:telegram@example'],
      true,
    )).toEqual([
      'claude',
      '--dangerously-load-development-channels',
      'plugin:telegram@example',
    ])
  })

  test('bypasses administrative and non-interactive invocations', () => {
    expect(claudeLaunchArgv('claude', ['mcp', 'list'], true))
      .toEqual(['claude', 'mcp', 'list'])
    expect(claudeLaunchArgv('claude', ['--version'], true))
      .toEqual(['claude', '--version'])
    expect(claudeLaunchArgv('claude', ['-p', 'hello'], true))
      .toEqual(['claude', '-p', 'hello'])
    expect(claudeLaunchArgv('claude', [], false))
      .toEqual(['claude'])
  })
})
