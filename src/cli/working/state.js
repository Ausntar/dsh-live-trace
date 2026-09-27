/**
 * What is the orca doing?
 *
 * The animation answers to the session's real activity, so this module turns
 * the same record stream the trace dashboard consumes into one of a handful of
 * work states. It is deliberately pure: give it records and a clock, read back
 * a state.
 *
 * @module dsh-live-working/state
 */

/**
 * Every state the scene can draw.
 *
 * `thinking`, `typing` and `writing` are the subdivisions of "the model is
 * working": reasoning, prose/code streaming, and a file being written. They
 * look slightly different because they are different kinds of work.
 */
export const WORK_STATES = [
  'sleep',
  'thinking',
  'typing',
  'writing',
  'waiting',
  'reading',
  'searching',
  'calling',
  // A subagent has finished and is calling back: the telephone rings and the
  // orca answers it with the subagent's own reply.
  'ringing'
]

/**
 * How long a callback keeps ringing.
 *
 * Long enough to read the reply off the bubble, short enough that it settles
 * back to what the session is actually doing.
 */
export const CALL_MS = 2500
/** How long a callback rings before it settles. */
export const RING_MS = 14_000

/**
 * How long a running shell command may stay silent before the orca dozes off.
 * A build that prints nothing for this long looks exactly like no work at all.
 */
export const SILENT_MS = 8000

/** Tool names grouped by what they make the orca do. */
export const TOOL_KINDS = {
  shell: ['bash', 'shell', 'sh', 'exec', 'run', 'terminal', 'command'],
  read: ['read', 'read_file', 'readfile', 'view', 'open', 'cat', 'list', 'ls', 'glob', 'grep', 'search_files'],
  search: ['web_search', 'websearch', 'web_fetch', 'webfetch', 'fetch', 'browse', 'search_web'],
  subagent: ['task', 'agent', 'subagent', 'delegate', 'spawn_agent', 'task_tool'],
  write: ['write', 'write_file', 'writefile', 'edit', 'edit_file', 'apply_patch', 'patch', 'multiedit', 'notebook_edit']
}

/**
 * What kind of work a tool name implies.
 *
 * The lookup is loose on purpose: tool names arrive in several styles
 * (`read_file`, `ReadFile`, `read-file`) and a miss should degrade to "the
 * model is working", never to a crash.
 *
 * @param {unknown} name
 * @returns {'shell' | 'read' | 'search' | 'subagent' | 'write' | null}
 */
export function classifyTool(name) {
  if (typeof name !== 'string' || name.length === 0) return null
  const needle = name.toLowerCase().replace(/[^a-z]/g, '')
  for (const [kind, names] of Object.entries(TOOL_KINDS)) {
    for (const candidate of names) {
      const target = candidate.replace(/[^a-z]/g, '')
      if (needle === target || needle.endsWith(target) || needle.startsWith(target)) return kind
    }
  }
  return null
}


/* ------------------------------------------------------------------ *
 * Subagents: the telephone queue
 * ------------------------------------------------------------------ */

/** One argument value as it appears in a call, clipped to something readable. */
function quoteValue(value, limit = 44) {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return '…'
  const flat = text.replace(/\s+/g, ' ').trim()
  return `"${flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat}"`
}

/**
 * The call as it was written, not just the instruction inside it.
 *
 * A subagent invocation is more than its prompt: the bubble shows the actual
 * call — `task(description="…", prompt="…")` — so it is clear what was asked
 * and how, and how many arguments came with it.
 *
 * @param {unknown} tool
 * @param {unknown} rawArgs the plugin's `arguments`, usually a JSON string
 * @returns {string}
 */
export function callFormat(tool, rawArgs) {
  const name = typeof tool === 'string' && tool.trim().length > 0 ? tool.trim() : 'subagent'
  if (rawArgs === undefined || rawArgs === null) return `${name}()`
  let args = rawArgs
  if (typeof args === 'string') {
    const text = args.trim()
    if (text.length === 0) return `${name}()`
    try {
      args = JSON.parse(text)
    } catch {
      return `${name}(${text.replace(/\s+/g, ' ')})`
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return `${name}(${quoteValue(args)})`
  const keys = Object.keys(args)
  if (keys.length === 0) return `${name}()`
  return `${name}(${keys.map((key) => `${key}=${quoteValue(args[key])}`).join(', ')})`
}

/**
 * When a record actually happened.
 *
 * The plugin timestamps every entry, and a viewer replaying the backlog gets
 * hours of history at once. Using the wall clock instead made every replayed
 * event look like it had just happened — so starting the command rang the
 * telephone for a subagent that finished five minutes ago.
 *
 * @param {any} record
 * @param {number} fallback
 * @returns {number}
 */
export function eventTime(record, fallback) {
  const raw = record?.entry?.time ?? record?.time ?? record?.at
  return Number.isFinite(raw) ? raw : fallback
}

/** The text a finished subagent came back with. */
export function replyTextOf(entry) {
  const candidates = [entry?.output?.text, entry?.result, entry?.rawText, entry?.text]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return ''
}

/** A subagent as the scene needs it. */
function subagentView(state, record) {
  if (record === null || record === undefined) return null
  const pending = state.subagentOrder
    .map((callId) => state.subagents.get(callId))
    .filter((item) => item !== undefined && item.status === 'pending')
  return {
    index: record.index,
    total: state.subagentCount,
    // Everything dispatched before this one that has not finished yet.
    queued: pending.filter((item) => item.callId !== record.callId).length,
    tool: record.tool,
    format: record.format,
    input: record.input,
    reply: record.status === 'done' ? record.result : null
  }
}

/** The number of subagents dispatched but not yet finished. */
function pendingSubagents(state) {
  let count = 0
  for (const record of state.subagents.values()) if (record.status === 'pending') count += 1
  return count
}


/**
 * A background subagent replies in two steps, and only the second one is an
 * answer.
 *
 * Dispatching one returns immediately with `started subagent <id>` — an
 * acknowledgement that the work was handed out, not the work. The subagent's
 * actual answer arrives later, as a message from the agent. Treating the
 * acknowledgement as the reply made every background subagent look finished the
 * instant it started, which emptied the queue and rang the telephone
 * immediately.
 */
const DISPATCH_ACK = /^started\s+subagent\s+(\S+)/i
const AGENT_MESSAGE = /^Agent\s+(\S+)\s+sent a message:\s*([\s\S]*)$/i
const AGENT_FINISHED = /^Background\s+subagent\s+(\S+)\s+finished/i
const CLOSING_MESSAGE = /Its closing message:\s*([\s\S]*)$/i

/**
 * Read a subagent notice.
 *
 * @param {unknown} text
 * @returns {{ handle: string, reply: string | null } | null}
 */
export function parseSubagentNotice(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const trimmed = text.trim()
  const sent = AGENT_MESSAGE.exec(trimmed)
  if (sent !== null) return { handle: sent[1], reply: sent[2].trim() }
  const closing = CLOSING_MESSAGE.exec(trimmed)
  if (closing !== null && AGENT_FINISHED.test(trimmed)) {
    return { handle: AGENT_FINISHED.exec(trimmed)[1], reply: closing[1].trim() }
  }
  return null
}

/** Is this result just the acknowledgement that a subagent was dispatched? */
export function isDispatchAck(text) {
  return typeof text === 'string' && DISPATCH_ACK.test(text.trim())
}

/** A fresh activity model. */
export function createWorkState() {
  return {
    status: 'idle',
    streamActive: false,
    streamKind: null,
    activeTool: null,
    lastOutputAt: 0,
    lastEventAt: 0,
    subagentCount: 0,
    subagent: null,
    /** Every subagent call in this session, keyed by call id. */
    subagents: new Map(),
    /** Call ids in the order they were dispatched: the queue. */
    subagentOrder: [],
    /** The subagent whose call is currently in flight. */
    activeSubagent: null,
    /** The most recent callback, which is what the telephone is ringing about. */
    lastReply: null,
    // The tail of whatever the model last put on the wire: what the little
    // window on the desk shows.
    preview: ''
  }
}

/** The text a tool call was given, as one short line, for the bubble. */
function summarise(input) {
  if (typeof input !== 'string' || input.trim().length === 0) return null
  return input.replace(/\s+/g, ' ').trim()
}

/** Arguments that best describe what a call is for, most specific first. */
const ARGUMENT_KEYS = ['description', 'prompt', 'task', 'instructions', 'query', 'command', 'path', 'file_path', 'pattern']

/** Pull a human-meaningful argument out of a tool call's arguments. */
function describeCall(entry) {
  let args = entry.arguments ?? entry.args ?? entry.input
  // The plugin publishes the call arguments as the raw JSON string it received.
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    } catch {
      return summarise(args)
    }
  }
  // With no arguments field at all, the entry itself may carry them (older
  // plugin versions, or a hand-written record).
  if (args === null || args === undefined) args = entry
  if (args !== null && typeof args === 'object' && args !== entry) {
    for (const key of ARGUMENT_KEYS) {
      const value = args[key]
      if (typeof value === 'string' && value.trim().length > 0) return summarise(value)
    }
    const first = Object.values(args).find((value) => typeof value === 'string' && value.trim().length > 0)
    if (typeof first === 'string') return summarise(first)
  }
  if (args === entry) {
    for (const key of ARGUMENT_KEYS) {
      const value = entry[key]
      if (typeof value === 'string' && value.trim().length > 0) return summarise(value)
    }
  }
  // Fall back to the entry's own one-line summary, which already contains the
  // arguments but leads with the tool name.
  const text = summarise(entry.text)
  if (text === null) return null
  const name = typeof entry.tool === 'string' ? entry.tool : null
  if (name !== null && text.startsWith(name)) return summarise(text.slice(name.length)) ?? name
  return text
}

/**
 * Fold one record into the activity model.
 *
 * @param {ReturnType<typeof createWorkState>} state
 * @param {any} record
 * @param {number} [now]
 * @returns {{ changed: boolean, finishedTool: object | null }}
 */
export function reduceWork(state, record, now = Date.now()) {
  if (record === null || typeof record !== 'object') return { changed: false, finishedTool: null }

  if (record.kind === 'status') {
    const status = record.status ?? 'idle'
    const changed = state.status !== status || state.streamActive !== (record.streamActive === true)
    state.status = status
    state.streamActive = record.streamActive === true
    state.lastEventAt = eventTime(record, now)
    return { changed, finishedTool: null }
  }

  if (record.kind === 'stream') {
    const reasoning = typeof record.reasoning === 'string' ? record.reasoning : ''
    const text = typeof record.text === 'string' ? record.text : ''
    if (text.length > 0) state.preview = text
    else if (reasoning.length > 0) state.preview = reasoning
    const kind = reasoning.length > 0 ? 'thinking' : text.length > 0 ? 'typing' : state.streamKind
    const changed = state.streamKind !== kind
    state.streamKind = kind
    state.streamActive = true
    state.lastEventAt = eventTime(record, now)
    return { changed, finishedTool: null }
  }

  if (record.kind === 'stream-end') {
    state.streamActive = false
    state.streamKind = null
    state.lastEventAt = eventTime(record, now)
    return { changed: true, finishedTool: null }
  }

  if (record.kind !== 'entry') return { changed: false, finishedTool: null }

  const entry = record.entry
  if (entry === null || entry === undefined) return { changed: false, finishedTool: null }

  const at = eventTime(record, now)
  const isTool = entry.tag === 'tool' || entry.tag === 'tool-call' || entry.tag === 'tool-result'
  if (!isTool) {
    // A subagent hanging up: its answer arrives as a message from the agent.
    const notice = parseSubagentNotice(entry.text ?? entry.rawText)
    if (notice !== null) {
      const finished = [...state.subagents.values()].find(
        (item) => item.handle === notice.handle && item.status === 'pending'
      )
      if (finished !== undefined) {
        finished.status = 'done'
        finished.result = notice.reply ?? ''
        if (state.activeSubagent === finished.callId) state.activeSubagent = null
        state.lastReply = { callId: finished.callId, index: finished.index, text: finished.result, at }
        state.preview = finished.result
        state.lastEventAt = at
        return { changed: true, finishedTool: null }
      }
    }
    if (typeof entry.rawText === 'string' && entry.rawText.length > 0) state.preview = entry.rawText
    else if (typeof entry.text === 'string' && entry.text.length > 0 && entry.tag === 'assistant') state.preview = entry.text
    state.lastEventAt = at
    return { changed: false, finishedTool: null }
  }

  const kind = classifyTool(entry.tool ?? entry.name)
  const phase = entry.phase ?? (entry.tag === 'tool-result' ? 'result' : 'call')

  if (phase === 'call') {
    if (kind === 'subagent') {
      const callId = entry.callId ?? entry.key ?? `subagent-${state.subagentCount + 1}`
      state.subagentCount += 1
      const name = entry.tool ?? entry.name ?? 'task'
      const described = describeCall(entry)
      const record = {
        callId,
        index: state.subagentCount,
        tool: name,
        // With the raw arguments (the current plugin) this is the call exactly
        // as written. Without them it falls back to the one-line summary the
        // entry already carries, so the bubble still shows a call rather than
        // an empty `task()`.
        format: entry.arguments === undefined
          ? (described === null ? `${name}()` : `${name}(${described})`)
          : callFormat(name, entry.arguments),
        input: described,
        status: 'pending',
        startedAt: at,
        result: ''
      }
      state.subagents.set(callId, record)
      state.subagentOrder.push(callId)
      state.activeSubagent = callId
      state.subagent = { index: record.index, input: describeCall(entry), name: record.tool }
      state.preview = record.format
    }
    state.activeTool = {
      callId: entry.callId ?? entry.key ?? null,
      name: entry.tool ?? entry.name ?? 'tool',
      kind,
      at,
      input: describeCall(entry)
    }
    state.preview = kind === 'subagent' ? undefined : (state.activeTool.input ?? state.preview)
    // Shell output resets the silence clock so a chatty command never sleeps.
    if (kind === 'shell') state.lastOutputAt = at
    state.lastEventAt = now
    return { changed: true, finishedTool: null }
  }

  // A result settles the tool it belongs to; shell output also keeps the
  // orca awake.
  const settled = state.activeTool
  const resultCallId = entry.callId ?? entry.key ?? null
  if (settled !== null && (settled.callId === null || settled.callId === resultCallId)) {
    state.activeTool = null
  }
  // A subagent hanging up: record its reply, which is what the telephone will
  // be ringing about.
  const callId = resultCallId ?? state.activeSubagent
  const finished = callId === null ? undefined : state.subagents.get(callId)
  if (finished !== undefined && finished.status === 'pending') {
    const ack = replyTextOf(entry)
    if (isDispatchAck(ack)) {
      // Handed out, not finished: a background subagent keeps its place in the
      // queue, and its answer arrives later as a message from the agent.
      finished.background = true
      finished.handle = DISPATCH_ACK.exec(ack.trim())[1]
      // The acknowledgement comes back at once, so the tool call is over in
      // milliseconds. Remember when the call was placed: the handset is held
      // for a moment afterwards, or the whole gesture is never seen.
      finished.dispatchedAt = at
      state.lastReply = null
    } else {
      finished.status = 'done'
      finished.result = ack
      if (state.activeSubagent === callId) state.activeSubagent = null
      state.lastReply = { callId, index: finished.index, text: finished.result, at }
    }
  }
  if (kind === 'shell' || settled?.kind === 'shell') {
    state.lastOutputAt = at
    if (settled?.kind === 'shell') state.activeTool = null
  }
  state.lastEventAt = at
  return { changed: true, finishedTool: settled }
}

/**
 * What the little window on the desk should show.
 *
 * The tail of the model's output while it writes, otherwise the call it is
 * running — the same text the telephone bubble uses.
 *
 * @param {ReturnType<typeof createWorkState>} state
 * @returns {string}
 */
export function previewOf(state) {
  const active = state.activeTool
  if (active !== null && typeof active.input === 'string' && active.input.length > 0) return active.input
  return typeof state.preview === 'string' ? state.preview : ''
}

/**
 * The state to draw right now.
 *
 * @param {ReturnType<typeof createWorkState>} state
 * @param {number} [now]
 * @returns {{ kind: string, subagent: { index: number, input: string | null } | null }}
 */
export function workStateOf(state, now = Date.now()) {
  // How many subagents are still out. Every state carries it, so a caller can
  // always ask the desk how deep the queue is.
  const out = pendingSubagents(state)
  const view = (kind, subagent, extra = {}) => ({ kind, subagent, waiting: false, pending: out, ...extra })

  // A subagent calling back rings the telephone. Answering it is the most
  // important thing on the desk, so it outranks everything else.
  const reply = state.lastReply
  if (reply !== null && typeof reply.at === 'number' && now - reply.at < RING_MS) {
    const answered = state.subagents.get(reply.callId)
    if (answered !== undefined) return view('ringing', subagentView(state, answered))
  }

  const tool = state.activeTool
  if (tool !== null) {
    if (tool.kind === 'subagent') {
      const record = state.activeSubagent === null ? undefined : state.subagents.get(state.activeSubagent)
      const held = record === undefined ? null : subagentView(state, record)
      return view('calling', held ?? state.subagent)
    }
    if (tool.kind === 'search') return view('searching', null)
    if (tool.kind === 'read') return view('reading', null)
    if (tool.kind === 'write') return view('writing', null)
    if (tool.kind === 'shell') {
      // A command that has said nothing for a long time is indistinguishable
      // from no work at all, so the orca falls asleep on it.
      const silentFor = now - Math.max(state.lastOutputAt, tool.at)
      return view(silentFor >= SILENT_MS ? 'sleep' : 'waiting', null)
    }
    return view('typing', null)
  }

  if (state.streamKind === 'thinking') return view('thinking', null)
  if (state.streamKind === 'typing') return view('typing', null)

  // Just after handing work out, the handset is still in the orca's flipper.
  // Without this the call is never seen: a background dispatch is acknowledged
  // immediately, so the tool is gone before the handset has finished rising.
  const calling = [...state.subagents.values()].filter(
    (item) => item.status === 'pending' && Number.isFinite(item.dispatchedAt) && now - item.dispatchedAt < CALL_MS
  )
  if (calling.length > 0) {
    const latest = calling.reduce((best, item) => (item.dispatchedAt > best.dispatchedAt ? item : best))
    return view('calling', subagentView(state, latest))
  }

  // Work handed out and nothing left to do: the orca dozes at the desk until
  // one of the subagents rings back.
  if (out > 0 && (state.status === 'idle' || state.status === 'error')) {
    return view('sleep', null, { waiting: true })
  }

  switch (state.status) {
    case 'running':
      return view('typing', null)
    case 'tool':
      return view('waiting', null)
    case 'waiting-approval':
      return view('thinking', null)
    case 'error':
      return view('typing', null)
    default:
      return view('sleep', null)
  }
}
