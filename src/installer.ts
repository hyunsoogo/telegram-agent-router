import { basename, resolve } from 'node:path'
import type { ClientKind } from './protocol.js'

export type InstallTarget = Exclude<ClientKind, 'other'> | 'both'

export type InstallOptions = {
  target: InstallTarget
  sessionId: string
  label: string
  workspace: string
  binaryPath?: string
  claudeScope?: 'local' | 'user' | 'project'
}

export type InstallCommand = {
  client: 'claude' | 'codex'
  argv: string[]
}

function safeName(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!clean) throw new Error('session ID must contain a letter or number')
  return `telegram-router-${clean}`
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
  const binary = resolveBinaryPath(options.binaryPath)
  const name = safeName(options.sessionId)
  const bridgeArgs = (client: 'claude' | 'codex') => [
    binary,
    'mcp',
    '--client', client,
    '--session', options.sessionId,
    '--label', options.label,
    '--workspace', resolve(options.workspace),
  ]
  const commands: InstallCommand[] = []
  if (options.target === 'claude' || options.target === 'both') {
    commands.push({
      client: 'claude',
      argv: ['claude', 'mcp', 'add', '--scope', options.claudeScope ?? 'user', name, '--', ...bridgeArgs('claude')],
    })
  }
  if (options.target === 'codex' || options.target === 'both') {
    commands.push({
      client: 'codex',
      argv: ['codex', 'mcp', 'add', name, '--', ...bridgeArgs('codex')],
    })
  }
  return commands
}

export function printableCommand(argv: string[]): string {
  return argv.map(value => /^[A-Za-z0-9_./:\\=-]+$/.test(value) ? value : JSON.stringify(value)).join(' ')
}

export async function installClients(options: InstallOptions, dryRun: boolean): Promise<void> {
  for (const command of installationCommands(options)) {
    process.stdout.write(`[${command.client}] ${printableCommand(command.argv)}\n`)
    if (dryRun) continue
    const proc = Bun.spawn(command.argv, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    const code = await proc.exited
    if (code !== 0) throw new Error(`${command.client} MCP registration failed with exit code ${code}`)
  }
}
