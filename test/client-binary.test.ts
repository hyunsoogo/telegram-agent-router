import { afterEach, describe, expect, test } from 'bun:test'
import {
  clientBinaryIdentity,
  codexStandaloneCurrentCandidates,
  codexVersionCheck,
  findUnmanagedClientBinary,
  resolveClientBinaryPath,
  resolveCodexRuntimeBinary,
  sameClientBinary,
} from '../src/client-binary.js'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const temporaryDirectories: string[] = []
const executableSymlinkTest = process.platform === 'win32' ? test.skip : test

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'telegram-agent-router-client-binary-'))
  temporaryDirectories.push(path)
  return path
}

function standaloneInstallation(home: string, version: string, content: string) {
  const standalone = join(home, 'standalone')
  const release = join(standalone, 'releases', version)
  const current = join(standalone, 'current')
  const binary = join(release, 'bin', 'codex.exe')
  mkdirSync(join(release, 'bin'), { recursive: true })
  writeFileSync(binary, content)
  symlinkSync(release, current, process.platform === 'win32' ? 'junction' : 'dir')
  return {
    release,
    releaseBinary: binary,
    current,
    currentBinary: join(current, 'bin', 'codex.exe'),
  }
}

describe('client binary discovery', () => {
  test('skips the managed Windows wrapper and selects the real Codex executable', () => {
    const home = temporaryDirectory()
    const shims = join(home, 'shims')
    const bin = join(home, 'bin')
    mkdirSync(shims)
    mkdirSync(bin)
    writeFileSync(
      join(shims, 'codex.cmd'),
      '@echo off\r\nrem telegram-agent-router managed Codex wrapper\r\nrouter launch codex -- %*\r\n',
    )
    const binary = join(bin, 'codex.exe')
    writeFileSync(binary, 'native Codex executable')

    expect(findUnmanagedClientBinary('codex', `${shims};${bin}`, '.EXE;.CMD', 'win32'))
      .toBe(realpathSync(binary))
  })

  test('falls back to PATH when the configured Codex binary disappeared', () => {
    const home = temporaryDirectory()
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const binary = join(bin, 'codex')
    writeFileSync(binary, 'replacement Codex executable')
    chmodSync(binary, 0o755)

    expect(resolveCodexRuntimeBinary(join(home, 'removed-codex'), bin, '', 'linux'))
      .toBe(realpathSync(binary))
  })

  test('keeps a valid configured binary ahead of another PATH candidate', () => {
    const home = temporaryDirectory()
    const configured = join(home, 'configured-codex')
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(configured, 'configured')
    writeFileSync(join(bin, 'codex'), 'path candidate')
    chmodSync(configured, 0o755)
    chmodSync(join(bin, 'codex'), 0o755)

    expect(resolveCodexRuntimeBinary(configured, bin, '', 'linux')).toBe(realpathSync(configured))
  })

  test('preserves a standalone current path instead of resolving its junction', () => {
    const home = temporaryDirectory()
    const installation = standaloneInstallation(home, '0.146.0-test', 'current Codex executable')

    expect(resolveClientBinaryPath(installation.currentBinary, 'codex', 'win32'))
      .toBe(installation.currentBinary)
    expect(resolveClientBinaryPath(installation.currentBinary, 'codex', 'win32'))
      .not.toBe(realpathSync(installation.currentBinary))
  })

  test('migrates a configured standalone release path to current', () => {
    const home = temporaryDirectory()
    const installation = standaloneInstallation(home, '0.146.0-test', 'current Codex executable')

    expect(resolveCodexRuntimeBinary(installation.releaseBinary, '', '.EXE', 'win32'))
      .toBe(installation.currentBinary)
  })

  test('prefers standalone current before an unmanaged PATH candidate', () => {
    const home = temporaryDirectory()
    const installation = standaloneInstallation(home, '0.146.0-test', 'current Codex executable')
    const pathBin = join(home, 'path-bin')
    mkdirSync(pathBin)
    writeFileSync(join(pathBin, 'codex.exe'), 'older PATH Codex executable')

    expect(resolveCodexRuntimeBinary(undefined, pathBin, '.EXE', 'win32', [installation.currentBinary]))
      .toBe(installation.currentBinary)
  })

  test('discovers the platform standalone current locations', () => {
    expect(codexStandaloneCurrentCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      CODEX_HOME: 'C:\\Users\\tester\\.codex',
    }, 'C:\\Users\\tester')).toEqual([
      resolve('C:\\Users\\tester\\.codex\\packages\\standalone\\current\\bin\\codex.exe'),
      resolve('C:\\Users\\tester\\.codex\\standalone\\current\\bin\\codex.exe'),
      resolve('C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\packages\\standalone\\current\\bin\\codex.exe'),
      resolve('C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\standalone\\current\\bin\\codex.exe'),
      resolve('C:\\Users\\tester\\AppData\\Local\\Codex\\packages\\standalone\\current\\bin\\codex.exe'),
      resolve('C:\\Users\\tester\\AppData\\Local\\Codex\\standalone\\current\\bin\\codex.exe'),
    ])
  })

  test('detects a Codex update through the stable current path', () => {
    const home = temporaryDirectory()
    const first = standaloneInstallation(home, '0.146.0-test', 'old Codex')
    const before = clientBinaryIdentity(first.currentBinary, 'codex', 'win32')
    const nextRelease = join(home, 'standalone', 'releases', '0.147.0-test')
    mkdirSync(join(nextRelease, 'bin'), { recursive: true })
    writeFileSync(join(nextRelease, 'bin', 'codex.exe'), 'new Codex executable with changed identity')
    rmSync(first.current, { recursive: true, force: true })
    symlinkSync(nextRelease, first.current, process.platform === 'win32' ? 'junction' : 'dir')

    const after = clientBinaryIdentity(first.currentBinary, 'codex', 'win32')
    expect(before.path).toBe(first.currentBinary)
    expect(after.path).toBe(first.currentBinary)
    expect(sameClientBinary(before, after)).toBe(false)
    expect(codexVersionCheck(after, before)[0]).toBe(false)
    expect(codexVersionCheck(after, before)[1]).toContain('differs from router runtime')
    expect(codexVersionCheck(after, { ...after })[0]).toBe(true)
  })

  executableSymlinkTest('executes the updated Codex release through the unchanged current path', () => {
    const home = temporaryDirectory()
    const standalone = join(home, 'standalone')
    const firstRelease = join(standalone, 'releases', '0.146.0-test')
    const nextRelease = join(standalone, 'releases', '0.147.0-test')
    const current = join(standalone, 'current')
    for (const [release, output] of [[firstRelease, 'old'], [nextRelease, 'new']] as const) {
      mkdirSync(join(release, 'bin'), { recursive: true })
      const binary = join(release, 'bin', 'codex')
      writeFileSync(binary, `#!/bin/sh\nprintf '${output}\\n'\n`)
      chmodSync(binary, 0o755)
    }
    symlinkSync(firstRelease, current, 'dir')

    const configured = join(firstRelease, 'bin', 'codex')
    const selected = resolveCodexRuntimeBinary(configured, '', '', 'linux', [])
    expect(selected).toBe(join(current, 'bin', 'codex'))
    expect(Bun.spawnSync([selected!]).stdout.toString()).toBe('old\n')

    rmSync(current, { recursive: true, force: true })
    symlinkSync(nextRelease, current, 'dir')
    const selectedAfterUpdate = resolveCodexRuntimeBinary(configured, '', '', 'linux', [])
    expect(selectedAfterUpdate).toBe(selected)
    expect(Bun.spawnSync([selectedAfterUpdate!]).stdout.toString()).toBe('new\n')
  })

  test('rejects a managed wrapper as a real client binary', () => {
    const home = temporaryDirectory()
    const wrapper = join(home, 'codex')
    writeFileSync(
      wrapper,
      '#!/bin/sh\n# telegram-agent-router managed Codex wrapper\nexec router launch codex -- "$@"\n',
    )
    chmodSync(wrapper, 0o755)

    expect(() => resolveClientBinaryPath(wrapper, 'codex', 'linux')).toThrow('managed router wrapper')
    expect(readFileSync(wrapper, 'utf8')).toContain('managed Codex wrapper')
  })

  test('detects an in-place binary replacement without hashing the executable', () => {
    const home = temporaryDirectory()
    const binary = join(home, 'codex')
    writeFileSync(binary, 'old')
    chmodSync(binary, 0o755)
    const before = clientBinaryIdentity(binary, 'codex', 'linux')
    writeFileSync(binary, 'new executable with a different size')
    chmodSync(binary, 0o755)
    const after = clientBinaryIdentity(binary, 'codex', 'linux')

    expect(sameClientBinary(before, before)).toBe(true)
    expect(sameClientBinary(before, after)).toBe(false)
  })
})
