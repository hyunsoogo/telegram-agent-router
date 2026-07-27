import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { RouterProfile } from './paths.js'

export type AutostartOptions = {
  binaryPath: string
  profiles: RouterProfile[]
  dryRun?: boolean
  platform?: NodeJS.Platform
}

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

async function run(argv: string[], dryRun: boolean, allowFailure = false): Promise<CommandResult> {
  process.stdout.write(`${argv.map(quote).join(' ')}\n`)
  if (dryRun) return { code: 0, stdout: '', stderr: '' }
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0 && !allowFailure) {
    throw new Error(`${argv[0]} failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`)
  }
  return { code, stdout, stderr }
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:\\=-]+$/.test(value) ? value : JSON.stringify(value)
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function windowsRunCommand(binaryPath: string, profile: RouterProfile): string[] {
  const escapedBinary = binaryPath.replaceAll("'", "''")
  const action = [
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle Hidden',
    '-Command',
    `"Start-Process -WindowStyle Hidden -FilePath '${escapedBinary}' -ArgumentList 'daemon --profile ${profile}'"`,
  ].join(' ')
  return [
    'reg.exe',
    'ADD',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '/v', `TelegramAgentRouter-${profile}`,
    '/t', 'REG_SZ',
    '/d', action,
    '/f',
  ]
}

export function launchAgentPlist(binaryPath: string, profile: RouterProfile): string {
  const label = `io.github.telegram-agent-router.${profile}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binaryPath)}</string>
    <string>daemon</string>
    <string>--profile</string>
    <string>${profile}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`
}

export function systemdUserUnit(binaryPath: string, profile: RouterProfile): string {
  const escaped = binaryPath
    .replaceAll('%', '%%')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
  return `[Unit]
Description=Telegram Agent Router (${profile})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${escaped}" daemon --profile ${profile}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`
}

function writeManagedFile(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, mode ? { mode } : undefined)
  if (mode) {
    try { chmodSync(path, mode) } catch {}
  }
  process.stdout.write(`wrote ${path}\n`)
}

async function installWindows(options: AutostartOptions): Promise<void> {
  for (const profile of options.profiles) {
    await run(windowsRunCommand(options.binaryPath, profile), Boolean(options.dryRun))
    const argv = [options.binaryPath, 'daemon', '--profile', profile]
    process.stdout.write(`${argv.map(quote).join(' ')}\n`)
    if (!options.dryRun) {
      const daemon = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      daemon.unref()
    }
  }
}

async function installMacos(options: AutostartOptions): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('cannot determine macOS user ID')
  const domain = `gui/${uid}`
  for (const profile of options.profiles) {
    const label = `io.github.telegram-agent-router.${profile}`
    const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
    if (!options.dryRun) writeManagedFile(path, launchAgentPlist(options.binaryPath, profile), 0o600)
    else process.stdout.write(`write ${path}\n`)
    await run(['launchctl', 'bootout', `${domain}/${label}`], Boolean(options.dryRun), true)
    let bootstrap: CommandResult | undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      bootstrap = await run(
        ['launchctl', 'bootstrap', domain, path],
        Boolean(options.dryRun),
        true,
      )
      if (options.dryRun || bootstrap.code === 0) break
      await Bun.sleep(250)
    }
    if (!bootstrap || bootstrap.code !== 0) {
      throw new Error(`launchctl bootstrap failed: ${bootstrap?.stderr.trim() || bootstrap?.stdout.trim() || 'unknown error'}`)
    }
    await run(['launchctl', 'enable', `${domain}/${label}`], Boolean(options.dryRun))
    await run(['launchctl', 'kickstart', '-k', `${domain}/${label}`], Boolean(options.dryRun))
  }
}

async function installLinux(options: AutostartOptions): Promise<void> {
  const unitDir = join(homedir(), '.config', 'systemd', 'user')
  for (const profile of options.profiles) {
    const path = join(unitDir, `telegram-agent-router-${profile}.service`)
    if (!options.dryRun) writeManagedFile(path, systemdUserUnit(options.binaryPath, profile), 0o600)
    else process.stdout.write(`write ${path}\n`)
  }
  await run(['systemctl', '--user', 'daemon-reload'], Boolean(options.dryRun))
  for (const profile of options.profiles) {
    const service = `telegram-agent-router-${profile}.service`
    await run(['systemctl', '--user', 'enable', service], Boolean(options.dryRun))
    await run(['systemctl', '--user', 'restart', service], Boolean(options.dryRun))
  }

  const username = userInfo().username
  const linger = await run(['loginctl', 'show-user', username, '-p', 'Linger', '--value'], Boolean(options.dryRun), true)
  if (options.dryRun || linger.stdout.trim() === 'yes') return
  const enabled = await run(['loginctl', 'enable-linger', username], false, true)
  if (enabled.code !== 0) {
    process.stderr.write(
      `WARNING: services are enabled, but boot-without-login still requires:\n` +
      `  sudo loginctl enable-linger ${quote(username)}\n`,
    )
  }
}

export async function installAutostart(options: AutostartOptions): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return await installWindows(options)
  if (platform === 'darwin') return await installMacos(options)
  if (platform === 'linux') return await installLinux(options)
  throw new Error(`automatic start is not supported on ${platform}`)
}
