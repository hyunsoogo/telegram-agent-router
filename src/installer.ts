import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { installAutostart } from './autostart.js'
import {
  CLIENT_WRAPPER_MARKERS,
  isManagedClientWrapper,
  resolveClientBinaryPath,
} from './client-binary.js'
import { loadConfig, statePaths, type RouterProfile } from './paths.js'
import { VERSION } from './version.js'

export type InstallTarget = RouterProfile | 'both'

export type InstallOptions = {
  target: InstallTarget
  binaryPath?: string
  claudeBinary?: string
  codexBinary?: string
  claudeScope?: 'local' | 'user' | 'project'
  autostart?: boolean
  platform?: NodeJS.Platform
}

export type InstallCommand = {
  client: 'claude'
  argv: string[]
}

type WrapperClient = 'claude' | 'codex'

export type DaemonHealth = {
  profile?: string
  pid?: number
  version?: string
  sessions?: unknown[]
}

export class DaemonReplacementBlockedError extends Error {}

type HealthProbe = () => Promise<DaemonHealth | undefined>
type Delay = (milliseconds: number) => Promise<void>

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
      options.claudeBinary ?? 'claude', 'mcp', 'add',
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
  const marker = CLIENT_WRAPPER_MARKERS.codex
  if (platform === 'win32') {
    return `@echo off\r\nrem ${marker}\r\n"${binaryPath.replaceAll('"', '""')}" launch codex -- %*\r\n`
  }
  return `#!/bin/sh\n# ${marker}\nexec ${shellQuote(binaryPath)} launch codex -- "$@"\n`
}

export function claudeWrapperContent(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const marker = CLIENT_WRAPPER_MARKERS.claude
  if (platform === 'win32') {
    return `@echo off\r\nrem ${marker}\r\n"${binaryPath.replaceAll('"', '""')}" launch claude -- %*\r\n`
  }
  return `#!/bin/sh\n# ${marker}\nexec ${shellQuote(binaryPath)} launch claude -- "$@"\n`
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function resolveClaudeBinaryPath(
  candidate: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return resolveClientBinaryPath(candidate, 'claude', platform)
}

export function resolveCodexBinaryPath(
  candidate: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return resolveClientBinaryPath(candidate, 'codex', platform)
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  const marker = '# telegram-agent-router client wrappers'
  const legacyMarker = '# telegram-agent-router codex wrapper'
  const block = `${marker}\nexport PATH=${shellQuote(directory)}:"$PATH"\n`
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (existing.includes(marker) || existing.includes(legacyMarker)) return
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

export function windowsShimsDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, '.telegram-agent-router', 'shims')
}

async function writeManagedWrapper(
  path: string,
  content: string,
  client: WrapperClient,
  platform: NodeJS.Platform,
): Promise<void> {
  const existing = lstatIfPresent(path)
  if (existing && !existing.isSymbolicLink() && !isManagedClientWrapper(path, client, platform)) {
    const label = client === 'claude' ? 'Claude' : 'Codex'
    throw new Error(`refusing to overwrite existing ${label} executable: ${path}; pass --${client}-binary with the real executable and move it outside the wrapper path`)
  }
  const suffix = `${process.pid}-${Date.now()}`
  const replacement = `${path}.new-${suffix}`
  const previous = `${path}.previous-${suffix}`
  await Bun.write(replacement, content)
  if (platform !== 'win32') {
    try { chmodSync(replacement, 0o755) } catch {}
  }
  let previousMoved = false
  try {
    if (existing) {
      renameSync(path, previous)
      previousMoved = true
    }
    renameSync(replacement, path)
    if (previousMoved) {
      try { unlinkSync(previous) } catch {}
    }
  } catch (error) {
    try {
      if (previousMoved && !lstatIfPresent(path) && lstatIfPresent(previous)) {
        renameSync(previous, path)
      }
    } catch {}
    try {
      if (lstatIfPresent(replacement)) unlinkSync(replacement)
    } catch {}
    throw error
  }
}

async function installClientWrapper(
  client: WrapperClient,
  binaryPath: string,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
  managePath = true,
  homeDirectory = homedir(),
): Promise<string> {
  const directory = join(homeDirectory, '.local', 'bin')
  const path = join(directory, platform === 'win32' ? `${client}.cmd` : client)
  const content = client === 'claude'
    ? claudeWrapperContent(binaryPath, platform)
    : codexWrapperContent(binaryPath, platform)
  process.stdout.write(`write ${path}\n`)
  if (!dryRun) {
    mkdirSync(directory, { recursive: true })
    await writeManagedWrapper(path, content, client, platform)
  }
  if (platform === 'win32') {
    // PATHEXT ranks .exe above .cmd inside one directory, so a native
    // ${client}.exe in ~/.local/bin (e.g. the native Claude Code installer)
    // permanently shadows the .cmd wrapper. A duplicate wrapper in a shim
    // directory that sits earlier on PATH wins regardless of PATHEXT.
    const shimPath = join(windowsShimsDirectory(homeDirectory), `${client}.cmd`)
    process.stdout.write(`write ${shimPath}\n`)
    const nativeExecutable = join(directory, `${client}.exe`)
    if (existsSync(nativeExecutable)) {
      process.stdout.write(`note: ${nativeExecutable} shadows ${basename(path)} through PATHEXT; the shim directory takes precedence on PATH\n`)
    }
    if (!dryRun) {
      mkdirSync(windowsShimsDirectory(homeDirectory), { recursive: true })
      await writeManagedWrapper(shimPath, content, client, platform)
    }
  }
  if (managePath) {
    if (platform === 'win32') {
      await prependWindowsUserPath(directory, dryRun)
      await prependWindowsUserPath(windowsShimsDirectory(homeDirectory), dryRun)
    } else prependPosixPath(directory, platform, dryRun)
  }
  return path
}

export function installClaudeWrapper(
  binaryPath: string,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
  managePath = true,
  homeDirectory = homedir(),
): Promise<string> {
  return installClientWrapper('claude', binaryPath, dryRun, platform, managePath, homeDirectory)
}

export type WindowsCommandResolution = { path: string; managed: boolean }

export function resolveWindowsCommand(
  client: WrapperClient,
  environmentPath = process.env.PATH ?? '',
  pathExtensions = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  platform: NodeJS.Platform = process.platform,
): WindowsCommandResolution | undefined {
  const extensions = pathExtensions.split(';').filter(Boolean)
  for (const rawDirectory of environmentPath.split(';')) {
    const directory = rawDirectory.trim().replaceAll('"', '')
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${client}${extension.toLowerCase()}`)
      const stats = lstatIfPresent(candidate)
      if (!stats?.isFile()) continue
      return { path: candidate, managed: isManagedClientWrapper(candidate, client, platform) }
    }
  }
  return undefined
}

export function installCodexWrapper(
  binaryPath: string,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
  managePath = true,
  homeDirectory = homedir(),
): Promise<string> {
  return installClientWrapper('codex', binaryPath, dryRun, platform, managePath, homeDirectory)
}

function healthUrl(profile: RouterProfile): { url: URL; port: number } {
  const config = loadConfig(statePaths(profile))
  const url = new URL(`http://${config.host}:${config.port}/health`)
  url.searchParams.set('secret', config.secret)
  return { url, port: config.port }
}

export function assertDaemonReplaceable(profile: RouterProfile, health: DaemonHealth): void {
  if (profile !== 'claude') return
  const activeSessions = Array.isArray(health.sessions) ? health.sessions.length : 0
  if (activeSessions === 0) return
  throw new DaemonReplacementBlockedError(
    `cannot update claude while ${activeSessions} Claude bridge session${activeSessions === 1 ? ' is' : 's are'} still active; ` +
    'fully exit Claude Code and retry the install',
  )
}

export async function assertDaemonStayedStopped(
  profile: RouterProfile,
  port: number,
  probe: HealthProbe,
  delay: Delay = Bun.sleep,
  attempts = 10,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(100)
    const health = await probe()
    if (health?.profile === profile) {
      throw new DaemonReplacementBlockedError(
        `${profile} daemon restarted during install on port ${port} as ${health.version ?? 'legacy'} ` +
        `(pid ${health.pid ?? 'unknown'}); fully exit active ${profile === 'claude' ? 'Claude Code' : 'Codex'} sessions and retry`,
      )
    }
  }
}

async function probeProfileHealth(profile: RouterProfile, timeout: number): Promise<DaemonHealth | undefined> {
  const { url } = healthUrl(profile)
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  return await response.json() as DaemonHealth
}

async function assertWindowsDaemonStayedStopped(profile: RouterProfile): Promise<void> {
  const { port } = healthUrl(profile)
  await assertDaemonStayedStopped(
    profile,
    port,
    () => probeProfileHealth(profile, 250),
  )
}

export type RunningProcess = {
  pid?: number
  commandLine?: string
  executablePath?: string
}

function commandLineArguments(commandLine: string): string[] {
  const trimmed = commandLine.trim()
  const executableEnd = trimmed.startsWith('"') ? trimmed.indexOf('"', 1) + 1 : trimmed.search(/\s|$/)
  return trimmed.slice(executableEnd).trim().split(/\s+/).filter(Boolean)
}

// The polite per-profile stop only reaches the daemon that answers on the
// health port. Daemons from previous versions that crashed, lost their port,
// or predate the health handshake linger forever; sweep every daemon process
// that runs out of the install directory. Bridge processes (mcp, launch) stay
// untouched because killing them drops live sessions.
export function staleDaemonPids(
  processes: RunningProcess[],
  installDirectory: string,
  profiles: RouterProfile[],
  currentPid: number,
): number[] {
  const prefix = `${resolve(installDirectory).toLowerCase()}${sep}`
  const pids: number[] = []
  for (const candidate of processes) {
    const pid = candidate.pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid === currentPid) continue
    if (!candidate.executablePath || !resolve(candidate.executablePath).toLowerCase().startsWith(prefix)) continue
    const args = commandLineArguments(candidate.commandLine ?? '')
    if (args[0] !== 'daemon') continue
    const profileFlag = args.indexOf('--profile')
    const profile = profileFlag >= 0 ? args[profileFlag + 1] : 'codex'
    if (!profiles.includes(profile as RouterProfile)) continue
    pids.push(pid)
  }
  return pids
}

async function listWindowsRouterProcesses(): Promise<RunningProcess[]> {
  const script = 'Get-CimInstance Win32_Process -Filter "Name LIKE \'telegram-agent-router%\'" | '
    + 'Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress'
  const child = Bun.spawn(['powershell.exe', '-NoProfile', '-Command', script], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const output = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error('could not enumerate running router processes')
  const trimmed = output.trim()
  if (!trimmed) return []
  type Row = { ProcessId?: number; CommandLine?: string; ExecutablePath?: string }
  const parsed = JSON.parse(trimmed) as Row | Row[]
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
    pid: row.ProcessId,
    ...(row.CommandLine ? { commandLine: row.CommandLine } : {}),
    ...(row.ExecutablePath ? { executablePath: row.ExecutablePath } : {}),
  }))
}

async function killStaleWindowsDaemons(profiles: RouterProfile[], dryRun: boolean): Promise<void> {
  const directory = dirname(installedBinaryPath('win32'))
  process.stdout.write(`kill leftover router daemons in ${directory}\n`)
  if (dryRun) return
  const pids = staleDaemonPids(await listWindowsRouterProcesses(), directory, profiles, process.pid)
  for (const pid of pids) {
    process.stdout.write(`kill stale daemon pid ${pid}\n`)
    try {
      process.kill(pid)
    } catch {
      continue
    }
    let stopped = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0)
        await Bun.sleep(100)
      } catch {
        stopped = true
        break
      }
    }
    if (!stopped) throw new Error(`stale daemon pid ${pid} did not stop`)
  }
}

async function stopExistingWindowsDaemon(profile: RouterProfile, dryRun: boolean): Promise<void> {
  process.stdout.write(`check and stop existing ${profile} daemon if safe\n`)
  if (dryRun) return
  const paths = statePaths(profile)
  if (!existsSync(paths.config)) return
  const health = await probeProfileHealth(profile, 750)
  if (health?.profile !== profile) return
  assertDaemonReplaceable(profile, health)
  let pid = Number.NaN
  if (typeof health.pid === 'number' && Number.isSafeInteger(health.pid)) {
    pid = health.pid
  } else if (existsSync(paths.pid)) {
    pid = Number.parseInt(readFileSync(paths.pid, 'utf8'), 10)
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return
  process.kill(pid, 'SIGTERM')
  let stopped = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(100)
    } catch {
      stopped = true
      break
    }
  }
  if (!stopped) throw new Error(`${profile} daemon pid ${pid} did not stop`)
  await assertWindowsDaemonStayedStopped(profile)
}

export async function waitForStableProfileHealth(
  profile: RouterProfile,
  version: string,
  port: number,
  probe: HealthProbe,
  delay: Delay = Bun.sleep,
  attempts = 40,
): Promise<void> {
  let lastError: unknown
  let healthyPid: number | undefined
  let consecutiveHealthy = 0
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const health = await probe()
      if (!health) throw new Error('health endpoint unavailable')
      if (health.profile !== profile || health.version !== version) {
        throw new Error(`port ${port} is running ${health.profile ?? 'unknown'} ${health.version ?? 'legacy'}, expected ${profile} ${version}`)
      }
      const pid = typeof health.pid === 'number' && Number.isSafeInteger(health.pid) && health.pid > 1
        ? health.pid
        : undefined
      consecutiveHealthy = pid !== undefined && pid === healthyPid ? consecutiveHealthy + 1 : 1
      healthyPid = pid
      if (healthyPid !== undefined && consecutiveHealthy >= 2) return
      lastError = new Error(`waiting for ${profile} ${version} pid ${health.pid ?? 'unknown'} to remain healthy`)
    } catch (error) {
      lastError = error
      consecutiveHealthy = 0
      healthyPid = undefined
    }
    await delay(250)
  }
  throw new Error(`${profile} service did not become healthy: ${String(lastError)}`)
}

async function verifyProfileHealth(profile: RouterProfile, dryRun: boolean): Promise<void> {
  process.stdout.write(`verify ${profile} profile health\n`)
  if (dryRun) return
  const { port } = healthUrl(profile)
  await waitForStableProfileHealth(
    profile,
    VERSION,
    port,
    () => probeProfileHealth(profile, 750),
  )
}

export async function installClients(options: InstallOptions, dryRun: boolean): Promise<void> {
  const platform = options.platform ?? process.platform
  const sourceBinary = resolveBinaryPath(options.binaryPath)
  const profiles: RouterProfile[] = options.target === 'both' ? ['claude', 'codex'] : [options.target]
  if (options.autostart !== false && platform === 'win32') {
    for (const profile of profiles) await stopExistingWindowsDaemon(profile, dryRun)
    await killStaleWindowsDaemons(profiles, dryRun)
  }
  const binary = await installProgramBinary(sourceBinary, dryRun, platform)
  for (const command of installationCommands({ ...options, binaryPath: binary })) {
    const remove = [
      options.claudeBinary ?? 'claude', 'mcp', 'remove',
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

  if (options.target === 'claude' || options.target === 'both') {
    if (!options.claudeBinary && !dryRun) throw new Error('Claude Code CLI not found; pass --claude-binary with the real executable')
    await installClaudeWrapper(binary, dryRun, platform, false)
  }

  if (options.target === 'codex' || options.target === 'both') {
    await installCodexWrapper(binary, dryRun, platform, false)
  }

  // installProgramBinary already prepended ~/.local/bin; prepending the shim
  // directory afterwards keeps it in front, so shims beat PATHEXT shadowing.
  if (platform === 'win32') await prependWindowsUserPath(windowsShimsDirectory(), dryRun)

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
