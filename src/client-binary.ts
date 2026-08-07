import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type ClientKind = 'claude' | 'codex'

export type ClientBinaryIdentity = {
  path: string
  size: number
  mtimeMs: number
}

export const CLIENT_WRAPPER_MARKERS: Record<ClientKind, string> = {
  claude: 'telegram-agent-router managed Claude wrapper',
  codex: 'telegram-agent-router managed Codex wrapper',
}

const MAX_WRAPPER_BYTES = 16 * 1024

function codexCurrentBinaryForReleasePath(path: string): string | undefined {
  const match = path.match(/^(.*[\\/]standalone)[\\/]releases[\\/][^\\/]+[\\/]bin[\\/](codex(?:\.exe)?)$/i)
  if (!match) return undefined
  const separator = path.includes('\\') ? '\\' : '/'
  return `${match[1]}${separator}current${separator}bin${separator}${match[2]}`
}

function isCodexStandaloneCurrentPath(path: string): boolean {
  return /[\\/]standalone[\\/]current[\\/]bin[\\/]codex(?:\.exe)?$/i.test(path)
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function isManagedClientWrapper(
  path: string,
  client: ClientKind,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const stats = lstatIfPresent(path)
  if (!stats?.isFile() || stats.size > MAX_WRAPPER_BYTES) return false
  const content = readFileSync(path, 'utf8')
  if (content.includes(CLIENT_WRAPPER_MARKERS[client])) return true
  if (client === 'claude') return false
  return platform === 'win32'
    ? content.includes(' launch codex -- %*')
    : content.includes(' launch codex -- "$@"')
}

export function resolveClientBinaryPath(
  candidate: string | undefined,
  client: ClientKind,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!candidate) return undefined
  const absolute = resolve(candidate)
  const current = client === 'codex' ? codexCurrentBinaryForReleasePath(absolute) : undefined
  const selected = current && lstatIfPresent(current) ? current : absolute
  let canonical: string
  try {
    canonical = realpathSync(selected)
  } catch {
    const label = client === 'claude' ? 'Claude' : 'Codex'
    throw new Error(`${label} binary does not resolve to an existing file: ${selected}`)
  }
  const target = statSync(canonical)
  if (
    !target.isFile()
    || (platform !== 'win32' && process.platform !== 'win32' && (target.mode & 0o111) === 0)
  ) {
    const label = client === 'claude' ? 'Claude' : 'Codex'
    throw new Error(`${label} binary is not an executable file: ${canonical}`)
  }
  if (isManagedClientWrapper(canonical, client, platform)) {
    const label = client === 'claude' ? 'Claude' : 'Codex'
    throw new Error(`${label} binary resolves to the managed router wrapper: ${canonical}; pass --${client}-binary with the real executable`)
  }
  // Codex standalone updates atomically retarget the `current` junction. Keep
  // that stable path as the executable identity while validating its target.
  return client === 'codex' && isCodexStandaloneCurrentPath(selected) ? selected : canonical
}

export function codexStandaloneCurrentCandidates(
  platform: NodeJS.Platform = process.platform,
  environment: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): string[] {
  const executable = platform === 'win32' ? 'codex.exe' : 'codex'
  const roots = [
    environment.CODEX_HOME,
    ...(platform === 'win32' && environment.LOCALAPPDATA
      ? [
          join(environment.LOCALAPPDATA, 'OpenAI', 'Codex'),
          join(environment.LOCALAPPDATA, 'Codex'),
        ]
      : []),
    join(homeDirectory, '.codex'),
  ].filter((root): root is string => Boolean(root))
  return [...new Set(roots.flatMap(root => [
    resolve(root, 'packages', 'standalone', 'current', 'bin', executable),
    resolve(root, 'standalone', 'current', 'bin', executable),
  ]))]
}

export function findUnmanagedClientBinary(
  client: ClientKind,
  environmentPath = process.env.PATH ?? '',
  pathExtensions = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const separator = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32'
    ? pathExtensions.split(';').filter(Boolean).map(value => value.startsWith('.') ? value : `.${value}`)
    : ['']
  for (const rawDirectory of environmentPath.split(separator)) {
    const directory = rawDirectory.trim().replaceAll('"', '')
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${client}${platform === 'win32' ? extension.toLowerCase() : extension}`)
      const stats = lstatIfPresent(candidate)
      if (!stats || (!stats.isFile() && !stats.isSymbolicLink())) continue
      if (isManagedClientWrapper(candidate, client, platform)) continue
      try {
        return resolveClientBinaryPath(candidate, client, platform)
      } catch {
        continue
      }
    }
  }
  return undefined
}

export function resolveCodexRuntimeBinary(
  configuredPath: string | undefined,
  environmentPath = process.env.PATH ?? '',
  pathExtensions = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  platform: NodeJS.Platform = process.platform,
  standaloneCandidates = codexStandaloneCurrentCandidates(platform),
): string | undefined {
  if (configuredPath) {
    try {
      return resolveClientBinaryPath(configuredPath, 'codex', platform)
    } catch {}
  }
  for (const candidate of standaloneCandidates) {
    try {
      return resolveClientBinaryPath(candidate, 'codex', platform)
    } catch {}
  }
  return findUnmanagedClientBinary('codex', environmentPath, pathExtensions, platform)
}

export function clientBinaryIdentity(
  candidate: string,
  client: ClientKind,
  platform: NodeJS.Platform = process.platform,
): ClientBinaryIdentity {
  const path = resolveClientBinaryPath(candidate, client, platform)
  if (!path) throw new Error(`${client} binary is missing`)
  const stats = statSync(path)
  return { path, size: stats.size, mtimeMs: stats.mtimeMs }
}

export function sameClientBinary(
  left: ClientBinaryIdentity | undefined,
  right: ClientBinaryIdentity | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.path === right.path
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs,
  )
}

export function codexVersionCheck(
  installed: ClientBinaryIdentity | undefined,
  running: ClientBinaryIdentity | undefined,
): [boolean, string] {
  if (!installed) return [false, 'installed Codex binary not found']
  if (!running) return [false, `router did not report its Codex runtime; installed ${installed.path}`]
  const matches = sameClientBinary(installed, running)
  return [
    matches,
    matches
      ? `${installed.path} (${installed.size} bytes)`
      : `installed ${installed.path} (${installed.size} bytes) differs from router runtime ${running.path} (${running.size} bytes); restart or launch Codex through the router`,
  ]
}
