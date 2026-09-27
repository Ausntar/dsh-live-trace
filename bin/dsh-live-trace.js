#!/usr/bin/env node
/**
 * `dsh-live-trace` executable.
 *
 * Thin wrapper: resolve the version, hand the arguments to the CLI, and map the
 * returned code onto the process exit status.
 */

import { readFileSync } from 'node:fs'

import { run } from '../src/cli/main.js'

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

run(process.argv.slice(2), { version }).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`dsh-live-trace: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
)
