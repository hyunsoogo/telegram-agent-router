import { afterEach, describe, expect, test } from 'bun:test'
import {
  clientBinaryIdentity,
  findUnmanagedClientBinary,
  resolveClientBinaryPath,
  resolveCodexRuntimeBinary,
  sameClientBinary,
} from '../src/client-binary.js'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'telegram-agent-router-client-binary-'))
  temporaryDirectories.push(path)
  return path
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
