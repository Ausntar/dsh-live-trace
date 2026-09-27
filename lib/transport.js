/**
 * The Host-side Unix domain socket server: the transport the observer plugin
 * publishes on and the standalone viewer subscribes to.
 *
 * A Unix socket rather than a TCP port is deliberate. It cannot be reached from
 * another machine, it cannot collide with the Harness web server's port, it
 * needs no authentication story, and its permissions are the access control.
 * Each Harness process owns one socket file under
 * `<runtimeDir>/sockets/<pid>.sock`, so two `dsh` processes never fight over
 * one path.
 *
 * @module dsh-live-trace/transport
 */

import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'

import { socketsDir } from './paths.js'
import { CLIENT_KIND, createLineDecoder, encodeRecord, MAX_REPLAY_ENTRIES, PROTOCOL_VERSION, SERVER_KIND } from './protocol.js'

/** How often an idle connection receives a heartbeat, in milliseconds. */
export const HEARTBEAT_MS = 5000

/** Entries replayed to a viewer that does not ask for a specific count. */
export const DEFAULT_REPLAY_LIMIT = 500

/**
 * @param {string} runtimeDir
 * @param {number} pid
 * @returns {string} the socket path this process should own
 */
export function defaultSocketPath(runtimeDir, pid = process.pid) {
  return `${socketsDir(runtimeDir)}/${pid}.sock`
}

/**
 * Start the observer's socket server.
 *
 * @param {object} options
 * @param {string} options.socketPath       absolute path to bind
 * @param {import('./tracker.js').TraceHub} options.hub
 * @param {() => object} [options.serverInfo] server identity for the `hello` record
 * @param {number} [options.heartbeatMs]
 * @param {(error: Error) => void} [options.onError]
 * @returns {{ socketPath: string, close: () => Promise<void>, clientCount: () => number, broadcast: (record: object) => void, ready: Promise<void> }}
 */
export function createTraceServer(options) {
  const { socketPath, hub, serverInfo = () => ({}), heartbeatMs = HEARTBEAT_MS, onError } = options

  mkdirSync(socketsDir(options.runtimeDir ?? dirnameOf(socketPath)), { recursive: true, mode: 0o700 })
  // A leftover file from a crashed process would make bind() fail with EADDRINUSE.
  rmSync(socketPath, { force: true })

  const clients = new Set()
  let closed = false

  const server = createServer((socket) => {
    /** @type {{ socket: import('node:net').Socket, decoder: ReturnType<typeof createLineDecoder>, sessionId: string | null, send: (record: object) => void }} */
    const client = { socket, decoder: createLineDecoder(), sessionId: null, send: () => {} }
    clients.add(client)
    socket.setNoDelay(true)
    socket.setEncoding('utf8')

    const send = (record) => {
      if (socket.destroyed) return
      try {
        socket.write(encodeRecord({ v: PROTOCOL_VERSION, ...record }))
      } catch {
        /* the socket already died; close handling below cleans up */
      }
    }

    client.send = send
    client.sessionId = null

    // The session list is enough to start: the viewer answers with an explicit
    // SELECT, which is what makes per-viewer session routing unambiguous.
    send({
      kind: SERVER_KIND.HELLO,
      protocol: PROTOCOL_VERSION,
      server: serverInfo(),
      sessions: hub.sessionsInfo(),
      activeSessionId: hub.activeSessionId,
      replayLimit: DEFAULT_REPLAY_LIMIT
    })

    socket.on('data', (chunk) => {
      let records
      try {
        records = client.decoder.push(chunk)
      } catch (error) {
        onError?.(/** @type {Error} */ (error))
        socket.destroy()
        return
      }
      for (const record of records) handleClientRecord(client, record, hub, send)
    })
    socket.on('error', () => {
      /* handled by close */
    })
    socket.on('close', () => {
      clients.delete(client)
    })
  })

  server.on('error', (error) => onError?.(error))

  const ready = new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600)
      } catch {
        /* the platform may not support chmod on sockets; the directory mode still applies */
      }
      resolvePromise(undefined)
    })
  })

  const heartbeat = setInterval(() => {
    const record = { kind: SERVER_KIND.HEARTBEAT, at: Date.now(), clients: clients.size }
    for (const client of clients) client.send(record)
  }, heartbeatMs)
  heartbeat.unref?.()

  /**
   * Route one hub record: session-scoped records only reach viewers bound to
   * that session; the session list reaches everyone.
   * @param {object} record
   */
  function broadcast(record) {
    if (closed) return
    if (record.kind === SERVER_KIND.SESSIONS) {
      // `boundSessionId` is per-viewer state, so the shared list record is
      // personalized on the way out rather than broadcast verbatim.
      for (const client of clients) client.send({ ...record, boundSessionId: client.sessionId })
      return
    }
    const sessionId = record.sessionId
    for (const client of clients) {
      if (client.sessionId !== null && client.sessionId === sessionId) client.send(record)
    }
  }

  const unsubscribe = hub.subscribe(broadcast)

  return {
    socketPath,
    ready,
    clientCount: () => clients.size,
    broadcast,
    async close() {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      for (const client of clients) client.socket.destroy()
      clients.clear()
      await new Promise((resolvePromise) => server.close(() => resolvePromise(undefined)))
      rmSync(socketPath, { force: true })
    }
  }
}

function dirnameOf(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '.' : path.slice(0, index)
}

/**
 * Apply one client request.
 * @param {{ sessionId: string | null }} client
 * @param {any} record
 * @param {import('./tracker.js').TraceHub} hub
 * @param {(record: object) => void} send
 */
function handleClientRecord(client, record, hub, send) {
  if (record === null || typeof record !== 'object') return
  switch (record.kind) {
    case CLIENT_KIND.SELECT: {
      const explicit = record.sessionId !== undefined && record.sessionId !== null
      const requested = explicit ? String(record.sessionId) : hub.activeSessionId
      if (requested === null || !hub.stateOf(requested)) {
        if (explicit) {
          send({
            kind: SERVER_KIND.ERROR,
            message: `unknown session ${String(record.sessionId)}`,
            sessions: hub.sessionsInfo(),
            boundSessionId: client.sessionId
          })
        } else {
          // No explicit request and nothing to bind to yet: an empty Harness is
          // not an error, so answer with the (empty) session list and wait.
          send({
            kind: SERVER_KIND.SESSIONS,
            sessions: hub.sessionsInfo(),
            activeSessionId: hub.activeSessionId,
            boundSessionId: client.sessionId
          })
        }
        return
      }
      client.sessionId = requested
      const limit = clampLimit(record.limit)
      send({
        kind: SERVER_KIND.SESSIONS,
        sessions: hub.sessionsInfo(),
        activeSessionId: hub.activeSessionId,
        boundSessionId: client.sessionId
      })
      for (const replay of hub.snapshot(requested, limit)) send(replay)
      break
    }
    case CLIENT_KIND.REPLAY: {
      if (client.sessionId === null) return
      for (const replay of hub.snapshot(client.sessionId, clampLimit(record.limit))) send(replay)
      break
    }
    case CLIENT_KIND.PING:
      send({ kind: SERVER_KIND.HEARTBEAT, at: Date.now(), pong: true })
      break
    default:
      // Forward compatibility: an unknown client request is ignored, never fatal.
      break
  }
}

function clampLimit(limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_REPLAY_LIMIT
  return Math.max(1, Math.min(MAX_REPLAY_ENTRIES, Math.floor(limit)))
}
