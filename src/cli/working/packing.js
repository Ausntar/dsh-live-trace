/**
 * How many pixels a terminal cell can carry, and with what glyphs.
 *
 * A cell is roughly twice as tall as it is wide, so the mapping from pixels to
 * glyphs decides both the resolution and the shape of the pixels:
 *
 * | packing    | pixels/cell | pixel shape | glyphs                          |
 * |------------|-------------|-------------|---------------------------------|
 * | `half`     | 1 x 2       | square      | `▀ ▄ █`                         |
 * | `quadrant` | 2 x 2       | 1:2 tall    | `▘ ▝ ▖ ▗ ▚ ▞ ▛ ▜ ▙ ▟`           |
 * | `braille`  | 2 x 4       | square      | `U+2800..U+28FF`                |
 *
 * `half` is what the dashboard draws with: it is the only packing whose pixels
 * are square *and* whose glyphs are solid, which is what pixel art of a whale
 * needs. `braille` carries four times as many pixels with square pixels too,
 * but every pixel is a dot with gaps around it, so solid areas come out
 * stippled — good for a plot, poor for a picture. `quadrant` doubles the
 * horizontal count at the cost of pixels that are twice as tall as they are
 * wide, which stretches anything drawn for square pixels.
 *
 * None of this is a free win, which is why the dashboard stays on `half` and
 * this module exists to let you *look* at the alternatives on your own font.
 *
 * @module dsh-live-working/packing
 */

/** Half blocks: one wide, two tall, and every glyph is solid. */
const HALF = {
  name: 'half',
  cols: 1,
  rows: 2,
  square: true,
  solid: true,
  glyphs: [' ', '▀', '▄', '█'],
  label: 'half blocks — 1x2, square pixels, solid glyphs (what the dashboard uses)'
}

/**
 * Quadrant blocks, in row-major bit order: top-left 1, top-right 2,
 * bottom-left 4, bottom-right 8. Combinations that coincide with a half or
 * full block use that glyph instead, which is both cleaner and better
 * supported.
 */
const QUADRANT = {
  name: 'quadrant',
  cols: 2,
  rows: 2,
  square: false,
  solid: true,
  glyphs: [
    ' ', '▘', '▝', '▀',
    '▖', '▌', '▞', '▛',
    '▗', '▚', '▐', '▜',
    '▄', '▙', '▟', '█'
  ],
  label: 'quadrant blocks — 2x2, pixels 1:2 tall, solid glyphs'
}

/**
 * Braille patterns. The eight dots are numbered down each column, so the bit
 * for a dot is not its position in reading order:
 *
 * ```
 * 1 4
 * 2 5
 * 3 6
 * 7 8
 * ```
 */
const BRAILLE_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80]
const BRAILLE = {
  name: 'braille',
  cols: 2,
  rows: 4,
  square: true,
  solid: false,
  glyphs: Array.from({ length: 256 }, (_, mask) => String.fromCodePoint(0x2800 + mask)),
  bits: BRAILLE_BITS,
  label: 'braille — 2x4, square pixels, but every pixel is a dot with gaps'
}

/** Every packing, in increasing order of resolution. */
export const PACKINGS = { half: HALF, quadrant: QUADRANT, braille: BRAILLE }

/** Packing names. */
export const PACKING_NAMES = Object.keys(PACKINGS)

/**
 * @param {string} [name]
 * @returns {typeof HALF}
 */
export function packingFor(name) {
  return PACKINGS[name] ?? HALF
}

/**
 * The glyph for a set of filled pixels within one cell.
 *
 * @param {object} packing
 * @param {boolean[]} filled row-major, `packing.cols * packing.rows` entries
 * @returns {string}
 */
export function glyphFor(packing, filled) {
  if (packing.bits === undefined) {
    let mask = 0
    for (let index = 0; index < filled.length; index += 1) {
      if (filled[index]) mask |= 1 << index
    }
    return packing.glyphs[mask] ?? ' '
  }
  let mask = 0
  for (let index = 0; index < filled.length; index += 1) {
    if (filled[index]) mask |= packing.bits[index]
  }
  return packing.glyphs[mask] ?? ' '
}

/**
 * A sample sheet for one packing, so you can see what your font does with it.
 *
 * A font that lacks these glyphs does not fail loudly: it substitutes a box, a
 * blank, or another character, and the picture quietly falls apart. Printing
 * this is the only reliable way to find out.
 *
 * @param {object} packing
 * @returns {{ label: string, rows: string[] }}
 */
export function probe(packing) {
  const rows = []
  // Every glyph the packing uses, in a grid.
  for (let start = 0; start < packing.glyphs.length; start += 16) {
    rows.push(packing.glyphs.slice(start, start + 16).map((glyph) => `${glyph}${glyph}`).join(''))
  }
  // A disc rasterised at the packing's own pixel resolution, so its edge falls
  // on partial cells and every glyph gets used. Filling whole cells instead
  // would draw an identical blocky disc for all three packings and tell you
  // nothing.
  const cells = 17
  const across = cells * packing.cols
  const down = cells * packing.rows
  const radius = (Math.min(across, down) - 1) / 2
  const cx = (across - 1) / 2
  const cy = (down - 1) / 2
  const filledAt = (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius
  for (let cellY = 0; cellY < cells; cellY += 1) {
    const line = []
    for (let cellX = 0; cellX < cells; cellX += 1) {
      const filled = []
      for (let row = 0; row < packing.rows; row += 1) {
        for (let col = 0; col < packing.cols; col += 1) {
          filled.push(filledAt(cellX * packing.cols + col, cellY * packing.rows + row))
        }
      }
      line.push(glyphFor(packing, filled))
    }
    rows.push(line.join(''))
  }
  return { label: packing.label, rows }
}
