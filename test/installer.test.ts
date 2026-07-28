import { afterEach, describe, expect, test } from 'bun:test'
import {
  claudeWrapperContent,
  codexWrapperContent,
  installationCommands,
  installClaudeWrapper,
  installCodexWrapper,
  printableCommand,
  resolveClaudeBinaryPath,
  resolveCodexBinaryPath,
  resolveWindowsCommand,
  windowsShimsDirectory,
} from '../src/installer.js'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const temporaryDirectories: string[] = []
const symlinkTest = process.platform === 'win32' ? test.skip : test

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
      claudeBinary: '/opt/claude',
      claudeScope: 'user',
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toEqual({
      client: 'claude',
      argv: ['/opt/claude', 'mcp', 'add', '--scope', 'user', 'telegram-router', '--', resolve('/opt/telegram-agent-router'), 'mcp', '--profile', 'claude'],
    })
    expect(commands.flatMap(command => command.argv)).not.toContain('bun')
    expect(commands.flatMap(command => command.argv)).not.toContain('node')
    expect(commands.flatMap(command => command.argv)).not.toContain('npx')
  })

  test('quotes values with spaces for dry-run output', () => {
    expect(printableCommand(['binary', '--label', 'My Project'])).toBe('binary --label "My Project"')
  })

  test('client wrappers preserve all user arguments', () => {
    expect(claudeWrapperContent('C:\\Program Files\\router.exe', 'win32')).toContain('launch claude -- %*')
    expect(claudeWrapperContent('/opt/router', 'linux')).toBe(
      `#!/bin/sh\n# telegram-agent-router managed Claude wrapper\nexec '/opt/router' launch claude -- "$@"\n`,
    )
    expect(codexWrapperContent('C:\\Program Files\\router.exe', 'win32')).toContain('launch codex -- %*')
    expect(codexWrapperContent('/opt/router', 'linux')).toBe(
      `#!/bin/sh\n# telegram-agent-router managed Codex wrapper\nexec '/opt/router' launch codex -- "$@"\n`,
    )
  })

  symlinkTest('resolves a Claude symlink to its real executable', () => {
    const home = temporaryHome()
    const binary = join(home, 'claude-real')
    const link = join(home, 'claude')
    writeFileSync(binary, 'claude binary')
    symlinkSync(binary, link)

    expect(resolveClaudeBinaryPath(link, 'linux')).toBe(realpathSync(binary))
  })

  symlinkTest('resolves a Codex symlink to its real executable', () => {
    const home = temporaryHome()
    const binary = join(home, 'codex-real')
    const link = join(home, 'codex')
    writeFileSync(binary, 'codex binary')
    symlinkSync(binary, link)

    expect(resolveCodexBinaryPath(link, 'linux')).toBe(realpathSync(binary))
  })

  symlinkTest('replaces a Codex symlink without modifying its target', async () => {
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

  symlinkTest('replaces a Claude symlink with a channel-enabled wrapper', async () => {
    const home = temporaryHome()
    const directory = join(home, '.local', 'bin')
    const binary = join(home, 'claude-real')
    const link = join(directory, 'claude')
    mkdirSync(directory, { recursive: true })
    writeFileSync(binary, 'original claude binary')
    chmodSync(binary, 0o755)
    symlinkSync(binary, link)

    await installClaudeWrapper('/opt/router', false, 'linux', false, home)

    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(readFileSync(link, 'utf8')).toBe(claudeWrapperContent('/opt/router', 'linux'))
    expect(readFileSync(binary, 'utf8')).toBe('original claude binary')
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

describe('windows PATHEXT shadowing', () => {
  test('windows wrapper install also writes a shim wrapper that survives a native exe', async () => {
    const home = temporaryHome()
    const binDirectory = join(home, '.local', 'bin')
    mkdirSync(binDirectory, { recursive: true })
    writeFileSync(join(binDirectory, 'claude.exe'), 'native claude binary')

    await installClaudeWrapper('C:\\router\\telegram-agent-router.exe', false, 'win32', false, home)

    const wrapper = readFileSync(join(binDirectory, 'claude.cmd'), 'utf8')
    const shim = readFileSync(join(windowsShimsDirectory(home), 'claude.cmd'), 'utf8')
    expect(wrapper).toBe(claudeWrapperContent('C:\\router\\telegram-agent-router.exe', 'win32'))
    expect(shim).toBe(wrapper)
    expect(readFileSync(join(binDirectory, 'claude.exe'), 'utf8')).toBe('native claude binary')
  })

  test('codex wrapper install writes the windows shim as well', async () => {
    const home = temporaryHome()

    await installCodexWrapper('C:\\router\\telegram-agent-router.exe', false, 'win32', false, home)

    expect(readFileSync(join(windowsShimsDirectory(home), 'codex.cmd'), 'utf8'))
      .toBe(codexWrapperContent('C:\\router\\telegram-agent-router.exe', 'win32'))
  })

  test('resolveWindowsCommand follows PATH directory order before PATHEXT order', () => {
    const home = temporaryHome()
    const shims = join(home, 'shims')
    const bin = join(home, 'bin')
    mkdirSync(shims, { recursive: true })
    mkdirSync(bin, { recursive: true })
    const wrapper = claudeWrapperContent('C:\\router\\telegram-agent-router.exe', 'win32')
    writeFileSync(join(bin, 'claude.exe'), 'native claude binary')
    writeFileSync(join(bin, 'claude.cmd'), wrapper)
    writeFileSync(join(shims, 'claude.cmd'), wrapper)
    const pathExtensions = '.COM;.EXE;.BAT;.CMD'

    const shadowed = resolveWindowsCommand('claude', `${bin};${shims}`, pathExtensions, 'win32')
    expect(shadowed?.path).toBe(join(bin, 'claude.exe'))
    expect(shadowed?.managed).toBe(false)

    const shimmed = resolveWindowsCommand('claude', `${shims};${bin}`, pathExtensions, 'win32')
    expect(shimmed?.path).toBe(join(shims, 'claude.cmd'))
    expect(shimmed?.managed).toBe(true)

    expect(resolveWindowsCommand('claude', '', pathExtensions, 'win32')).toBeUndefined()
  })
})
