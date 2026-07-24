import { describe, expect, test } from 'bun:test'
import { installationCommands, printableCommand } from '../src/installer.js'
import { resolve } from 'node:path'

describe('standalone client installer', () => {
  test('generates Claude Code and Codex commands that invoke only the compiled binary', () => {
    const commands = installationCommands({
      target: 'both',
      sessionId: 'my-project',
      label: 'My Project',
      workspace: '/work/my-project',
      binaryPath: '/opt/telegram-agent-router',
      claudeScope: 'user',
    })
    expect(commands).toHaveLength(2)
    expect(commands[0]).toEqual({
      client: 'claude',
      argv: ['claude', 'mcp', 'add', '--scope', 'user', 'telegram-router-my-project', '--', resolve('/opt/telegram-agent-router'), 'mcp', '--client', 'claude', '--session', 'my-project', '--label', 'My Project', '--workspace', resolve('/work/my-project')],
    })
    expect(commands[1]?.argv).toEqual(['codex', 'mcp', 'add', 'telegram-router-my-project', '--', resolve('/opt/telegram-agent-router'), 'mcp', '--client', 'codex', '--session', 'my-project', '--label', 'My Project', '--workspace', resolve('/work/my-project')])
    expect(commands.flatMap(command => command.argv)).not.toContain('bun')
    expect(commands.flatMap(command => command.argv)).not.toContain('node')
    expect(commands.flatMap(command => command.argv)).not.toContain('npx')
  })

  test('quotes labels with spaces for dry-run output', () => {
    expect(printableCommand(['binary', '--label', 'My Project'])).toBe('binary --label "My Project"')
  })
})
