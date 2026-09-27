/**
 * The dashboard's non-trace panels: the session switcher that is also the
 * landing screen, the file-change (diff) panel, and the command panel.
 *
 * Each builder is pure: it takes the view model plus a size and returns rows of
 * styled segments, already wrapped. The renderer frames them; the terminal is
 * never touched here.
 *
 * @module dsh-live-trace/views
 */

import { formatDuration, shortPath, shortSessionId } from './format.js'
import { DEFAULT_TRANSLATOR, statusText } from './i18n.js'
import { displayWidth } from './width.js'
import { highlightLine } from './highlight.js'
import { renderMarkdown } from './markdown.js'
import { statusGlyph, statusStyle } from './theme.js'
import { padTo, rowWidth, sanitize, truncateSegments, wrapSegments } from './width.js'
import { editTotals, sessionRows } from './view-state.js'

/** Rows reserved for the file list above a diff before it starts scrolling. */
const MAX_FILE_ROWS = 6
/** Output lines shown for a command that is not selected, and for the selected one. */
const OUTPUT_PREVIEW_LINES = 3
const OUTPUT_SELECTED_LINES = 14

/** One styled segment. @typedef {{ text: string, sgr?: string }} Segment */

/** @param {string} text @param {string} [sgr] @returns {Segment[]} */
function seg(text, sgr) {
  return [{ text, sgr }]
}

/**
 * A section heading row pair: the title and its underline.
 * @returns {Segment[][]}
 */
function sectionHeader(title, right, width, theme) {
  const left = seg(title, theme.ui.panelTitle)
  const rightSeg = right === undefined || right.length === 0 ? [] : seg(right, theme.ui.dim)
  const gap = Math.max(1, width - rowWidth(left) - rowWidth(rightSeg))
  return [
    [...left, { text: ' '.repeat(gap) }, ...rightSeg],
    seg('─'.repeat(Math.max(0, width)), theme.ui.border)
  ]
}

/** Wrap one logical row into a first line plus hanging-indent continuations. */
function hanging(prefix, body, width, indent) {
  const available = Math.max(8, width - rowWidth(prefix))
  const wrapped = wrapSegments(body, available)
  return wrapped.map((line, index) =>
    index === 0 ? [...prefix, ...line] : [{ text: ' '.repeat(indent), sgr: '' }, ...line]
  )
}

/* ------------------------------------------------------------------ *
 * Sessions: the landing screen and the switcher
 * ------------------------------------------------------------------ */

/**
 * Render the session list.
 *
 * @param {import('./view-state.js').ViewState} state
 * @param {{ width: number, theme: any, now?: number, overlay?: boolean }} context
 * @returns {{ rows: Segment[][], cursorRow: number }}
 */
export function sessionsView(state, context) {
  const { width, theme } = context
  const t = context.t ?? DEFAULT_TRANSLATOR
  const now = context.now ?? Date.now()
  const rows = sessionRows(state, now)
  const out = []
  /** Body row -> session index, so a mouse click can select one. */
  const rowItems = []

  const active = rows.filter((row) => row.activity !== 'idle').length
  const headerRows = sectionHeader(
    t('panel.sessions'),
    rows.length === 0 ? t('panel.none') : t('panel.known', { n: rows.length, m: active }),
    width,
    theme
  )
  out.push(...headerRows)
  rowItems.push(...headerRows.map(() => -1))

  if (rows.length === 0) {
    out.push(seg(t('sessions.empty'), theme.ui.statusIdle))
    out.push(seg(t('sessions.emptyHint'), theme.ui.dim))
    return { rows: out, cursorRow: -1, rowItems: [-1, -1, -1, -1] }
  }

  const idWidth = Math.min(26, Math.max(...rows.map((row) => shortSessionId(row.id, 26).length)))
  const activityLabel = (row) => statusText(t, row.activity)
  const activityWidth = Math.min(20, Math.max(...rows.map((row) => displayWidth(activityLabel(row)))))
  const positionWidth = Math.min(12, Math.max(...rows.map((row) => `T${row.turn}·S${row.step}`.length)))
  const ageWidth = 8

  let cursorRow = -1
  for (const row of rows) {
    if (row.selected) cursorRow = out.length
    const marker = row.selected ? '▸' : ' '
    const bound = row.bound ? '●' : ' '
    const activity = activityLabel(row)
    const position = `T${row.turn}·S${row.step}`

    out.push([
      { text: `${marker} `, sgr: row.selected ? theme.ui.cursor : theme.ui.dim },
      { text: `${bound} `, sgr: row.bound ? theme.tag.turn : theme.ui.dim },
      { text: `${statusGlyph(row.activity, Math.floor(now / 250))} `, sgr: statusStyle(theme, row.activity) },
      { text: padTo(activity, activityWidth), sgr: statusStyle(theme, row.activity) },
      { text: `  ${padTo(position, positionWidth)}`, sgr: theme.ui.value },
      { text: `  ${padTo(formatAge(row.idleFor, t), ageWidth)}`, sgr: theme.ui.dim },
      { text: '  ', sgr: '' },
      { text: row.title !== undefined ? sanitize(row.title) : shortSessionId(row.id, idWidth), sgr: row.selected ? theme.ui.selected : theme.level.info }
    ])

    const detail = [shortSessionId(row.id, 32)]
    if (row.title !== undefined) detail.push(`· ${sanitize(row.title)}`)
    if (row.origin === 'subagent') detail.push(`· ${t('sessions.subagent', { n: row.delegationDepth ?? 1 })}`)
    if (typeof row.cwd === 'string' && row.cwd.length > 0) detail.push(`· ${shortPath(sanitize(row.cwd), 40)}`)
    out.push([
      { text: `${row.selected ? '▸ ' : '  '}  `, sgr: theme.ui.dim },
      { text: detail.join(' '), sgr: theme.ui.dim }
    ])
    // Both rows of a session select that session.
    rowItems.push(row.index, row.index)
  }
  return { rows: out, cursorRow, rowItems }
}

/** `now`, `12s`, `4m`, `2h` — how long a session has been quiet. */
function formatAge(ms, t = DEFAULT_TRANSLATOR) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-'
  if (ms < 1500) return t('age.now')
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

/* ------------------------------------------------------------------ *
 * Edits: what the model changed on disk
 * ------------------------------------------------------------------ */

/**
 * Render the file-change panel: a file list above the selected file's diff.
 *
 * @param {import('./view-state.js').ViewState} state
 * @param {{ width: number, theme: any, height?: number, cursor?: number }} context
 * @returns {{ rows: Segment[][], cursorRow: number }}
 */
export function editsView(state, context) {
  const { width, theme } = context
  const t = context.t ?? DEFAULT_TRANSLATOR
  const totals = editTotals(state)
  const out = []

  const summary =
    totals.files === 0
      ? t('edits.noChanges')
      : `${t(totals.files === 1 ? 'edits.fileCount' : 'edits.filePlural', { n: totals.files })}  +${totals.added} −${totals.removed}`
  const headerRows = sectionHeader(t('panel.edits'), summary, width, theme)
  out.push(...headerRows)
  const rowItems = headerRows.map(() => -1)

  if (state.edits.length === 0) {
    out.push(seg(t('edits.empty'), theme.ui.statusIdle))
    out.push(seg(t('edits.emptyHint'), theme.ui.dim))
    return { rows: out, cursorRow: -1, rowItems: [-1, -1, -1, -1] }
  }

  const cursor = clamp(context.cursor ?? 0, 0, state.edits.length - 1)
  const listRows = Math.min(state.edits.length, MAX_FILE_ROWS)
  // Keep the selected file inside the visible slice of the list.
  const start = clamp(cursor - listRows + 1, 0, Math.max(0, state.edits.length - listRows))

  let cursorRow = -1
  for (let index = start; index < start + listRows; index += 1) {
    const edit = state.edits[index]
    if (index === cursor) cursorRow = out.length
    const marker = index === cursor ? '▸' : ' '
    const counts = `+${edit.added} −${edit.removed}`
    const badge =
      edit.operation === 'create' ? t('edits.badge.new') : edit.operation === 'delete' ? t('edits.badge.del') : t('edits.badge.mod')
    const pathRoom = Math.max(12, width - 4 - counts.length - 6)
    out.push([
      { text: `${marker} `, sgr: index === cursor ? theme.ui.cursor : theme.ui.dim },
      ...truncateSegments(seg(sanitize(edit.path), index === cursor ? theme.ui.selected : theme.level.info), pathRoom),
      { text: `  ${counts}`, sgr: index === cursor ? theme.ui.added : theme.ui.dim },
      { text: `  ${badge}`, sgr: theme.ui.dim }
    ])
    rowItems.push(index)
  }
  if (state.edits.length > listRows) {
    out.push(
      seg(
        `  ${t(state.edits.length - listRows === 1 ? 'edits.moreFile' : 'edits.moreFiles', { n: state.edits.length - listRows })}`,
        theme.ui.dim
      )
    )
    rowItems.push(-1)
  }

  out.push(seg('─'.repeat(Math.max(0, width)), theme.ui.border))
  rowItems.push(-1)
  const diff = diffRows(state.edits[cursor], width, theme)
  out.push(...diff)
  rowItems.push(...diff.map(() => -1))
  return { rows: out, cursorRow, rowItems }
}

/** Unified-diff rows for one file's aggregated hunks. */
function diffRows(edit, width, theme, t = DEFAULT_TRANSLATOR) {
  if (edit === undefined) return []
  const out = []
  edit.hunks.forEach((hunk, index) => {
    if (index > 0) out.push(seg('  ⋮', theme.ui.dim))
    out.push(
      seg(`  @@ ${sanitize(edit.path)}${hunk.oldText === null ? `  ${t('edits.newFile')}` : ''}`, theme.ui.hunkHeader)
    )
    if (typeof hunk.oldText === 'string' && hunk.oldText.length > 0) {
      for (const line of hunk.oldText.split('\n')) out.push(...diffLine('- ', line, theme.ui.removed, theme.ui.removedBg, width))
    }
    for (const line of hunk.newText.split('\n')) out.push(...diffLine('+ ', line, theme.ui.added, theme.ui.addedBg, width))
  })
  return out
}

function diffLine(marker, text, colour, background, width) {
  const prefix = [{ text: `  ${marker}`, sgr: colour }]
  const room = Math.max(8, width - rowWidth(prefix))
  const line = seg(sanitize(text), colour)
  const wrapped = wrapSegments(line, room)
  return wrapped.map((piece, index) =>
    index === 0
      ? [...prefix, ...piece.map((segment) => ({ ...segment, sgr: colour }))]
      : [{ text: '   ', sgr: background }, ...piece.map((segment) => ({ ...segment, sgr: colour }))]
  )
}

/* ------------------------------------------------------------------ *
 * Commands: what the model ran and what came back
 * ------------------------------------------------------------------ */

/**
 * Render the command panel: one block per shell command the session ran.
 *
 * @param {import('./view-state.js').ViewState} state
 * @param {{ width: number, theme: any, commands?: object[], selected?: number, height?: number }} context
 * @returns {{ rows: Segment[][], cursorRow: number }}
 */
export function commandsView(state, context) {
  const { width, theme } = context
  const t = context.t ?? DEFAULT_TRANSLATOR
  const commands = context.commands ?? []
  const out = []

  const failed = commands.filter((command) => command.ok === false).length
  const running = commands.filter((command) => command.pending).length
  const summary =
    commands.length === 0
      ? t('panel.none')
      : [
          t('commands.summaryRun', { n: commands.length }),
          failed > 0 ? t('commands.summaryFailed', { n: failed }) : null,
          running > 0 ? t('commands.summaryRunning', { n: running }) : null
        ]
          .filter((part) => part !== null)
          .join(' · ')
  out.push(...sectionHeader(t('panel.commands'), summary, width, theme))

  if (commands.length === 0) {
    out.push(seg(t('commands.empty'), theme.ui.statusIdle))
    out.push(seg(t('commands.emptyHint'), theme.ui.dim))
    return { rows: out, cursorRow: -1 }
  }

  const selected = clamp(context.selected ?? commands.length - 1, 0, commands.length - 1)
  let cursorRow = -1

  commands.forEach((command, index) => {
    const isSelected = index === selected
    if (isSelected) cursorRow = out.length
    const glyph = command.pending ? statusGlyph('tool', 0) : command.ok === false ? '✗' : '✓'
    const colour = command.pending ? theme.ui.statusTool : command.ok === false ? theme.ui.exitFail : theme.ui.exitOk
    const status = command.pending
      ? t('commands.running')
      : command.signal !== undefined && command.signal !== null
        ? t('commands.signal', { x: command.signal })
        : t('commands.exit', { n: command.exitCode ?? 0 })

    const right = `${command.durationMs === undefined ? '' : formatDuration(command.durationMs)}  ${status}`.trim()
    const head = [{ text: `${isSelected ? '▸ ' : '  '}${glyph} `, sgr: colour }]
    const room = Math.max(12, width - rowWidth(head) - right.length - 3)
    const oneLineCommand = sanitize(command.command.replace(/\s*\n\s*/g, ' '))
    const commandSegments = truncateSegments(highlightLine(oneLineCommand, 'bash', theme.syn), room)
    // In cells, not code units: a translated status such as `执行中…` is wider
    // than its character count.
    const gap = Math.max(1, width - rowWidth(head) - rowWidth(commandSegments) - displayWidth(right))
    out.push([...head, ...commandSegments, { text: ' '.repeat(gap), sgr: '' }, { text: right, sgr: colour }])

    if (command.description !== undefined && command.description.length > 0) {
      out.push([{ text: '    ', sgr: '' }, ...truncateSegments(seg(sanitize(command.description), theme.ui.dim), Math.max(8, width - 4))])
    }

    const budget = isSelected ? OUTPUT_SELECTED_LINES : OUTPUT_PREVIEW_LINES
    const lines = sanitize(command.outputText ?? '').split('\n').filter((line, position, all) => position < all.length - 1 || line.length > 0)
    if (lines.length === 0) {
      out.push(seg(`    ${t('commands.noOutput')}`, theme.ui.dim))
    } else {
      for (const line of lines.slice(0, budget)) {
        for (const wrapped of wrapSegments(seg(line, theme.ui.output), Math.max(8, width - 4))) {
          out.push([{ text: '    ', sgr: '' }, ...wrapped])
        }
      }
      const hidden = command.output?.omitted ?? 0
      if (lines.length > budget || hidden > 0) {
        const more = hidden + Math.max(0, lines.length - budget)
        out.push(seg(`    ${t('trace.moreLines', { n: more })}`, theme.ui.dim))
      }
    }
    out.push(seg('', theme.ui.dim))
  })

  return { rows: out, cursorRow }
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/**
 * A tool block for the trace: the command or arguments, the output, and the
 * status, as one readable card instead of disconnected call and result lines.
 *
 * @param {object} entry
 * @param {{ width: number, theme: any, indent?: number, raw?: boolean }} context
 * @returns {Segment[][]}
 */
export function toolDetailRows(entry, context) {
  const { width, theme } = context
  const indent = context.indent ?? 0
  const gutter = ' '.repeat(indent)
  const room = Math.max(8, width - indent)
  const out = []

  if (entry.shell !== undefined) {
    for (const row of commandRows(gutter, entry.shell.command, room)) {
      out.push([{ text: gutter, sgr: '' }, ...row.map((segment) => ({ ...segment, sgr: theme.ui.command }))])
    }
  }

  if (entry.phase === 'result') {
    if (entry.output !== undefined && entry.output.text.length > 0) {
      const lines = entry.output.text.split('\n')
      for (const line of lines.slice(0, 40)) {
        for (const wrapped of wrapSegments(seg(sanitize(line), theme.ui.output), room)) {
          out.push([{ text: gutter, sgr: '' }, ...wrapped])
        }
      }
      if (entry.output.truncated === true && entry.output.omitted > 0) {
        out.push(seg(`${gutter}… ${entry.output.omitted} more line${entry.output.omitted === 1 ? '' : 's'}`, theme.ui.dim))
      }
    } else if (entry.rawText !== undefined && entry.rawText.length > 0 && entry.shell === undefined) {
      // Non-shell tools: keep the existing markdown/plain body treatment.
      for (const row of contextualBody(entry, { width: room, theme, raw: context.raw })) {
        out.push([{ text: gutter, sgr: '' }, ...row])
      }
    }
  }
  return out
}

/**
 * Render a shell command the way a terminal shows it: a prompt marker, the
 * command, and a hanging indent for any continuation lines.
 */
function commandRows(gutter, command, room) {
  const out = []
  const lines = sanitize(command).split('\n')
  lines.forEach((line, index) => {
    const prompt = index === 0 ? '$ ' : '  '
    for (const wrapped of wrapSegments(seg(prompt + line, ''), room)) {
      out.push(wrapped)
    }
  })
  return out
}

/** Markdown body of a non-shell tool result, honouring the raw toggle. */
function contextualBody(entry, context) {
  const text = entry.rawText ?? entry.text ?? ''
  if (context.raw === true) {
    return wrapSegments(seg(sanitize(text), context.theme.ui.output), context.width)
  }
  return renderMarkdown(text, {
    width: context.width,
    md: context.theme.md,
    syn: context.theme.syn
  })
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}
