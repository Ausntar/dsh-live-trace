/**
 * The three ways a terminal cell can carry pixels.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { glyphFor, PACKINGS, PACKING_NAMES, packingFor, probe } from '../src/cli/working/packing.js'

test('the packings and their geometry', () => {
  assert.deepEqual(PACKING_NAMES, ['half', 'quadrant', 'braille'])
  assert.equal(PACKINGS.half.cols * PACKINGS.half.rows, 2)
  assert.equal(PACKINGS.quadrant.cols * PACKINGS.quadrant.rows, 4)
  assert.equal(PACKINGS.braille.cols * PACKINGS.braille.rows, 8)

  // Only half and braille keep square pixels; only half and quadrant are solid.
  assert.deepEqual(
    PACKING_NAMES.filter((name) => PACKINGS[name].square),
    ['half', 'braille']
  )
  assert.deepEqual(
    PACKING_NAMES.filter((name) => PACKINGS[name].solid),
    ['half', 'quadrant']
  )
  // Nothing is both, which is the whole trade-off.
  assert.equal(PACKING_NAMES.filter((name) => PACKINGS[name].square && PACKINGS[name].solid).length, 1)

  assert.equal(packingFor('nonsense'), PACKINGS.half, 'an unknown packing falls back to half')
  assert.equal(packingFor(undefined), PACKINGS.half)
  assert.equal(packingFor('braille'), PACKINGS.braille)
})

test('half blocks map all four masks', () => {
  assert.equal(glyphFor(PACKINGS.half, [false, false]), ' ')
  assert.equal(glyphFor(PACKINGS.half, [true, false]), '▀')
  assert.equal(glyphFor(PACKINGS.half, [false, true]), '▄')
  assert.equal(glyphFor(PACKINGS.half, [true, true]), '█')
  assert.equal(PACKINGS.half.glyphs.length, 4)
})

test('quadrant glyphs are the right quadrants', () => {
  // Row-major: top-left, top-right, bottom-left, bottom-right.
  const at = (tl, tr, bl, br) => glyphFor(PACKINGS.quadrant, [tl, tr, bl, br])
  assert.equal(at(0, 0, 0, 0), ' ')
  assert.equal(at(1, 0, 0, 0), '▘', 'top left')
  assert.equal(at(0, 1, 0, 0), '▝', 'top right')
  assert.equal(at(0, 0, 1, 0), '▖', 'bottom left')
  assert.equal(at(0, 0, 0, 1), '▗', 'bottom right')
  // The combinations that have their own half-block glyph use it.
  assert.equal(at(1, 1, 0, 0), '▀')
  assert.equal(at(0, 0, 1, 1), '▄')
  assert.equal(at(1, 0, 1, 0), '▌')
  assert.equal(at(0, 1, 0, 1), '▐')
  assert.equal(at(1, 1, 1, 1), '█')
  // And the diagonals.
  assert.equal(at(1, 0, 0, 1), '▚')
  assert.equal(at(0, 1, 1, 0), '▞')
  // Every mask is distinct and inside the block.
  assert.equal(new Set(PACKINGS.quadrant.glyphs).size, 16, 'all sixteen masks differ')
  for (const glyph of PACKINGS.quadrant.glyphs) {
    const code = glyph.codePointAt(0)
    assert.ok(code === 0x20 || (code >= 0x2580 && code <= 0x259f), `${glyph} is not a block element`)
  }
})

test('braille dots land on the right dots', () => {
  // The eight dots are numbered down each column, so reading order is not bit
  // order. Getting this wrong mirrors the picture, which is why it is checked
  // dot by dot.
  const dots = (x, y) => glyphFor(PACKINGS.braille, Array.from({ length: 8 }, (_, index) => index === y * 2 + x))
  assert.equal(dots(0, 0), '⠁', 'dot 1')
  assert.equal(dots(0, 1), '⠂', 'dot 2')
  assert.equal(dots(0, 2), '⠄', 'dot 3')
  assert.equal(dots(1, 0), '⠈', 'dot 4')
  assert.equal(dots(1, 1), '⠐', 'dot 5')
  assert.equal(dots(1, 2), '⠠', 'dot 6')
  assert.equal(dots(0, 3), '⡀', 'dot 7')
  assert.equal(dots(1, 3), '⢀', 'dot 8')
  assert.equal(glyphFor(PACKINGS.braille, new Array(8).fill(true)), '⣿', 'full')
  assert.equal(glyphFor(PACKINGS.braille, new Array(8).fill(false)), '⠀', 'blank')
  // All 256 patterns are distinct braille characters.
  assert.equal(PACKINGS.braille.glyphs.length, 256)
  assert.equal(new Set(PACKINGS.braille.glyphs).size, 256)
  for (const glyph of PACKINGS.braille.glyphs) {
    const code = glyph.codePointAt(0)
    assert.ok(code >= 0x2800 && code <= 0x28ff, `${code.toString(16)} is not braille`)
  }
})

test('a wrong glyph set is caught by counting, not by eye', () => {
  // Every packing must be able to express every combination of its pixels.
  for (const name of PACKING_NAMES) {
    const packing = PACKINGS[name]
    const combinations = 2 ** (packing.cols * packing.rows)
    const seen = new Set()
    for (let mask = 0; mask < combinations; mask += 1) {
      const filled = Array.from({ length: packing.cols * packing.rows }, (_, index) => (mask & (1 << index)) !== 0)
      seen.add(glyphFor(packing, filled))
    }
    assert.equal(seen.size, combinations, `${name} cannot express all ${combinations} combinations`)
  }
})

test('the probe shows a disc at the packing resolution', () => {
  for (const name of PACKING_NAMES) {
    const packing = PACKINGS[name]
    const { rows, label } = probe(packing)
    assert.ok(label.includes(name))
    // Every glyph, then a square of cells.
    const samples = Math.ceil(packing.glyphs.length / 16)
    const cells = 17
    assert.equal(rows.length, samples + cells)
    for (const row of rows.slice(samples)) assert.equal([...row].length, cells)
    // The disc is round in pixel space, so its widest rows straddle the middle.
    // Quadrant pixels are twice as tall as they are wide, so the widest *plateau*
    // is broad and it is its centre that must sit in the middle, not its start.
    const disc = rows.slice(samples)
    const widths = disc.map((row) => [...row].filter((glyph) => glyph !== ' ' && glyph !== '⠀').length)
    const widest = Math.max(...widths)
    const plateau = widths.map((width, index) => [width, index]).filter(([width]) => width === widest).map(([, index]) => index)
    const centre = plateau.reduce((sum, index) => sum + index, 0) / plateau.length
    assert.ok(Math.abs(centre - (cells - 1) / 2) <= 2, `${name}: the disc is centred at ${centre}, not ${(cells - 1) / 2}`)
  }
})
