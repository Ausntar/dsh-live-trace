/**
 * The wire protocol between the Host observer plugin and the standalone
 * `dsh-live-trace` viewer.
 *
 * Transport is newline-delimited JSON over a Unix domain socket. Every record
 * is a plain JSON object with a `v` (protocol version) and a `kind`. The
 * viewer treats unknown kinds as forward-compatible noise, and the plugin
 * ignores unknown client kinds: neither side can break the other by being
 * newer.
 *
 * @module dsh-live-trace/protocol
 */

/** Protocol version carried on every record in both directions. */
export const PROTOCOL_VERSION = 1

/** Record kinds the plugin sends to a viewer. */
export const SERVER_KIND = {
  /** First record on every connection: server identity, sessions, backlog policy. */
  HELLO: 'hello',
  /** The full session list changed (a session was created or disposed). */
  SESSIONS: 'sessions',
  /** One normalized trace entry for the selected session. */
  ENTRY: 'entry',
  /** Coalesced live streaming text for the selected session. */
  STREAM: 'stream',
  /** The live stream for the selected session settled or was abandoned. */
  STREAM_END: 'stream-end',
  /** Liveness/status change for the selected session. */
  STATUS: 'status',
  /** Cumulative token accounting for the selected session. */
  USAGE: 'usage',
  /** The session's aggregated file changes, one entry per touched path. */
  EDITS: 'edits',
  /** Periodic keepalive; carries server clock and connection count. */
  HEARTBEAT: 'heartbeat',
  /** A protocol-level problem the viewer should surface. */
  ERROR: 'error'
}

/** Record kinds a viewer sends to the plugin. */
export const CLIENT_KIND = {
  /** Bind to a session id, or to the server's current default when omitted. */
  SELECT: 'select',
  /** Ask for the retained backlog of the bound session. */
  REPLAY: 'replay',
  /** Application-level ping; the plugin answers with a heartbeat. */
  PING: 'ping'
}

/** How many normalized entries a viewer may request in one replay. */
export const MAX_REPLAY_ENTRIES = 5000

/** Longest single NDJSON line either side will buffer before failing the connection. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024

/**
 * Serialize one record as an NDJSON line.
 * @param {object} record
 * @returns {string}
 */
export function encodeRecord(record) {
  return `${JSON.stringify(record)}\n`
}

/**
 * Build an incremental NDJSON decoder.
 *
 * Sockets deliver arbitrary byte splits, so the decoder buffers until it sees a
 * newline and rejects a single over-long line instead of growing without bound.
 * @returns {{ push(chunk: string | Buffer): object[], pending(): number }}
 */
export function createLineDecoder() {
  let buffer = ''
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const out = []
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        if (trimmed.trim().length > 0) {
          let parsed
          try {
            parsed = JSON.parse(trimmed)
          } catch {
            throw new Error(`dsh-live-trace: malformed JSON record (${trimmed.length} bytes)`)
          }
          out.push(parsed)
        }
        index = buffer.indexOf('\n')
      }
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = ''
        throw new Error(`dsh-live-trace: record exceeded ${MAX_LINE_BYTES} bytes`)
      }
      return out
    },
    pending() {
      return buffer.length
    }
  }
}

/** @returns {boolean} whether a decoded record is one this module understands. */
export function isKnownRecord(record, kinds) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.kind === 'string' &&
    Object.values(kinds).includes(record.kind)
  )
}
