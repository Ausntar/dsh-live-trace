/**
 * Locate the live DeepSeek Harness installation so integration tests can boot
 * the real `@deepseek-ai/dsh-session` plugin instead of a mock.
 *
 * The test suite must pass on a machine without a Harness install too, so
 * callers get `null` and skip rather than fail.
 *
 * @module test/helpers/dsh
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Candidate directories that hold a Harness `node_modules`. */
function candidateRoots() {
  const roots = []
  if (process.env.DSH_LIVE_TRACE_DSH_ROOT) roots.push(process.env.DSH_LIVE_TRACE_DSH_ROOT)
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles', 'node_modules'))
  roots.push(join(homedir(), '.dsh', 'profiles', 'node_modules'))
  roots.push(join(homedir(), '.dsh', 'profiles', 'web', 'node_modules'))
  const globalRoot = process.env.npm_config_prefix
  if (globalRoot) roots.push(join(globalRoot, 'lib', 'node_modules'))
  return roots
}

/**
 * @returns {string | null} a `node_modules` directory that can resolve both the
 * Harness packages the integration test needs, or `null`.
 */
export function findHarnessModules(roots = candidateRoots()) {
  for (const root of roots) {
    const marker = join(root, '@deepseek-ai', 'dsh-session', 'package.json')
    const cordis = join(root, '@deepseek-ai', 'cordis', 'package.json')
    if (existsSync(marker) && existsSync(cordis)) return root
  }
  return null
}

/**
 * Import the real Cordis `Context` and `dsh-session` plugin.
 * @returns {Promise<{ Context: any, sessionPlugin: any, moduleRoot: string } | null>}
 */
export async function loadHarnessRuntime() {
  const root = findHarnessModules()
  if (root === null) return null
  const require_ = createRequire(join(root, 'noop.js'))
  const cordis = await import(pathToFileURL(require_.resolve('@deepseek-ai/cordis')).href)
  const sessionModule = await import(pathToFileURL(require_.resolve('@deepseek-ai/dsh-session')).href)
  return {
    moduleRoot: root,
    Context: cordis.Context,
    sessionPlugin: sessionModule.default ?? sessionModule
  }
}

/** The installed Harness version, or `null` when it cannot be read. */
export function harnessVersion(root) {
  const resolved = root ?? findHarnessModules()
  if (resolved === null) return null
  try {
    return JSON.parse(readFileSync(join(resolved, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}
