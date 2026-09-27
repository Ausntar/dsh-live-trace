/**
 * Terminal text measurement and layout primitives.
 *
 * The dashboard must align in a terminal that may be 80 columns wide and may
 * carry CJK text, so measuring a string with `.length` is wrong twice over:
 * Han characters occupy two cells, and a model's output can contain escape
 * sequences that would otherwise corrupt the screen. Everything here works on
 * plain code points and on styled *segment* lists, so colors never have to be
 * parsed back out of a string.
 *
 * A row is `Segment[]`; a {@link Segment} is `{ text, sgr? }` where `sgr` is a
 * raw SGR parameter list such as `"1;38;5;39"`.
 *
 * @module dsh-live-trace/width
 */

/**
 * @typedef {{ text: string, sgr?: string }} Segment
 */

/** Ranges whose code points occupy two terminal cells. */
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  // Emoji_Presentation code points that terminals render double width.
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
]

/** Ranges of zero-width marks that attach to the preceding cell. */
const ZERO_RANGES = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0eb1, 0x0eb1],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef]
]

function inRanges(codePoint, ranges) {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

/**
 * Terminal cells one code point occupies: 0 for combining marks and zero-width
 * joiners, 2 for East Asian Wide/Fullwidth and emoji, 1 otherwise.
 * @param {number} codePoint
 * @returns {number}
 */
export function codePointWidth(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint < 0) return 0
  if (codePoint === 0) return 0
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  if (inRanges(codePoint, ZERO_RANGES)) return 0
  if (inRanges(codePoint, WIDE_RANGES)) return 2
  return 1
}

/**
 * Display width of plain text.
 * @param {string} text
 * @returns {number}
 */
export function displayWidth(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let width = 0
  for (const character of text) width += codePointWidth(character.codePointAt(0) ?? 0)
  return width
}

/**
 * Remove anything that would let untrusted model output drive the terminal.
 *
 * ANSI escape sequences are stripped outright, then remaining C0/C1 controls
 * are replaced with a space so they cannot move the cursor or beep.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function sanitize(input) {
  if (input === null || input === undefined) return ''
  let text = String(input)
  // CSI / OSC / DCS / APC / PM / SOS and the simple two-byte escapes.
  text = text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
  text = text.replace(/\u001b[P^_X][^\u001b]*(?:\u001b\\)?/g, '')
  text = text.replace(/\u001b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
  text = text.replace(/\u001b[@-Z\\-_]/g, '')
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
  return text
}

/**
 * Split styled segments into one entry per code point, preserving style.
 * @param {Segment[]} segments
 * @returns {Array<{ ch: string, sgr?: string }>}
 */
export function explode(segments) {
  const out = []
  for (const segment of segments) {
    if (segment === null || segment === undefined) continue
    const text = sanitize(segment.text)
    if (text.length === 0) continue
    for (const character of text) out.push({ ch: character, sgr: segment.sgr })
  }
  return out
}

/**
 * Re-join per-code-point entries into the fewest segments.
 * @param {Array<{ ch: string, sgr?: string }>} chars
 * @returns {Segment[]}
 */
export function collapse(chars) {
  const out = []
  for (const item of chars) {
    const last = out[out.length - 1]
    if (last !== undefined && last.sgr === item.sgr) last.text += item.ch
    else out.push({ text: item.ch, sgr: item.sgr })
  }
  return out
}

/**
 * Display width of a row.
 * @param {Segment[]} segments
 * @returns {number}
 */
export function rowWidth(segments) {
  let width = 0
  for (const segment of segments ?? []) {
    if (segment === null || segment === undefined) continue
    width += displayWidth(sanitize(segment.text))
  }
  return width
}

/**
 * Truncate a plain string to a cell budget.
 * @param {string} text
 * @param {number} width
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncate(text, width, ellipsis = '…') {
  return truncateSegments([{ text }], width, ellipsis)
    .map((segment) => segment.text)
    .join('')
}

/**
 * Truncate a row to a cell budget, appending an ellipsis when it was cut.
 * @param {Segment[]} segments
 * @param {number} width
 * @param {string} [ellipsis]
 * @returns {Segment[]}
 */
export function truncateSegments(segments, width, ellipsis = '…') {
  if (width <= 0) return []
  const chars = explode(segments)
  let total = 0
  for (const item of chars) total += codePointWidth(item.ch.codePointAt(0) ?? 0)
  if (total <= width) return collapse(chars)
  const budget = Math.max(0, width - displayWidth(ellipsis))
  const kept = []
  let used = 0
  for (const item of chars) {
    const itemWidth = codePointWidth(item.ch.codePointAt(0) ?? 0)
    if (used + itemWidth > budget) break
    kept.push(item)
    used += itemWidth
  }
  const result = collapse(kept)
  if (displayWidth(ellipsis) > 0) result.push({ text: ellipsis, sgr: kept[kept.length - 1]?.sgr })
  return result
}

/**
 * Wrap a row into lines no wider than `width`.
 *
 * Breaks at a space when one is available on the line; otherwise hard-breaks,
 * which is the correct behavior for CJK text that carries no spaces.
 *
 * @param {Segment[]} segments
 * @param {number} width
 * @returns {Segment[][]}
 */
export function wrapSegments(segments, width) {
  if (width <= 0) return [segments]
  const chars = explode(segments)
  /** @type {Segment[][]} */
  const lines = []
  /** @type {Array<{ ch: string, sgr?: string }>} */
  let line = []
  let lineWidth = 0
  let lastSpace = -1

  const widthUpTo = (list) => {
    let width = 0
    for (const item of list) width += codePointWidth(item.ch.codePointAt(0) ?? 0)
    return width
  }

  const breakLine = () => {
    if (lastSpace > 0) {
      lines.push(collapse(line.slice(0, lastSpace)))
      line = line.slice(lastSpace + 1)
    } else {
      lines.push(collapse(line))
      line = []
    }
    lineWidth = widthUpTo(line)
    lastSpace = -1
    for (let index = 0; index < line.length; index += 1) {
      if (line[index].ch === ' ') lastSpace = index
    }
  }

  for (const item of chars) {
    const itemWidth = codePointWidth(item.ch.codePointAt(0) ?? 0)
    // A character wider than the whole budget cannot be displayed at all; the
    // only alternatives are overflowing the line or dropping it, and the
    // renderer's contract is that every produced line fits.
    if (itemWidth > width) continue
    if (line.length > 0 && lineWidth + itemWidth > width) breakLine()
    line.push(item)
    lineWidth += itemWidth
    if (item.ch === ' ') lastSpace = line.length - 1
  }
  if (line.length > 0 || lines.length === 0) lines.push(collapse(line))
  return lines
}

/**
 * Serialize a row into an ANSI string.
 * @param {Segment[]} segments
 * @returns {string}
 */
export function renderRow(segments) {
  let out = ''
  for (const segment of segments ?? []) {
    if (segment === null || segment === undefined || segment.text.length === 0) continue
    if (segment.sgr === undefined || segment.sgr === '') out += segment.text
    else out += `\u001b[${segment.sgr}m${segment.text}\u001b[0m`
  }
  return out
}

/**
 * Right-pad a row to a full cell width with a background style.
 * @param {Segment[]} segments
 * @param {number} width
 * @param {string} [fillSgr]
 * @returns {Segment[]}
 */
export function padRow(segments, width, fillSgr) {
  const used = rowWidth(segments)
  if (used >= width) return segments
  return [...segments, { text: ' '.repeat(width - used), sgr: fillSgr }]
}

/**
 * Pad plain text to a cell budget (not a code-unit count).
 *
 * `String.prototype.padEnd` counts UTF-16 units, so a translated label made of
 * Han characters would come out short and break column alignment.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function padTo(text, width) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const used = displayWidth(value)
  return used >= width ? value : value + ' '.repeat(width - used)
}
