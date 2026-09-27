#!/usr/bin/env node
/**
 * `dsh-live-working` — the orca at its desk, animated for the live session.
 */

import { run } from '../src/cli/working/main.js'

const code = await run({
  stdout: process.stdout,
  stdin: process.stdin,
  stderr: process.stderr,
  argv: process.argv.slice(2)
})
process.exit(code)
