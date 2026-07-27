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
  appServerPort: number,
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
    '--remote', `ws://127.0.0.1:${appServerPort}`,
    ...(hasExplicitCwd ? [] : ['-C', cwd]),
    ...args,
  ]
}

export async function launchCodex(
  binaryPath: string,
  paths: StatePaths,
  config: RouterConfig,
  args: string[],
): Promise<number> {
  if (!config.appServerPort) throw new Error('codex appServerPort is not configured')
  const argv = codexLaunchArgv(binaryPath, config.appServerPort, process.cwd(), args)
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

  const child = Bun.spawn(argv, {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await child.exited
}
