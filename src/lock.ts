import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export function acquireDaemonLock(pidFile: string): () => void {
  const claim = () => writeFileSync(pidFile, String(process.pid), { flag: 'wx', mode: 0o600 })
  try {
    claim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error
    const incumbent = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    if (Number.isSafeInteger(incumbent) && incumbent > 1) {
      try {
        process.kill(incumbent, 0)
        throw new Error(`router daemon already running with pid ${incumbent}`)
      } catch (probe) {
        if (probe instanceof Error && probe.message.startsWith('router daemon already running')) throw probe
      }
    }
    unlinkSync(pidFile)
    claim()
  }

  let released = false
  return () => {
    if (released) return
    released = true
    try {
      if (Number.parseInt(readFileSync(pidFile, 'utf8'), 10) === process.pid) unlinkSync(pidFile)
    } catch {}
  }
}
