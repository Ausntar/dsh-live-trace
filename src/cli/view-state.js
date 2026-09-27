/**
 * The dashboard's view model: fold protocol records into the state a frame
 * renders from.
 *
 * This module is pure with respect to the terminal — it knows nothing about
 * ANSI, sizes, or input — so the mapping from a wire record to visible state is
 * directly testable, and the renderer stays a dumb projection.
 *
 * @module dsh-live-trace/view-state
 */

/** Entries retained in the viewer's own scrollback, independent of the plugin's backlog. */
export const MAX_VIEW_ENTRIES = 5000

/**
 * @typedef {object} ViewState
 * @property {object | null} server
 * @property {boolean} connected
 * @property {object[]} sessions
 * @property {string | null} sessionId
 * @property {object[]} entries
 * @property {object | null} stream
 * @property {object} status
 * @property {object} usage
 * @property {number | null} contextWindow
 * @property {number} lastRecordAt
 * @property {number} recordCount
 * @property {string | null} serverError
 * @property {number} droppedEntries
 * @property {'trace' | 'sessions' | 'edits' | 'commands'} view  active panel
 * @property {boolean} sessionsOverlay  switcher shown over any panel
 * @property {object[]} edits           aggregated file changes for the bound session
 * @property {Map<string, number>} entryIndex  entry key -> position, for in-place updates
 * @property {Record<string, number>} scroll   per-panel scroll offset
 * @property {{ sessions: number, edits: number }} cursor  selection per navigable panel
 * @property {boolean} rawText          disable markdown rendering
 * @property {boolean} expandThinking   show thinking in full; only a key press changes it
 */

/**
 * @param {{ now?: number }} [options]
 * @returns {ViewState}
 */
export function createViewState(options = {}) {
  return {
    server: null,
    connected: false,
    sessions: [],
    sessionId: null,
    entries: [],
    stream: null,
    status: {
      status: 'idle',
      agentStatus: 'idle',
      turn: 0,
      step: 0,
      maxStep: 0,
      since: null,
      error: null,
      streamActive: false
    },
    usage: {},
    contextWindow: null,
    lastRecordAt: options.now ?? 0,
    recordCount: 0,
    serverError: null,
    droppedEntries: 0,
    turnStartedAt: null,
    pendingCalls: new Map(),
    entrySeq: 0,
    view: 'trace',
    sessionsOverlay: false,
    edits: [],
    entryIndex: new Map(),
    scroll: { trace: 0, sessions: 0, edits: 0, commands: 0 },
    cursor: { sessions: 0, edits: 0 },
    rawText: false,
    // Thinking starts visible and only collapses when the user asks: while the
    // model reasons, the trace should follow it rather than fold it away.
    expandThinking: true
  }
}

/** Panels the viewer can show. */
export const VIEWS = ['trace', 'sessions', 'edits', 'commands']

/**
 * Bind the view to a different session, discarding the previous session's
 * scrollback. The caller is responsible for asking the plugin to replay.
 * @param {ViewState} state
 * @param {string | null} sessionId
 */
export function bindSession(state, sessionId) {
  state.sessionId = sessionId
  state.entries = []
  state.entryIndex.clear()
  state.stream = null
  state.pendingCalls.clear()
  state.droppedEntries = 0
  state.edits = []
  state.scroll.trace = 0
  state.scroll.commands = 0
  state.scroll.edits = 0
  state.cursor.edits = 0
  state.usage = {}
  state.contextWindow = null
  state.status = {
    status: 'idle',
    agentStatus: 'idle',
    turn: 0,
    step: 0,
    maxStep: 0,
    since: null,
    error: null,
    streamActive: false
  }
  state.turnStartedAt = null
}

/**
 * Fold one server record into the view state.
 * @param {ViewState} state
 * @param {any} record
 * @returns {{ changed: boolean, kind: string, appended: boolean }}
 */
export function applyRecord(state, record) {
  if (record === null || typeof record !== 'object' || typeof record.kind !== 'string') {
    return { changed: false, kind: 'invalid', appended: false }
  }
  state.recordCount += 1
  state.lastRecordAt = Date.now()

  switch (record.kind) {
    case 'hello': {
      state.server = record.server ?? null
      state.connected = true
      state.serverError = null
      state.sessions = Array.isArray(record.sessions) ? record.sessions : []
      if (state.sessionId === null) {
        const preferred =
          state.sessions.find((session) => session.id === record.activeSessionId) ??
          state.sessions[0] ??
          null
        bindSession(state, preferred?.id ?? null)
      }
      return { changed: true, kind: 'hello', appended: false }
    }

    case 'sessions': {
      state.sessions = Array.isArray(record.sessions) ? record.sessions : state.sessions
      const bindingGone =
        state.sessionId === null || !state.sessions.some((session) => session.id === state.sessionId)
      if (bindingGone) {
        const next =
          state.sessions.find((session) => session.id === record.activeSessionId) ?? state.sessions[0] ?? null
        bindSession(state, next?.id ?? null)
      }
      return { changed: true, kind: 'sessions', appended: false }
    }

    case 'entry': {
      if (record.sessionId !== state.sessionId) return { changed: false, kind: 'entry-other', appended: false }
      const entry = normalizeEntry(record.entry, state)
      if (entry.tag === 'turn' && typeof entry.label === 'string') {
        if (entry.label.endsWith('END')) state.turnStartedAt = null
        else state.turnStartedAt = entry.at
      }

      // A keyed entry updates the row it already owns. A tool call and its
      // result share a key, so the "running" row is upgraded in place instead
      // of leaving a dangling half behind; the position is preserved so the
      // trace never reorders under the reader.
      const existing = entry.key === undefined ? undefined : state.entryIndex.get(entry.key)
      if (existing !== undefined && state.entries[existing] !== undefined) {
        const previous = state.entries[existing]
        state.entries[existing] = { ...entry, key: previous.key }
        return { changed: true, kind: 'entry', appended: false, replaced: true }
      }

      state.entries.push(entry)
      if (entry.key !== undefined) state.entryIndex.set(entry.key, state.entries.length - 1)
      if (state.entries.length > MAX_VIEW_ENTRIES) {
        const dropped = state.entries.length - MAX_VIEW_ENTRIES
        state.entries.splice(0, dropped)
        state.droppedEntries += dropped
        reindexEntries(state)
      }
      return { changed: true, kind: 'entry', appended: true }
    }

    case 'edits': {
      if (record.sessionId !== state.sessionId) return { changed: false, kind: 'edits-other', appended: false }
      state.edits = Array.isArray(record.edits) ? record.edits : []
      if (state.cursor.edits >= state.edits.length) state.cursor.edits = Math.max(0, state.edits.length - 1)
      state.scroll.edits = 0
      return { changed: true, kind: 'edits', appended: false }
    }

    case 'stream': {
      if (record.sessionId !== state.sessionId) return { changed: false, kind: 'stream-other', appended: false }
      state.stream = {
        text: typeof record.text === 'string' ? record.text : '',
        reasoning: typeof record.reasoning === 'string' ? record.reasoning : '',
        turn: record.turn ?? 0,
        step: record.step ?? 0,
        at: record.at ?? Date.now()
      }
      return { changed: true, kind: 'stream', appended: false }
    }

    case 'stream-end': {
      if (record.sessionId !== state.sessionId) return { changed: false, kind: 'stream-end-other', appended: false }
      state.stream = null
      return { changed: true, kind: 'stream-end', appended: false }
    }

    case 'status': {
      if (record.sessionId !== state.sessionId) return { changed: false, kind: 'status-other', appended: false }
      state.status = {
        status: record.status ?? 'idle',
        agentStatus: record.agentStatus ?? 'idle',
        turn: record.turn ?? 0,
        step: record.step ?? 0,
        maxStep: record.maxStep ?? 0,
        since: record.since ?? null,
        error: record.error ?? null,
        streamActive: record.streamActive === true
      }
      return { changed: true, kind: 'status', appended: false }
    }

    case 'usage': {
      if (record.sessionId !== state.sessionId) return { changed: false, kind: 'usage-other', appended: false }
      state.usage = record.usage ?? {}
      state.contextWindow = record.contextWindow ?? null
      return { changed: true, kind: 'usage', appended: false }
    }

    case 'heartbeat':
      state.connected = true
      return { changed: false, kind: 'heartbeat', appended: false }

    case 'error':
      state.serverError = typeof record.message === 'string' ? record.message : 'server error'
      return { changed: true, kind: 'error', appended: false }

    default:
      return { changed: false, kind: 'unknown', appended: false }
  }
}

/**
 * Normalize one wire entry and enrich it with viewer-side facts (stable key and
 * tool duration, which only the viewer knows because it saw both endpoints).
 */
function normalizeEntry(raw, state) {
  const entry = raw !== null && typeof raw === 'object' ? { ...raw } : { text: String(raw) }
  state.entrySeq += 1
  // A key supplied by the plugin is authoritative: it is what lets a tool
  // result replace the row its call already occupies. Only keyless entries get
  // a viewer-local identity.
  entry.key =
    typeof entry.key === 'string' && entry.key.length > 0
      ? entry.key
      : `${state.sessionId ?? 's'}:${entry.seq ?? 'x'}:${state.entrySeq}`
  entry.at = typeof entry.time === 'number' ? entry.time : Date.now()
  if (entry.tag === 'tool' && typeof entry.callId === 'string') {
    state.pendingCalls.set(entry.callId, { name: entry.tool ?? '', at: entry.at })
  } else if (entry.tag === 'result') {
    const callId = typeof entry.callId === 'string' ? entry.callId : null
    if (callId !== null) {
      const pending = state.pendingCalls.get(callId)
      if (pending !== undefined) {
        entry.durationMs = Math.max(0, entry.at - pending.at)
        state.pendingCalls.delete(callId)
      }
    } else if (state.pendingCalls.size === 1) {
      // Some tools answer a call the log never paired with an id; fall back to
      // the single outstanding call rather than dropping the duration.
      const [onlyId, pending] = [...state.pendingCalls.entries()][0]
      entry.durationMs = Math.max(0, entry.at - pending.at)
      state.pendingCalls.delete(onlyId)
    }
  }
  return entry
}

/**
 * Rebuild the key index after the ring buffer drops its oldest entries.
 *
 * Without this the index would still point at positions that have shifted,
 * and a tool result would replace the wrong row.
 */
function reindexEntries(state) {
  state.entryIndex.clear()
  state.entries.forEach((entry, index) => {
    if (entry.key !== undefined) state.entryIndex.set(entry.key, index)
  })
}

/**
 * Every shell command the bound session has run, oldest first.
 *
 * Derived from the trace rather than a separate wire record: the entry already
 * carries the command, its output, and its settlement once both halves of the
 * call have been received.
 *
 * @param {ViewState} state
 * @returns {object[]}
 */
export function commandsOf(state) {
  const commands = []
  for (const entry of state.entries) {
    if (entry.tag !== 'tool' || entry.shell === undefined) continue
    commands.push({
      key: entry.key,
      callId: entry.callId,
      command: entry.shell.command,
      description: entry.shell.description,
      cwd: entry.shell.cwd,
      at: entry.at,
      turn: entry.turn,
      step: entry.step,
      pending: entry.phase === 'call',
      ok: entry.ok,
      exitCode: entry.shellStatus?.exitCode,
      signal: entry.shellStatus?.signal,
      durationMs: entry.durationMs,
      output: entry.output,
      outputText: entry.output?.text ?? entry.rawText ?? '',
      truncated: entry.output?.truncated === true
    })
  }
  return commands
}

/**
 * Aggregate edit totals for the header of the edits panel.
 * @param {ViewState} state
 * @returns {{ files: number, added: number, removed: number }}
 */
export function editTotals(state) {
  let added = 0
  let removed = 0
  for (const edit of state.edits) {
    added += edit.added ?? 0
    removed += edit.removed ?? 0
  }
  return { files: state.edits.length, added, removed }
}

/**
 * One row per known session, for the landing screen and the switcher.
 *
 * @param {ViewState} state
 * @param {number} [now]
 * @returns {object[]}
 */
export function sessionRows(state, now = Date.now()) {
  return state.sessions.map((session, index) => ({
    index,
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    agentPreset: session.agentPreset,
    origin: session.origin,
    delegationDepth: session.delegationDepth,
    turn: session.turn ?? 0,
    step: session.step ?? 0,
    activity: session.activity ?? 'idle',
    lastEventAt: session.lastEventAt ?? null,
    age: typeof session.createdAt === 'number' ? now - session.createdAt : null,
    idleFor: typeof session.lastEventAt === 'number' ? now - session.lastEventAt : null,
    bound: session.id === state.sessionId,
    selected: index === state.cursor.sessions
  }))
}

/**
 * The session summary the view is currently bound to.
 * @param {ViewState} state
 * @returns {object | null}
 */
export function activeSession(state) {
  return state.sessions.find((session) => session.id === state.sessionId) ?? null
}

/**
 * Total tokens for the footer: the provider total when reported, else input+output.
 * @param {object} usage
 * @returns {number}
 */
export function usageTotal(usage) {
  if (typeof usage?.totalTokens === 'number' && usage.totalTokens > 0) return usage.totalTokens
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
}
