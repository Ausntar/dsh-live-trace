/**
 * Event normalization: raw DeepSeek Harness events into flat display records.
 *
 * Everything here is pure and has no Harness, filesystem, or terminal
 * dependency, so the mapping from an event to what the dashboard shows is
 * testable in isolation and identical in the plugin and the viewer's fixtures.
 *
 * Two families of input arrive:
 *
 * 1. Durable session-log events, delivered as `ctx.on('session/event', (session, event))`.
 *    Their envelope is `{ type, seq, time, data }`.
 * 2. Live, in-process events the log does not record verbatim, such as
 *    `agent/assistant-stream`, `agent/status`, and `agent/error`.
 *
 * @module dsh-live-trace/normalize
 */

import {
  capOutput,
  diffOperationFrom,
  filePathFrom,
  narrowFileDiffs,
  parseExitStatus,
  shellCallFrom
} from './tools.js'

/** Display tags; the viewer maps each to a distinct color and prefix treatment. */
export const TAG = {
  SESSION: 'session',
  TURN: 'turn',
  STEP: 'step',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  RESULT: 'result',
  ERROR: 'error',
  APPROVAL: 'approval',
  META: 'meta'
}

/** Default cap on one entry's primary text, in characters. */
export const DEFAULT_TEXT_LIMIT = 4000

/**
 * Event types the dashboard hides by default.
 *
 * These are internal transport bookkeeping records, not agent activity: they
 * carry delivery watermarks or diagnostics and would otherwise drown the trace
 * in one useless line per step. Entries ending in `*` are prefix matches.
 */
export const DEFAULT_MUTED_EVENT_TYPES = ['session-log-deepseek/*']

const DEFAULT_OPTIONS = {
  showSystemMessages: false,
  showRequestMetadata: false,
  // An unknown event type is much more likely to be a plugin's bookkeeping
  // record than something a human needs to watch, so the board stays quiet by
  // default and shows them only when asked.
  showUnknownEvents: false,
  mutedEventTypes: DEFAULT_MUTED_EVENT_TYPES,
  textLimit: DEFAULT_TEXT_LIMIT
}

/**
 * @param {unknown} type an event type name
 * @param {string[]} [patterns] exact names or `prefix*` patterns
 * @returns {boolean} whether the type is hidden
 */
export function isMutedEventType(type, patterns = DEFAULT_MUTED_EVENT_TYPES) {
  if (typeof type !== 'string' || !Array.isArray(patterns)) return false
  return patterns.some((pattern) =>
    typeof pattern === 'string' && pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern
  )
}

/* ------------------------------------------------------------------ *
 * Text utilities
 * ------------------------------------------------------------------ */

/**
 * Collapse any text to a single line: no CR/LF/TAB, no runs of whitespace.
 * @param {unknown} value
 * @returns {string}
 */
export function collapse(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/[\r\n\t\f\v]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Collapse and cap text with a trailing ellipsis.
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
export function clip(value, limit = 160) {
  const text = collapse(value)
  if (limit <= 0 || text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Render an arbitrary thrown value as one line.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return clip(error, 400)
  if (typeof error === 'object') {
    const record = /** @type {Record<string, unknown>} */ (error)
    const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : undefined
    const message =
      typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : typeof record.reason === 'string' && record.reason.length > 0
          ? record.reason
          : undefined
    if (code !== undefined && message !== undefined) return clip(`${code}: ${message}`, 400)
    if (message !== undefined) return clip(message, 400)
    if (code !== undefined) return clip(code, 400)
    try {
      return clip(JSON.stringify(record), 400)
    } catch {
      return 'unserializable error'
    }
  }
  return clip(String(error), 400)
}

/* ------------------------------------------------------------------ *
 * LLM content helpers
 * ------------------------------------------------------------------ */

/** Attachment display name, tolerating the several shapes refs use. */
function attachmentName(attachment) {
  if (attachment === null || typeof attachment !== 'object') return ''
  const record = /** @type {Record<string, unknown>} */ (attachment)
  for (const key of ['name', 'fileName', 'filename', 'title', 'id']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * Flatten model-facing content blocks into one display line.
 * @param {unknown} content
 * @param {{ includeReasoning?: boolean, includeToolCalls?: boolean }} [options]
 * @returns {string}
 */
export function contentText(content, options = {}) {
  if (typeof content === 'string') return collapse(content)
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (block)
    switch (record.type) {
      case 'text':
        parts.push(collapse(record.text))
        break
      case 'reasoning':
        if (options.includeReasoning === true) parts.push(collapse(record.text))
        break
      case 'tool-call':
        if (options.includeToolCalls === true) {
          parts.push(`→ ${collapse(record.name)}(${clip(record.arguments, 120)})`)
        }
        break
      case 'tool-addition':
        parts.push(`+tool ${collapse(record.toolName)}`)
        break
      case 'tool-removal':
        parts.push(`-tool ${collapse(record.toolName)}`)
        break
      case 'image': {
        const name = attachmentName(record.attachment)
        parts.push(name.length > 0 ? `[image ${name}]` : '[image]')
        break
      }
      case 'file': {
        const name = attachmentName(record.attachment)
        parts.push(name.length > 0 ? `[file ${name}]` : '[file]')
        break
      }
      default:
        if (typeof record.type === 'string') parts.push(`[${record.type}]`)
    }
  }
  return parts.filter((part) => part.length > 0).join(' ')
}

/**
 * Flatten content blocks preserving their internal line structure.
 *
 * {@link contentText} collapses everything to one line, which is right for a
 * compact trace row. Markdown rendering needs the original paragraphs and code
 * fences back, so this variant joins blocks with a blank line and keeps
 * newlines inside each block.
 *
 * @param {unknown} content
 * @param {{ includeReasoning?: boolean, includeToolCalls?: boolean }} [options]
 * @returns {string}
 */
export function contentBlocks(content, options = {}) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (block)
    switch (record.type) {
      case 'text':
        if (typeof record.text === 'string' && record.text.trim().length > 0) parts.push(record.text)
        break
      case 'reasoning':
        if (options.includeReasoning === true && typeof record.text === 'string' && record.text.trim().length > 0) {
          parts.push(record.text)
        }
        break
      case 'tool-call':
        if (options.includeToolCalls === true) {
          parts.push(`→ ${collapse(record.name)}(${clip(record.arguments, 120)})`)
        }
        break
      default:
        break
    }
  }
  return parts.join('\n\n')
}

/** Raw multi-line text of a model message, capped without collapsing lines. */
function rawMessageText(message, options = {}) {
  const limit = options.limit ?? 4000
  const raw = contentBlocks(/** @type {Record<string, unknown> | undefined} */ (message)?.content, options)
  return raw.length > limit ? raw.slice(0, limit) : raw
}

/** First non-empty text chunk of a model message, capped. */
function messageText(message, options = {}) {
  const content = /** @type {Record<string, unknown> | undefined} */ (message)?.content
  return clip(contentText(content, options), options.limit ?? 4000)
}

/**
 * Summarize raw tool-call arguments (an unparsed JSON string) for one line.
 * @param {unknown} raw
 * @param {number} [limit]
 * @returns {string}
 */
export function summarizeToolArguments(raw, limit = 200) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return clip(raw, limit)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return clip(raw, limit)
  const parts = []
  for (const [key, value] of Object.entries(parsed)) {
    let rendered
    if (typeof value === 'string') rendered = JSON.stringify(clip(value, 120))
    else if (value === null) rendered = 'null'
    else if (typeof value === 'bigint') rendered = String(value)
    else if (typeof value === 'object') {
      try {
        rendered = clip(JSON.stringify(value), 80)
      } catch {
        rendered = '[object]'
      }
    } else rendered = String(value)
    parts.push(`${key}=${rendered}`)
    if (parts.join(' ').length >= limit) break
  }
  return clip(parts.join(' '), limit)
}

/**
 * Human text for a `turn/end` reason.
 * @param {unknown} reason
 * @returns {string}
 */
export function turnEndReasonText(reason) {
  if (reason === null || typeof reason !== 'object') return 'ended'
  const record = /** @type {Record<string, unknown>} */ (reason)
  switch (record.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return record.reason === undefined ? 'aborted' : `aborted (${clip(record.reason, 80)})`
    case 'blocked':
      return 'blocked'
    case 'error':
      return `error: ${describeError(record.error)}`
    case 'max-tokens':
      return 'max output tokens reached'
    case 'forked':
      return 'forked'
    default:
      return typeof record.kind === 'string' ? record.kind : 'ended'
  }
}

/* ------------------------------------------------------------------ *
 * Session metadata
 * ------------------------------------------------------------------ */

/**
 * Project a live Session into the small shape the viewer displays.
 * @param {any} session
 * @returns {{ id: string, title?: string, cwd?: string, createdAt?: number, origin?: string, parentSession?: string, delegationDepth?: number, agentPreset?: string, seq?: number }}
 */
export function sessionInfo(session) {
  const header = session?.header ?? {}
  const id = typeof session?.id === 'string' ? session.id : String(session?.id ?? 'unknown')
  /** @type {any} */
  const info = { id }
  const title = session?.title ?? header.title
  if (typeof title === 'string' && title.length > 0) info.title = clip(title, 120)
  if (typeof header.cwd === 'string') info.cwd = header.cwd
  if (typeof header.createdAt === 'number') info.createdAt = header.createdAt
  if (typeof header.origin === 'string') info.origin = header.origin
  if (header.parentSession !== undefined && header.parentSession !== null) {
    info.parentSession = String(header.parentSession)
  }
  if (typeof header.delegationDepth === 'number') info.delegationDepth = header.delegationDepth
  if (typeof header.agentPreset === 'string') info.agentPreset = header.agentPreset
  const seq = session?.seq
  if (typeof seq === 'number') info.seq = seq
  return info
}

/**
 * Display label for a session's origin.
 * @param {object} info a {@link sessionInfo} result
 * @returns {string}
 */
export function sessionKindLabel(info) {
  if (info.origin === 'subagent') {
    const depth = typeof info.delegationDepth === 'number' ? ` L${info.delegationDepth}` : ''
    return `subagent${depth}`
  }
  return 'main'
}

/* ------------------------------------------------------------------ *
 * Durable session events
 * ------------------------------------------------------------------ */

const EVENT_PREFIX = {
  'turn/start': 'TURN',
  'turn/end': 'TURN',
  'step/start': 'STEP',
  'step/end': 'STEP'
}

/**
 * Normalize one append-feed session event.
 *
 * @param {{ type: string, seq?: number, time?: number, data?: any }} event
 * @param {{ showSystemMessages?: boolean, showRequestMetadata?: boolean, showUnknownEvents?: boolean, mutedEventTypes?: string[], textLimit?: number, outputLimits?: object }} [options]
 * @param {{ pendingTool?: { name?: string, shell?: object, filePath?: string } }} [context]
 *   the in-flight call a tool result settles, supplied by the tracker
 * @returns {{ entries: object[], usage?: object, context?: object, sessionTitle?: string }}
 */
export function normalizeSessionEvent(event, options = {}, context = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const type = event?.type
  const data = event?.data ?? {}
  const base = {
    seq: typeof event?.seq === 'number' ? event.seq : null,
    time: typeof event?.time === 'number' ? event.time : Date.now(),
    event: typeof type === 'string' ? type : 'unknown'
  }
  const out = { entries: [] }
  if (isMutedEventType(type, config.mutedEventTypes)) return out

  switch (type) {
    case 'turn/start':
      out.entries.push({
        ...base,
        tag: TAG.TURN,
        label: `${EVENT_PREFIX[type]} ${data.turn}`,
        text: 'turn started',
        turn: data.turn
      })
      break

    case 'turn/end':
      out.entries.push({
        ...base,
        tag: TAG.TURN,
        label: `${EVENT_PREFIX[type]} ${data.turn} END`,
        text: turnEndReasonText(data.reason),
        turn: data.turn,
        level: data.reason?.kind === 'error' ? 'error' : data.reason?.kind === 'completed' ? 'success' : 'info'
      })
      break

    case 'step/start':
      out.entries.push({
        ...base,
        tag: TAG.STEP,
        label: `${EVENT_PREFIX[type]} ${data.step}`,
        text: 'model call started',
        turn: data.turn,
        step: data.step
      })
      break

    case 'step/end':
      out.entries.push({
        ...base,
        tag: TAG.STEP,
        label: `${EVENT_PREFIX[type]} ${data.step} END`,
        text: 'step closed',
        turn: data.turn,
        step: data.step
      })
      break

    case 'user/message': {
      const source = data.source ?? {}
      const injected = source.kind !== undefined && source.kind !== 'user'
      out.entries.push({
        ...base,
        tag: TAG.USER,
        label: injected ? 'CONTEXT' : 'USER',
        text: messageText(data, { limit: config.textLimit }),
        detail: injected ? `source: ${clip(source.kind, 60)}` : undefined,
        level: injected ? 'muted' : 'info'
      })
      break
    }

    case 'developer/message':
      out.entries.push({
        ...base,
        tag: TAG.META,
        label: 'DEVELOPER',
        text: messageText(data.message, { limit: config.textLimit }) || 'developer instruction',
        turn: data.turn,
        step: data.step
      })
      break

    case 'system/message':
      if (config.showSystemMessages) {
        out.entries.push({
          ...base,
          tag: TAG.META,
          label: 'SYSTEM',
          text: messageText(data.message, { limit: config.textLimit }) || '(empty system prompt)',
          turn: data.turn,
          step: data.step,
          level: 'muted'
        })
      }
      break

    case 'assistant/message': {
      const visible = rawMessageText(data.message, { limit: config.textLimit })
      const thinking = rawMessageText(data.message, { includeReasoning: true, limit: config.textLimit })
      // `contentBlocks` with reasoning included also returns the visible text,
      // so subtract it to keep only the thinking part.
      const reasoning = thinking === visible ? '' : thinking.replace(visible, '').trim()
      const toolCalls = contentText(data.message?.content, { includeToolCalls: true })
      const collapsed = collapse(visible)
      out.entries.push({
        ...base,
        tag: TAG.ASSISTANT,
        label: data.interrupted === true ? 'ASSISTANT (interrupted)' : 'ASSISTANT',
        // `text` stays the one-line form so `--plain`, filters, and the repeat
        // collapsing keep working; `rawText` carries the markdown.
        text: collapsed || (toolCalls.length > 0 ? toolCalls : '(no visible text)'),
        rawText: visible,
        reasoning: reasoning.length > 0 ? reasoning : undefined,
        turn: data.turn,
        step: data.step,
        level: data.interrupted === true ? 'warn' : 'info'
      })
      if (data.usage !== undefined && data.usage !== null) out.usage = data.usage
      break
    }

    case 'assistant/attempt': {
      const reasoning = clip(reasoningOnly(data.stream), 400)
      out.entries.push({
        ...base,
        tag: TAG.META,
        label: 'ATTEMPT',
        text: reasoning.length > 0 ? `attempt settled without a message: ${reasoning}` : 'attempt settled without a message',
        turn: data.turn,
        step: data.step,
        level: 'warn'
      })
      break
    }

    case 'tool/call': {
      const callId = data.callId !== undefined ? String(data.callId) : undefined
      const shell = shellCallFrom(data.name, data.arguments)
      const filePath = filePathFrom(data.arguments)
      out.entries.push({
        ...base,
        // The call and its result share a key, so the viewer can upgrade the row
        // in place instead of leaving a dangling "running" line behind.
        key: toolKey(callId, base.seq),
        phase: 'call',
        tag: TAG.TOOL,
        label: 'TOOL',
        text: `${clip(data.name, 60)} ${summarizeToolArguments(data.arguments)}`.trim(),
        tool: typeof data.name === 'string' ? data.name : undefined,
        callId,
        // The raw call arguments ride along so a viewer can describe the work
        // in the model's own words (the mascot's telephone bubble, for one).
        arguments: data.arguments,
        turn: data.turn,
        step: data.step,
        ...(shell === undefined ? {} : { shell }),
        ...(filePath === undefined ? {} : { filePath })
      })
      break
    }

    case 'tool/result': {
      const isError = data.message?.isError === true
      const callId = data.message?.toolCallId !== undefined ? String(data.message.toolCallId) : undefined
      const call = context.pendingTool
      const toolName =
        call?.name ??
        (typeof data.message?.source?.toolName === 'string' ? data.message.source.toolName : undefined) ??
        'tool'
      // Parsed from the raw multi-line text: the exit marker lives on its own
      // final line, which a collapsed one-liner would no longer match.
      const rawBody = rawMessageText(data.message, { limit: config.textLimit })

      // A shell result carries its exit status as a trailing marker; splitting
      // it out lets the board show the status as its own pill and keeps the
      // marker out of the output body.
      let output
      let shellStatus
      let body = rawBody
      if (call?.shell !== undefined) {
        const parsed = parseExitStatus(rawBody)
        const capped = capOutput(parsed.body, config.outputLimits)
        output = capped
        shellStatus = { exitCode: parsed.exitCode, signal: parsed.signal }
        body = capped.text
      }

      const diffs = narrowFileDiffs(data.meta)
      const operation = diffOperationFrom(data.meta)
      // A shell command reports failure through its exit status, not through
      // `isError` (a non-zero exit is information for the model, not an
      // infrastructure failure), so the glyph follows the exit code.
      const ok = shellStatus?.exitCode !== undefined ? shellStatus.exitCode === 0 : !isError

      out.entries.push({
        ...base,
        key: toolKey(callId, base.seq),
        phase: 'result',
        tag: TAG.TOOL,
        // A merged block keeps reading as the tool that ran; an orphaned result
        // (whose call the viewer never saw) still reads as a result.
        label: call === undefined ? 'RESULT' : 'TOOL',
        text: (call === undefined ? `${clip(toolName, 40)} ` : '') + (collapse(body) || (isError ? 'tool failed' : 'ok')),
        rawText: body,
        detail: isError && data.error !== undefined ? describeError(data.error) : undefined,
        ok,
        level: ok ? 'success' : 'error',
        tool: toolName,
        callId,
        turn: data.turn,
        step: data.step,
        ...(call?.shell === undefined ? {} : { shell: call.shell }),
        ...(call?.filePath === undefined ? {} : { filePath: call.filePath }),
        ...(output === undefined ? {} : { output }),
        ...(shellStatus === undefined ? {} : { shellStatus }),
        ...(diffs === undefined ? {} : { diffs }),
        ...(operation === undefined ? {} : { operation })
      })
      break
    }

    case 'approval/asked':
      out.entries.push({
        ...base,
        tag: TAG.APPROVAL,
        label: 'APPROVAL',
        text: `${clip(data.toolName, 60)}${data.reason !== undefined ? ` — ${clip(data.reason, 300)}` : ''}`.trim(),
        callId: data.callId !== undefined ? String(data.callId) : undefined,
        level: 'warn'
      })
      break

    case 'approval/decided':
      out.entries.push({
        ...base,
        tag: TAG.APPROVAL,
        label: 'APPROVAL',
        text: `decision: ${clip(data.outcome, 40)}`,
        level: data.outcome === 'allowed-once' ? 'success' : data.outcome === 'rejected' ? 'error' : 'warn'
      })
      break

    case 'request/context':
      out.context = {
        provider: data.provider,
        model: data.model,
        capacity: pickNumber(data, ['capacity', 'contextWindow', 'maxContextTokens', 'contextTokens'])
      }
      if (config.showRequestMetadata) {
        out.entries.push({
          ...base,
          tag: TAG.META,
          label: 'ROUTE',
          text: `${clip(data.provider, 40)}/${clip(data.model, 60)}`,
          level: 'muted'
        })
      }
      break

    case 'request/header':
      if (config.showRequestMetadata) {
        out.entries.push({
          ...base,
          tag: TAG.META,
          label: 'HEADER',
          text: `request header (${clip(data.reason, 40)})`,
          level: 'muted'
        })
      }
      break

    case 'session/title': {
      const title = clip(data.title, 200)
      if (title.length > 0) out.sessionTitle = title
      out.entries.push({
        ...base,
        tag: TAG.META,
        label: 'TITLE',
        text: title,
        level: 'muted'
      })
      break
    }

    case 'permission/preset':
    case 'sandbox/mode':
    case 'approval/policy':
      out.entries.push({
        ...base,
        tag: TAG.META,
        label: 'POLICY',
        text: describePolicyEvent(type, data),
        level: 'muted'
      })
      break

    case 'session/end-seed':
      break

    default:
      if (config.showUnknownEvents) {
        out.entries.push({
          ...base,
          tag: TAG.META,
          label: typeof type === 'string' ? type.toUpperCase() : 'EVENT',
          text: summarizeUnknown(data, config.textLimit),
          level: 'muted'
        })
      }
  }

  return out
}

/** One compact line for a startup policy record. */
function describePolicyEvent(type, data) {
  switch (type) {
    case 'permission/preset':
      return `preset=${clip(data?.preset, 60) || 'default'}`
    case 'sandbox/mode':
      return `sandbox=${clip(data?.mode, 60) || 'default'}`
    case 'approval/policy':
      return `approval=${clip(data?.policy, 60) || 'default'}`
    default:
      return ''
  }
}

/** Extract only reasoning text from content blocks or a compact stream record list. */
function reasoningOnly(source) {
  if (!Array.isArray(source)) return ''
  const parts = []
  for (const item of source) {
    if (item === null || typeof item !== 'object') continue
    // Durable assistant streams are `AssistantStreamRecord[]`; a reasoning
    // block shows up either as a bare content block or inside `chunk`.
    const block = /** @type {any} */ (item)
    const chunk = block.chunk ?? block.block ?? block
    if (chunk?.type === 'reasoning' && typeof chunk.text === 'string') parts.push(chunk.text)
    else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
  }
  return collapse(parts.join(' '))
}

/** Stable identity that lets a call and its result occupy one trace row. */
function toolKey(callId, seq) {
  return callId === undefined ? `tool#${seq ?? 'x'}` : `tool:${callId}`
}

function pickNumber(object, keys) {
  for (const key of keys) {
    const value = object?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Best-effort one-line account of an event shape we do not model. */
function summarizeUnknown(data, limit) {
  if (data === null || data === undefined) return ''
  if (typeof data !== 'object') return clip(data, 200)
  for (const key of ['message', 'reason', 'text', 'name', 'kind', 'outcome']) {
    if (key in data) {
      const value = data[key]
      if (typeof value === 'string') return clip(value, 200)
      if (value !== null && typeof value === 'object') return clip(contentText(value?.content) || JSON.stringify(value), 200)
    }
  }
  try {
    return clip(JSON.stringify(data), Math.min(200, limit))
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * Live, in-process events
 * ------------------------------------------------------------------ */

/**
 * Normalize an `agent/status` transition into a status value for the dashboard.
 * @param {'idle' | 'running' | string} status
 * @returns {'idle' | 'running'}
 */
export function agentStatusValue(status) {
  return status === 'running' ? 'running' : 'idle'
}

/**
 * Normalize `agent/error`.
 * @param {{ turn?: number, step?: number, error?: unknown, time?: number }} payload
 * @param {{ textLimit?: number }} [options]
 * @returns {{ entries: object[] }}
 */
export function normalizeAgentError(payload, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options }
  return {
    entries: [
      {
        seq: null,
        time: typeof payload?.time === 'number' ? payload.time : Date.now(),
        event: 'agent/error',
        tag: TAG.ERROR,
        label: 'ERROR',
        text: clip(describeError(payload?.error), config.textLimit),
        turn: payload?.turn,
        step: payload?.step,
        level: 'error'
      }
    ]
  }
}

/**
 * Normalize a session announcement into a lifecycle entry.
 * @param {any} session
 * @param {string} [source]
 * @returns {{ entry: object, info: object }}
 */
export function normalizeSessionCreated(session, source) {
  const info = sessionInfo(session)
  return {
    info,
    entry: {
      seq: null,
      time: typeof info.createdAt === 'number' ? info.createdAt : Date.now(),
      event: 'session/created',
      tag: TAG.SESSION,
      label: 'SESSION',
      text: `opened${source !== undefined ? ` (${source})` : ''}${info.title !== undefined ? ` — ${info.title}` : ''}`,
      level: 'info'
    }
  }
}

/**
 * Normalize an `agent/created` announcement into a routing entry.
 * @param {any} agent
 * @param {string} [source]
 * @returns {{ entry: object | null, model?: string, provider?: string }}
 */
export function normalizeAgentCreated(agent, source) {
  const options = agent?.options ?? {}
  const provider = typeof options.provider === 'string' ? options.provider : undefined
  const model = typeof options.model === 'string' ? options.model : undefined
  if (provider === undefined && model === undefined) return { entry: null }
  return {
    provider,
    model,
    entry: {
      seq: null,
      time: Date.now(),
      event: 'agent/created',
      tag: TAG.META,
      label: 'MODEL',
      text: `${provider ?? '?'}/${model ?? '?'}${source !== undefined ? ` (${source})` : ''}`,
      level: 'muted'
    }
  }
}

/* ------------------------------------------------------------------ *
 * Usage accounting
 * ------------------------------------------------------------------ */

/**
 * Fold one `usage` payload into running totals.
 * @param {{ inputTokens?: number, outputTokens?: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number } | undefined} totals mutable totals
 * @param {object | undefined} usage one step's reported usage
 * @returns {object} the same totals object, mutated
 */
export function accumulateUsage(totals, usage) {
  if (usage === null || typeof usage !== 'object') return totals
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value
  }
  return totals
}
