/**
 * The orca, sampled from the reference artwork.
 *
 * Two things about the source art matter here:
 *
 * 1. It is a **sleeping** whale — the grey marks above it are three `Z`
 *    glyphs, not a water spout. They are *excluded* when sampling, so the
 *    sprite is the creature alone on a transparent background. The scene draws
 *    its own `z`s, and only while the orca is actually asleep.
 * 2. Its native pixel grid is 64x40 (the artwork's blocks are 5 source pixels
 *    across). Sampling at that size keeps every row of the original; sampling
 *    smaller silently drops detail, and sampling larger only duplicates rows.
 *
 * Classes: `.` transparent, `b` body blue, `o` outline navy, `w` belly white.
 *
 * @module dsh-live-working/art
 */

/** Sprite width in pixels (and cells: a cell is one pixel wide). */
export const ORCA_W = 64

/** Sprite height in pixels. A terminal cell holds two of these rows. */
/** The body's height. This is what the layout positions; the canvas is taller. */
export const ORCA_H = 40

/**
 * The canvas the sprite is drawn on.
 *
 * Taller than the body on purpose. The flukes reach the last row of the body,
 * so a tail with nowhere to go had no room to droop at all — every attempt to
 * lay it down either ate pixels or left the shape ragged. The spare rows below
 * are empty, invisible, and exactly what the tail needs to sink into.
 */
export const ORCA_SPARE = 16
export const SPRITE_H = ORCA_H + ORCA_SPARE

/** The orca, exactly as sampled from the reference. */
const ORCA = [
  '..........................................oo....................',
  '..........................................oo....................',
  '........................................oobboo..............oo..',
  '........................................oobboo..............oo..',
  '........................................oobbbboo..........oobboo',
  '........................................oobbbboo..........oobboo',
  '........................................oobbbbbboo....oooobbbboo',
  '........................................oobbbbbboooooooooobbbboo',
  '........................................oobbbbbbbboooobbbbbbbboo',
  '........oooooooooooooooooo..............oobbbbbbbboooobbbbbbbboo',
  '........oooooooooooooooooo................oobbbbbbbbbbbbbbbboo..',
  '......oobbbbbbbbbbbbbbbbbboooo............oooobbbbbbbbbbbbbboo..',
  '......oobbbbbbbbbbbbbbbbbboooo..............oobbbbbbbbbbbbbboo..',
  '....oobbbbbbbbbbbbbbbbbbbbbbbboooo..........oobbbbbbbbbboooooo..',
  '....oobbbbbbbbbbbbbbbbbbbbbbbboooo..........oobbbbbbbbbboooo....',
  '..oobbbbbbbbbbbbbbbbbbbbbbbbbbbbbboooo........oobbbbbboo........',
  '..oobbbbbbbbbbbbbbbbbbbbbbbbbbbbbboooo........oobbbbbboo........',
  'oooobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbboo....oobbbbbbbboo........',
  'oooobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbboo....oobbbbbbbboo........',
  'oobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbboooobbbbbbbbbboo........',
  'oobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbboooobbbbbbbbbboo........',
  'oobbbbbboobbbbbbbbbbbboobbbbbbbbbbbbbbbbbbbbbbbbbbbbbboo........',
  'oobbbbbboobbbbbbbbbbbboobbbbbbbbbbbbbbbbbbbbbbbbbbbbbboo........',
  'oobbbbbboobbbbbbbbbbbboobbbbbbbbbbbbbbbbbbbbbbbbbbbboo..........',
  'oobbbbbboobbbbbbbbbbbboobbbbbbbbbbbbbbbbbbbbbbbbbbbboo..........',
  'oobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbboo..........',
  'oobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbboo..........',
  'oobbbbbbbbwwwwwwwwwwwwwwbbbbbbbbbbbbbbbboobbbbbbbboo............',
  'oobbbbbbbbwwwwwwwwwwwwwwbbbbbbbbbbbbbbbboobbbbbbbboo............',
  'oooobbwwwwwwwwwwwwwwwwwwwwwwwwbbbbbbbbbbbboobbbbbboo............',
  'oooowwwwwwwwwwwwwwwwwwwwwwwwwwwwoobbbbbbbboooobboooo............',
  '..oowwwwwwwwwwwwwwwwwwwwwwwwwwwwoobbbbbbbboooobboo..............',
  '..oooowwwwwwwwwwwwwwwwwwwwwwwwwwoobbbbbbbbbboooooo..............',
  '....oowwwwwwwwwwwwwwwwwwwwwwwwwwoobbbbbbbbbboooo................',
  '......oooowwwwwwwwwwwwwwwwwwwwwwwwoobbbbbbbbbboooo..............',
  '......oooowwwwwwwwwwwwwwwwwwwwwwwwoobbbbbbbbbboooo..............',
  '..........oowwwwwwwwwwwwwwwwwwwwwwoooobbbbbbbbbbbboo............',
  '..........oowwwwwwwwwwwwwwwwwwwwwwoooobbbbbbbbbbbboo............',
  '............oooooooooooooooooooooo....oooooooooooooo............',
  '............oooooooooooooooooooooo....oooooooooooooo............'
]

/** A fresh, mutable copy of the orca at rest. */
export function orcaGrid() {
  const body = ORCA.map((row) => row.split(''))
  // Empty rows below, for the tail to droop into. Nothing else draws here.
  for (let index = 0; index < ORCA_SPARE; index += 1) {
    body.push(new Array(ORCA_W).fill('.'))
  }
  return body
}

/**
 * The eyes, found in the sampled grid as two dark marks inside the head.
 * Each is 2x4 pixels, which is enough to open, squint and close.
 */
export const EYES = [
  { x: 8, y: 21, width: 2, height: 4 },
  { x: 22, y: 21, width: 2, height: 4 }
]

/**
 * Set both eyes.
 *
 * @param {string[][]} grid
 * @param {'open' | 'squint' | 'closed' | 'happy'} mode
 */
export function setEyes(grid, mode) {
  for (const eye of EYES) {
    const rows = eye.height
    // Restore the body first so every mode is independent of the last.
    for (let dy = 0; dy < rows; dy += 1) {
      for (let dx = 0; dx < eye.width; dx += 1) grid[eye.y + dy][eye.x + dx] = 'b'
    }
    if (mode === 'open') {
      for (let dy = 0; dy < rows; dy += 1) {
        for (let dx = 0; dx < eye.width; dx += 1) grid[eye.y + dy][eye.x + dx] = 'o'
      }
    } else if (mode === 'squint') {
      // Only the bottom pixel row survives: a contented narrowing.
      for (let dx = 0; dx < eye.width; dx += 1) grid[eye.y + rows - 1][eye.x + dx] = 'o'
    } else if (mode === 'closed') {
      // One horizontal line, one pixel wider than the eye at each end, which
      // reads as a shut eye rather than a dash.
      for (let dx = -1; dx <= eye.width; dx += 1) grid[eye.y + rows - 1][eye.x + dx] = 'o'
    } else if (mode === 'happy') {
      // An upward arc.
      grid[eye.y + rows - 2][eye.x] = 'o'
      grid[eye.y + rows - 2][eye.x + eye.width - 1] = 'o'
      for (let dx = 0; dx < eye.width; dx += 1) grid[eye.y + rows - 1][eye.x + dx] = 'o'
    }
  }
}

/**
 * Scale a pixel grid by a whole number, for a terminal with room to spare.
 *
 * Pixel art scales by whole numbers or not at all: a fractional scale produces
 * uneven blocks that look like a rendering fault.
 *
 * @param {string[][]} grid
 * @param {number} factor
 * @returns {string[][]}
 */
/**
 * Where the tail begins.
 *
 * Not one column: the flukes' left edge wanders. The upper lobe starts at
 * column 41, the lower one at 42, and only the middle rows — where the tail
 * joins the back — begin at 45. Taking the whole tail to be everything right of
 * a single column left the strip at 41..44 behind, which the eye reads as part
 * of the tail sitting still while the rest of it moves.
 *
 * The middle rows are the exception for a reason: at rows 18..27 the body's own
 * back reaches column 41, so including those columns there would drag the orca's
 * back down with the tail.
 */
/**
 * The tail is **drawn**, one pose per state, not transformed.
 *
 * Six attempts at applying a transform to the single tail in the source art all
 * traded one artefact for another: a shear frayed the edge, a fold tore the
 * silhouette, a slide put the tail under the table, and every version left
 * either a spike, a hole showing the background through, or both. The source
 * art has one tail — an upright V — and no room anywhere to move it into. So
 * there are two poses now, and the renderer picks one.
 */
export const TAIL_X = 41

/** The leftmost tail column at a given row, in the original art. */
const TAIL_EDGES = (() => {
  // Rows 0..18 have a clear gap between the body and the flukes, so their
  // leading edge can simply be read: it is the first filled column from 40
  // rightwards. Later rows merge with the body's own back and there is nothing
  // to read, so they take a nominal edge.
  const edges = []
  for (let y = 0; y < ORCA.length; y += 1) {
    if (y >= 19) {
      edges.push(y < 28 ? 45 : 42)
      continue
    }
    let left = -1
    for (let x = 40; x < ORCA_W; x += 1) {
      if (ORCA[y][x] !== '.') {
        left = x
        break
      }
    }
    edges.push(left === -1 ? 40 : left)
  }
  return edges
})()

/**
 * The leftmost column of the tail on a row.
 *
 * Not one column. The flukes' leading edge steps between 40 and 46 down the
 * sprite, and taking it for a single value leaves a strip of tail behind when
 * the tail is lifted out — a lone vertical line beside the orca that looks
 * exactly like a transform artefact and is nothing of the sort.
 */
export function tailLeftFor(y) {
  return TAIL_EDGES[y] ?? 40
}

/**
 * The tail as spans of `[row, firstColumn, lastColumn]`.
 *
 * `up` is lifted straight out of the source art, so the awake pose is unchanged.
 * `sleep` is drawn: the tail curls round to the front, over the near side of
 * the body, and tucks back in. Drawn art cannot lose a pixel or open a gap,
 * which is the whole reason for doing it this way.
 */
const TAIL_SPANS = {
  up: null, // extracted from the art at load time
  // The tail comes off the body's rear and sweeps down and forward along the
  // desk, curling up at the front. The right end of every row reaches the rear,
  // which is what joins it to the orca; drawing only the curl at the front left
  // an oval floating on the belly with the body's back bare.
  sleep: [
    [30, 27, 45],
    [31, 24, 45],
    [32, 21, 44],
    [33, 19, 44],
    [34, 17, 43],
    [35, 15, 43],
    [36, 16, 42],
    [37, 19, 41],
    [38, 23, 40]
  ]
}

/**
 * How far back the body reaches, row by row, once the tail is out of the way.
 *
 * The source art's rear is a straight wall — the tail covered it, so it never
 * showed. With the tail curled round to the front it is the last thing you see,
 * and a flat vertical edge reads as a body that has been sliced off. These are
 * the columns that round it.
 */
export /** The column the rear's fill is normalised from. */
const INNER = 34

export const SLEEP_REAR = new Map([
  [18, 40],
  [19, 41],
  [20, 42],
  [21, 43],
  [22, 43],
  [23, 44],
  [24, 44],
  [25, 45],
  [26, 45],
  [27, 45],
  [28, 45],
  [29, 45],
  [30, 45],
  [31, 45],
  [32, 44],
  [33, 44],
  [34, 43],
  [35, 43],
  [36, 42],
  [37, 41],
  [38, 40],
  [39, 38]
])

/** The awake tail, exactly as the source art has it. */
function liftedTail() {
  const cells = []
  for (let y = 0; y < ORCA.length; y += 1) {
    for (let x = tailLeftFor(y); x < ORCA_W; x += 1) {
      if (ORCA[y][x] !== '.') cells.push([x, y, ORCA[y][x]])
    }
  }
  return cells
}

/** The sleeping tail: the drawn spans, with its edge generated. */
function sleepingTail() {
  const cells = []
  const spans = TAIL_SPANS.sleep
  const filled = new Set()
  for (const [y, from, to] of spans) {
    for (let x = from; x <= to; x += 1) filled.add(`${x},${y}`)
  }
  /**
   * A neighbour the tail would show an edge against.
   *
   * Unlike the flat pose this one lies *on* the body, so it keeps its outline
   * everywhere: without an edge it would be blue on blue and simply not visible.
   * The edge is what makes it read as a coil rather than a lump.
   */
  const exposed = (x, y) => !filled.has(`${x},${y}`)

  for (const [y, from, to] of spans) {
    for (let x = from; x <= to; x += 1) {
      const edge =
        exposed(x + 1, y) || exposed(x - 1, y) || exposed(x, y + 1) || exposed(x, y - 1)
      cells.push([x, y, edge ? 'o' : 'b'])
    }
  }
  return cells
}

const TAIL_CACHE = new Map()

/**
 * The tail's pixels for a pose, filled and outlined.
 *
 * The outline is generated rather than drawn: a cell with an empty neighbour
 * becomes the dark edge, which keeps the drawn pose's edge identical in
 * treatment to the rest of the sprite.
 *
 * @param {'up' | 'sleep'} pose
 * @returns {Map<string, string>} "x,y" -> class
 */
export function tailPixels(pose) {
  const key = pose === 'sleep' ? 'sleep' : 'up'
  const hit = TAIL_CACHE.get(key)
  if (hit !== undefined) return hit

  const out = new Map()
  for (const [x, y, cls] of key === 'sleep' ? sleepingTail() : liftedTail()) {
    out.set(`${x},${y}`, cls)
  }
  TAIL_CACHE.set(key, out)
  return out
}

/**
 * The orca, with one of its tails.
 *
 * @param {{ pose?: 'up' | 'sleep', sway?: number }} [options] sway shifts the
 *   whole tail rigidly, which cannot open a gap because no column moves
 *   relative to another.
 */
export function orcaWithTail(options = {}) {
  const pose = options.pose === 'sleep' ? 'sleep' : 'up'
  const sway = Number.isFinite(options.sway) ? Math.round(options.sway) : 0
  const grid = ORCA.map((row) => row.split(''))
  // Take the source art's own tail out; the pose supplies one instead.
  for (let y = 0; y < grid.length; y += 1) {
    for (let x = tailLeftFor(y); x < ORCA_W; x += 1) grid[y][x] = '.'
  }
  // With the tail gone, round the body's rear rather than leaving the wall the
  // tail used to hide.
  if (pose === 'sleep') {
    for (const [y, rear] of SLEEP_REAR) {
      const row = grid[y]
      // Fill out to the curve, then cut everything past it. Filling matters:
      // the source art's rear does not reach the curve on every row, and
      // clearing alone left the edge stepping in and out with stray fill
      // pixels caught between two runs of outline.
      let last = -1
      for (let x = 0; x < ORCA_W; x += 1) if (row[x] !== '.') last = x
      for (let x = last + 1; x <= rear; x += 1) row[x] = 'b'
      for (let x = rear + 1; x < ORCA_W; x += 1) row[x] = '.'
      // One clean edge. The source art's rear carries stray outline pixels
      // inside the silhouette, and once the curve is filled they read as a
      // nick in the edge rather than as shading.
      // Any outline still inside the filled band becomes fill, so each row has
      // exactly one edge at the curve.
      for (let x = INNER; x < rear; x += 1) if (row[x] === 'o') row[x] = 'b'
      row[rear] = 'o'
    }
  }

  // The spare rows go on first: a swayed tail needs somewhere to land, and
  // appending them afterwards silently clipped whatever moved past the body.
  for (let index = 0; index < ORCA_SPARE; index += 1) grid.push(new Array(ORCA_W).fill('.'))
  // Where the tail meets the body. A rigid shift would pull the base away from
  // the body and show the background through the seam, so the columns near the
  // junction are drawn unshifted as well: the tail pivots instead of sliding.
  const ANCHOR = 50
  for (const [key, cls] of tailPixels(pose)) {
    const [x, y] = key.split(',').map(Number)
    if (sway !== 0 && x < ANCHOR) {
      grid[y][x] = cls
      continue
    }
    const target = y + sway
    if (target < 0 || target >= grid.length) continue
    grid[target][x] = cls
  }
  return grid
}

/** How far the tail swings on a frame, in pixels. */
export function tailSwayFor(kind, frame) {
  if (kind === 'calling' || kind === 'ringing') return 0
  const amp = kind === 'waiting' || kind === 'reading' ? 2.5 : 2
  return Math.round(Math.sin(frame / 7) * amp)
}

/** How far along the settle to the sleeping pose is, 0 to 1. */
export function tailDroopFor(kind, sleepFor = 0) {
  if (kind !== 'sleep') return 0
  const settle = Math.max(0, Math.min(1, sleepFor / 16))
  return settle * settle * (3 - 2 * settle)
}


export function scaleGrid(grid, factor) {
  const n = Math.max(1, Math.trunc(factor))
  if (n === 1) return grid.map((row) => row.slice())
  const out = []
  for (const row of grid) {
    const grown = []
    for (const cell of row) for (let index = 0; index < n; index += 1) grown.push(cell)
    for (let index = 0; index < n; index += 1) out.push(grown.slice())
  }
  return out
}
