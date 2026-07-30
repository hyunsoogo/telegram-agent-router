import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistAppServerPort, type StatePaths } from '../src/paths.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function temporaryCodexPaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'telegram-agent-router-paths-'))
  temporaryDirectories.push(root)
  return {
    profile: 'codex',
    root,
    home: root,
    config: join(root, 'config.json'),
    env: join(root, '.env'),
    database: join(root, 'router.sqlite'),
    pid: join(root, 'daemon.pid'),
  }
}

describe('codex App Server port persistence', () => {
  test('rewrites only the App Server port and keeps every other setting', () => {
    const paths = temporaryCodexPaths()
    writeFileSync(paths.config, JSON.stringify({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47324,
      codexBinary: 'C:\\codex\\bin\\codex.exe',
    }, null, 2))

    persistAppServerPort(47325, paths)

    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toEqual({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47325,
      codexBinary: 'C:\\codex\\bin\\codex.exe',
    })
  })

  test('fails loudly when the config file is missing instead of creating one', () => {
    const paths = temporaryCodexPaths()

    expect(() => persistAppServerPort(47325, paths)).toThrow()
  })
})
