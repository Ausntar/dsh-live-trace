/**
 * Terminal measurement: the 80-column contract starts here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codePointWidth,
  collapse,
  displayWidth,
  explode,
  padRow,
  renderRow,
  rowWidth,
  sanitize,
  truncate,
  truncateSegments,
  wrapSegments
} from '../src/cli/width.js'
import { stripAnsi } from './helpers/util.js'

test('displayWidth counts CJK as two cells and ASCII as one', () => {
  assert.equal(displayWidth('hello'), 5)
  assert.equal(displayWidth('推理中'), 6)
  assert.equal(displayWidth('a推b理c'), 7)
  assert.equal(displayWidth(''), 0)
  assert.equal(displayWidth('한글'), 4)
  assert.equal(displayWidth('ＡＢ'), 4)
})

test('displayWidth treats combining marks as zero width', () => {
  // e + COMBINING ACUTE ACCENT renders as one cell
  assert.equal(displayWidth('e\u0301'), 1)
  assert.equal(displayWidth('a\u200bb'), 2)
})

test('displayWidth counts emoji presentation as two cells but glyphs used in the UI as one', () => {
  assert.equal(displayWidth('✅'), 2)
  assert.equal(displayWidth('🎉'), 2)
  // The board's own marks are East Asian Ambiguous, not Wide.
  assert.equal(displayWidth('✓'), 1)
  assert.equal(displayWidth('✗'), 1)
  assert.equal(displayWidth('●'), 1)
  assert.equal(displayWidth('⠋'), 1)
})

test('codePointWidth classifies controls as zero width', () => {
  assert.equal(codePointWidth(0x00), 0)
  assert.equal(codePointWidth(0x09), 0)
  assert.equal(codePointWidth(0x7f), 0)
  assert.equal(codePointWidth(0x41), 1)
  assert.equal(codePointWidth(0x4e2d), 2)
})

test('sanitize strips escape sequences from untrusted content', () => {
  assert.equal(sanitize('\u001b[31mred\u001b[0m'), 'red')
  assert.equal(sanitize('a\u0007b'), 'a b')
  assert.equal(sanitize('\u001b]0;title\u0007visible'), 'visible')
  assert.equal(sanitize('\u001b[2Jcleared'), 'cleared')
  assert.equal(sanitize(null), '')
  assert.equal(sanitize(undefined), '')
})

test('truncate respects a cell budget, not a character count', () => {
  assert.equal(truncate('hello world', 5), 'hell…')
  assert.equal(truncate('推理中推理中', 5), '推理…')
  assert.equal(displayWidth(truncate('推理中推理中', 5)), 5)
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(truncate('abc', 0), '')
})

test('truncate never splits a wide character across the boundary', () => {
  // Budget 3 with a two-cell character leaves room for one wide char + ellipsis.
  const result = truncate('中中中', 3)
  assert.equal(result, '中…')
  assert.equal(displayWidth(result), 3)
})

test('truncateSegments keeps styles and survives escape-free round trips', () => {
  const segments = truncateSegments([{ text: '推理中推理中', sgr: '1;38;5;39' }], 5)
  assert.equal(rowWidth(segments), 5)
  assert.equal(segments.every((segment) => segment.sgr === '1;38;5;39'), true)
})

test('wrapSegments breaks on spaces and hard-breaks CJK', () => {
  const ascii = wrapSegments([{ text: 'hello world foo bar' }], 10)
  assert.deepEqual(
    ascii.map((line) => line.map((segment) => segment.text).join('')),
    ['hello', 'world foo', 'bar']
  )

  const cjk = wrapSegments([{ text: '推理中推理中推理中' }], 6)
  assert.deepEqual(
    cjk.map((line) => line.map((segment) => segment.text).join('')),
    ['推理中', '推理中', '推理中']
  )
})

test('every wrapped line fits the width budget', () => {
  const samples = [
    'a'.repeat(250),
    '推理中'.repeat(60),
    'mixed 中文 and english words '.repeat(20),
    '  leading and trailing   spaces are collapsed   '
  ]
  for (const sample of samples) {
    for (const width of [1, 2, 3, 7, 20, 79, 80]) {
      for (const line of wrapSegments([{ text: sample }], width)) {
        assert.ok(rowWidth(line) <= width, `line ${JSON.stringify(rowWidth(line))} exceeded ${width}`)
      }
    }
  }
})

test('renderRow round-trips styles and padRow fills to an exact width', () => {
  const row = padRow([{ text: '推理', sgr: '38;5;42' }], 10)
  assert.equal(rowWidth(row), 10)
  const rendered = renderRow(row)
  assert.equal(displayWidth(stripAnsi(rendered)), 10)
})

test('collapse re-joins adjacent characters that share a style', () => {
  const chars = explode([{ text: 'abcd', sgr: 'x' }])
  assert.equal(chars.length, 4)
  assert.equal(collapse(chars).length, 1)
  assert.equal(collapse(explode([{ text: 'ab', sgr: 'x' }, { text: 'cd', sgr: 'y' }])).length, 2)
})
