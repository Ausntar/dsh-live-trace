/**
 * Per-session trace state and the record fan-out the transport publishes.
 *
 * `TraceHub` owns every piece of live dashboard state: the retained backlog of
 * normalized entries, the current Turn/Step position, the coalesced streaming
 * buffer, cumulative token usage, and the derived activity status. It is
 * deliberately free of Cordis and socket concerns so the state machine can be
 * tested directly, and so the plugin's event listeners stay a thin adapter.
 *
 * Every mutation publishes protocol records through {@link TraceHub#subscribe}.
 * Nothing here reads the session log back or writes to it.
 *
 * @module dsh-live-trace/tracker
 */

import {
  accumulateUsage,
  agentStatusValue,
  normalizeAgentCreated,
  normalizeAgentError,
  normalizeSessionCreated,
  normalizeSessionEvent,
  sessionInfo,
  TAG
} from './normalize.js'
import { PROTOCOL_VERSION, SERVER_KIND } from './protocol.js'
import { countDiffLines, writeCallFrom } from './tools.js'

/** Longest coalesced stream tail retained per attempt, in characters. */
export const STREAM_TAIL_LIMIT = 4000

/**
 * Dashboard activity status, in the vocabulary the footer displays.
 * @typedef {'idle' | 'running' | 'tool' | 'waiting-approval' | 'error'} ActivityStatus
 */

/**
 * One monitored session's derived state.
 * @typedef {object} SessionState
 * @property {object} info           {@link sessionInfo} projection, kept current.
 * @property {object[]} entries      retained normalized entries (ring buffer).
 * @property {number} turn           latest turn number, 0 before the first.
 * @property {number} step           latest step number, 0 before the first.
 * @property {number} maxStep        highest step seen in the current turn.
 * @property {ActivityStatus} activity
 * @property {'idle' | 'running'} agentStatus
 * @property {number | null} statusSince
 * @property {number | null} lastEventAt
 * @property {string | null} lastError
 * @property {Set<string>} pendingApprovals
 * @property {object} usage
 * @property {number | null} contextWindow
 * @property {string | null} provider
 * @property {string | null} model
 * @property {number | null} turnStartedAt
 * @property {object | null} stream
 */

/**
 * Create the empty per-session state for one announced session.
 * @returns {SessionState}
 */
function emptySessionState(info) {
  return {
    info,
    entries: [],
    turn: 0,
    step: 0,
    maxStep: 0,
    activity: 'idle',
    agentStatus: 'idle',
    turnOpen: false,
    statusSince: null,
    statusSignature: null,
    lastEventAt: null,
    lastError: null,
    pendingApprovals: new Set(),
    usage: {},
    contextWindow: null,
    provider: null,
    model: null,
    turnStartedAt: null,
    stream: null,
    /** In-flight tool calls by callId, used to settle a result into its block. */
    pendingTools: new Map(),
    /** Aggregated file changes, one record per touched path. */
    edits: []
  }
}

/** Options accepted by {@link TraceHub}. */
const HUB_DEFAULTS = {
  /** Normalized entries retained per session for late-joining viewers. */
  backlogSize: 2000,
  /** Minimum gap between coalesced streaming updates, in milliseconds. */
  streamIntervalMs: 500,
  /** Clock used for coalescing and status timestamps; injectable for tests. */
  now: () => Date.now(),
  /** Passed through to the normalizer. */
  normalizeOptions: {}
}

export class TraceHub {
  /**
   * @param {Partial<typeof HUB_DEFAULTS>} [options]
   */
  constructor(options = {}) {
    this.options = { ...HUB_DEFAULTS, ...options }
    /** Clock used for coalescing and status timestamps. */
    this.now = this.options.now
    /** @type {Map<string, SessionState>} */
    this.sessions = new Map()
    /** @type {Set<(record: object) => void>} */
    this.listeners = new Set()
    /** Session the dashboard shows by default: the most recently active one. */
    this.activeSessionId = null
    /** Last published session-list signature, so summaries only flow on change. */
    this.sessionsSignature = null
  }

  /**
   * Register a record consumer.
   * @param {(record: object) => void} listener
   * @returns {() => void} disposer
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** @param {object} record */
  emit(record) {
    const framed = { v: PROTOCOL_VERSION, ...record }
    for (const listener of this.listeners) {
      try {
        listener(framed)
      } catch {
        /* one broken viewer must never disturb the Harness */
      }
    }
  }

  /**
   * @param {string} sessionId
   * @returns {SessionState | undefined}
   */
  stateOf(sessionId) {
    return this.sessions.get(sessionId)
  }

  /** Summary list for the registry and the `sessions` record. */
  sessionsInfo() {
    return [...this.sessions.values()]
      .map((state) => ({
        ...state.info,
        turn: state.turn,
        step: state.step,
        activity: state.activity,
        lastEventAt: state.lastEventAt
      }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  /* ---------------- session lifecycle ---------------- */

  /**
   * @param {any} session a live Harness Session
   * @param {string} [source] creation source (`startup`, `resume`, …)
   */
  onSessionCreated(session, source) {
    const { entry, info } = normalizeSessionCreated(session, source)
    const state = emptySessionState(info)
    if (typeof info.createdAt === 'number') state.statusSince = info.createdAt
    this.sessions.set(info.id, state)
    this.activeSessionId = info.id
    this.remember(state, entry)
    this.emitSessions()
  }

  /** @param {any} session */
  onSessionDisposed(session) {
    const id = String(session?.id ?? '')
    if (!this.sessions.has(id)) return
    this.remember(this.sessions.get(id), {
      seq: null,
      time: this.now(),
      event: 'session/disposed',
      tag: TAG.SESSION,
      label: 'SESSION',
      text: 'closed',
      level: 'muted'
    })
    this.sessions.delete(id)
    if (this.activeSessionId === id) {
      this.activeSessionId = this.sessionsInfo()[0]?.id ?? null
    }
    this.emitSessions()
  }

  emitSessions() {
    this.emit({ kind: SERVER_KIND.SESSIONS, sessions: this.sessionsInfo(), activeSessionId: this.activeSessionId })
  }

  /* ---------------- durable session events ---------------- */

  /**
   * @param {any} session
   * @param {{ type: string, seq?: number, time?: number, data?: any }} event
   */
  onSessionEvent(session, event) {
    const id = String(session?.id ?? '')
    let state = this.sessions.get(id)
    if (state === undefined) {
      // A session entered before this plugin loaded, or a scoped event for a
      // session we have not seen announced. Adopt it so nothing is lost.
      this.onSessionCreated(session)
      state = this.sessions.get(id)
      if (state === undefined) return
    }

    const callId = event?.type === 'tool/result' ? toId(event.data?.message?.toolCallId) : undefined
    const pendingTool = callId === undefined ? undefined : state.pendingTools.get(callId)
    const { entries, usage, context, sessionTitle } = normalizeSessionEvent(
      event,
      this.options.normalizeOptions,
      pendingTool === undefined ? {} : { pendingTool }
    )
    if (typeof sessionTitle === 'string') {
      // The title arrives as a log-only event and belongs in the header, not
      // only in the trace, so the summary list is refreshed too.
      state.info.title = sessionTitle
      this.emitSessions()
    }
    for (const entry of entries) {
      this.settleToolActivity(state, entry, pendingTool, callId, event)
      this.remember(state, entry)
    }
    this.trackPosition(state, event)
    if (usage !== undefined) {
      accumulateUsage(state.usage, usage)
      this.emit({ kind: SERVER_KIND.USAGE, sessionId: id, usage: { ...state.usage }, contextWindow: state.contextWindow })
    }
    if (context !== undefined) {
      if (context.provider !== undefined) state.provider = context.provider
      if (context.model !== undefined) state.model = context.model
      if (typeof context.capacity === 'number') state.contextWindow = context.capacity
      this.emit({ kind: SERVER_KIND.USAGE, sessionId: id, usage: { ...state.usage }, contextWindow: state.contextWindow })
    }
    this.touch(state, id, event?.time)
  }

  /**
   * Keep the in-flight call table and the per-session edit aggregate current.
   *
   * The duration a tool took is only knowable where both endpoints are seen, so
   * it is stamped here rather than in the pure normalizer.
   *
   * @param {SessionState} state
   * @param {object} entry a freshly normalized entry, mutated in place
   * @param {{ at?: number, name?: string } | undefined} pendingTool
   * @param {string | undefined} callId
   * @param {{ type?: string, data?: any }} [event] the raw event, for call arguments
   */
  settleToolActivity(state, entry, pendingTool, callId, event) {
    if (entry.tag !== 'tool') return
    if (entry.phase === 'call') {
      const id = entry.callId
      if (id !== undefined) {
        state.pendingTools.set(id, {
          name: entry.tool,
          shell: entry.shell,
          filePath: entry.filePath,
          write: writeCallFrom(event?.data?.arguments, entry.filePath),
          at: typeof entry.time === 'number' ? entry.time : this.now()
        })
      }
      return
    }
    if (entry.phase !== 'result') return

    // A created file reports no hunks because it had no prior text; the applied
    // content lives in the call arguments, so rebuild the whole-file diff.
    if (entry.operation === 'create' && entry.diffs === undefined && pendingTool?.write !== undefined) {
      entry.diffs = [{ path: pendingTool.write.filePath, oldText: null, newText: pendingTool.write.content }]
    }
    if (pendingTool !== undefined && typeof pendingTool.at === 'number') {
      entry.durationMs = Math.max(0, (typeof entry.time === 'number' ? entry.time : this.now()) - pendingTool.at)
    }
    if (callId !== undefined) state.pendingTools.delete(callId)
    if (Array.isArray(entry.diffs) && entry.diffs.length > 0) this.recordEdits(state, entry)
  }

  /**
   * Fold one result's diff hunks into the session's per-path aggregate.
   *
   * Re-editing the same file appends to that file's record rather than
   * replacing it, so the edits view shows everything the model changed.
   */
  recordEdits(state, entry) {
    const byPath = new Map(state.edits.map((edit) => [edit.path, edit]))
    for (const hunk of entry.diffs) {
      let edit = byPath.get(hunk.path)
      if (edit === undefined) {
        edit = { path: hunk.path, added: 0, removed: 0, hunks: [], calls: 0, firstAt: entry.time, lastAt: entry.time }
        state.edits.push(edit)
        byPath.set(hunk.path, edit)
      }
      const counts = countDiffLines([hunk])
      edit.added += counts.added
      edit.removed += counts.removed
      edit.hunks.push(hunk)
      edit.calls += 1
      edit.lastAt = entry.time
      if (entry.operation === 'create') edit.operation = 'create'
      else if (edit.operation === undefined) edit.operation = entry.operation ?? 'update'
    }
    this.emit({ kind: SERVER_KIND.EDITS, sessionId: state.info.id, edits: state.edits })
  }

  /** Update turn/step/activity from one durable event. */
  trackPosition(state, event) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        state.turn = numberOr(data.turn, state.turn)
        state.step = 0
        state.maxStep = 0
        state.turnOpen = true
        state.turnStartedAt = typeof event?.time === 'number' ? event.time : Date.now()
        state.lastError = null
        this.setActivity(state, 'running')
        break
      case 'turn/end':
        state.step = 0
        state.turnOpen = false
        this.setActivity(state, 'idle')
        break
      case 'step/start':
        state.turn = numberOr(data.turn, state.turn)
        state.step = numberOr(data.step, state.step)
        state.maxStep = Math.max(state.maxStep, state.step)
        this.setActivity(state, 'running')
        break
      case 'step/end':
        state.step = numberOr(data.step, state.step)
        break
      case 'tool/call':
        this.setActivity(state, 'tool')
        this.clearStream(state)
        break
      case 'tool/result':
        this.setActivity(state, state.turnOpen ? 'running' : 'idle')
        break
      case 'approval/asked': {
        const id = data?.id === undefined ? null : String(data.id)
        if (id !== null) state.pendingApprovals.add(id)
        this.setActivity(state, 'waiting-approval')
        break
      }
      case 'approval/decided': {
        const id = data?.id === undefined ? null : String(data.id)
        if (id !== null) state.pendingApprovals.delete(id)
        this.setActivity(state, state.turnOpen ? 'running' : 'idle')
        break
      }
      case 'assistant/message':
        // The durable message settles the live stream.
        this.clearStream(state)
        break
      default:
        break
    }
    // Turn and step advance without any activity change, so the position is
    // published independently of {@link TraceHub#setActivity}.
    this.emitStatus(state)
    this.emitSessionsIfChanged()
  }

  /**
   * Publish the session list when any session's summary actually moved.
   *
   * The switcher shows every session at once, so their progress has to reach a
   * viewer that is not bound to them. The signature keeps this to a handful of
   * records per step instead of one per event.
   */
  emitSessionsIfChanged() {
    const signature = [...this.sessions.values()]
      .map((state) => `${state.info.id}|${state.activity}|${state.turn}|${state.step}|${state.info.title ?? ''}`)
      .join('\n')
    if (signature === this.sessionsSignature) return false
    this.sessionsSignature = signature
    this.emitSessions()
    return true
  }

  /** Record an entry in the ring buffer and publish it. */
  remember(state, entry) {
    if (entry === null || entry === undefined) return
    state.entries.push(entry)
    const cap = this.options.backlogSize
    if (state.entries.length > cap) state.entries.splice(0, state.entries.length - cap)
    this.emit({ kind: SERVER_KIND.ENTRY, sessionId: state.info.id, entry })
  }

  /** Mark a session as the most recently active and refresh its seq watermark. */
  touch(state, id, time) {
    state.lastEventAt = typeof time === 'number' ? time : this.now()
    if (typeof state.info.seq === 'number') state.info.seq += 1
    this.activeSessionId = id
  }

  setActivity(state, activity) {
    if (state.activity === activity) return
    state.activity = activity
    state.statusSince = this.now()
    this.emitStatus(state)
  }

  /**
   * Publish the current status when it actually changed.
   *
   * Every viewer-visible field participates, so a step advancing while the
   * activity stays `running` still reaches the footer.
   *
   * @param {SessionState} state
   * @param {{ force?: boolean }} [options]
   * @returns {boolean} whether a record was published
   */
  emitStatus(state, options = {}) {
    const signature = [
      state.activity,
      state.turn,
      state.step,
      state.maxStep,
      state.pendingApprovals.size,
      state.agentStatus,
      state.lastError ?? '',
      state.stream === null ? 'nostream' : 'stream'
    ].join('|')
    if (options.force !== true && state.statusSignature === signature) return false
    state.statusSignature = signature
    this.emit({ kind: SERVER_KIND.STATUS, ...this.statusRecord(state) })
    return true
  }

  statusRecord(state) {
    return {
      sessionId: state.info.id,
      status: state.activity,
      agentStatus: state.agentStatus,
      turn: state.turn,
      step: state.step,
      maxStep: state.maxStep,
      since: state.statusSince,
      at: this.now(),
      error: state.lastError,
      streamActive: state.stream !== null
    }
  }

  /* ---------------- live in-process events ---------------- */

  /**
   * @param {any} agent
   * @param {string} [source]
   */
  onAgentCreated(agent, source) {
    const session = agent?.session
    const id = String(session?.id ?? '')
    const state = this.sessions.get(id)
    const { entry, provider, model } = normalizeAgentCreated(agent, source)
    if (state !== undefined) {
      if (provider !== undefined) state.provider = provider
      if (model !== undefined) state.model = model
      if (entry !== null) this.remember(state, entry)
      this.emitStatus(state, { force: true })
    }
  }

  /**
   * @param {any} agent
   * @param {'idle' | 'running' | string} status
   */
  onAgentStatus(agent, status) {
    const state = this.sessions.get(String(agent?.session?.id ?? ''))
    if (state === undefined) return
    state.agentStatus = agentStatusValue(status)
    if (state.agentStatus === 'idle' && state.pendingApprovals.size === 0 && state.activity !== 'error') {
      this.setActivity(state, 'idle')
    } else if (state.agentStatus === 'running' && state.activity === 'idle') {
      this.setActivity(state, 'running')
    } else {
      this.emitStatus(state)
    }
    if (state.agentStatus === 'idle') this.clearStream(state)
  }

  /**
   * Coalesce one `agent/assistant-stream` frame.
   * @param {any} agent
   * @param {any} frame
   */
  onAssistantStream(agent, frame) {
    const state = this.sessions.get(String(agent?.session?.id ?? ''))
    if (state === undefined || frame === null || typeof frame !== 'object') return
    const now = this.now()
    switch (frame.type) {
      case 'start':
        state.stream = {
          attemptId: frame.attemptId,
          revision: frame.revision,
          turn: frame.turn,
          step: frame.step,
          text: '',
          reasoning: '',
          seenIndexes: new Map(),
          lastFlush: now,
          dirty: false
        }
        break
      case 'chunk': {
        const stream = state.stream
        if (stream === null || stream.attemptId !== frame.attemptId) return
        const chunk = frame.chunk ?? {}
        const index = typeof chunk.index === 'number' ? chunk.index : -1
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          stream.text = tail(`${stream.text}${chunk.text}`, STREAM_TAIL_LIMIT)
          stream.seenIndexes.set(index, true)
          stream.dirty = true
        } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          stream.reasoning = tail(`${stream.reasoning}${chunk.text}`, STREAM_TAIL_LIMIT)
          stream.seenIndexes.set(index, true)
          stream.dirty = true
        } else if (chunk.type === 'block-end' && typeof chunk.block?.text === 'string') {
          // Some adapters only surface the assembled block; use it when this
          // index produced no deltas, so nothing is duplicated.
          if (stream.seenIndexes.get(index) !== true) {
            const text = chunk.block.text
            if (chunk.block.type === 'reasoning') stream.reasoning = tail(`${stream.reasoning}${text}`, STREAM_TAIL_LIMIT)
            else stream.text = tail(`${stream.text}${text}`, STREAM_TAIL_LIMIT)
            stream.seenIndexes.set(index, true)
            stream.dirty = true
          }
        }
        break
      }
      case 'end':
        if (state.stream !== null && state.stream.attemptId === frame.attemptId) state.stream.ended = true
        break
      default:
        break
    }
  }

  /**
   * Publish coalesced streaming updates that have been quiet long enough.
   * @param {number} [now]
   * @returns {number} how many sessions were flushed
   */
  flushStreams(now = this.now()) {
    let flushed = 0
    for (const state of this.sessions.values()) {
      const stream = state.stream
      if (stream === null) continue
      if (stream.dirty === false || now - stream.lastFlush < this.options.streamIntervalMs) continue
      stream.lastFlush = now
      stream.dirty = false
      flushed += 1
      this.emit({
        kind: SERVER_KIND.STREAM,
        sessionId: state.info.id,
        turn: stream.turn,
        step: stream.step,
        text: stream.text,
        reasoning: stream.reasoning,
        at: now
      })
    }
    return flushed
  }

  /** Drop the live stream buffer, telling viewers to stop showing it. */
  clearStream(state) {
    if (state.stream === null) return
    state.stream = null
    this.emit({ kind: SERVER_KIND.STREAM_END, sessionId: state.info.id, at: this.now() })
    this.emitStatus(state)
  }

  /**
   * @param {{ agent?: any, turn?: number, step?: number, error?: unknown, time?: number }} payload
   */
  onAgentError(payload) {
    const state = this.sessions.get(String(payload?.agent?.session?.id ?? ''))
    const { entries } = normalizeAgentError(payload, this.options.normalizeOptions)
    if (state === undefined) return
    state.lastError = entries[0]?.text ?? 'error'
    for (const entry of entries) this.remember(state, entry)
    this.clearStream(state)
    state.statusSince = this.now()
    state.activity = 'error'
    this.emitStatus(state, { force: true })
  }

  /* ---------------- replay ---------------- */

  /**
   * Records a late-joining viewer needs to fill its screen for one session.
   * @param {string} sessionId
   * @param {number} [limit]
   * @returns {object[]}
   */
  snapshot(sessionId, limit = 500) {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return []
    const entries = state.entries.slice(-limit)
    const records = entries.map((entry) => ({ kind: SERVER_KIND.ENTRY, sessionId, entry }))
    if (state.edits.length > 0) records.push({ kind: SERVER_KIND.EDITS, sessionId, edits: state.edits })
    records.push({ kind: SERVER_KIND.USAGE, sessionId, usage: { ...state.usage }, contextWindow: state.contextWindow })
    records.push({ kind: SERVER_KIND.STATUS, ...this.statusRecord(state) })
    if (state.stream !== null && state.stream.dirty) {
      records.push({
        kind: SERVER_KIND.STREAM,
        sessionId,
        turn: state.stream.turn,
        step: state.stream.step,
        text: state.stream.text,
        reasoning: state.stream.reasoning,
        at: this.now()
      })
    }
    return records
  }
}

function toId(value) {
  return value === undefined || value === null ? undefined : String(value)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function tail(text, limit) {
  return text.length <= limit ? text : text.slice(text.length - limit)
}
