/**
 * In-process instance bookkeeping for the observer plugin.
 *
 * Cordis hot reload can load a fresh generation of a plugin before the previous
 * generation's disposer has finished. Both generations would then want the same
 * socket path (same pid). This module lets the new generation release the old
 * server first, and lets a stale disposer avoid deleting the live generation's
 * discovery record.
 *
 * @module dsh-live-trace/instance
 */

/** @type {Map<number, { close: () => Promise<void> }>} */
const active = new Map()

/**
 * Close a previously registered instance for this process, if any.
 * @param {number} pid
 * @returns {Promise<void>}
 */
export async function disconnectExistingInstance(pid) {
  const existing = active.get(pid)
  if (existing === undefined) return
  active.delete(pid)
  try {
    await existing.close()
  } catch {
    /* a half-torn-down server is exactly why we are here */
  }
}

/**
 * Record the server a fresh instance now owns.
 * @param {number} pid
 * @param {{ close: () => Promise<void> }} server
 */
export function registerInstance(pid, server) {
  active.set(pid, server)
}

/**
 * Drop a disposed instance's registration.
 *
 * Guarded on identity: a slow disposer from a previous generation must not
 * evict the server a newer generation has already registered.
 *
 * @param {number} pid
 * @param {{ close: () => Promise<void> }} server the caller's own server
 * @returns {boolean} whether this call removed the registration
 */
export function releaseInstance(pid, server) {
  if (active.get(pid) !== server) return false
  active.delete(pid)
  return true
}

/**
 * @param {number} pid
 * @returns {boolean} whether this process currently has a registered observer
 */
export function hasInstance(pid) {
  return active.has(pid)
}

/** @returns {number} how many observer instances this process holds (0 or 1) */
export function instanceCount() {
  return active.size
}
