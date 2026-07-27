import { describe, expect, test } from 'bun:test'
import { codexWrapperContent, installationCommands, printableCommand } from '../src/installer.js'
import { resolve } from 'node:path'

describe('standalone client installer', () => {
  test('registers one dynamic user-scoped Claude bridge', () => {
    const commands = installationCommands({
      target: 'both',
      binaryPath: '/opt/telegram-agent-router',
      claudeScope: 'user',
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toEqual({
      client: 'claude',
      argv: ['claude', 'mcp', 'add', '--scope', 'user', 'telegram-router', '--', resolve('/opt/telegram-agent-router'), 'mcp', '--profile', 'claude'],
    })
    expect(commands.flatMap(command => command.argv)).not.toContain('bun')
    expect(commands.flatMap(command => command.argv)).not.toContain('node')
    expect(commands.flatMap(command => command.argv)).not.toContain('npx')
  })

  test('quotes values with spaces for dry-run output', () => {
    expect(printableCommand(['binary', '--label', 'My Project'])).toBe('binary --label "My Project"')
  })

  test('Codex wrappers preserve all user arguments on Windows and POSIX', () => {
    expect(codexWrapperContent('C:\\Program Files\\router.exe', 'win32')).toContain('launch codex -- %*')
    expect(codexWrapperContent('/opt/router', 'linux')).toBe(
      `#!/bin/sh\nexec '/opt/router' launch codex -- "$@"\n`,
    )
  })
})
