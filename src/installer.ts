import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { installAutostart } from './autostart.js'
import { loadConfig, statePaths, type RouterProfile } from './paths.js'
import { VERSION } from './version.js'

export type InstallTarget = RouterProfile | 'both'

export type InstallOptions = {
  target: InstallTarget
  binaryPath?: string
  codexBinary?: string
  claudeScope?: 'local' | 'user' | 'project'
  autostart?: boolean
  platform?: NodeJS.Platform
}

export type InstallCommand = {
  client: 'claude'
  argv: string[]
}

export function resolveBinaryPath(explicit?: string): string {
  if (explicit) return resolve(explicit)
  const executable = resolve(process.execPath)
  if (/^bun(?:\.exe)?$/i.test(basename(executable))) {
    throw new Error('install must run from a compiled binary; pass --binary when developing')
  }
  return executable
}

export function installationCommands(options: InstallOptions): InstallCommand[] {
  if (options.target === 'codex') return []
  const binary = resolveBinaryPath(options.binaryPath)
  return [{
    client: 'claude',
    argv: [
      'claude', 'mcp', 'add',
      '--scope', options.claudeScope ?? 'user',
      'telegram-router',
      '--',
      binary, 'mcp', '--profile', 'claude',
    ],
  }]
}

export function printableCommand(argv: string[]): string {
  return argv.map(value => /^[A-Za-z0-9_./:\\=-]+$/.test(value) ? value : JSON.stringify(value)).join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function codexWrapperContent(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return `@echo off\r\n"${binaryPath.replaceAll('"', '""')}" launch codex -- %*\r\n`
  }
  return `#!/bin/sh\nexec ${shellQuote(binaryPath)} launch codex -- "$@"\n`
}

function profilePath(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? join(homedir(), '.zprofile') : join(homedir(), '.profile')
}

function installedBinaryPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(
      localAppData,
      'Programs',
      'telegram-agent-router',
      `telegram-agent-router-${VERSION}.exe`,
    )
  }
  return join(homedir(), '.local', 'lib', 'telegram-agent-router', `telegram-agent-router-${VERSION}`)
}

async function copyProgramBinary(sourcePath: string, destination: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      copyFileSync(sourcePath, destination)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (!['EBUSY', 'EACCES', 'EPERM'].includes(code ?? '')) throw error
      await Bun.sleep(100)
    }
  }
  throw lastError
}

async function prependWindowsUserPath(directory: string, dryRun: boolean): Promise<void> {
  const powershellDirectory = `'${directory.replaceAll("'", "''")}'`
  const script = [
    `$directory = ${powershellDirectory}`,
    `$path = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `$parts = @($path -split ';' | Where-Object { $_ -and $_ -ne $directory })`,
    `[Environment]::SetEnvironmentVariable('Path', ((@($directory) + $parts) -join ';'), 'User')`,
  ].join('; ')
  const argv = ['powershell.exe', '-NoProfile', '-Command', script]
  process.stdout.write(`${printableCommand(argv)}\n`)
  if (dryRun) return
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`failed to prepend ${directory} to the user PATH`)
}

function prependPosixPath(directory: string, platform: NodeJS.Platform, dryRun: boolean): void {
  const path = profilePath(platform)
  const marker = '# telegram-agent-router codex wrapper'
  const block = `${marker}\nexport PATH=${shellQuote(directory)}:"$PATH"\n`
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (existing.includes(marker)) return
  process.stdout.write(`update ${path}\n`)
  if (dryRun) return
  writeFileSync(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${block}`)
}

async function installProgramBinary(
  sourcePath: string,
  dryRun: boolean,
  platform: NodeJS.Platform,
): Promise<string> {
  const destination = installedBinaryPath(platform)
  const binDirectory = join(homedir(), '.local', 'bin')
  const shim = join(binDirectory, platform === 'win32' ? 'telegram-agent-router.cmd' : 'telegram-agent-router')
  process.stdout.write(`copy ${sourcePath} -> ${destination}\n`)
  process.stdout.write(`write ${shim}\n`)
  if (!dryRun) {
    mkdirSync(dirname(destination), { recursive: true })
    if (resolve(sourcePath) !== resolve(destination)) await copyProgramBinary(sourcePath, destination)
    if (platform !== 'win32') {
      try { chmodSync(destination, 0o755) } catch {}
    }
    mkdirSync(binDirectory, { recursive: true })
    const content = platform === 'win32'
      ? `@echo off\r\n"${destination.replaceAll('"', '""')}" %*\r\n`
      : `#!/bin/sh\nexec ${shellQuote(destination)} "$@"\n`
    await Bun.write(shim, content)
    if (platform !== 'win32') {
      try { chmodSync(shim, 0o755) } catch {}
    }
  }
  if (platform === 'win32') await prependWindowsUserPath(binDirectory, dryRun)
  else prependPosixPath(binDirectory, platform, dryRun)
  return destination
}

export async function installCodexWrapper(
  binaryPath: string,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
  managePath = true,
): Promise<string> {
  const directory = join(homedir(), '.local', 'bin')
  const path = join(directory, platform === 'win32' ? 'codex.cmd' : 'codex')
  process.stdout.write(`write ${path}\n`)
  if (!dryRun) {
    mkdirSync(directory, { recursive: true })
    await Bun.write(path, codexWrapperContent(binaryPath, platform))
    if (platform !== 'win32') {
      try { chmodSync(path, 0o755) } catch {}
    }
  }
  if (managePath) {
    if (platform === 'win32') await prependWindowsUserPath(directory, dryRun)
    else prependPosixPath(directory, platform, dryRun)
  }
  return path
}

function healthUrl(profile: RouterProfile): { url: URL; port: number } {
  const config = loadConfig(statePaths(profile))
  const url = new URL(`http://${config.host}:${config.port}/health`)
  url.searchParams.set('secret', config.secret)
  return { url, port: config.port }
}

async function stopExistingWindowsDaemon(profile: RouterProfile, dryRun: boolean): Promise<void> {
  process.stdout.write(`stop existing ${profile} daemon if running\n`)
  if (dryRun) return
  const paths = statePaths(profile)
  if (!existsSync(paths.config)) return
  try {
    const { url } = healthUrl(profile)
    const response = await fetch(url, { signal: AbortSignal.timeout(750) })
    if (!response.ok) return
    const health = await response.json() as { profile?: string; pid?: number }
    if (health.profile !== profile) return
    let pid = Number.NaN
    if (typeof health.pid === 'number' && Number.isSafeInteger(health.pid)) {
      pid = health.pid
    } else if (existsSync(paths.pid)) {
      pid = Number.parseInt(readFileSync(paths.pid, 'utf8'), 10)
    }
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return
    process.kill(pid, 'SIGTERM')
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0)
        await Bun.sleep(100)
      } catch {
        return
      }
    }
    throw new Error(`${profile} daemon pid ${pid} did not stop`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('did not stop')) throw error
  }
}

async function verifyProfileHealth(profile: RouterProfile, dryRun: boolean): Promise<void> {
  process.stdout.write(`verify ${profile} profile health\n`)
  if (dryRun) return
  const { url, port } = healthUrl(profile)
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) })
      if (response.ok) {
        const health = await response.json() as { profile?: string; version?: string }
        if (health.profile === profile && health.version === VERSION) return
        throw new Error(`port ${port} is running ${health.profile ?? 'unknown'} ${health.version ?? 'legacy'}, expected ${profile} ${VERSION}`)
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(250)
  }
  throw new Error(`${profile} service did not become healthy: ${String(lastError)}`)
}

export async function installClients(options: InstallOptions, dryRun: boolean): Promise<void> {
  const platform = options.platform ?? process.platform
  const sourceBinary = resolveBinaryPath(options.binaryPath)
  const profiles: RouterProfile[] = options.target === 'both' ? ['claude', 'codex'] : [options.target]
  if (options.autostart !== false && platform === 'win32') {
    for (const profile of profiles) await stopExistingWindowsDaemon(profile, dryRun)
  }
  const binary = await installProgramBinary(sourceBinary, dryRun, platform)
  for (const command of installationCommands({ ...options, binaryPath: binary })) {
    const remove = [
      'claude', 'mcp', 'remove',
      '--scope', options.claudeScope ?? 'user',
      'telegram-router',
    ]
    process.stdout.write(`[${command.client}] ${printableCommand(remove)}\n`)
    if (!dryRun) {
      const old = Bun.spawn(remove, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      await old.exited
    }
    process.stdout.write(`[${command.client}] ${printableCommand(command.argv)}\n`)
    if (dryRun) continue
    const child = Bun.spawn(command.argv, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    const code = await child.exited
    if (code !== 0) throw new Error(`Claude MCP registration failed with exit code ${code}`)
  }

  if (options.target === 'codex' || options.target === 'both') {
    await installCodexWrapper(binary, dryRun, platform, false)
  }

  if (options.autostart !== false) {
    await installAutostart({
      binaryPath: binary,
      profiles,
      dryRun,
      platform,
    })
    for (const profile of profiles) await verifyProfileHealth(profile, dryRun)
  }
}
