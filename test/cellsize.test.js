/**
 * Reading the terminal's geometry, and the arithmetic on top of it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { cellsForWindow, parseSizeReport, pixelResolution, queryTerminalSize } from '../src/cli/cellsize.js'

test('the two geometry reports are read out of a stream', () => {
  assert.deepEqual(parseSizeReport('\u001b[6;18;9t'), { cell: { width: 9, height: 18 } })
  assert.deepEqual(parseSizeReport('\u001b[4;720;1440t'), { textArea: { width: 1440, height: 720 } })
  // Both together, in either order, with other replies interleaved.
  const both = parseSizeReport('\u001b[6;18;9t\u001b[4;720;1440t')
  assert.deepEqual(both, { cell: { width: 9, height: 18 }, textArea: { width: 1440, height: 720 } })
  assert.deepEqual(parseSizeReport('\u001b[1;1R\u001b[4;720;1440t\u001b[3;7R\u001b[6;18;9t').cell, { width: 9, height: 18 })

  // Anything that is not a report yields nothing rather than throwing.
  for (const junk of ['', 'hello', undefined, null, 42, '\u001b[6;0;0t', '\u001b[6;;t']) {
    assert.deepEqual(parseSizeReport(junk).cell, undefined, JSON.stringify(junk))
  }
})

test('the real resolution follows from the cell size', () => {
  // The cell is about twice as tall as it is wide, which is the whole problem.
  const cell = { width: 9, height: 18 }
  const resolution = pixelResolution(cell, { cols: 148, rows: 40 })
  assert.deepEqual(resolution, { width: 1332, height: 720, aspect: 0.5 })
})

test('a smaller font buys cells, which is what buys pixels', () => {
  // A 1332x720 window, at three font sizes.
  const window = { width: 1332, height: 720 }
  const big = cellsForWindow({ width: 9, height: 18 }, window)
  const small = cellsForWindow({ width: 4, height: 9 }, window)

  assert.deepEqual({ cols: big.cols, rows: big.rows }, { cols: 148, rows: 40 })
  // Halving the font doubles the cells in each direction, so four times as many
  // cells — and the drawing budget is two pixels per cell.
  assert.equal(small.cols, 333)
  assert.equal(small.rows, 80)
  assert.ok(small.artPixels > big.artPixels * 4, 'and four times the drawing')
  assert.equal(big.artPixels, 148 * 40 * 2)

  // Degenerate input must not divide by zero.
  assert.deepEqual(cellsForWindow({ width: 0, height: 0 }, window), { cols: 0, rows: 0, artPixels: 0 })
})

test('a terminal that does not answer does not stall or throw', async () => {
  // Not a TTY: resolves immediately, touches nothing.
  const result = await queryTerminalSize({ stdin: { isTTY: false }, stdout: { write: () => {} } })
  assert.deepEqual(result, { answered: false })

  // A TTY that never replies still settles, on the timeout.
  const listeners = []
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(value) {
      this.isRaw = value
    },
    resume() {},
    pause() {},
    on(event, handler) {
      if (event === 'data') listeners.push(handler)
    },
    removeListener() {}
  }
  const written = []
  const started = Date.now()
  const timedOut = await queryTerminalSize({ stdin, stdout: { write: (data) => written.push(data) } }, 60)
  assert.equal(timedOut.answered, false, 'nothing was written back')
  assert.ok(Date.now() - started >= 40, 'but it waited rather than resolving at once')
  assert.equal(listeners.length, 1, 'and it did ask')
  assert.equal(written.length, 1)
  assert.match(written[0], /\u001b\[16t/, 'for the cell size')
  assert.match(written[0], /\u001b\[14t/, 'and the text area')
  assert.equal(stdin.isRaw, false, 'leaving raw mode as it found it')
})

test('an answering terminal resolves as soon as both reports arrive', async () => {
  let handler = null
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(value) {
      this.isRaw = value
    },
    resume() {},
    pause() {},
    on(event, fn) {
      if (event === 'data') handler = fn
    },
    removeListener() {}
  }
  const pending = queryTerminalSize({ stdin, stdout: { write: () => {} } }, 5000)
  // Both halves, then wait: the promise should already have resolved.
  handler(Buffer.from('\u001b[6;18;9t'))
  handler(Buffer.from('\u001b[4;720;1440t'))
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.cell, { width: 9, height: 18 })
  assert.deepEqual(result.textArea, { width: 1440, height: 720 })
})
