import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'
import type { SessionDescriptor } from './protocol.js'

function slug(value: string, fallback: string): string {
  const result = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 28)
  return result || fallback
}

export function gitBranch(workspace: string): string | undefined {
  const result = Bun.spawnSync(['git', '-C', workspace, 'branch', '--show-current'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if (result.exitCode !== 0) return undefined
  const branch = result.stdout.toString().trim()
  return branch || undefined
}

export function createClaudeSession(input: {
  workspace?: string
  label?: string
  summary?: string
  parentPid?: number
} = {}): SessionDescriptor {
  const workspace = resolve(input.workspace ?? process.cwd())
  const parentPid = input.parentPid ?? process.ppid
  const machine = slug(hostname(), 'host')
  const project = slug(basename(workspace), 'workspace')
  const digest = createHash('sha256')
    .update(`${hostname()}\0${workspace}\0${parentPid}\0${process.pid}`)
    .digest('hex')
    .slice(0, 8)
  return {
    id: `${machine}-${project}-${digest}`.slice(0, 64),
    client: 'claude',
    label: input.label ?? basename(workspace) ?? 'Claude',
    workspace,
    branch: gitBranch(workspace),
    summary: input.summary,
    status: 'active',
    startedAt: new Date().toISOString(),
  }
}
