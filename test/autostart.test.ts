import { describe, expect, test } from 'bun:test'
import { launchAgentPlist, systemdUserUnit, windowsRunCommand } from '../src/autostart.js'

describe('cross-platform automatic start definitions', () => {
  test('Windows uses a per-user login Run entry', () => {
    const command = windowsRunCommand('C:\\Tools\\router.exe', 'codex')
    expect(command).toContain('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')
    expect(command).toContain('TelegramAgentRouter-codex')
    expect(command.join(' ')).toContain('daemon --profile codex')
  })

  test('macOS LaunchAgent keeps each profile alive', () => {
    const plist = launchAgentPlist('/Applications/router', 'claude')
    expect(plist).toContain('io.github.telegram-agent-router.claude')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).toContain('<string>claude</string>')
  })

  test('Linux systemd user service restarts and starts at boot', () => {
    const unit = systemdUserUnit('/usr/local/bin/router', 'codex')
    expect(unit).toContain('ExecStart="/usr/local/bin/router" daemon --profile codex')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WantedBy=default.target')
  })
})
