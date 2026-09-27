/**
 * Discovery registry for running Harness processes that host the observer.
 *
 * The plugin owns one socket per process, but a viewer starts with no idea
 * which process or socket to use. Each plugin instance therefore publishes a
 * small JSON record (its pid, socket path, working directory, and session
 * list) and refreshes a heartbeat; the viewer scans that directory, drops dead
 * processes, and picks the best match.
 *
 * @module dsh-live-trace/registry
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROTOCOL_VERSION } from './protocol.js'
import { serversDir } from './paths.js'

/** A record older than this (by heartbeat) is treated as abandoned. */
export const STALE_HEARTBEAT_MS = 60_000

/** Registry records are tiny; anything larger is corruption. */
const MAX_RECORD_BYTES = 1024 * 1024

/**
 * @param {string} dir servers directory
 * @param {number} pid
 * @returns {string} absolute path of one process's registry record
 */
export function serverRecordPath(dir, pid) {
  return join(dir, `${pid}.json`)
}

/**
 * @param {string} dir servers directory
 * @param {object} record
 * @returns {string} the path written
 */
export function writeServerRecord(dir, record) {
  mkdirSync(dir, { recursive: true })
  const target = serverRecordPath(dir, record.pid)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ ...record, v: PROTOCOL_VERSION })}\n`, { mode: 0o600 })
  renameSync(temp, target)
  return target
}

/**
 * @param {string} dir servers directory
 * @param {number} pid
 */
export function removeServerRecord(dir, pid) {
  rmSync(serverRecordPath(dir, pid), { force: true })
}

/**
 * Remove a registry record only when it still describes `socket`.
 *
 * A reloaded plugin generation and a late disposer of the previous generation
 * share one pid, so an unconditional delete could remove the live generation's
 * record.
 *
 * @param {string} dir servers directory
 * @param {number} pid
 * @param {string} socket socket path the caller owns
 * @returns {boolean} whether a record was removed
 */
export function removeServerRecordIfOwner(dir, pid, socket) {
  const path = serverRecordPath(dir, pid)
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (record !== null && typeof record === 'object' && record.socket !== socket) return false
  } catch {
    return false
  }
  rmSync(path, { force: true })
  return true
}

/**
 * Read every parseable registry record from a directory.
 * @param {string} dir servers directory
 * @returns {object[]}
 */
export function readServerRecords(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const raw = readFileSync(path, 'utf8')
      if (raw.length > MAX_RECORD_BYTES) continue
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.pid === 'number') records.push(parsed)
    } catch {
      /* a half-written or corrupt record is not a reason to fail discovery */
    }
  }
  return records
}

/**
 * @param {number} pid
 * @returns {boolean} whether the process exists and is signalable by us.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM'
  }
}

/**
 * Drop records whose process is gone and whose heartbeat has gone stale.
 *
 * A fresh heartbeat is trusted unconditionally, because only a live writer can
 * refresh it. Liveness probing alone is not enough: a viewer running in a
 * different PID namespace than the Harness — a container, WSL, or a sandboxed
 * shell — cannot signal the Harness process, and treating that as "dead" would
 * let a read-only discovery command delete a live server's record.
 *
 * @param {string} dir servers directory
 * @param {{ now?: number, staleMs?: number, removeFiles?: boolean }} [options]
 * @returns {object[]} the surviving records, newest heartbeat first
 */
export function pruneServerRecords(dir, options = {}) {
  const now = options.now ?? Date.now()
  const staleMs = options.staleMs ?? STALE_HEARTBEAT_MS
  const removeFiles = options.removeFiles ?? true
  const surviving = []
  for (const record of readServerRecords(dir)) {
    const heartbeat = typeof record.heartbeat === 'number' ? record.heartbeat : record.startedAt ?? 0
    const fresh = now - heartbeat <= staleMs
    if (fresh || isProcessAlive(record.pid)) {
      surviving.push(record)
    } else if (removeFiles) {
      // Best effort: a concurrent viewer on another account may lack permission.
      try {
        rmSync(serverRecordPath(dir, record.pid), { force: true })
      } catch {
        /* ignore */
      }
    }
  }
  surviving.sort((a, b) => (b.heartbeat ?? b.startedAt ?? 0) - (a.heartbeat ?? a.startedAt ?? 0))
  return surviving
}

/**
 * Choose the Harness process a viewer should attach to.
 *
 * Precedence: an explicit socket wins outright; then an explicit pid; then the
 * record whose serving directory matches `cwd`; then the freshest record.
 *
 * @param {object[]} records records from {@link pruneServerRecords}
 * @param {{ socket?: string, pid?: number, cwd?: string }} [preferences]
 * @returns {object | undefined}
 */
export function selectServerRecord(records, preferences = {}) {
  if (preferences.socket !== undefined) {
    const exact = records.find((record) => record.socket === preferences.socket)
    if (exact !== undefined) return exact
    // An explicit socket is usable even when no registry record describes it,
    // which is what `--socket` promises and what a sandboxed run needs.
    return { pid: -1, socket: preferences.socket, cwd: preferences.cwd, sessions: [], activeSessionId: null }
  }
  if (records.length === 0) return undefined
  if (preferences.pid !== undefined) {
    return records.find((record) => record.pid === preferences.pid) ?? freshest(records)
  }
  if (preferences.cwd !== undefined) {
    const byCwd = records.find((record) => record.cwd === preferences.cwd)
    if (byCwd !== undefined) return byCwd
  }
  return freshest(records)
}

/** @returns {object} the record with the newest heartbeat, irrespective of input order. */
function freshest(records) {
  return records.reduce((best, record) =>
    (record.heartbeat ?? record.startedAt ?? 0) > (best.heartbeat ?? best.startedAt ?? 0) ? record : best
  )
}

/**
 * Pick the session a viewer should bind to.
 *
 * Precedence: an explicit session id; then the session whose `cwd` matches the
 * viewer's; then the record's own `activeSessionId`; then the newest session.
 *
 * @param {object} record a registry record
 * @param {{ sessionId?: string, cwd?: string }} [preferences]
 * @returns {object | undefined}
 */
export function selectSession(record, preferences = {}) {
  const sessions = Array.isArray(record?.sessions) ? record.sessions : []
  if (preferences.sessionId !== undefined) {
    return sessions.find((session) => session.id === preferences.sessionId)
  }
  if (sessions.length === 0) return undefined
  if (preferences.cwd !== undefined) {
    const matches = sessions.filter((session) => session.cwd === preferences.cwd)
    if (matches.length > 0) return newestSession(matches)
  }
  if (typeof record.activeSessionId === 'string') {
    const active = sessions.find((session) => session.id === record.activeSessionId)
    if (active !== undefined) return active
  }
  return newestSession(sessions)
}

/** @returns {object} the most recently created session in a list */
export function newestSession(sessions) {
  return sessions.reduce((best, session) =>
    (session.createdAt ?? 0) >= (best.createdAt ?? 0) ? session : best
  )
}

/** Convenience wrapper resolving the standard servers directory. */
export function resolveServersDir(runtimeDir) {
  return serversDir(runtimeDir)
}
