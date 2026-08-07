import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadConfig,
  persistAppServerPort,
  persistCodexBinary,
  persistCodexRuntime,
  type StatePaths,
} from '../src/paths.js'

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
  test('migrates a versioned standalone Codex path to current when loading config', () => {
    const paths = temporaryCodexPaths()
    const standalone = join(paths.root, 'standalone')
    const release = join(standalone, 'releases', '0.146.0-test')
    const current = join(standalone, 'current')
    mkdirSync(join(release, 'bin'), { recursive: true })
    writeFileSync(join(release, 'bin', 'codex.exe'), 'Codex executable')
    chmodSync(join(release, 'bin', 'codex.exe'), 0o755)
    symlinkSync(release, current, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(paths.config, JSON.stringify({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47325,
      codexBinary: join(release, 'bin', 'codex.exe'),
    }, null, 2))

    expect(loadConfig(paths).codexBinary).toBe(join(current, 'bin', 'codex.exe'))
    expect(JSON.parse(readFileSync(paths.config, 'utf8')).codexBinary)
      .toBe(join(current, 'bin', 'codex.exe'))
  })

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

  test('updates the Codex binary without losing the App Server port', () => {
    const paths = temporaryCodexPaths()
    writeFileSync(paths.config, JSON.stringify({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47325,
      codexBinary: 'C:\\codex\\old\\codex.exe',
    }, null, 2))

    persistCodexBinary('C:\\codex\\new\\codex.exe', paths)

    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toEqual({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47325,
      codexBinary: resolve('C:\\codex\\new\\codex.exe'),
    })
  })

  test('updates the Codex binary and App Server port together', () => {
    const paths = temporaryCodexPaths()
    writeFileSync(paths.config, JSON.stringify({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47325,
      codexBinary: 'C:\\codex\\old\\codex.exe',
    }, null, 2))

    persistCodexRuntime('C:\\codex\\new\\codex.exe', 47326, paths)

    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toEqual({
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47326,
      codexBinary: resolve('C:\\codex\\new\\codex.exe'),
    })
  })

  test('serializes concurrent config patches so migration cannot discard a port update', async () => {
    const paths = temporaryCodexPaths()
    const initial = {
      profile: 'codex',
      host: '127.0.0.1',
      port: 47322,
      secret: 'keep-this-secret',
      appServerPort: 47323,
      codexBinary: 'C:\\codex\\old\\codex.exe',
    }
    writeFileSync(paths.config, JSON.stringify(initial, null, 2))
    writeFileSync(`${paths.config}.lock`, 'test holds the config lock', { flag: 'wx' })
    const nextBinary = resolve('C:\\codex\\new\\codex.exe')
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'src', 'paths.ts')).href
    const script = [
      `import { persistCodexBinary } from ${JSON.stringify(moduleUrl)}`,
      `process.stdout.write('ready\\n')`,
      `persistCodexBinary(${JSON.stringify(nextBinary)}, ${JSON.stringify(paths)})`,
    ].join('; ')
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const reader = child.stdout.getReader()
      const ready = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(ready.value)).toContain('ready')
      await Bun.sleep(100)
      writeFileSync(paths.config, JSON.stringify({ ...initial, appServerPort: 47326 }, null, 2))
      unlinkSync(`${paths.config}.lock`)

      expect(await child.exited).toBe(0)
      const config = JSON.parse(readFileSync(paths.config, 'utf8'))
      expect(config.appServerPort).toBe(47326)
      expect(config.codexBinary).toBe(nextBinary)
    } finally {
      try { unlinkSync(`${paths.config}.lock`) } catch {}
      if (child.exitCode === null) child.kill()
      await child.exited.catch(() => {})
    }
  })
})
