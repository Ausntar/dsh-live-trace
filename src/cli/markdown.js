/**
 * Zero-dependency Markdown rendering into styled *rows* for the dashboard.
 *
 * `renderMarkdown()` turns a Markdown document into `Segment[][]` — each row is
 * already wrapped to the requested cell width, so `renderRow(row)` can be
 * emitted directly. Styling comes from two caller-supplied palettes
 * (`md` for Markdown structure, `syn` for fenced code highlighting); every
 * palette value may be `''` to disable color.
 *
 * Design rules:
 *  - All incoming text is passed through `sanitize()` first, then every row is
 *    produced through `wrapSegments()`/`truncateSegments()`, so
 *    `rowWidth(row) <= width` holds for every row and every `width >= 8`.
 *  - Malformed input never throws: the public entry point has a last-resort
 *    plain-text fallback.
 *  - Code is highlighted per line with `highlightLine`/`highlightCode` from
 *    `highlight.js`; long code lines wrap under a two-space continuation
 *    indent instead of overflowing.
 *
 * @module dsh-live-trace/markdown
 */

import { highlightCode } from './highlight.js'
import { displayWidth, rowWidth, sanitize, truncateSegments, wrapSegments } from './width.js'

/**
 * @typedef {{ text: string, sgr?: string }} Segment
 */

/** Rows narrower than this cannot carry a gutter; widths are clamped up to it. */
const MIN_WIDTH = 4
/** Cheap guard against pathological emphasis nesting. */
const MAX_INLINE_DEPTH = 6

/* ------------------------------------------------------------------ *
 * Segment plumbing
 * ------------------------------------------------------------------ */

/**
 * Resolve a palette entry, collapsing `''`/missing to "unstyled".
 * @param {Record<string, string> | undefined} palette
 * @param {string} key
 * @returns {string | undefined}
 */
function styleOf(palette, key) {
  if (palette === null || palette === undefined) return undefined
  const value = palette[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Concatenate two SGR parameter lists so styles nest.
 * @param {string | undefined} outer
 * @param {string | undefined} inner
 * @returns {string | undefined}
 */
function combine(outer, inner) {
  if (outer !== undefined && inner !== undefined) return `${outer};${inner}`
  return outer ?? inner
}

/**
 * Append text to a segment list, merging equal styles.
 * @param {Segment[]} out
 * @param {string} text
 * @param {string | undefined} [sgr]
 */
function pushSeg(out, text, sgr) {
  if (text.length === 0) return
  const style = sgr === '' ? undefined : sgr
  const last = out[out.length - 1]
  if (last !== undefined && last.sgr === style) {
    last.text += text
    return
  }
  if (style === undefined) out.push({ text })
  else out.push({ text, sgr: style })
}

/**
 * Apply an outer style to a segment list (unstyled parts inherit it).
 * @param {Segment[]} segments
 * @param {string | undefined} style
 * @returns {Segment[]}
 */
function decorate(segments, style) {
  if (style === undefined) return segments
  return segments.map((segment) => ({ text: segment.text, sgr: combine(style, segment.sgr) }))
}

/** Wrap to a positive budget; a non-positive budget yields no rows. */
function wrapTo(segments, budget) {
  if (budget <= 0) return []
  return wrapSegments(segments, budget)
}

/* ------------------------------------------------------------------ *
 * Inline rendering
 * ------------------------------------------------------------------ */

const ESCAPABLE = '\\`*_{}[]()#+-.!>~|'

/** Find an unescaped marker; -1 when absent. */
function findClosing(text, from, marker) {
  let index = from
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text.startsWith(marker, index)) return index
    index += 1
  }
  return -1
}

/** Count a run of one character. */
function countRun(text, index, ch) {
  let end = index
  while (end < text.length && text[end] === ch) end += 1
  return end - index
}

/** The faint variant used for the URL trailing a link. */
function dimStyle(md) {
  const link = styleOf(md, 'link')
  return link === undefined ? undefined : `2;${link}`
}

/**
 * Render inline Markdown to styled segments. Markup characters are removed;
 * escaped punctuation is emitted literally.
 *
 * @param {string} text
 * @param {Record<string, string>} md
 * @param {string | undefined} [baseStyle]
 * @param {number} [depth]
 * @returns {Segment[]}
 */
function renderInline(text, md, baseStyle, depth = 0) {
  if (text.length === 0) return []
  if (depth > MAX_INLINE_DEPTH) {
    const plain = []
    let index = 0
    while (index < text.length) {
      if (text[index] === '\\' && ESCAPABLE.includes(text[index + 1] ?? '')) {
        pushSeg(plain, text[index + 1])
        index += 2
        continue
      }
      pushSeg(plain, text[index])
      index += 1
    }
    return decorate(plain, baseStyle)
  }

  /** @type {Segment[]} */
  const out = []
  const n = text.length
  const bold = styleOf(md, 'bold')
  const italic = styleOf(md, 'italic')
  const strike = styleOf(md, 'strike')
  const linkStyle = styleOf(md, 'link')
  const codeStyle = styleOf(md, 'inlineCode')
  let index = 0

  while (index < n) {
    const ch = text[index]

    if (ch === '\\' && ESCAPABLE.includes(text[index + 1] ?? '')) {
      pushSeg(out, text[index + 1])
      index += 2
      continue
    }

    if (ch === '`') {
      const run = countRun(text, index, '`')
      const close = text.indexOf('`'.repeat(run), index + run)
      if (close !== -1) {
        pushSeg(out, text.slice(index + run, close), codeStyle)
        index = close + run
        continue
      }
      for (const segment of decorate([{ text: text.slice(index) }], baseStyle)) {
        pushSeg(out, segment.text, segment.sgr)
      }
      break
    }

    if (text.startsWith('**', index) || text.startsWith('__', index)) {
      const marker = text.slice(index, index + 2)
      const close = findClosing(text, index + 2, marker)
      if (close !== -1 && close > index + 2) {
        const inner = decorate(renderInline(text.slice(index + 2, close), md, undefined, depth + 1), bold)
        for (const segment of inner) pushSeg(out, segment.text, combine(baseStyle, segment.sgr))
        index = close + 2
        continue
      }
    }

    if (text.startsWith('~~', index)) {
      const close = findClosing(text, index + 2, '~~')
      if (close !== -1 && close > index + 2) {
        const inner = decorate(renderInline(text.slice(index + 2, close), md, undefined, depth + 1), strike)
        for (const segment of inner) pushSeg(out, segment.text, combine(baseStyle, segment.sgr))
        index = close + 2
        continue
      }
    }

    if (ch === '*' || ch === '_') {
      const beforeOk = ch !== '_' || index === 0 || !/[A-Za-z0-9]/.test(text[index - 1])
      const close = beforeOk ? findClosing(text, index + 1, ch) : -1
      const afterOk = close !== -1 && close + 1 < n ? !/[A-Za-z0-9]/.test(text[close + 1]) : close !== -1
      if (close !== -1 && close > index + 1 && afterOk) {
        const inner = decorate(renderInline(text.slice(index + 1, close), md, undefined, depth + 1), italic)
        for (const segment of inner) pushSeg(out, segment.text, combine(baseStyle, segment.sgr))
        index = close + 1
        continue
      }
    }

    if (ch === '[') {
      const labelEnd = text.indexOf(']', index + 1)
      if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', labelEnd + 2)
        if (urlEnd !== -1) {
          const label = text.slice(index + 1, labelEnd)
          let url = text.slice(labelEnd + 2, urlEnd).trim()
          const title = /[ \t]+"[^"]*"$/.exec(url)
          if (title !== null) url = url.slice(0, title.index).trim()
          const rendered = decorate(renderInline(label, md, undefined, depth + 1), linkStyle)
          for (const segment of rendered) pushSeg(out, segment.text, combine(baseStyle, segment.sgr))
          if (url.length > 0 && url !== label) {
            pushSeg(out, ` (${url})`, combine(baseStyle, dimStyle(md)))
          }
          index = urlEnd + 1
          continue
        }
      }
    }

    if (ch === '<') {
      const autolink = /^<([A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+)>/.exec(text.slice(index))
      if (autolink !== null) {
        pushSeg(out, autolink[1], combine(baseStyle, linkStyle))
        index += autolink[0].length
        continue
      }
    }

    if (ch === 'h' && text.startsWith('http', index)) {
      const bare = /^https?:\/\/[^\s<>()[\]{}"']+/.exec(text.slice(index))
      if (bare !== null) {
        const url = bare[0].replace(/[.,;:!?]+$/, '')
        if (url.length > 0) {
          pushSeg(out, url, combine(baseStyle, linkStyle))
          index += url.length
          continue
        }
      }
    }

    // Plain run up to the next potentially meaningful character.
    let end = index + 1
    while (end < n && !'\\`*_~[<h'.includes(text[end])) end += 1
    pushSeg(out, text.slice(index, end), baseStyle)
    index = end
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Block helpers
 * ------------------------------------------------------------------ */

/** True when a line opens a block that ends the current paragraph/item. */
function isBlockStart(line) {
  return (
    /^ {0,3}(?:`{3,}|~{3,})/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line) ||
    /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+/.test(line) ||
    /^(?: {4}|\t)/.test(line)
  )
}

/** Push wrapped rows for one logical paragraph-like line. */
function pushWrapped(segments, ctx) {
  for (const row of wrapTo(segments, ctx.width)) ctx.rows.push(row)
}

/** Blank-line separator, only between existing, non-empty rows. */
function addSeparator(ctx) {
  const rows = ctx.rows
  if (rows.length === 0) return
  if (rows[rows.length - 1].length > 0) rows.push([])
}

/** Split a GFM table row on unescaped pipes. */
function splitRow(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells = []
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\' && text[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (text[index] === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += text[index]
  }
  cells.push(current.trim())
  return cells
}

/** Is `lines[index]` a table header followed by a delimiter row? */
function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false
  if (!lines[index].includes('|')) return false
  const delimiter = lines[index + 1].trim()
  if (!delimiter.includes('|') || !delimiter.includes('-')) return false
  return /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(delimiter)
}

/** @returns {Array<'left' | 'right' | 'center'>} */
function parseAligns(line) {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/* ------------------------------------------------------------------ *
 * Block rendering
 * ------------------------------------------------------------------ */

/** Gutter-prefixed code rows: first line at `width - 2`, continuations at `- 4`. */
function codeRows(segments, width, borderStyle) {
  const rows = []
  const chunks = wrapTo(segments, Math.max(1, width - 2))
  const lines = [chunks[0] ?? []]
  for (let index = 1; index < chunks.length; index += 1) {
    for (const sub of wrapTo(chunks[index], Math.max(1, width - 4))) lines.push(sub)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const row = []
    pushSeg(row, index === 0 ? '│ ' : '│   ', borderStyle)
    for (const segment of lines[index]) pushSeg(row, segment.text, segment.sgr)
    rows.push(row)
  }
  return rows
}

/** Style highlighted code segments with the `md.code` fallback. */
function withCodeStyle(segments, md) {
  const fallback = styleOf(md, 'code')
  if (fallback === undefined) return segments
  return segments.map((segment) => (segment.sgr === undefined ? { text: segment.text, sgr: fallback } : segment))
}

/** Render a fenced code block, including a fence left open at end of input. */
function renderFence(lines, start, open, ctx) {
  const markerChar = open[1][0]
  const info = (open[2] ?? '').trim()
  const langHint = info.split(/\s+/)[0] ?? ''
  const content = []
  const closeRe = markerChar === '`' ? /^ {0,3}`{3,}[ \t]*$/ : /^ {0,3}~{3,}[ \t]*$/
  let index = start + 1
  while (index < lines.length) {
    if (closeRe.test(lines[index])) {
      index += 1
      break
    }
    content.push(lines[index])
    index += 1
  }

  const borderStyle = styleOf(ctx.md, 'fenceBorder')
  const langStyle = styleOf(ctx.md, 'fenceLang')
  if (langHint.length > 0) {
    const label = truncateSegments([{ text: langHint, sgr: langStyle }], Math.max(0, ctx.width - 2), '…')
    const row = []
    pushSeg(row, '│ ', borderStyle)
    const pad = ctx.width - 2 - rowWidth(label)
    if (pad > 0) pushSeg(row, ' '.repeat(pad))
    for (const segment of label) pushSeg(row, segment.text, segment.sgr)
    ctx.rows.push(row)
  }

  for (const raw of content) {
    const highlighted = highlightCode(raw, langHint, ctx.syn)
    for (const row of codeRows(withCodeStyle(highlighted, ctx.md), ctx.width, borderStyle)) ctx.rows.push(row)
  }
  return index
}

/** Render a four-space indented code block. */
function renderIndentedCode(lines, start, ctx) {
  const collected = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      let probe = index + 1
      while (probe < lines.length && lines[probe].trim() === '') probe += 1
      if (probe < lines.length && /^(?: {4}|\t)/.test(lines[probe])) {
        for (let blank = index; blank < probe; blank += 1) collected.push('')
        index = probe
        continue
      }
      break
    }
    if (!/^(?: {4}|\t)/.test(line)) break
    collected.push(line.replace(/^(?: {4}|\t)/, ''))
    index += 1
  }

  const borderStyle = styleOf(ctx.md, 'fenceBorder')
  for (const raw of collected) {
    const highlighted = highlightCode(raw, 'text', ctx.syn)
    for (const row of codeRows(withCodeStyle(highlighted, ctx.md), ctx.width, borderStyle)) ctx.rows.push(row)
  }
  return index
}

/** Render an ATX heading. */
function renderHeading(level, content, ctx) {
  const style = styleOf(ctx.md, level <= 2 ? 'heading' : 'heading2')
  const segments = decorate(renderInline(content, ctx.md, undefined, 0), style)
  pushWrapped(segments, ctx)
}

/** Render a blockquote block, repeating the `│ ` gutter on every row. */
function renderQuote(lines, start, ctx) {
  const content = []
  let depth = 1
  let index = start
  while (index < lines.length) {
    const match = /^ {0,3}(>{1,})[ \t]?(.*)$/.exec(lines[index])
    if (match !== null) {
      depth = Math.max(depth, match[1].length)
      content.push(match[2])
      index += 1
      continue
    }
    if (lines[index].trim() !== '' && !isBlockStart(lines[index])) {
      content.push(lines[index].trim())
      index += 1
      continue
    }
    break
  }

  const maxDepth = Math.max(1, Math.floor((ctx.width - 1) / 2))
  const gutter = '│ '.repeat(Math.min(depth, maxDepth))
  const gutterStyle = styleOf(ctx.md, 'quote')
  const segments = renderInline(content.join(' '), ctx.md, undefined, 0)
  const budget = ctx.width - displayWidth(gutter)
  const wrapped = wrapTo(segments, budget)
  const out = wrapped.length === 0 ? [[]] : wrapped
  for (const line of out) {
    const row = []
    pushSeg(row, gutter, gutterStyle)
    for (const segment of line) pushSeg(row, segment.text, segment.sgr)
    ctx.rows.push(row)
  }
  return index
}

/** Render a run of list items with a hanging indent and one nesting level. */
function renderList(lines, start, ctx) {
  let index = start
  const markerStyle = styleOf(ctx.md, 'bullet')
  while (index < lines.length) {
    const match = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(lines[index])
    if (match === null) break
    const indent = match[1].replace(/\t/g, '    ').length
    const level = indent >= 2 ? 1 : 0
    const ordered = /^\d/.test(match[2])
    const markerText = ordered ? `${match[2]} ` : level === 0 ? '• ' : '◦ '
    const content = [match[3].trim()]
    index += 1

    while (index < lines.length) {
      const next = lines[index]
      if (next.trim() === '') break
      if (/^(\s*)([-*+]|\d{1,9}[.)])[ \t]+/.test(next)) break
      if (isBlockStart(next)) break
      const nextIndent = (next.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length
      if (nextIndent < indent + 2) break
      content.push(next.trim())
      index += 1
    }

    const prefix = (level === 0 ? '' : '  ') + markerText
    const prefixWidth = displayWidth(prefix)
    const budget = ctx.width - prefixWidth
    const segments = renderInline(content.join(' '), ctx.md, undefined, 0)

    if (budget <= 0) {
      // A very wide marker at a very narrow width: keep the text, drop the marker.
      pushWrapped(segments, ctx)
      continue
    }

    const wrapped = wrapTo(segments, budget)
    let first = true
    for (const line of wrapped) {
      const row = []
      pushSeg(row, first ? prefix : ' '.repeat(prefixWidth), markerStyle)
      for (const segment of line) pushSeg(row, segment.text, segment.sgr)
      ctx.rows.push(row)
      first = false
    }
  }
  return index
}

/** Render a GFM table with aligned columns. Returns the next line index. */
function renderTable(lines, start, ctx) {
  const header = splitRow(lines[start])
  const aligns = parseAligns(lines[start + 1])
  const body = []
  let index = start + 2
  while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
    body.push(splitRow(lines[index]))
    index += 1
  }

  const columnCount = Math.max(header.length, aligns.length, ...body.map((row) => row.length))
  const available = ctx.width - (3 * columnCount + 1)
  if (columnCount === 0 || available < columnCount) {
    // Too narrow for aligned columns: fall back to plain wrapped lines.
    for (let line = start; line < index; line += 1) {
      pushWrapped(renderInline(lines[line].trim(), ctx.md, undefined, 0), ctx)
    }
    return index
  }

  const widths = new Array(columnCount).fill(3)
  const measure = (cells) => {
    for (let column = 0; column < columnCount; column += 1) {
      widths[column] = Math.max(widths[column], displayWidth(cells[column] ?? ''))
    }
  }
  measure(header)
  for (const row of body) measure(row)
  let total = widths.reduce((sum, value) => sum + value, 0)
  while (total > available) {
    let widest = 0
    for (let column = 1; column < columnCount; column += 1) {
      if (widths[column] > widths[widest]) widest = column
    }
    if (widths[widest] <= 1) break
    widths[widest] -= 1
    total -= 1
  }

  const borderStyle = styleOf(ctx.md, 'fenceBorder')
  for (const cells of [header, ...body]) {
    const row = []
    pushSeg(row, '│ ', borderStyle)
    for (let column = 0; column < columnCount; column += 1) {
      if (column > 0) pushSeg(row, ' │ ', borderStyle)
      const rendered = truncateSegments(renderInline(cells[column] ?? '', ctx.md, undefined, 0), widths[column], '…')
      const pad = widths[column] - rowWidth(rendered)
      const align = aligns[column] ?? 'left'
      let leftPad = 0
      let rightPad = pad
      if (align === 'right') {
        leftPad = pad
        rightPad = 0
      } else if (align === 'center') {
        leftPad = Math.floor(pad / 2)
        rightPad = pad - leftPad
      }
      if (leftPad > 0) pushSeg(row, ' '.repeat(leftPad))
      for (const segment of rendered) pushSeg(row, segment.text, segment.sgr)
      if (rightPad > 0) pushSeg(row, ' '.repeat(rightPad))
    }
    pushSeg(row, ' │', borderStyle)
    ctx.rows.push(row)
  }
  return index
}

/** Render a paragraph, merging soft-wrapped source lines. */
function renderParagraph(lines, start, ctx) {
  const parts = []
  let index = start
  while (index < lines.length && lines[index].trim() !== '') {
    if (index > start && isBlockStart(lines[index])) break
    parts.push(lines[index].trim())
    index += 1
  }
  pushWrapped(renderInline(parts.join(' '), ctx.md, undefined, 0), ctx)
  return index
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Clamp a requested width into a gutter-safe range. */
function clampWidth(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 80
  return Math.max(MIN_WIDTH, Math.floor(numeric))
}

/** Last-resort renderer used if the structured path ever throws. */
function fallbackRows(source, width, md) {
  const rows = []
  const style = styleOf(md, 'code')
  for (const line of source.split('\n')) {
    for (const row of wrapSegments([style === undefined ? { text: line } : { text: line, sgr: style }], width)) {
      rows.push(row)
    }
  }
  return rows
}

/**
 * Render Markdown into width-bounded rows.
 *
 * @param {string} text
 * @param {{ width?: number, md?: Record<string, string>, syn?: Record<string, string>, maxLines?: number }} [options]
 * @returns {Segment[][]}
 */
export function renderMarkdown(text, options = {}) {
  const source = sanitize(text).replace(/\r\n?/g, '\n')
  const width = clampWidth(options?.width)
  const md = options?.md !== null && typeof options?.md === 'object' ? options.md : {}
  const syn = options?.syn !== null && typeof options?.syn === 'object' ? options.syn : {}

  if (source.trim().length === 0) return []

  let rows
  try {
    rows = renderBlocks(source, width, md, syn)
  } catch {
    rows = fallbackRows(source, width, md)
  }

  const maxLines = options?.maxLines
  if (typeof maxLines === 'number' && Number.isFinite(maxLines) && maxLines >= 0 && rows.length > maxLines) {
    const limit = Math.floor(maxLines)
    if (limit === 0) return []
    const kept = rows.slice(0, limit - 1)
    const remaining = rows.length - kept.length
    const more = truncateSegments(
      [{ text: `… ${remaining} more lines`, sgr: styleOf(md, 'more') }],
      width,
      '…'
    )
    rows = [...kept, more]
  }

  return rows
}

/**
 * The structured block walk. Kept separate so `renderMarkdown` can wrap it in a
 * try/catch without duplicating option handling.
 *
 * @param {string} source
 * @param {number} width
 * @param {Record<string, string>} md
 * @param {Record<string, string>} syn
 * @returns {Segment[][]}
 */
function renderBlocks(source, width, md, syn) {
  /** @type {Segment[][]} */
  const rows = []
  const ctx = { width, md, syn, rows }
  const lines = source.split('\n')
  let index = 0

  while (index < lines.length) {
    const before = index
    const line = lines[index]

    if (line.trim() === '') {
      addSeparator(ctx)
      index += 1
      continue
    }

    const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line)
    if (fence !== null) {
      index = renderFence(lines, index, fence, ctx)
      if (index <= before) index = before + 1
      continue
    }

    if (/^(?: {4}|\t)/.test(line)) {
      index = renderIndentedCode(lines, index, ctx)
      if (index <= before) index = before + 1
      continue
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line)
    if (heading !== null) {
      renderHeading(heading[1].length, heading[2] ?? '', ctx)
      index += 1
      continue
    }

    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      const rule = []
      pushSeg(rule, '─'.repeat(width), styleOf(md, 'rule'))
      rows.push(rule)
      index += 1
      continue
    }

    if (/^ {0,3}>/.test(line)) {
      index = renderQuote(lines, index, ctx)
      if (index <= before) index = before + 1
      continue
    }

    if (/^(\s*)([-*+]|\d{1,9}[.)])[ \t]+/.test(line)) {
      index = renderList(lines, index, ctx)
      if (index <= before) index = before + 1
      continue
    }

    if (isTableStart(lines, index)) {
      index = renderTable(lines, index, ctx)
      if (index <= before) index = before + 1
      continue
    }

    index = renderParagraph(lines, index, ctx)
    if (index <= before) index += 1
  }

  return rows
}
