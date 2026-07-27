const PASSTHROUGH_COMMANDS = new Set([
  'agents',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'install',
  'mcp',
  'plugin',
  'setup-token',
  'update',
  'upgrade',
])

export function claudeLaunchArgv(
  binaryPath: string,
  args: string[],
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): string[] {
  if (!interactive) return [binaryPath, ...args]
  if (args.some(value => ['--help', '-h', '--version', '-v', '--print', '-p'].includes(value))) {
    return [binaryPath, ...args]
  }
  if (args.some(value => ['--channels', '--dangerously-load-development-channels'].includes(value))) {
    return [binaryPath, ...args]
  }
  const firstCommand = args.find(value => !value.startsWith('-'))
  if (firstCommand && PASSTHROUGH_COMMANDS.has(firstCommand)) return [binaryPath, ...args]
  return [
    binaryPath,
    '--dangerously-load-development-channels',
    'server:telegram-router',
    ...args,
  ]
}

export async function launchClaude(binaryPath: string, args: string[]): Promise<number> {
  const child = Bun.spawn(claudeLaunchArgv(binaryPath, args), {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await child.exited
}
