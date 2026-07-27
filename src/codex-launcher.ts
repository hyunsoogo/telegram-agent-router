import type { RouterConfig, StatePaths } from './paths.js'

function healthUrl(config: RouterConfig): string {
  const url = new URL(`http://${config.host}:${config.port}/health`)
  url.searchParams.set('secret', config.secret)
  return url.toString()
}

async function healthy(config: RouterConfig): Promise<boolean> {
  try {
    const response = await fetch(healthUrl(config), { signal: AbortSignal.timeout(750) })
    return response.ok
  } catch {
    return false
  }
}

export function codexLaunchArgv(
  binaryPath: string,
  remoteUrl: string,
  cwd: string,
  args: string[],
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): string[] {
  if (!interactive) return [binaryPath, ...args]
  const passthrough = new Set([
    'app-server', 'app', 'apply', 'archive', 'cloud', 'completion', 'debug', 'delete',
    'doctor', 'e', 'exec', 'exec-server', 'features', 'help', 'login', 'logout', 'mcp',
    'mcp-server', 'plugin', 'remote-control', 'review', 'sandbox', 'unarchive', 'update',
  ])
  if (args.some(value => ['--help', '-h', '--version', '-V'].includes(value))) {
    return [binaryPath, ...args]
  }
  const firstCommand = args.find(value => !value.startsWith('-'))
  if (firstCommand && passthrough.has(firstCommand)) return [binaryPath, ...args]
  const hasExplicitCwd = args.some(value => value === '-C' || value === '--cd')
  return [
    binaryPath,
    '--remote', remoteUrl,
    ...(hasExplicitCwd ? [] : ['-C', cwd]),
    ...args,
  ]
}

async function codexClientUrl(config: RouterConfig): Promise<string> {
  const url = new URL(`http://${config.host}:${config.port}/codex-client/register`)
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.secret}` },
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`Codex client registration failed with HTTP ${response.status}`)
  const result = await response.json() as { url?: unknown }
  if (typeof result.url !== 'string' || !result.url.startsWith('ws://127.0.0.1:')) {
    throw new Error('Codex router returned an invalid client URL')
  }
  return result.url
}

export async function launchCodex(
  binaryPath: string,
  paths: StatePaths,
  config: RouterConfig,
  args: string[],
): Promise<number> {
  if (!config.appServerPort) throw new Error('codex appServerPort is not configured')
  let argv = codexLaunchArgv(binaryPath, 'ws://127.0.0.1/unused', process.cwd(), args)
  const routed = argv[1] === '--remote'
  if (routed && !await healthy(config)) {
    const routerBinary = process.execPath
    const daemon = Bun.spawn([routerBinary, 'daemon', '--profile', 'codex'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    daemon.unref()
    for (let attempt = 0; attempt < 40 && !await healthy(config); attempt += 1) await Bun.sleep(250)
  }
  if (routed && !await healthy(config)) {
    throw new Error(`codex router did not become healthy; run doctor --profile codex (${paths.config})`)
  }
  if (routed) argv = codexLaunchArgv(binaryPath, await codexClientUrl(config), process.cwd(), args)

  const child = Bun.spawn(argv, {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await child.exited
}
