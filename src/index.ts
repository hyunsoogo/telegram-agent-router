#!/usr/bin/env bun

import { main } from './cli.js'

try {
  await main()
} catch (error) {
  process.stderr.write(`telegram-agent-router: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
