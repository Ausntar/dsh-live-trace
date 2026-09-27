/**
 * dsh-live-trace — Host-side observer plugin.
 *
 * The plugin subscribes to the Harness event bus in-process, normalizes what it
 * sees into flat display records, and publishes them on a Unix domain socket.
 * It is strictly read-only: it never appends a session event, never changes a
 * tool decision, never touches the model request, and never writes to stdout
 * (which belongs to whatever surface the Harness is driving). The standalone
 * `dsh-live-trace` viewer is a separate process that renders those records in
 * a different terminal.
 *
 * Cleanup is owned by the plugin's Cordis fiber: every `ctx.on` registration
 * returns a disposer, every timer is cleared, the socket is closed and unlinked,
 * and the discovery record is removed. Unloading the plugin leaves nothing
 * behind.
 *
 * @module dsh-live-trace
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { disconnectExistingInstance, registerInstance, releaseInstance } from './lib/instance.js'
import { resolveRuntimeDir, serversDir, socketsDir } from './lib/paths.js'
import { DEFAULT_MUTED_EVENT_TYPES } from './lib/normalize.js'
import { MAX_REPLAY_ENTRIES, PROTOCOL_VERSION, SERVER_KIND } from './lib/protocol.js'
import { removeServerRecordIfOwner, writeServerRecord } from './lib/registry.js'
import { TraceHub } from './lib/tracker.js'
import { createTraceServer, defaultSocketPath, DEFAULT_REPLAY_LIMIT, HEARTBEAT_MS } from './lib/transport.js'

/** Cordis plugin name. */
export const name = 'dsh-live-trace'

/** This package's version, read lazily so the manifest stays the single source of truth. */
export const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Plugin defaults; every one is overridable from `cordis.patch.yml`. */
export const CONFIG_DEFAULTS = {
  enabled: true,
  streamIntervalMs: 500,
  backlogSize: 2000,
  heartbeatMs: HEARTBEAT_MS,
  replayLimit: DEFAULT_REPLAY_LIMIT,
  showSystemMessages: false,
  showRequestMetadata: false,
  showUnknownEvents: false,
  mutedEventTypes: undefined,
  textLimit: undefined,
  outputLines: undefined,
  outputChars: undefined,
  runtimeDir: undefined,
  socketPath: undefined
}

/**
 * Coerce the loader's config row into a validated options object.
 *
 * The plugin deliberately declares no `Config` schema: the observer must load
 * even in a profile that cannot resolve the schema package, and a mistyped
 * option should degrade to its default rather than refuse to start.
 *
 * @param {unknown} config
 * @returns {typeof CONFIG_DEFAULTS}
 */
export function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? /** @type {any} */ (config) : {}
  return {
    enabled: raw.enabled !== false,
    streamIntervalMs: clampInt(raw.streamIntervalMs, CONFIG_DEFAULTS.streamIntervalMs, 50, 60_000),
    backlogSize: clampInt(raw.backlogSize, CONFIG_DEFAULTS.backlogSize, 10, 100_000),
    heartbeatMs: clampInt(raw.heartbeatMs, CONFIG_DEFAULTS.heartbeatMs, 500, 300_000),
    replayLimit: clampInt(raw.replayLimit, CONFIG_DEFAULTS.replayLimit, 1, MAX_REPLAY_ENTRIES),
    showSystemMessages: raw.showSystemMessages === true,
    showRequestMetadata: raw.showRequestMetadata === true,
    showUnknownEvents: raw.showUnknownEvents === true,
    mutedEventTypes: resolveMutedEventTypes(raw.mutedEventTypes),
    textLimit: clampInt(raw.textLimit, undefined, 120, 100_000),
    outputLines: clampInt(raw.outputLines, undefined, 1, 100_000),
    outputChars: clampInt(raw.outputChars, undefined, 200, 1_000_000),
    runtimeDir: typeof raw.runtimeDir === 'string' && raw.runtimeDir.trim().length > 0 ? resolve(raw.runtimeDir) : undefined,
    socketPath: typeof raw.socketPath === 'string' && raw.socketPath.trim().length > 0 ? resolve(raw.socketPath) : undefined
  }
}

/** Accept an override list, or keep the built-in bookkeeping filter. */
function resolveMutedEventTypes(value) {
  if (value === undefined) return DEFAULT_MUTED_EVENT_TYPES
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string')
  // `false` turns the filter off entirely, which is what debugging wants.
  if (value === false || value === null) return []
  return DEFAULT_MUTED_EVENT_TYPES
}

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** Resolve a logger without assuming the Cordis logger service exists. */
function makeLogger(ctx) {
  const noop = { info() {}, warn() {}, error() {}, debug() {} }
  try {
    const service = ctx?.logger ?? ctx?.get?.('logger')
    if (typeof service === 'function') {
      const scoped = service('dsh-live-trace')
      if (scoped !== null && typeof scoped === 'object') return scoped
    }
    if (service !== null && typeof service === 'object' && typeof service.warn === 'function') return service
  } catch {
    /* fall through to the no-op logger */
  }
  return noop
}

/**
 * Cordis plugin entry.
 *
 * @param {any} ctx plugin fiber context
 * @param {object} [config] the `cordis.patch.yml` row's `config`
 * @returns {any} an effect disposer so Cordis owns teardown
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)
  if (options.enabled === false) return undefined

  const logger = makeLogger(ctx)
  const runtimeDir = options.runtimeDir ?? resolveRuntimeDir()
  const socketPath = options.socketPath ?? defaultSocketPath(runtimeDir, process.pid)
  const startedAt = Date.now()

  const hub = new TraceHub({
    backlogSize: options.backlogSize,
    streamIntervalMs: options.streamIntervalMs,
    normalizeOptions: {
      showSystemMessages: options.showSystemMessages,
      showRequestMetadata: options.showRequestMetadata,
      showUnknownEvents: options.showUnknownEvents,
      mutedEventTypes: options.mutedEventTypes,
      ...(options.textLimit === undefined ? {} : { textLimit: options.textLimit }),
      ...(options.outputLines === undefined && options.outputChars === undefined
        ? {}
        : {
            outputLimits: {
              ...(options.outputLines === undefined ? {} : { maxLines: options.outputLines }),
              ...(options.outputChars === undefined ? {} : { maxChars: options.outputChars })
            }
          })
    }
  })

  return ctx.effect(async () => {
    /** @type {Array<() => void>} */
    const disposers = []
    /** @type {ReturnType<typeof createTraceServer> | null} */
    let server = null
    /** @type {NodeJS.Timeout | null} */
    let flushTimer = null
    /** @type {NodeJS.Timeout | null} */
    let registryTimer = null

    const listen = (event, handler) => {
      try {
        const dispose = ctx.on(event, handler)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        logger.warn?.(`could not subscribe to ${event}: ${describe(error)}`)
      }
    }

    listen('session/created', (session) => {
      safe(() => hub.onSessionCreated(session, 'live'))
    })
    listen('session/disposed', (session) => {
      safe(() => hub.onSessionDisposed(session))
    })
    listen('session/event', (session, event) => {
      safe(() => hub.onSessionEvent(session, event))
    })
    listen('agent/created', (payload) => {
      safe(() => hub.onAgentCreated(payload?.agent, payload?.source))
    })
    listen('agent/status', (payload) => {
      safe(() => hub.onAgentStatus(payload?.agent, payload?.status))
    })
    listen('agent/assistant-stream', (payload) => {
      safe(() => hub.onAssistantStream(payload?.agent, payload?.frame))
    })
    listen('agent/error', (payload) => {
      safe(() => hub.onAgentError(payload))
    })

    // Adopt sessions that already exist, so a viewer attached before the next
    // event still sees the current session list.
    try {
      const sessions = ctx.get?.('sessions')
      for (const session of sessions?.list?.() ?? []) hub.onSessionCreated(session, 'startup')
    } catch (error) {
      logger.debug?.(`session list unavailable at startup: ${describe(error)}`)
    }

    // Coalesced streaming text is pushed on a fixed cadence instead of per
    // chunk, so a fast model cannot flood the viewer.
    flushTimer = setInterval(() => {
      safe(() => hub.flushStreams())
    }, Math.max(50, Math.min(options.streamIntervalMs, 250)))
    flushTimer.unref?.()

    const serverInfo = () => ({
      pid: process.pid,
      version,
      protocol: PROTOCOL_VERSION,
      profile: process.env.DSH_PROFILE ?? null,
      cwd: process.cwd(),
      runtimeDir,
      socket: socketPath,
      startedAt,
      hubActive: true
    })

    const publishRegistry = () => {
      try {
        writeServerRecord(serversDir(runtimeDir), {
          ...serverInfo(),
          heartbeat: Date.now(),
          activeSessionId: hub.activeSessionId,
          sessions: hub.sessionsInfo()
        })
      } catch (error) {
        logger.debug?.(`could not write discovery record: ${describe(error)}`)
      }
    }

    try {
      // A previous instance in this same process (hot reload) must release the
      // socket path before the new one binds it.
      await disconnectExistingInstance(process.pid)
      server = createTraceServer({
        socketPath,
        runtimeDir,
        hub,
        serverInfo,
        heartbeatMs: options.heartbeatMs,
        onError: (error) => logger.warn?.(`socket error: ${describe(error)}`)
      })
      await server.ready
      registerInstance(process.pid, server)
      publishRegistry()
      // A session appearing or disappearing is exactly when a viewer's
      // discovery view must change, so refresh the record immediately rather
      // than waiting for the next heartbeat.
      disposers.push(
        hub.subscribe((record) => {
          if (record.kind === SERVER_KIND.SESSIONS) publishRegistry()
        })
      )
      registryTimer = setInterval(publishRegistry, Math.max(1000, Math.floor(options.heartbeatMs / 2)))
      registryTimer.unref?.()
      logger.info?.(`observing on ${socketPath}`)
    } catch (error) {
      logger.warn?.(`observer transport unavailable: ${describe(error)}`)
      if (server !== null) {
        try {
          await server.close()
        } catch {
          /* already unusable */
        }
        server = null
      }
    }

    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* a partially registered listener is not a teardown failure */
        }
      }
      disposers.length = 0
      if (flushTimer !== null) clearInterval(flushTimer)
      if (registryTimer !== null) clearInterval(registryTimer)
      flushTimer = null
      registryTimer = null
      if (server !== null) {
        const owned = server
        try {
          await owned.close()
        } catch (error) {
          logger.debug?.(`socket close reported ${describe(error)}`)
        }
        // Only now is the in-process registration safe to drop: close() is what
        // releases the socket, and the identity guard keeps a stale disposer
        // from evicting a newer generation that already registered.
        releaseInstance(process.pid, owned)
        server = null
      }
      try {
        removeServerRecordIfOwner(serversDir(runtimeDir), process.pid, socketPath)
      } catch {
        /* nothing to remove */
      }
      logger.info?.('observer stopped')
    }
  }, 'dsh-live-trace')
}

/** Run a hub mutation without letting an observer bug escape into the Harness. */
function safe(run) {
  try {
    run()
  } catch {
    /* observation must never disturb the observed */
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export { TraceHub } from './lib/tracker.js'
export { normalizeSessionEvent } from './lib/normalize.js'
export { socketsDir, serversDir, resolveRuntimeDir }
