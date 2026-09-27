/**
 * The viewer-side socket client: connects to the observer's socket, decodes
 * records, and reconnects automatically when the Harness restarts.
 *
 * @module dsh-live-trace/client
 */

import { connect } from 'node:net'

import { CLIENT_KIND, createLineDecoder, encodeRecord, SERVER_KIND } from './protocol.js'

const RETRY_MIN_MS = 250
const RETRY_MAX_MS = 4000

/**
 * Connect to a running observer.
 *
 * `onRecord` receives every decoded server record, including the initial
 * `hello`. `onOpen` fires on every successful connection and again after a
 * reconnect, so the caller can reset derived view state.
 *
 * @param {object} options
 * @param {string} options.socketPath
 * @param {string | null} [options.sessionId] desired session; `null` follows the server default
 * @param {number} [options.replayLimit]
 * @param {(record: any) => void} options.onRecord
 * @param {(record: any) => void} [options.onOpen]
 * @param {(info: { willRetry: boolean }) => void} [options.onClose]
 * @param {(error: Error) => void} [options.onError]
 * @param {boolean} [options.retry]
 * @returns {{ close: () => void, select: (sessionId: string | null) => void, replay: (limit?: number) => void, isOpen: () => boolean, socketPath: string }}
 */
export function connectTrace(options) {
  const {
    socketPath,
    replayLimit,
    onRecord,
    onOpen,
    onClose,
    onError,
    retry = true,
    retryMinMs = RETRY_MIN_MS,
    retryMaxMs = RETRY_MAX_MS
  } = options

  let desiredSession = options.sessionId ?? null
  let boundSession = null
  let selectPending = false
  let socket = null
  let decoder = createLineDecoder()
  let closedByCaller = false
  let retryDelay = retryMinMs
  let timer = null
  let open = false

  const send = (record) => {
    if (socket === null || socket.destroyed) return
    try {
      socket.write(encodeRecord(record))
    } catch {
      /* the close handler owns recovery */
    }
  }

  /** Ask the server to bind us to its own default session. */
  const requestDefault = () => {
    if (closedByCaller || selectPending) return
    selectPending = true
    send({ v: 1, kind: CLIENT_KIND.SELECT, limit: replayLimit })
  }

  const scheduleRetry = () => {
    if (closedByCaller || retry === false || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      attempt()
    }, retryDelay)
    timer.unref?.()
    retryDelay = Math.min(retryMaxMs, Math.round(retryDelay * 1.7))
  }

  const handle = (record) => {
    const isSelectionAnswer =
      record !== null &&
      typeof record === 'object' &&
      (record.kind === SERVER_KIND.SESSIONS || record.kind === SERVER_KIND.ERROR) &&
      Array.isArray(record.sessions)
    if (isSelectionAnswer) {
      // `sessions` records are the authoritative answer to a selection: they
      // carry the list, the server's default, and the binding this viewer
      // actually holds. The opening `hello` is deliberately not one of them:
      // treating it as an answer would clear the pending flag and duplicate the
      // selection, which shows up as a replayed backlog.
      selectPending = false
      const list = record.sessions
      const reported = record.boundSessionId === undefined ? null : (record.boundSessionId ?? null)
      const wanted = desiredSession ?? reported
      if (record.kind === SERVER_KIND.ERROR || (wanted !== null && !list.some((session) => session.id === wanted))) {
        // The session being followed is gone, or the server refused the one
        // that was requested: fall back to following the server's default.
        desiredSession = null
        boundSession = null
      } else {
        boundSession = wanted
      }
      // A viewer with no binding keeps asking until one exists, so a dashboard
      // opened before the first session still starts following it.
      if (boundSession === null && desiredSession === null && list.length > 0) requestDefault()
    }
    onRecord(record)
  }

  function attempt() {
    if (closedByCaller) return
    decoder = createLineDecoder()
    const connection = connect(socketPath)
    socket = connection
    connection.setNoDelay(true)
    connection.setEncoding('utf8')

    connection.on('connect', () => {
      open = true
      retryDelay = retryMinMs
      boundSession = null
      selectPending = true
      send({ v: 1, kind: CLIENT_KIND.SELECT, sessionId: desiredSession ?? undefined, limit: replayLimit })
      onOpen?.({ socketPath })
    })

    connection.on('data', (chunk) => {
      let records
      try {
        records = decoder.push(chunk)
      } catch (error) {
        onError?.(/** @type {Error} */ (error))
        connection.destroy()
        return
      }
      for (const record of records) handle(record)
    })

    connection.on('error', (error) => {
      onError?.(/** @type {Error} */ (error))
    })

    connection.on('close', () => {
      const wasOpen = open
      open = false
      socket = null
      boundSession = null
      selectPending = false
      if (closedByCaller) return
      onClose?.({ willRetry: retry !== false })
      if (wasOpen) retryDelay = retryMinMs
      scheduleRetry()
    })
  }

  attempt()

  return {
    socketPath,
    isOpen: () => open,
    select(sessionId) {
      desiredSession = sessionId
      selectPending = true
      send({ v: 1, kind: CLIENT_KIND.SELECT, sessionId: sessionId ?? undefined, limit: replayLimit })
    },
    replay(limit) {
      send({ v: 1, kind: CLIENT_KIND.REPLAY, limit })
    },
    close() {
      closedByCaller = true
      if (timer !== null) clearTimeout(timer)
      if (socket !== null) socket.destroy()
    }
  }
}
