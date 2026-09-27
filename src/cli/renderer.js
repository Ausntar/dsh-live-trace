/**
 * The dashboard renderer: view state in, terminal rows out.
 *
 * `renderFrame` is pure — it takes the view model plus a size and returns one
 * ANSI string per terminal row. It never writes, never reads the clock beyond
 * the `now` it is given, and never inspects the terminal, which means the whole
 * layout (including the 80-column contract) is testable without a TTY.
 *
 * Four panels share the same chrome: the chronological trace, the session
 * switcher, the file-change diff, and the command list. The trace renders model
 * prose as Markdown and each tool call as one block with its command, output,
 * and status.
 *
 * @module dsh-live-trace/renderer
 */

import { formatClock, formatDuration, formatTokens, shortPath, shortSessionId } from './format.js'
import { highlightLine } from './highlight.js'
import { renderMarkdown } from './markdown.js'
import { statusGlyph, statusStyle } from './theme.js'
import { DEFAULT_TRANSLATOR, statusText } from './i18n.js'
import { commandsView, editsView, sessionsView, toolDetailRows } from './views.js'
import { displayWidth, padRow, padTo, renderRow, rowWidth, sanitize, truncate, truncateSegments, wrapSegments } from './width.js'
import { commandsOf, usageTotal, VIEWS } from './view-state.js'

/** Below this many columns the board cannot say anything useful. */
export const MIN_COLS = 24
/** Below this many rows the board cannot show a header, body, and footer. */
export const MIN_ROWS = 8

const HEADER_ROWS = 3
const FOOTER_ROWS = 3
const TITLE = 'dsh-live-trace'
/** Rows one trace entry may occupy before it is cut with a marker. */
const DEFAULT_MAX_ENTRY_ROWS = 40
/** Rows one entry may occupy while its thinking block is expanded. */
const EXPANDED_ENTRY_ROWS = 400
/** Output lines shown inline in a trace tool block. */
const TRACE_OUTPUT_LINES = 12

/**
 * Whether a tool entry has settled.
 *
 * The merged-block protocol marks this with `phase`. Against an older plugin
 * (whose entries carry no phase) the original protocol is recovered from the
 * tag: `result` was the settled half and `tool` the running one. Without this
 * a stale plugin would render every running call as if it had finished.
 */
function isSettledEntry(entry) {
  if (entry.phase === 'result') return true
  if (entry.phase === 'call') return false
  return entry.tag === 'result'
}

/** Collapse a multi-line command to one log line. */
function oneLine(value) {
  return sanitize(value).replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Render a full frame.
 *
 * @param {import('./view-state.js').ViewState} state
 * @param {object} options
 * @param {number} options.cols
 * @param {number} options.rows
 * @param {import('./theme.js').Theme} options.theme
 * @param {(key: string, params?: object) => string} [options.t] translator
 * @param {number} [options.now]
 * @param {number} [options.frame] spinner frame index
 * @param {number} [options.scrollOffset] trace offset, counted from the bottom
 * @param {number} [options.panelOffset] panel offset, counted from the top
 * @param {'trace' | 'sessions' | 'edits' | 'commands'} [options.view]
 * @param {boolean} [options.sessionsOverlay]
 * @param {boolean} [options.paused]
 * @param {boolean} [options.help]
 * @param {boolean} [options.rawText] disable Markdown rendering
 * @param {boolean} [options.expandThinking] show thinking in full
 * @param {number} [options.maxEntryRows]
 * @param {{ start?: number, bodyRows?: number, headerRows?: number, rowItems?: number[] | null, view?: string }} [out]
 *   optional sink for the painted window, so input handling can map a screen
 *   row back to the list item it shows
 * @returns {string[]} exactly `rows` ANSI strings
 */
export function renderFrame(state, options, out) {
  const { cols, rows, theme } = options
  const t = options.t ?? DEFAULT_TRANSLATOR
  const now = options.now ?? Date.now()
  const frame = options.frame ?? 0

  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return renderTooSmall(cols, rows, theme)
  }

  const bodyRows = rows - HEADER_ROWS - FOOTER_ROWS
  const contentWidth = cols - 4
  const view = options.sessionsOverlay === true ? 'sessions' : (options.view ?? 'trace')


  const traceOffset = view === 'trace' && options.help !== true ? Math.max(0, options.scrollOffset ?? 0) : 0
  // Render only what the window can show, plus the rows scrolled past.
  const budget = bodyRows + traceOffset + 2

  const panel =
    options.help === true
      ? { rows: helpLines(contentWidth, theme, t), cursorRow: -1, older: false }
      : buildPanel(state, { contentWidth, theme, now, frame, view, options, budget, t })

  // The trace follows the newest entry from the bottom; the panels are lists
  // that scroll from the top and keep their cursor row on screen.
  const total = panel.rows.length
  const maxTop = Math.max(0, total - bodyRows)
  let start
  if (view === 'trace' && options.help !== true) {
    start = Math.max(0, maxTop - traceOffset)
  } else {
    start = Math.max(0, Math.min(options.panelOffset ?? 0, maxTop))
  }
  if (panel.cursorRow >= 0) {
    if (panel.cursorRow < start) start = panel.cursorRow
    else if (panel.cursorRow >= start + bodyRows) start = panel.cursorRow - bodyRows + 1
  }
  start = Math.max(0, Math.min(start, maxTop))

  const visible = panel.rows.slice(start, start + bodyRows)
  const hiddenAbove = start
  const hiddenBelow = Math.max(0, total - (start + visible.length))
  // A windowed trace knows rows exist above it without knowing how many.
  const hasOlder = panel.older === true || start > 0

  const lines = []
  lines.push(renderRow(borderTop(cols, theme, view, t)))
  lines.push(renderRow(frameRow(headerContent(state, contentWidth, theme, now, t), cols, theme)))
  lines.push(renderRow(borderMid(cols, theme)))
  for (let index = 0; index < bodyRows; index += 1) {
    lines.push(renderRow(frameRow(visible[index] ?? [], cols, theme)))
  }
  lines.push(renderRow(borderMid(cols, theme)))
  lines.push(
    renderRow(
      frameRow(
        footerContent(state, contentWidth, theme, now, t, {
          hiddenAbove,
          hiddenBelow,
          hasOlder,
          offset: view === 'trace' ? Math.max(0, options.scrollOffset ?? 0) : start,
          paused: options.paused === true,
          view,
          overlay: options.sessionsOverlay === true
        }),
        cols,
        theme
      )
    )
  )
  lines.push(renderRow(borderBottom(cols, theme)))
  if (out !== undefined) {
    out.start = start
    out.bodyRows = bodyRows
    out.headerRows = HEADER_ROWS
    out.rowItems = panel.rowItems ?? null
    out.view = view
    out.total = total
  }
  return lines
}

/**
 * Line-oriented output for `--plain`, one line per entry.
 * @param {import('./view-state.js').ViewState} state
 * @param {{ cols?: number, t?: Function }} [options]
 * @returns {string[]}
 */
export function renderPlainLines(state, options = {}) {
  const cols = options.cols ?? 120
  return state.entries.map((entry) => renderPlainEntry(entry, cols, options.t))
}

/**
 * One plain line for a single entry, used by streaming plain mode.
 * @param {object} entry
 * @param {number} [cols]
 * @param {(key: string, params?: object) => string} [t]
 * @returns {string}
 */
export function renderPlainEntry(entry, cols = 200, t = DEFAULT_TRANSLATOR) {
  const time = formatClock(entry.at ?? Date.now())
  const label = `[${entry.label ?? entry.tag}]`
  const isToolish = entry.tag === 'tool' || entry.tag === 'result'
  const settled = isToolish && isSettledEntry(entry)
  // A running call's text already leads with the tool name; only a settled
  // block needs it prepended.
  const name = settled && entry.tool !== undefined ? `${sanitize(entry.tool)} ` : ''
  const mark = settled ? (entry.ok === false ? '✗ ' : '✓ ') : ''
  const status = settled
    ? entry.shellStatus?.signal !== undefined
      ? `  ${t('commands.signal', { x: sanitize(entry.shellStatus.signal) })}`
      : entry.shell !== undefined
        ? `  ${t('commands.exit', { n: entry.shellStatus?.exitCode ?? 0 })}`
        : ''
    : isToolish
      ? `  ${t('trace.running')}`
      : ''
  const duration = typeof entry.durationMs === 'number' ? ` ${formatDuration(entry.durationMs)}` : ''
  // The command belongs in the log line; the body alone would lose what ran.
  const command = settled && entry.shell !== undefined ? `  $ ${oneLine(entry.shell.command)}` : ''
  const body = sanitize(entry.text ?? '')
  return truncate(`${time} ${label} ${mark}${name}${body}${status}${duration}${command}`, cols, '…')
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function borderTop(cols, theme, view, t = DEFAULT_TRANSLATOR) {
  const inner = cols - 2
  const label = view === undefined ? TITLE : `${TITLE} · ${t(`view.${view}`)}`
  const head = `─ ${label} `
  // Measured in cells: a translated panel name may contain wide characters.
  const headWidth = displayWidth(head)
  const fill = headWidth < inner ? head + '─'.repeat(inner - headWidth) : truncate(head, inner)
  return [{ text: '┌', sgr: theme.ui.border }, { text: fill, sgr: theme.ui.border }, { text: '┐', sgr: theme.ui.border }]
}

function borderMid(cols, theme) {
  return [
    { text: '├', sgr: theme.ui.border },
    { text: '─'.repeat(Math.max(0, cols - 2)), sgr: theme.ui.border },
    { text: '┤', sgr: theme.ui.border }
  ]
}

function borderBottom(cols, theme) {
  return [
    { text: '└', sgr: theme.ui.border },
    { text: '─'.repeat(Math.max(0, cols - 2)), sgr: theme.ui.border },
    { text: '┘', sgr: theme.ui.border }
  ]
}

/** One bordered row: `│ content │`, content exactly `cols - 4` cells wide. */
function frameRow(content, cols, theme) {
  const inner = Math.max(0, cols - 4)
  const fitted = truncateSegments(content, inner)
  const padded = padRow(fitted, inner)
  return [{ text: '│ ', sgr: theme.ui.border }, ...padded, { text: ' │', sgr: theme.ui.border }]
}

/**
 * Place `left` and `right` at the two ends of one content row.
 *
 * Right-hand segments may carry a `priority`; when the row is too narrow the
 * lowest-priority segment is removed first, repeatedly, before either side is
 * truncated. That keeps the figures a user must see at 80 columns (tokens, the
 * scroll position) while dropping decoration (the usage breakdown, the key
 * hints). Segments without a priority are never removed.
 */
export function composeLR(left, right, width, options = {}) {
  const minLeft = Math.max(0, options.minLeft ?? 0)
  let head = [...(left ?? [])]
  let tail = [...(right ?? [])]

  // Anything marked `priority` may be dropped. Both sides are fair game — a
  // long title or a long error message must give way before the session does —
  // but nothing at or above `ESSENTIAL` is ever removed.
  const ESSENTIAL = 3
  const dropLowest = (list) => {
    let victim = -1
    let worst = Number.POSITIVE_INFINITY
    for (let index = 0; index < list.length; index += 1) {
      const priority = list[index]?.priority
      // At or above `ESSENTIAL` nothing may be dropped, however tight it gets.
      if (typeof priority !== 'number' || priority >= ESSENTIAL) continue
      if (priority < worst) {
        worst = priority
        victim = index
      }
    }
    return victim === -1 ? null : [...list.slice(0, victim), ...list.slice(victim + 1)]
  }
  while (rowWidth(head) + rowWidth(tail) + 2 > width) {
    const nextTail = dropLowest(tail)
    if (nextTail !== null) {
      tail = nextTail
      continue
    }
    const nextHead = dropLowest(head)
    if (nextHead !== null) {
      head = nextHead
      continue
    }
    break
  }

  // Still too wide: shorten the text on the right rather than the session id,
  // which is the whole point of the header. Only the detail is cut.
  let leftWidth = rowWidth(head)
  let rightWidth = rowWidth(tail)
  if (leftWidth + rightWidth + 2 > width) {
    const reserved = Math.min(leftWidth, Math.max(minLeft, leftWidth))
    const room = Math.max(0, width - 2 - reserved)
    if (room > 0) {
      tail = truncateSegments(tail, room)
      rightWidth = rowWidth(tail)
    }
  }
  if (leftWidth + rightWidth + 2 <= width) {
    return [...head, { text: ' '.repeat(width - leftWidth - rightWidth) }, ...tail]
  }
  // Only now does the left give way.
  if (rightWidth + 10 <= width) {
    return [...truncateSegments(head, width - rightWidth - 2), { text: '  ' }, ...tail]
  }
  return truncateSegments(head, width)
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function headerContent(state, width, theme, now, t = DEFAULT_TRANSLATOR) {
  const session = state.sessionId
  const summary = state.sessions.find((item) => item.id === session)

  // The session id is the identifier; the title and the path are decoration.
  // Marking them droppable keeps the id on screen when the header is tight.
  const left = [{ text: `${t('header.session')} `, sgr: theme.ui.label, priority: 3 }]
  if (session === null || session === undefined) {
    left.push({ text: t('header.noSession'), sgr: theme.ui.statusIdle, priority: 3 })
  } else {
    left.push({ text: shortSessionId(session, 28), sgr: theme.ui.value, priority: 3 })
    if (summary?.title !== undefined && summary.title.length > 0) {
      left.push({ text: ` · ${sanitize(summary.title)}`, sgr: theme.level.info, priority: 1 })
    }
    if (summary?.cwd !== undefined && width > 100) {
      left.push({ text: `  ${shortPath(sanitize(summary.cwd), 34)}`, sgr: theme.ui.dim, priority: 1 })
    }
  }

  const status = state.status.status ?? 'idle'
  const right = [
    { text: `${t('header.status')} `, sgr: theme.ui.label, priority: 3 },
    { text: `${statusGlyph(status, Math.floor(now / 250))} `, sgr: statusStyle(theme, status), priority: 3 },
    {
      text: state.connected ? statusText(t, status) : t('header.disconnected'),
      sgr: statusStyle(theme, state.connected ? status : 'error'),
      priority: 2
    }
  ]
  // The error text is the longest and least essential thing here, so it is the
  // first to go.
  if (state.status.error !== null && state.status.error !== undefined) {
    right.push({ text: ` — ${truncate(sanitize(state.status.error), 40)}`, sgr: theme.ui.fail, priority: 0 })
  }

  // Never squeeze the session out: give the left at least the label and the id.
  const minLeft = rowWidth(left.slice(0, session === null || session === undefined ? 2 : 2))
  return composeLR(left, right, width, { minLeft })
}

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

/**
 * Build the active panel's rows and its cursor row.
 *
 * @returns {{ rows: import('./width.js').Segment[][], cursorRow: number }}
 */
export function buildPanel(state, context) {
  const { contentWidth, theme, now, view, options, budget, t } = context
  if (view === 'sessions') {
    const panel = sessionsView(state, { width: contentWidth, theme, now, t, overlay: options.sessionsOverlay === true })
    return { ...panel, older: false }
  }
  if (view === 'edits') {
    const panel = editsView(state, { width: contentWidth, theme, t, cursor: state.cursor.edits })
    return { ...panel, older: false }
  }
  if (view === 'commands') {
    const commands = commandsOf(state)
    const panel = commandsView(state, { width: contentWidth, theme, t, commands, selected: commands.length - 1 })
    return { ...panel, older: false }
  }
  if (state.entries.length === 0) {
    return { rows: buildBodyLines(state, context), cursorRow: -1, older: false }
  }
  const trace = buildTraceRows(state, context, budget ?? Number.POSITIVE_INFINITY)
  return { rows: trace.rows, cursorRow: -1, older: trace.older }
}

/**
 * Memoized entry rendering.
 *
 * A frame repaints every ~120ms, but an entry's rows only change when its
 * content, the width, or a rendering toggle changes. Caching per entry object
 * makes a steady-state repaint almost free; entries are replaced rather than
 * mutated, so identity is a safe cache key.
 *
 * @type {WeakMap<object, Map<string, import('./width.js').Segment[][]>>}
 */
const entryRowCache = new WeakMap()

function cachedEntryLines(entry, context) {
  let byContext = entryRowCache.get(entry)
  if (byContext === undefined) {
    byContext = new Map()
    entryRowCache.set(entry, byContext)
  }
  const key = [
    context.contentWidth,
    context.showTime === true ? 't' : '-',
    context.labelWidth,
    context.repeat ?? 1,
    context.maxEntryRows,
    context.options?.rawText === true ? 'raw' : 'md',
    context.options?.expandThinking === false ? '-' : 'x',
    context.options?.thinkingLines ?? 3
  ].join('|')
  const hit = byContext.get(key)
  if (hit !== undefined) return hit
  const rows = entryLines(entry, context)
  byContext.set(key, rows)
  return rows
}

/** Whether two entries would collapse into one repeated row. */
function sameEntry(a, b) {
  return a.tag === b.tag && a.label === b.label && a.text === b.text && a.ok === b.ok
}

/** The live streaming indicator, which sits below every committed entry. */
function streamIndicatorRows(state, context) {
  if (state.stream === null) return []
  const { contentWidth, theme, options } = context
  const t = context.t ?? DEFAULT_TRANSLATOR
  const glyph = statusGlyph(state.status.status === 'idle' ? 'running' : state.status.status, context.frame)
  const out = []

  // Reasoning is the point while the model is thinking, so it is wrapped and
  // shown as a block. It used to be one line holding the last few characters,
  // which is unreadable exactly when you most want to read it.
  const reasoning = sanitize(state.stream.reasoning ?? '').trim()
  if (reasoning.length > 0) {
    const label = `${t('trace.thinking')} `
    const labelWidth = displayWidth(label)
    const gutterWidth = 2 + labelWidth + 2
    // Through the same renderer the committed block uses, so Markdown in the
    // reasoning is formatted rather than shown as its own syntax.
    const rows = renderBody(reasoning, {
      width: Math.max(8, contentWidth - gutterWidth),
      theme,
      raw: options?.rawText === true,
      thinking: true
    })
    // The tail is what is being thought right now, so the block is anchored to
    // its end rather than its start.
    const limit = streamThinkingLines(options)
    for (const [index, row] of rows.slice(-limit).entries()) {
      out.push([
        { text: index === 0 ? `${glyph} ` : '  ', sgr: theme.ui.statusRunning },
        { text: index === 0 ? label : ' '.repeat(labelWidth), sgr: theme.ui.label },
        { text: '┊ ', sgr: theme.ui.border },
        ...row
      ])
    }
  }

  const writing = sanitize(state.stream.text ?? '').trim()
  if (writing.length > 0) {
    const label = `${t('trace.writing')} `
    const labelWidth = displayWidth(label)
    const rows = renderBody(writing, {
      width: Math.max(8, contentWidth - (2 + labelWidth + 2)),
      theme,
      raw: options?.rawText === true
    })
    for (const [index, row] of rows.slice(-streamThinkingLines(options)).entries()) {
      out.push([
        { text: index === 0 ? `${glyph} ` : '  ', sgr: theme.ui.statusRunning },
        { text: index === 0 ? label : ' '.repeat(labelWidth), sgr: theme.ui.label },
        { text: '┊ ', sgr: theme.ui.border },
        ...row
      ])
    }
  }

  return out
}

/**
 * How many rows of live reasoning to show.
 *
 * `e` expands; the collapsed count is `--thinking-lines`. Expanded means
 * "show me the thinking", so it is several times that rather than a token two
 * lines — the complaint that started this.
 */
function streamThinkingLines(options) {
  const base = Math.max(1, options?.thinkingLines ?? 3)
  if (options?.expandThinking === false) return base
  return Math.max(4, base * 4)
}

/**
 * Render the newest trace rows, stopping once `budget` rows are covered.
 *
 * The trace is bottom-anchored, so a frame only ever shows the tail. The
 * original implementation rendered the *entire* log and then sliced it, which
 * cost seconds per frame on a long session and is what made scrolling feel
 * laggy.
 *
 * @param {import('./view-state.js').ViewState} state
 * @param {object} context
 * @param {number} budget rows the caller needs
 * @returns {{ rows: import('./width.js').Segment[][], older: boolean }}
 */
export function buildTraceRows(state, context, budget = Number.POSITIVE_INFINITY) {
  const { contentWidth, theme } = context

  const blocks = []
  let rows = 0

  const indicator = streamIndicatorRows(state, context)
  if (indicator.length > 0) {
    blocks.push(indicator)
    rows += indicator.length
  }

  const showTime = contentWidth >= 60
  const labelWidth = computeLabelWidth(state.entries)
  const maxEntryRows = context.options?.maxEntryRows ?? DEFAULT_MAX_ENTRY_ROWS
  let index = state.entries.length - 1

  while (index >= 0 && rows < budget) {
    const entry = state.entries[index]
    // Collapse a run of identical entries into one counted row, walking
    // backwards so grouping costs nothing extra.
    let first = index
    while (first - 1 >= 0 && sameEntry(state.entries[first - 1], entry)) first -= 1
    const rendered = cachedEntryLines(entry, {
      ...context,
      showTime,
      labelWidth,
      repeat: index - first + 1,
      maxEntryRows
    })
    blocks.push(rendered)
    rows += rendered.length
    index = first - 1
  }

  const out = []
  for (let block = blocks.length - 1; block >= 0; block -= 1) out.push(...blocks[block])
  return { rows: out, older: index >= 0 }
}

/**
 * Build every wrapped trace line for the current state.
 *
 * Kept as the unbounded form for tests and one-off rendering; the frame path
 * uses {@link buildTraceRows} with a row budget.
 *
 * @returns {import('./width.js').Segment[][]}
 */
export function buildBodyLines(state, context) {
  const { theme } = context
  if (state.entries.length === 0) {
    const out = []
    const t = context.t ?? DEFAULT_TRANSLATOR
    if (!state.connected) {
      out.push([{ text: t('trace.connecting'), sgr: theme.ui.statusIdle }])
    } else if (state.sessions.length === 0) {
      out.push([{ text: t('trace.noSession'), sgr: theme.ui.statusIdle }])
    } else {
      out.push([{ text: t('trace.waiting'), sgr: theme.ui.statusIdle }])
    }
    if (state.serverError !== null && state.serverError !== undefined) {
      out.push([{ text: sanitize(state.serverError), sgr: theme.ui.fail }])
    }
    out.push(...streamIndicatorRows(state, context))
    return out
  }
  return buildTraceRows(state, context, Number.POSITIVE_INFINITY).rows
}

/**
 * Collapse runs of identical consecutive entries into one line.
 *
 * Chatty plugins can append the same bookkeeping record once per step; showing
 * one line with a `×N` count keeps the trace readable without hiding that the
 * event happened N times. The newest occurrence supplies the timestamp.
 *
 * @param {object[]} entries
 * @returns {Array<{ entry: object, count: number }>}
 */
export function groupRepeats(entries) {
  const groups = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    const same =
      last !== undefined &&
      last.entry.tag === entry.tag &&
      last.entry.label === entry.label &&
      last.entry.text === entry.text &&
      last.entry.ok === entry.ok
    if (same) {
      last.count += 1
      // Keep the first occurrence's ordering but report the latest time.
      last.entry = { ...entry, key: last.entry.key }
    } else {
      groups.push({ entry, count: 1 })
    }
  }
  return groups
}

function computeLabelWidth(entries) {
  let widest = 8
  for (const entry of entries.slice(-40)) {
    const label = `[${entry.label ?? entry.tag ?? '?'}]`
    widest = Math.max(widest, displayWidth(label))
  }
  return Math.max(9, Math.min(22, widest)) + 1
}

/** The `HH:MM:SS [LABEL] ` prefix every trace row starts with. */
function entryPrefix(entry, context) {
  const { theme, labelWidth, showTime } = context
  const tagStyle = theme.tag[entry.tag] ?? theme.ui.value
  const indented = entry.tag === 'tool' || entry.tag === 'approval' || entry.tag === 'result'
  const prefix = []
  if (showTime) prefix.push({ text: `${formatClock(entry.at)} `, sgr: theme.ui.dim })
  if (indented) prefix.push({ text: '  ', sgr: '' })
  const label = `[${truncate(entry.label ?? entry.tag ?? '?', labelWidth - 3)}]`
  prefix.push({ text: label, sgr: tagStyle })
  prefix.push({ text: ' '.repeat(Math.max(1, labelWidth - displayWidth(label))), sgr: '' })
  return prefix
}

/** Indent a set of rows under an entry's prefix. */
function indentRows(rows, indent) {
  return rows.map((row) => [{ text: ' '.repeat(indent), sgr: '' }, ...row])
}

function entryLines(entry, context) {
  const { contentWidth, theme } = context
  const prefix = entryPrefix(entry, context)
  const prefixWidth = rowWidth(prefix)

  // A turn opening gets a full-width rule, matching the board's reading order.
  if (entry.event === 'turn/start') {
    return [[...prefix, { text: '─'.repeat(Math.max(0, contentWidth - prefixWidth)), sgr: theme.ui.border }]]
  }

  // Expanding thinking is an explicit request for the whole block, so it lifts
  // the per-entry cap; leaving it in place made `e` look broken on long
  // reasoning. It stays bounded so one entry can never flood the frame.
  const budget =
    context.options?.expandThinking !== false
      ? Math.max(context.maxEntryRows ?? DEFAULT_MAX_ENTRY_ROWS, EXPANDED_ENTRY_ROWS)
      : (context.maxEntryRows ?? DEFAULT_MAX_ENTRY_ROWS)
  const isTool = entry.tag === 'tool' || entry.tag === 'result'
  const rows = isTool ? toolBlockRows(entry, context, prefix, prefixWidth) : proseRows(entry, context, prefix, prefixWidth)
  if (rows.length <= budget) return rows
  const kept = rows.slice(0, budget - 1)
  const capT = context.options?.t ?? DEFAULT_TRANSLATOR
  kept.push([
    { text: ' '.repeat(prefixWidth), sgr: '' },
    { text: capT('trace.moreLines', { n: rows.length - budget + 1 }), sgr: theme.ui.dim }
  ])
  return kept
}

/** An assistant/user entry: Markdown body plus a thinking section. */
function proseRows(entry, context, prefix, prefixWidth) {
  const { contentWidth, theme } = context
  const bodyWidth = Math.max(8, contentWidth - prefixWidth)
  const raw = context.options?.rawText === true
  const lines = []

  const source = entry.rawText !== undefined && entry.rawText.length > 0 ? entry.rawText : (entry.text ?? '')
  const rendered = renderBody(source, { width: bodyWidth, theme, raw, level: entry.level })
  const body = rendered.length > 0 ? rendered : [{ text: '(empty)', sgr: theme.level.muted }]
  const repeat = typeof context.repeat === 'number' && context.repeat > 1
    ? [{ text: `×${context.repeat} `, sgr: theme.ui.scrollHint }]
    : []
  if (repeat.length > 0) {
    // The count is re-wrapped with the body so the row still fits its budget.
    const first = wrapSegments([...repeat, ...body[0]], bodyWidth)
    lines.push([...prefix, ...first[0]])
    for (const row of first.slice(1)) lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...row])
    for (const row of body.slice(1)) lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...row])
    lines.push(...thinkingRows(entry, context, prefixWidth, bodyWidth))
    if (typeof entry.detail === 'string' && entry.detail.length > 0) {
      const detailWidth = Math.max(8, bodyWidth - 2)
      for (const line of wrapSegments([{ text: `↳ ${sanitize(entry.detail)}`, sgr: theme.level.muted }], detailWidth)) {
        lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...line])
      }
    }
    return lines
  }
  lines.push([...prefix, ...body[0]])
  for (const row of body.slice(1)) lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...row])

  lines.push(...thinkingRows(entry, context, prefixWidth, bodyWidth))

  if (typeof entry.detail === 'string' && entry.detail.length > 0) {
    const detailWidth = Math.max(8, bodyWidth - 2)
    for (const line of wrapSegments([{ text: `↳ ${sanitize(entry.detail)}`, sgr: theme.level.muted }], detailWidth)) {
      lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...line])
    }
  }
  return lines
}

/**
 * The thinking block under an assistant entry.
 *
 * Collapsed by default: reasoning is usually long and rarely what you are
 * watching for, so it shows a few lines and a marker telling you how much more
 * there is and which key opens it. `e` expands every block at once.
 *
 * @returns {import('./width.js').Segment[][]}
 */
function thinkingRows(entry, context, prefixWidth, bodyWidth) {
  const { theme, options } = context
  const reasoning = entry.reasoning
  if (typeof reasoning !== 'string' || reasoning.length === 0) return []
  const gutter = [
    { text: ' '.repeat(prefixWidth), sgr: '' },
    { text: '┊ ', sgr: theme.ui.border }
  ]
  const rows = renderBody(reasoning, {
    width: Math.max(8, bodyWidth - 2),
    theme,
    raw: options?.rawText === true,
    thinking: true
  })
  if (rows.length === 0) return []

  // Visible unless the user collapsed it: thinking is the point while the
  // model reasons, so the default must not hide it.
  const expanded = options?.expandThinking !== false
  const collapsedLines = Math.max(1, options?.thinkingLines ?? 3)
  const shown = expanded ? rows.length : Math.min(rows.length, collapsedLines)
  const out = rows.slice(0, shown).map((row) => [...gutter, ...row])

  if (!expanded && rows.length > shown) {
    const t = context.options?.t ?? DEFAULT_TRANSLATOR
    const hint = t('trace.expand')
    const key = hint.slice(0, hint.indexOf(' '))
    out.push([
      ...gutter,
      { text: `${t('trace.moreLines', { n: rows.length - shown })}  `, sgr: theme.ui.dim },
      { text: key, sgr: theme.ui.cursor },
      { text: hint.slice(key.length), sgr: theme.ui.dim }
    ])
  } else if (expanded && rows.length > collapsedLines) {
    const t = context.options?.t ?? DEFAULT_TRANSLATOR
    const hint = t('trace.collapse')
    const key = hint.slice(0, hint.indexOf(' '))
    out.push([...gutter, { text: key, sgr: theme.ui.cursor }, { text: hint.slice(key.length), sgr: theme.ui.dim }])
  }
  return out
}

/** Render a text body as Markdown, or as plain wrapped text in raw mode. */
function renderBody(text, context) {
  const source = sanitize(text)
  if (source.trim().length === 0) return []
  if (context.raw === true) {
    const sgr = context.thinking === true ? context.theme.ui.stream : (context.theme.level[context.level] ?? context.theme.level.info)
    return wrapSegments([{ text: source, sgr }], context.width)
  }
  const rows = renderMarkdown(source, { width: context.width, md: context.theme.md, syn: context.theme.syn })
  if (context.thinking === true) {
    // Thinking keeps its own dim tone over whatever Markdown styled.
    return rows.map((row) => row.map((segment) => (segment.sgr === undefined || segment.sgr === '' ? { ...segment, sgr: context.theme.ui.stream } : segment)))
  }
  return rows
}

/** A tool entry: header + the command it ran + its output + its status. */
function toolBlockRows(entry, context, prefix, prefixWidth) {
  const { contentWidth, theme } = context
  const t = context.options?.t ?? DEFAULT_TRANSLATOR
  const bodyWidth = Math.max(8, contentWidth - prefixWidth)
  const lines = []
  const settled = isSettledEntry(entry)

  const head = []
  if (typeof context.repeat === 'number' && context.repeat > 1) {
    head.push({ text: `×${context.repeat} `, sgr: theme.ui.scrollHint })
  }
  const summary =
    entry.shell?.description !== undefined && entry.shell.description.length > 0
      ? sanitize(entry.shell.description)
      : !settled && entry.phase === 'call'
        ? sanitize(entry.text ?? '')
        : settled && entry.shell !== undefined
          ? ''
          : sanitize(entry.text ?? '')
  // The name leads the header unless the text already leads with it, which is
  // how a running call's own summary reads in both protocols.
  const named = entry.tool !== undefined ? sanitize(entry.tool) : ''
  const name = named.length > 0 && !summary.startsWith(named) ? `${named} ` : ''
  head.push({ text: name, sgr: theme.level.info })
  head.push({ text: summary, sgr: theme.level[entry.level ?? 'info'] ?? theme.level.info })

  // Status pill: the settlement of a finished call, or a running marker.
  const pill = []
  if (settled) {
    const ok = entry.ok !== false
    pill.push({ text: `  ${ok ? '✓' : '✗'}`, sgr: ok ? theme.ui.ok : theme.ui.fail })
    if (entry.shellStatus?.signal !== undefined) pill.push({ text: ` signal ${sanitize(entry.shellStatus.signal)}`, sgr: theme.ui.fail })
    else if (entry.shell !== undefined) pill.push({ text: ` exit ${entry.shellStatus?.exitCode ?? 0}`, sgr: ok ? theme.ui.exitOk : theme.ui.exitFail })
    if (typeof entry.durationMs === 'number') pill.push({ text: ` ${formatDuration(entry.durationMs)}`, sgr: theme.ui.dim })
  } else {
    pill.push({ text: `  ${statusGlyph('tool', 0)} ${t('trace.running')}`, sgr: theme.ui.statusTool })
  }
  // The path is often already named in the summary; showing it twice is noise.
  if (entry.filePath !== undefined && !summary.includes(entry.filePath)) {
    pill.push({ text: ` ${shortPath(sanitize(entry.filePath), 40)}`, sgr: theme.ui.dim })
  }

  // The pill trails the end of the wrapped header, never the middle of it.
  const available = Math.max(8, bodyWidth - rowWidth(pill))
  const wrapped = wrapSegments(head, available)
  wrapped.forEach((row, index) => {
    const tail = index === wrapped.length - 1 ? pill : []
    if (index === 0) lines.push([...prefix, ...row, ...tail])
    else lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...row, ...tail])
  })

  if (entry.shell !== undefined) {
    for (const row of commandRows(entry.shell.command, bodyWidth, theme)) {
      lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...row])
    }
  }

  if (settled) {
    const output = entry.output?.text ?? entry.rawText ?? ''
    if (entry.shell === undefined && entry.diffs === undefined) {
      for (const row of renderBody(output, { width: bodyWidth, theme, raw: context.options?.rawText === true })) {
        lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...row])
      }
    } else if (entry.output !== undefined && output.length > 0) {
      const outputLines = sanitize(output).split('\n')
      for (const line of outputLines.slice(0, TRACE_OUTPUT_LINES)) {
        for (const wrappedLine of wrapSegments([{ text: line, sgr: theme.ui.output }], bodyWidth)) {
          lines.push([{ text: ' '.repeat(prefixWidth), sgr: '' }, ...wrappedLine])
        }
      }
      const omitted = (entry.output.omitted ?? 0) + Math.max(0, outputLines.length - TRACE_OUTPUT_LINES)
      if (omitted > 0) {
        lines.push([
          { text: ' '.repeat(prefixWidth), sgr: '' },
          { text: `${t('trace.moreLines', { n: omitted })}  ${t('trace.gotoCommands')}`, sgr: theme.ui.dim }
        ])
      }
    }
    if (entry.diffs !== undefined) {
      const counts = entry.diffs.reduce(
        (total, hunk) => ({
          added: total.added + (hunk.newText.length > 0 ? hunk.newText.split('\n').length : 0),
          removed: total.removed + (typeof hunk.oldText === 'string' && hunk.oldText.length > 0 ? hunk.oldText.split('\n').length : 0)
        }),
        { added: 0, removed: 0 }
      )
      lines.push([
        { text: ' '.repeat(prefixWidth), sgr: '' },
        {
          text: `${t(entry.diffs.length === 1 ? 'trace.hunk' : 'trace.hunks', { n: entry.diffs.length })} `,
          sgr: theme.level.muted
        },
        { text: `+${counts.added}`, sgr: theme.ui.added },
        { text: ' ', sgr: '' },
        { text: `−${counts.removed}`, sgr: theme.ui.removed },
        { text: `  ${t('trace.gotoEdits')}`, sgr: theme.ui.dim }
      ])
    }
  }
  return lines
}

/**
 * Render a shell command the way a terminal shows it: a prompt marker, the
 * command syntax highlighted, and a two-space hanging indent for continuations.
 *
 * Highlighting is per logical line rather than per block so wrapping can happen
 * inside it without losing the colouring.
 */
function commandRows(command, width, theme) {
  const out = []
  const lines = sanitize(command).split('\n')
  lines.forEach((line, index) => {
    const prompt = index === 0 ? { text: '$ ', sgr: theme.ui.hint } : { text: '  ', sgr: '' }
    const room = Math.max(4, width - rowWidth([prompt]))
    const wrapped = wrapSegments(highlightLine(line, 'bash', theme.syn), room)
    wrapped.forEach((row, rowIndex) => {
      const lead = rowIndex === 0 ? prompt : { text: ' '.repeat(rowWidth([prompt])), sgr: '' }
      out.push([lead, ...row])
    })
  })
  return out
}

/* ------------------------------------------------------------------ *
 * Help
 * ------------------------------------------------------------------ */

function helpLines(width, theme, t = DEFAULT_TRANSLATOR) {
  const sections = [
    [t('help.views'), [
      ['1 / t', t('help.tracePanel')],
      ['2 / s', t('help.sessionsPanel')],
      ['3 / d', t('help.editsPanel')],
      ['4 / c', t('help.commandsPanel')],
      ['tab', t('help.cycle')]
    ]],
    [t('help.trace'), [
      ['↑ / ↓', t('help.scrollLine')],
      ['PgUp / PgDn', t('help.page')],
      ['Home / End', t('help.jump')],
      ['e', t('help.thinking')],
      ['m', t('help.markdown')],
      ['l', t('help.language')],
      ['p', t('help.pause')],
      ['r', t('help.replay')]
    ]],
    [t('help.lists'), [
      ['↑ / ↓', t('help.select')],
      ['wheel', t('help.mouse')],
      ['click', t('help.click')],
      ['enter', t('help.bind')],
      ['esc', t('help.leave')]
    ]],
    ['', [
      ['?', t('help.helpKey')],
      ['q / Ctrl-C', t('help.quit')]
    ]]
  ]
  const out = [[{ text: t('help.title'), sgr: theme.ui.title }], [{ text: '', sgr: '' }]]
  for (const [heading, entries] of sections) {
    if (heading.length > 0) out.push([{ text: heading, sgr: theme.ui.title }])
    for (const [keys, description] of entries) {
      out.push([
        { text: '  ', sgr: '' },
        { text: padTo(keys, 24), sgr: theme.level.info },
        { text: description, sgr: theme.level.muted }
      ])
    }
    out.push([{ text: '', sgr: '' }])
  }
  out.push([{ text: t('help.readonly'), sgr: theme.level.muted }])
  out.push([{ text: t('help.width', { n: width }), sgr: theme.level.muted }])
  return out
}

/* ------------------------------------------------------------------ *
 * Footer
 * ------------------------------------------------------------------ */

function footerContent(state, width, theme, now, t, scroll) {
  const view = scroll.view ?? 'trace'
  const status = state.status.status ?? 'idle'
  const left = [{ text: `${statusGlyph(status, Math.floor(now / 250))} `, sgr: statusStyle(theme, status) }]
  left.push({
    text: scroll.paused === true ? t('footer.paused') : statusText(t, status),
    sgr: scroll.paused === true ? theme.ui.statusTool : statusStyle(theme, status)
  })

  if (scroll.overlay === true) left.push({ text: '   sessions', sgr: theme.ui.panelTitle })

  const turn = state.status.turn ?? 0
  const step = state.status.step ?? 0
  const maxStep = state.status.maxStep ?? 0
  if (turn > 0) left.push({ text: `   T${turn}`, sgr: theme.ui.value })
  if (step > 0) left.push({ text: ` · S${step}${maxStep > step ? `/${maxStep}` : ''}`, sgr: theme.ui.value })

  // "Elapsed" means the current turn while one is open, otherwise how long the
  // session has sat in its current state. Session age itself would be
  // misleading (a resumed session can be days old).
  const startedAt = state.turnStartedAt ?? state.status.since
  if (typeof startedAt === 'number' && startedAt > 0 && startedAt <= now) {
    left.push({ text: `   ${formatDuration(now - startedAt)}`, sgr: theme.ui.dim })
  }
  if (view === 'sessions' && state.sessions.length > 0) {
    left.push({ text: `   ${t('footer.sessions', { n: state.sessions.length })}`, sgr: theme.ui.dim })
  }
  if (view === 'edits' && state.edits.length > 0) {
    left.push({ text: `   ${t('footer.files', { n: state.edits.length })}`, sgr: theme.ui.dim })
  }

  const total = usageTotal(state.usage)
  const right = [
    { text: `${t('footer.tokens')} `, sgr: theme.ui.label },
    {
      text:
        state.contextWindow !== null && state.contextWindow !== undefined
          ? `${formatTokens(total)}/${formatTokens(state.contextWindow)}`
          : formatTokens(total),
      sgr: theme.ui.value
    }
  ]
  if (typeof state.usage?.inputTokens === 'number' || typeof state.usage?.outputTokens === 'number') {
    right.push({
      text: ` (↑${formatTokens(state.usage.inputTokens ?? 0)} ↓${formatTokens(state.usage.outputTokens ?? 0)})`,
      sgr: theme.ui.dim,
      priority: 1
    })
  }
  if (scroll.view === 'trace' && scroll.offset > 0) {
    right.push({ text: `   ${t('footer.above', { n: scroll.offset })}`, sgr: theme.ui.scrollHint, priority: 4 })
  } else if (scroll.hasOlder === true) {
    right.push({ text: `   ${t('footer.older')}`, sgr: theme.ui.scrollHint, priority: 3 })
  }
  if (scroll.hiddenBelow > 0) {
    right.push({ text: `   ${t('footer.below', { n: scroll.hiddenBelow })}`, sgr: theme.ui.scrollHint, priority: 3 })
  }
  right.push({ text: `   ${t(`keys.${view}`)}`, sgr: theme.ui.hint, priority: 2 })

  return composeLR(left, right, width)
}

/* ------------------------------------------------------------------ *
 * Degenerate sizes
 * ------------------------------------------------------------------ */

function renderTooSmall(cols, rows, theme) {
  const message = [
    `Terminal too small (${cols}×${rows}).`,
    `Need at least ${MIN_COLS}×${MIN_ROWS}.`,
    'Resize the window or press q.'
  ]
  const lines = []
  for (let index = 0; index < rows; index += 1) {
    const text = message[index] ?? ''
    lines.push(renderRow(padRow([{ text: truncate(text, Math.max(0, cols)), sgr: theme.ui.fail }], cols)))
  }
  return lines
}

export { VIEWS, toolDetailRows }
