/**
 * How big a terminal cell actually is, in pixels.
 *
 * A terminal will not let an application change its font — there is no escape
 * sequence for it, and `ESC[?3h` only switches between 80 and 132 columns. What
 * it *will* do is report the geometry, which is the half of the idea that
 * works: ask for the cell size, and you know the real resolution.
 *
 * @module dsh-live-trace/cellsize
 */

/** `CSI 4 ; <height> ; <width> t` — the text area, in pixels. */
const TEXT_AREA = /\u001b\[4;(\d+);(\d+)t/
/** `CSI 6 ; <height> ; <width> t` — one character cell, in pixels. */
const CELL_SIZE = /\u001b\[6;(\d+);(\d+)t/

/**
 * Read a geometry report out of whatever the terminal has written back.
 *
 * Terminals answer asynchronously and may interleave other replies, so this
 * scans rather than parsing positionally.
 *
 * @param {string} data
 * @returns {{ cell?: { width: number, height: number }, textArea?: { width: number, height: number } }}
 */
export function parseSizeReport(data) {
  const out = {}
  if (typeof data !== 'string') return out
  const cell = CELL_SIZE.exec(data)
  if (cell !== null) {
    const height = Number.parseInt(cell[1], 10)
    const width = Number.parseInt(cell[2], 10)
    if (width > 0 && height > 0) out.cell = { width, height }
  }
  const area = TEXT_AREA.exec(data)
  if (area !== null) {
    const height = Number.parseInt(area[1], 10)
    const width = Number.parseInt(area[2], 10)
    if (width > 0 && height > 0) out.textArea = { width, height }
  }
  return out
}

/** The sequences that ask for the two reports. */
export const QUERY_CELL_SIZE = '\u001b[16t'
export const QUERY_TEXT_AREA = '\u001b[14t'

/**
 * Ask the terminal for its geometry.
 *
 * Returns as soon as both reports arrive, or when the timeout expires — a
 * terminal that does not answer must not stall the caller, so every outcome
 * resolves rather than rejecting.
 *
 * @param {{ stdin: any, stdout: any, timeoutMs?: number }} io
 * @returns {Promise<{ cell?: object, textArea?: object, answered: boolean }>}
 */
export function queryTerminalSize(io, timeoutMs = 250) {
  return new Promise((resolve) => {
    const { stdin, stdout } = io
    if (stdin?.isTTY !== true || typeof stdin.setRawMode !== 'function') {
      resolve({ answered: false })
      return
    }
    let buffer = ''
    let timer = null
    const finish = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      stdin.removeListener('data', onData)
      if (wasRaw === false) stdin.setRawMode(false)
      stdin.pause?.()
      resolve({ ...parseSizeReport(buffer), answered: buffer.length > 0 })
    }
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const parsed = parseSizeReport(buffer)
      if (parsed.cell !== undefined && parsed.textArea !== undefined) finish()
    }
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume?.()
    stdin.on('data', onData)
    stdout.write(QUERY_CELL_SIZE + QUERY_TEXT_AREA)
    timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
  })
}

/**
 * The window's size in pixels, from the cells it is showing and how big they are.
 *
 * @param {{ width: number, height: number }} cell
 * @param {{ cols: number, rows: number }} cells
 */
export function pixelResolution(cell, cells) {
  return {
    width: cell.width * cells.cols,
    height: cell.height * cells.rows,
    aspect: cell.height === 0 ? 0 : cell.width / cell.height
  }
}

/**
 * How much a given font buys, for a window of a fixed pixel size.
 *
 * This is the number that matters: shrinking the font does **not** change the
 * window's pixels — it changes how many characters fit in them. Every extra
 * cell is two more pixels of drawing, because the renderer puts two vertical
 * pixels in each one.
 *
 * @param {{ width: number, height: number }} cell the font's cell, in pixels
 * @param {{ width: number, height: number }} window the text area, in pixels
 */
export function cellsForWindow(cell, window) {
  if (cell.width <= 0 || cell.height <= 0) return { cols: 0, rows: 0, artPixels: 0 }
  const cols = Math.floor(window.width / cell.width)
  const rows = Math.floor(window.height / cell.height)
  return { cols, rows, artPixels: cols * rows * 2 }
}
