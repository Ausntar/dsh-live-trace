/**
 * Small formatting helpers shared by the dashboard's chrome.
 * @module dsh-live-trace/format
 */

/**
 * Compact elapsed time: `0.8s`, `12.3s`, `1m05s`, `1h04m`.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s'
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
  }
  const hours = Math.floor(seconds / 3600)
  return `${hours}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/**
 * Wall-clock `HH:MM:SS` in local time.
 * @param {number} epochMs
 * @returns {string}
 */
export function formatClock(epochMs) {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

/**
 * Compact token count: `947`, `4.2K`, `1.3M`.
 * @param {number} value
 * @returns {string}
 */
export function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * Shorten a session id while keeping its distinguishing tail.
 * @param {string} id
 * @param {number} [width]
 * @returns {string}
 */
export function shortSessionId(id, width = 20) {
  if (typeof id !== 'string' || id.length <= width) return id ?? ''
  const tail = Math.max(4, width - 4)
  return `…${id.slice(id.length - tail)}`
}

/**
 * Middle-truncate a filesystem path so both its root and leaf survive.
 * @param {string} path
 * @param {number} width
 * @returns {string}
 */
export function shortPath(path, width) {
  if (typeof path !== 'string' || path.length <= width) return path ?? ''
  if (width <= 8) return `…${path.slice(path.length - (width - 1))}`
  const head = Math.ceil((width - 1) / 3)
  const tailPart = width - 1 - head
  return `${path.slice(0, head)}…${path.slice(path.length - tailPart)}`
}
