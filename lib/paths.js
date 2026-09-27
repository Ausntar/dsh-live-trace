/**
 * Path resolution shared by the Host plugin and the standalone viewer.
 *
 * Both halves must agree on where the plugin publishes its sockets and its
 * server registry, so resolution lives here rather than in either half.
 *
 * @module dsh-live-trace/paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Environment variable that overrides the runtime directory.
 *
 * The plugin writes its sockets and server registry here and the viewer reads
 * them from here. Setting it on both sides lets a test, a sandboxed shell, or a
 * second Harness home keep its live-trace state isolated without touching
 * `$DSH_HOME`.
 */
export const RUNTIME_DIR_ENV = 'DSH_LIVE_TRACE_DIR'

/** Expand `~`, `~/`, and `~\` against the operating-system home. */
export function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the Harness home with the same precedence the Harness itself uses:
 * `$DSH_HOME`, then `~/.dsh`. A blank override counts as unset.
 */
export function resolveDshHome(env = process.env) {
  const configured = env[DSH_HOME_ENV]
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(expandHomePath(configured.trim()))
  }
  return join(homedir(), '.dsh')
}

/**
 * Resolve the directory holding live-trace runtime state.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} absolute runtime directory (not necessarily created yet).
 */
export function resolveRuntimeDir(env = process.env) {
  const configured = env[RUNTIME_DIR_ENV]
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(expandHomePath(configured.trim()))
  }
  return join(resolveDshHome(env), 'live-trace')
}

/** Subdirectory holding one socket file per running Harness process. */
export function socketsDir(runtimeDir) {
  return join(runtimeDir, 'sockets')
}

/** Subdirectory holding one server-registry JSON record per running Harness process. */
export function serversDir(runtimeDir) {
  return join(runtimeDir, 'servers')
}
