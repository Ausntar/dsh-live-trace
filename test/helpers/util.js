/**
 * Filesystem and terminal helpers shared by the test suite.
 * @module test/helpers/util
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Matches the SGR and other escape sequences the renderer emits. */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g

/** @param {string} text */
export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Create a temporary directory, preferring the OS temp area and falling back to
 * the workspace when the sandbox forbids it.
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeTempDir(prefix = 'dsh-live-trace-') {
  const workspaceTmp = join(process.cwd(), '.tmp')
  const candidates = [tmpdir(), workspaceTmp]
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true })
      return mkdtempSync(join(base, prefix))
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('no writable temporary directory')
}

/** @param {string} dir */
export function removeTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Poll until `predicate` is truthy.
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const intervalMs = options.intervalMs ?? 10
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.label ?? 'condition'}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
}

/** Sleep helper. @param {number} ms */
export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
