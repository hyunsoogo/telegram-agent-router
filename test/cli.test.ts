import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const entry = join(root, 'src', 'index.ts')

async function run(...args: string[]) {
  const proc = Bun.spawn([process.execPath, 'run', entry, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
}

describe('CLI bootstrap', () => {
  test('--version prints the embedded version', async () => {
    const result = await run('--version')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('0.2.7\n')
    expect(result.stderr).toBe('')
  })

  test('unknown commands fail with help', async () => {
    const result = await run('not-a-command')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unknown command: not-a-command')
    expect(result.stderr).toContain('telegram-agent-router configure')
  })
})
