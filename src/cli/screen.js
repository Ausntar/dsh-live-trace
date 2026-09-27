/**
 * Terminal control: the alternate screen, size, raw input, and frame painting.
 *
 * This is the only module in the viewer that touches the TTY, so every other
 * piece of the dashboard stays unit-testable.
 *
 * @module dsh-live-trace/screen
 */

/** Sequences the alternate-screen painter emits. */
export const SEQUENCE = {
  altEnter: '\u001b[?1049h',
  altLeave: '\u001b[?1049l',
  hideCursor: '\u001b[?25l',
  showCursor: '\u001b[?25h',
  home: '\u001b[H',
  clearToEnd: '\u001b[J',
  clearLine: '\u001b[K',
  /** Begin synchronized output (DEC 2026); ignored by terminals without it. */
  syncBegin: '\u001b[?2026h',
  syncEnd: '\u001b[?2026l',
  /** Button-event reporting plus SGR coordinates, so the wheel is unambiguous. */
  mouseEnter: '\u001b[?1000h\u001b[?1006h',
  mouseLeave: '\u001b[?1000l\u001b[?1006l'
}

/**
 * Decode one SGR mouse report body (`b;x;y`) into a key the dashboard handles.
 *
 * @param {number} button
 * @param {number} x 1-based column
 * @param {number} y 1-based row
 * @returns {string | { type: 'click', x: number, y: number } | null}
 */
function mouseEvent(button, x, y, released) {
  if (button >= 64) {
    switch (button) {
      case 64:
        return 'wheel-up'
      case 65:
        return 'wheel-down'
      case 66:
        return 'wheel-left'
      case 67:
        return 'wheel-right'
      default:
        return null
    }
  }
  // Bit 5 marks pointer motion, which a dashboard has nothing to do with.
  if ((button & 32) !== 0) return null
  // Low two bits give the button. A release carries no new information, and
  // only the left button opens something.
  if (released) return null
  return (button & 3) === 0 ? { type: 'click', x, y } : null
}

/**
 * Parse raw terminal input into named keys.
 *
 * Escape sequences arrive split across reads often enough that the parser
 * buffers a partial sequence instead of treating its prefix as keystrokes.
 *
 * @returns {(chunk: string) => string[]}
 */
export function createKeyParser() {
  const sequences = [
    ['\u001b[1;5A', 'ctrl-up'],
    ['\u001b[1;5B', 'ctrl-down'],
    ['\u001b[A', 'up'],
    ['\u001b[B', 'down'],
    ['\u001b[C', 'right'],
    ['\u001b[D', 'left'],
    ['\u001bOA', 'up'],
    ['\u001bOB', 'down'],
    ['\u001b[5~', 'page-up'],
    ['\u001b[6~', 'page-down'],
    ['\u001b[H', 'home'],
    ['\u001b[F', 'end'],
    ['\u001b[1~', 'home'],
    ['\u001b[4~', 'end']
  ]
  let pending = ''
  const parser = (chunk) => {
    pending += chunk
    const keys = []
    for (;;) {
      if (pending.length === 0) break
      if (pending[0] !== '\u001b') {
        keys.push(pending[0])
        pending = pending.slice(1)
        continue
      }
      // SGR mouse reports are self-delimiting: ESC [ < b;x;y M|m
      if (pending.startsWith('\u001b[<')) {
        const terminator = pending.search(/[Mm]/)
        if (terminator === -1) break
        const fields = pending.slice(3, terminator).split(';')
        const released = pending[terminator] === 'm'
        pending = pending.slice(terminator + 1)
        const [button, x, y] = fields.map((value) => Number.parseInt(value, 10))
        const event = mouseEvent(button, x, y, released)
        if (event !== null) keys.push(event)
        continue
      }
      // A lone ESC may still be the prefix of an arrow key.
      if (pending.length === 1) break
      const match = sequences.find(([sequence]) => pending.startsWith(sequence))
      if (match !== undefined) {
        keys.push(match[1])
        pending = pending.slice(match[0].length)
        continue
      }
      const couldExtend = sequences.some(([sequence]) => sequence.startsWith(pending))
      if (couldExtend) break
      // Unknown escape: consume the ESC and re-examine the rest.
      pending = pending.slice(1)
    }
    if (pending.length > 64) pending = ''
    return keys
  }
  parser.pending = () => pending
  parser.takePending = () => {
    const held = pending
    pending = ''
    return held
  }
  return parser
}

export class Screen {
  /**
   * @param {{ stdout?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream, altScreen?: boolean, color?: boolean, mouse?: boolean }} [options]
   */
  constructor(options = {}) {
    this.stdout = options.stdout ?? process.stdout
    this.stdin = options.stdin ?? process.stdin
    this.altScreen = options.altScreen !== false
    this.mouse = options.mouse !== false
    this.entered = false
    this.rawWasSet = false
    this.listeners = { key: new Set(), resize: new Set() }
    this.onStdinData = null
    this.onStdoutResize = null
  }

  /** @returns {{ cols: number, rows: number }} */
  size() {
    return {
      cols: Math.max(20, this.stdout.columns ?? 80),
      rows: Math.max(6, this.stdout.rows ?? 24)
    }
  }

  /** Enter the alternate screen, hide the cursor, and start reading raw keys. */
  enter() {
    if (this.entered) return
    this.entered = true
    if (this.altScreen) this.stdout.write(SEQUENCE.altEnter)
    this.stdout.write(SEQUENCE.hideCursor)
    // Wheel events arrive as arrow keys in many terminals, which is reported as
    // a plain keypress and cannot be distinguished from one. Claiming the mouse
    // makes scrolling exact; Shift+drag still selects text.
    if (this.mouse !== false) this.stdout.write(SEQUENCE.mouseEnter)

    if (this.stdin.isTTY === true) {
      try {
        this.stdin.setRawMode(true)
        this.rawWasSet = true
      } catch {
        /* not a real TTY; key handling stays off */
      }
    }
    this.stdin.resume?.()
    this.stdin.setEncoding?.('utf8')

    const parseKeys = createKeyParser()
    let escapeTimer = null
    const flushEscape = () => {
      escapeTimer = null
      // A lone ESC never completes into an arrow key, so it must eventually be
      // delivered as the Escape key rather than held forever.
      if (parseKeys.takePending() === '\u001b') this.emitKey('escape')
    }
    this.onStdinData = (chunk) => {
      for (const key of parseKeys(String(chunk))) {
        if (key === '\u0003') {
          this.emitKey('quit')
          continue
        }
        this.emitKey(key)
      }
      if (escapeTimer !== null) clearTimeout(escapeTimer)
      if (parseKeys.pending() === '\u001b' && !/^\u001b\[<$/.test(parseKeys.pending())) {
        escapeTimer = setTimeout(flushEscape, 40)
        escapeTimer.unref?.()
      }
    }
    this.escapeTimer = () => escapeTimer
    this.stdin.on('data', this.onStdinData)

    this.onStdoutResize = () => this.emitResize()
    this.stdout.on('resize', this.onStdoutResize)
  }

  /** Restore the terminal, whatever happened. */
  leave() {
    if (!this.entered) return
    this.entered = false
    if (typeof this.escapeTimer === 'function') {
      const timer = this.escapeTimer()
      if (timer !== null) clearTimeout(timer)
    }
    if (this.onStdinData !== null) this.stdin.off('data', this.onStdinData)
    if (this.onStdoutResize !== null) this.stdout.off('resize', this.onStdoutResize)
    this.onStdinData = null
    this.onStdoutResize = null
    if (this.rawWasSet) {
      try {
        this.stdin.setRawMode(false)
      } catch {
        /* the TTY may already be gone */
      }
      this.rawWasSet = false
    }
    this.stdin.pause?.()
    const mouseOff = this.mouse === false ? '' : SEQUENCE.mouseLeave
    this.stdout.write(`${mouseOff}${SEQUENCE.showCursor}${this.altScreen ? SEQUENCE.altLeave : '\n'}`)
  }

  /**
   * Paint exactly `lines`, one per row, without a full-screen clear flicker.
   * @param {string[]} lines
   */
  paint(lines) {
    const { rows } = this.size()
    let out = `${SEQUENCE.syncBegin}${SEQUENCE.home}`
    for (let index = 0; index < rows; index += 1) {
      out += `${lines[index] ?? ''}${SEQUENCE.clearLine}`
      if (index < rows - 1) out += '\r\n'
    }
    out += SEQUENCE.clearToEnd + SEQUENCE.syncEnd
    this.stdout.write(out)
  }

  /** @param {string} message a message printed after leaving the alternate screen */
  writeLine(message) {
    this.stdout.write(`${message}\n`)
  }

  /** @param {(key: string) => void} listener */
  onKey(listener) {
    this.listeners.key.add(listener)
    return () => this.listeners.key.delete(listener)
  }

  /** @param {() => void} listener */
  onResize(listener) {
    this.listeners.resize.add(listener)
    return () => this.listeners.resize.delete(listener)
  }

  emitKey(key) {
    for (const listener of this.listeners.key) listener(key)
  }

  emitResize() {
    for (const listener of this.listeners.resize) listener()
  }
}
