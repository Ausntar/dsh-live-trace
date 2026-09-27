/**
 * Terminal input: key parsing, SGR mouse reports, and split reads.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createKeyParser, SEQUENCE } from '../src/cli/screen.js'

test('arrow and navigation keys are recognized', () => {
  const parse = createKeyParser()
  assert.deepEqual(parse('\u001b[A\u001b[B'), ['up', 'down'])
  assert.deepEqual(parse('\u001b[5~\u001b[6~'), ['page-up', 'page-down'])
  assert.deepEqual(parse('\u001b[H\u001b[F'), ['home', 'end'])
  assert.deepEqual(parse('q'), ['q'])
  assert.deepEqual(parse('\r'), ['\r'])
})

test('a sequence split across reads is buffered, not misread', () => {
  const parse = createKeyParser()
  assert.deepEqual(parse('\u001b'), [], 'a lone ESC waits for the rest')
  assert.equal(parse.pending(), '\u001b')
  assert.deepEqual(parse('[A'), ['up'])
  assert.equal(parse.pending(), '')
})

test('the wheel maps to its own keys', () => {
  const parse = createKeyParser()
  assert.deepEqual(parse('\u001b[<64;10;5M'), ['wheel-up'])
  assert.deepEqual(parse('\u001b[<65;10;5M'), ['wheel-down'])
  assert.deepEqual(parse('\u001b[<66;10;5M'), ['wheel-left'])
  assert.deepEqual(parse('\u001b[<67;10;5M'), ['wheel-right'])
})

test('a wheel report split across reads is reassembled', () => {
  const parse = createKeyParser()
  assert.deepEqual(parse('\u001b[<6'), [])
  assert.deepEqual(parse('4;10;5'), [])
  assert.deepEqual(parse('M'), ['wheel-up'])
})

test('a left press is a click carrying its coordinates; a release is dropped', () => {
  const parse = createKeyParser()
  assert.deepEqual(parse('\u001b[<0;12;7M'), [{ type: 'click', x: 12, y: 7 }])
  assert.deepEqual(parse('\u001b[<0;12;7m'), [], 'the release reports nothing new')
  // Motion and the other buttons are not useful to the dashboard.
  assert.deepEqual(parse('\u001b[<32;12;7M'), [])
  assert.deepEqual(parse('\u001b[<2;12;7M'), [])
})

test('mouse reports interleave with ordinary keys', () => {
  const parse = createKeyParser()
  assert.deepEqual(parse('q\u001b[<65;3;3M1'), ['q', 'wheel-down', '1'])
})

test('an unterminated mouse report cannot accumulate forever', () => {
  const parse = createKeyParser()
  assert.deepEqual(parse(`\u001b[<${'9'.repeat(400)}`), [], 'no report is emitted without a terminator')
  assert.equal(parse.pending(), '', 'the buffer is dropped rather than grown')
})

test('an unknown escape sequence degrades to literal keys', () => {
  const parse = createKeyParser()
  // Not a sequence this dashboard knows; the ESC is consumed and the rest is
  // treated as text, which is the least surprising fallback.
  assert.deepEqual(parse('\u001b[Z'), ['[', 'Z'])
})

test('the mouse mode is claimed on entry and released on exit', () => {
  assert.match(SEQUENCE.mouseEnter, /1000h/)
  assert.match(SEQUENCE.mouseEnter, /1006h/, 'SGR encoding gives exact coordinates')
  assert.match(SEQUENCE.mouseLeave, /1000l/)
  assert.match(SEQUENCE.mouseLeave, /1006l/)
})

test('the screen can be told not to claim the mouse', async () => {
  const { Screen } = await import('../src/cli/screen.js')
  const written = []
  const stdout = { columns: 80, rows: 24, write: (text) => written.push(text), on() {}, off() {} }
  const stdin = { isTTY: false, resume() {}, pause() {}, setEncoding() {}, on() {}, off() {} }
  const screen = new Screen({ stdout, stdin, altScreen: true, mouse: false })
  screen.enter()
  screen.leave()
  assert.equal(written.join('').includes(SEQUENCE.mouseEnter), false, 'mouse reporting stays off when disabled')
})
