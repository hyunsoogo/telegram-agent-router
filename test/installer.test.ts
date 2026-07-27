import { afterEach, describe, expect, test } from 'bun:test'
import {
  codexWrapperContent,
  installationCommands,
  installCodexWrapper,
  printableCommand,
  resolveCodexBinaryPath,
} from '../src/installer.js'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function temporaryHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'telegram-agent-router-installer-'))
  temporaryDirectories.push(path)
  return path
}

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
      `#!/bin/sh\n# telegram-agent-router managed Codex wrapper\nexec '/opt/router' launch codex -- "$@"\n`,
    )
  })

  test('resolves a Codex symlink to its real executable', () => {
    const home = temporaryHome()
    const binary = join(home, 'codex-real')
    const link = join(home, 'codex')
    writeFileSync(binary, 'codex binary')
    symlinkSync(binary, link)

    expect(resolveCodexBinaryPath(link, 'linux')).toBe(realpathSync(binary))
  })

  test('replaces a Codex symlink without modifying its target', async () => {
    const home = temporaryHome()
    const directory = join(home, '.local', 'bin')
    const binary = join(home, 'codex-real')
    const link = join(directory, 'codex')
    mkdirSync(directory, { recursive: true })
    writeFileSync(binary, 'original codex binary')
    chmodSync(binary, 0o755)
    symlinkSync(binary, link)

    await installCodexWrapper('/opt/router', false, 'linux', false, home)

    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(readFileSync(link, 'utf8')).toBe(codexWrapperContent('/opt/router', 'linux'))
    expect(readFileSync(binary, 'utf8')).toBe('original codex binary')
  })

  test('refuses to overwrite an unmanaged Codex executable', async () => {
    const home = temporaryHome()
    const path = join(home, '.local', 'bin', 'codex')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(path, 'original codex binary')

    await expect(installCodexWrapper('/opt/router', false, 'linux', false, home))
      .rejects.toThrow('refusing to overwrite existing Codex executable')
    expect(readFileSync(path, 'utf8')).toBe('original codex binary')
  })
})
