#!/usr/bin/env node
/**
 * Print a sample sheet for each way a terminal cell can carry pixels.
 *
 * Whether your font has these glyphs decides what resolution is available, and
 * a missing glyph does not error — it silently substitutes a box or a blank.
 * Run this and look.
 */
import { cellsForWindow, queryTerminalSize } from '../src/cli/cellsize.js'
import { PACKINGS, probe } from '../src/cli/working/packing.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('usage: dsh-glyph-probe [--raw]\n\n')
  process.stdout.write('Prints a sample of half-block, quadrant and braille glyphs.\n')
  process.stdout.write('--raw  write the characters without colour\n')
  process.exit(0)
}

const dim = (text) => `\u001b[38;5;245m${text}\u001b[0m`

// How big the cells really are decides how much can be drawn at all, so ask.
const geometry = await queryTerminalSize({ stdin: process.stdin, stdout: process.stdout })
const cols = process.stdout.columns ?? 80
const rows = process.stdout.rows ?? 24
process.stdout.write('\n')
if (geometry.cell === undefined) {
  process.stdout.write('The terminal did not report its cell size (CSI 16t); most do not.\n')
  process.stdout.write(`Known: ${cols}x${rows} cells.\n`)
} else {
  const { width, height } = geometry.cell
  const here = cellsForWindow(geometry.cell, geometry.textArea ?? { width: width * cols, height: height * rows })
  const smaller = cellsForWindow({ width: Math.max(1, Math.round(width / 2)), height: Math.max(1, Math.round(height / 2)) }, geometry.textArea ?? { width: width * cols, height: height * rows })
  process.stdout.write(`Cell size      ${width}x${height} px   (aspect ${(width / height).toFixed(2)})\n`)
  process.stdout.write(`Cells          ${cols}x${rows}\n`)
  process.stdout.write(`Drawing budget ${here.artPixels.toLocaleString()} pixels (two per cell)\n`)
  process.stdout.write(`Half the font  ${smaller.cols}x${smaller.rows} cells -> ${smaller.artPixels.toLocaleString()} pixels\n`)
  process.stdout.write('\nA terminal will not change its own font: there is no escape sequence.\n')
  process.stdout.write('Shrink it yourself and this number is what you gain.\n')
}


for (const packing of Object.values(PACKINGS)) {
  process.stdout.write(`\n${dim(`── ${packing.name} ─ ${packing.cols}x${packing.rows} ─ ${packing.square ? 'square' : 'non-square'} pixels ─ ${packing.solid ? 'solid' : 'dotted'} glyphs`)}\n\n`)
  const { rows } = probe(packing)
  for (const row of rows) process.stdout.write(`${row}\n`)
  process.stdout.write('\n')
}

process.stdout.write('Compare the three discs. The one that comes out round and seamless is the one\n')
process.stdout.write('your font supports; a row of boxes or question marks means it does not.\n')
