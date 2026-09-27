/**
 * The scene: the orca at its desk, animated for whatever it is doing.
 *
 * The scene is **sized to the terminal** rather than fixed. A frame is composed
 * as a pixel grid and then packed two-pixels-per-cell into terminal cells, so
 * the horizontal resolution available is the terminal width: a fixed 96-column
 * scene would sit in the middle of a wide terminal looking small and losing
 * detail that was there to be had. The sprites scale by whole numbers, because
 * pixel art scaled fractionally looks like a rendering fault.
 *
 * Text — the telephone bubble — is written into the cell grid directly, since
 * glyphs are not pixels.
 *
 * @module dsh-live-working/scene
 */

import { drawNature, drawWall, drawWindowView, skyState } from './sky.js'
import { displayWidth, truncate } from '../width.js'
import { orcaWithTail, ORCA_H, ORCA_W, scaleGrid, setEyes, tailDroopFor, tailSwayFor } from './art.js'
import {
  blit,
  canvas,
  drawBooks,
  drawBubble,
  drawDesk,
  drawFlipper,
  drawKeyboard,
  drawLimb,
  drawOpenBook,
  drawPhone,
  drawRingArcs,
  drawSleepZ,
  drawWindow,
  rect
} from './props.js'

/** The scene size used when the caller does not say (tests, previews). */
export const SCENE_W = 112
export const SCENE_H = 64

/** Largest scene, in cells, and the smallest a readable one can be. */
const MIN_W = 40
const MAX_W = 200
const MIN_H = 24

/** Which palette key each pixel class uses. */
const CLASS_KEY = {
  b: 'body',
  f: 'flipper',
  o: 'outline',
  w: 'belly',
  s: 'spout',
  a: 'accent',
  d: 'desk',
  D: 'deskDark',
  k: 'keyboard',
  K: 'key',
  r: 'phone',
  R: 'phoneDark',
  p: 'page',
  g: 'bookGreen',
  y: 'bookYellow',
  c: 'bookCyan',
  n: 'bubble',
  N: 'bubbleFill',
  q: 'pageShade',
  Q: 'pageDark',
  e: 'windowEdge',
  E: 'windowFill',
  F: 'windowFrame',
  S: 'sky',
  H: 'skyLow',
  B: 'landscape',
  O: 'glow',
  i: 'starDim',
  T: 'tree',
  j: 'ground',
  L: 'cloud',
  U: 'sun',
  M: 'moon',
  I: 'star',
  X: 'rain',
  Z: 'snow',
  G: 'fog',
  W: 'wall',
  V: 'wallShade',
  Y: 'floor',
  z: 'sleepZ',
  t: 'text'
}

/**
 * Priority when one cell holds two different pixels. Furniture is drawn over
 * the orca deliberately, so it wins; outline wins over body so the rim reads.
 */
const CLASS_ORDER = [
  't', 'n', 'N', 'z', 'e', 'E', 'F', 'a', 'r', 'R', 'o', 'K', 'k', 'd', 'D',
  'X', 'Z', 'G', 'L', 'U', 'M', 'O', 'I', 'i', 'T', 'j', 'B', 'H', 'S', 'V', 'W', 'Y',
  'g', 'y', 'c', 'p', 'q', 'Q', 'w', 's', 'f', 'b'
]

const GLYPHS = [' ', '▀', '▄', '█']
const EMPTY = '.'

/** Frame length of the blink, bobs and page turns. */
const CYCLE = 12

/**
 * How big the scene should be, in terminal cells, for a given terminal.
 *
 * @param {number} cols
 * @param {number} rows
 * @returns {{ width: number, height: number }}
 */
export function sceneSizeFor(cols, rows) {
  const safeCols = Number.isFinite(cols) ? cols : 80
  const safeRows = Number.isFinite(rows) ? rows : 24
  // Never wider than the terminal. There is no minimum floor here on purpose:
  // a floor that ignored the terminal would push the scene, and the telephone
  // bubble with it, off the screen. The caller refuses to draw a scene in a
  // terminal too small to hold one.
  const width = Math.min(MAX_W, Math.max(16, Math.floor(safeCols) - 2))
  // The scene is a wide band: keep its proportions when the terminal is short.
  const preferred = Math.round(width * 0.3)
  // Two rows are left over for the status line. The minimum height is a
  // preference, not a floor: on a short terminal a scene that insisted on 24
  // rows would be sliced by the caller and the status line would vanish with
  // it.
  const available = Math.max(8, Math.floor(safeRows) - 2)
  const height = Math.min(Math.max(preferred, Math.min(MIN_H, available)), available)
  return { width, height }
}

/**
 * What whole-number scale the orca should be drawn at.
 *
 * One is the native size; two is for a terminal with room to spare, where the
 * creature would otherwise look lost in the middle of the desk.
 *
 * @param {{ width: number, height: number }} size scene size in cells
 * @returns {number}
 */
export function orcaScaleFor(size) {
  const pixelW = size.width
  const pixelH = size.height * 2
  const fit = Math.min(Math.floor((pixelW * 0.68) / ORCA_W), Math.floor((pixelH * 0.78) / ORCA_H))
  return Math.max(1, Math.min(3, fit))
}

/** Positive modulo. */
function mod(value, base) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return 0
  return ((n % base) + base) % base
}

/**
 * Eyes for the current state and frame.
 *
 * Reading is punctuated by an occasional squint, and sleep closes them; the
 * model's other states keep them open.
 */
/**
 * Whether the orca is rubbing its eyes.
 *
 * Only at night, and only while it is working: the joke is that the work
 * carries on. Every so often it shuts its eyes and lifts a flipper to its face
 * for a moment, then carries on exactly where it was.
 *
 * @param {string} kind
 * @param {number} frame
 * @param {{ phase?: string } | undefined} sky
 */
export function isRubbingEyes(kind, frame, sky) {
  if (sky?.phase !== 'night') return false
  const working = kind === 'typing' || kind === 'writing' || kind === 'reading' || kind === 'searching'
  if (!working) return false
  return mod(frame + 23, RUB_BETWEEN) < RUB_LENGTH
}

/** Frames between eye rubs, and how long one lasts. */
export const RUB_BETWEEN = 72
export const RUB_LENGTH = 16

export function eyeMode(kind, frame) {
  const tick = mod(frame, CYCLE)
  switch (kind) {
    case 'sleep':
      return 'closed'
    case 'reading':
      // A long blink every cycle, so the squint reads as "reading" rather than
      // as a fixed expression.
      return tick >= 8 ? 'closed' : tick >= 6 ? 'squint' : 'open'
    case 'thinking':
      return tick % 4 === 3 ? 'squint' : 'open'
    case 'calling':
      return tick >= 6 ? 'happy' : 'open'
    case 'searching':
      return tick % 6 === 0 ? 'squint' : 'open'
    default:
      return 'open'
  }
}

/** Where everything goes, as fractions of the scene, resolved to pixels. */
export function layoutFor(size) {
  // Tolerate a missing or partial size: the layout is also used to place the
  // bubble on its own.
  const W = Number.isFinite(size?.width) ? size.width : SCENE_W
  const H = (Number.isFinite(size?.height) ? size.height : SCENE_H / 2) * 2
  const scale = orcaScaleFor(size)
  const deskTop = Math.round(H * 0.8)
  const orcaH = ORCA_H * scale
  return {
    scale,
    desk: { top: deskTop, left: Math.max(2, Math.round(W * 0.02)), right: W - Math.max(2, Math.round(W * 0.02)), thickness: Math.max(2, Math.round(H * 0.05)) },
    orca: {
      // Clamped so a narrow scene cannot push the creature off the right edge.
      x: Math.max(0, Math.min(Math.round(W * 0.17), W - ORCA_W * scale)),
      // Seated *behind* the desk: the furniture overlaps the last pixels of the
      // belly, which is what makes it look like it is sitting at the desk
      // rather than hovering above it.
      y: Math.max(2, deskTop - orcaH + Math.max(1, Math.round(H * 0.03))),
      width: ORCA_W * scale,
      height: orcaH
    },
    keyboard: { x: Math.round(W * 0.3), y: deskTop - Math.max(3, Math.round(H * 0.05)), width: Math.round(W * 0.28), height: Math.max(3, Math.round(H * 0.05)) },
    books: { x: Math.round(W * 0.68), y: deskTop - Math.max(8, Math.round(H * 0.2)), width: Math.round(W * 0.16), height: Math.max(8, Math.round(H * 0.2)) },
    phone: { x: Math.round(W * 0.015), y: deskTop - Math.max(9, Math.round(H * 0.19)), width: Math.max(8, Math.round(W * 0.115)), height: Math.max(9, Math.round(H * 0.19)) },
    document: { x: Math.round(W * 0.32), y: deskTop - Math.max(8, Math.round(H * 0.2)), width: Math.round(W * 0.36), height: Math.max(8, Math.round(H * 0.2)) },
    // A heads-up panel showing the text being typed. Upper right, because the
    // creature owns the left half of the scene and a window over the desk
    // covers it.
    // The whole outdoors, when there is no room around it.
    nature: {
      x: 0,
      y: 0,
      width: W,
      // The whole scene: the ground runs to the bottom, so the desk stands on it.
      height: H
    },
    // The window on the back wall. Drawn first, so the orca and the desk stand
    // in front of it.
    sky: {
      x: Math.round(W * 0.4),
      y: Math.round(H * 0.05),
      width: Math.round(W * 0.57),
      height: Math.max(10, Math.round(H * 0.58))
    },
    window: {
      // On the wall at the top left. Over the sky it sat across the arc the sun
      // and moon travel, and covered whichever of them happened to be up.
      x: Math.round(W * 0.02),
      y: Math.max(2, Math.round(H * 0.03)),
      width: Math.round(W * 0.3),
      height: Math.max(6, Math.round(H * 0.13))
    },
    // The book the orca is holding: large enough that the turning leaf is
    // legible, which a book the size of the desk stack never was.
    openBook: {
      // In front of the body rather than the head, so the creature still reads
      // as an orca while it holds the book open.
      x: Math.round(W * 0.42),
      y: deskTop - Math.max(10, Math.round(H * 0.28)),
      width: Math.round(W * 0.3),
      height: Math.max(8, Math.round(H * 0.2))
    }
  }
}

/** The point beside the orca's head where a handset is held. */
function earFor(layout) {
  // Against the face. The eye sits at (8, 21) in the 64x40 sprite and the
  // snout is the left edge, so the handset runs from the cheek down past the
  // chin, mostly clear of the body rather than across it.
  return {
    x: layout.orca.x + 7 * layout.scale,
    y: layout.orca.y + 15 * layout.scale,
    scale: layout.scale
  }
}

/**
 * Whether the preview window has a frame in this state.
 *
 * @param {string} kind
 * @param {{ width: number, height: number }} size
 */
export function windowVisible(kind, size) {
  if (kind === 'sleep') return false
  const area = layoutFor(size).window
  return area.width >= 14 && area.height >= 6
}

/**
 * Build the pixel grid for one frame.
 *
 * @param {{ kind: string, subagent?: object | null }} work
 * @param {number} frame
 * @param {{ size?: { width: number, height: number } }} [options]
 * @returns {string[][]}
 */
export function sceneGrid(work, frame, options = {}) {
  const kind = work?.kind ?? 'sleep'
  const size = options.size ?? { width: SCENE_W, height: SCENE_H / 2 }
  const layout = layoutFor(size)
  const tick = mod(frame, CYCLE)
  const grid = canvas(size.width, size.height * 2)
  const sky = options.sky ?? skyState(options.clockMs)

  // --- behind everything --------------------------------------------------
  if (options.scene === 'nature') {
    // No wall and no window: the backdrop *is* the outdoors, so the weather
    // covers the whole scene instead of one pane.
    drawNature(grid, layout.nature, sky, frame, {
      horizon: layout.desk.top - 2,
      trees: Math.max(3, Math.round(size.width / 16))
    })
  } else {
    drawWall(grid, size, layout.desk.top)
    drawWindowView(grid, layout.sky, sky, frame)
  }

  // --- the orca -----------------------------------------------------------
  const rubbing = isRubbingEyes(kind, frame, sky)
  const sleepFor = Number.isFinite(options.sleepFor) ? options.sleepFor : 0
  // Two tails, drawn: the renderer picks one rather than transforming the art.
  const pose = kind === 'sleep' && tailDroopFor(kind, sleepFor) >= 0.5 ? 'sleep' : 'up'
  const orca = orcaWithTail({ pose, sway: tailSwayFor(kind, frame) })
  // Rubbing closes the eyes whatever the pose was doing.
  setEyes(orca, rubbing ? 'closed' : eyeMode(kind, frame))
  // Sleep and thinking bob more slowly than typing; the phone call holds still.
  const bob = kind === 'sleep' ? (tick >= 6 ? layout.scale : 0) : kind === 'calling' ? 0 : tick % 4 === 0 ? layout.scale : 0
  blit(grid, scaleGrid(orca, layout.scale), layout.orca.x, layout.orca.y + bob)

  // --- the desk -----------------------------------------------------------
  drawDesk(grid, layout.desk.top, layout.desk.left, layout.desk.right, layout.desk.thickness)

  // --- what is on the desk, by activity ----------------------------------
  const keyboard = layout.keyboard
  switch (kind) {
    case 'searching':
      // Leafing through a book: the stack stays on the desk and a large open
      // book is held in front, its pages turning.
      drawKeyboard(grid, keyboard.x, keyboard.y, keyboard.width, keyboard.height, -1)
      drawBooks(grid, layout.books.x, layout.books.y, layout.books.width, layout.books.height, false, frame)
      drawOpenBook(grid, layout.openBook.x, layout.openBook.y, layout.openBook.width, layout.openBook.height, frame)
      break
    case 'reading':
      // The same open book, held still while reading.
      drawKeyboard(grid, keyboard.x, keyboard.y, keyboard.width, keyboard.height, -1)
      drawBooks(grid, layout.books.x, layout.books.y, layout.books.width, layout.books.height, false, frame)
      drawOpenBook(grid, layout.openBook.x, layout.openBook.y, layout.openBook.width, layout.openBook.height, 0)
      break
    case 'writing':
      drawDocument(grid, layout.document, frame)
      break
    case 'waiting':
      drawTerminal(grid, keyboard, frame)
      break
    case 'calling':
      // On the telephone: hands off the keyboard entirely.
      drawKeyboard(grid, keyboard.x, keyboard.y, keyboard.width, keyboard.height, -1)
      drawBooks(grid, layout.books.x, layout.books.y, layout.books.width, layout.books.height, false, frame)
      break
    case 'thinking':
      // Hands off the keys while it thinks, with a trail of dots above.
      drawKeyboard(grid, keyboard.x, keyboard.y, keyboard.width, keyboard.height, -1)
      drawBooks(grid, layout.books.x, layout.books.y, layout.books.width, layout.books.height, false, frame)
      drawThoughtDots(grid, layout, frame)
      break
    case 'sleep':
      drawKeyboard(grid, keyboard.x, keyboard.y, keyboard.width, keyboard.height, -1)
      drawBooks(grid, layout.books.x, layout.books.y, layout.books.width, layout.books.height, false, frame)
      break
    default:
      drawKeyboard(grid, keyboard.x, keyboard.y, keyboard.width, keyboard.height, frame)
      drawBooks(grid, layout.books.x, layout.books.y, layout.books.width, layout.books.height, false, frame)
      break
  }

  // The window frame is drawn whenever the preview text may be shown. Text
  // without a frame reads as a stray floating bubble — which is exactly how it
  // was reported.
  if (windowVisible(kind, size)) drawTypingWindow(grid, layout)

  // --- the orca's flippers -------------------------------------------------
  // Drawn after the desk furniture, so they rest *on* it rather than
  // disappearing behind it. The sampled sprite is a side view with no separate
  // limb, so any movement has to come from these.
  const atKeyboard = kind === 'typing' || kind === 'writing' || kind === 'waiting'
  const flipperX = layout.orca.x + Math.round(layout.orca.width * 0.38)
  const flipperY = layout.orca.y + Math.round(layout.orca.height * 0.78)
  const flipperSize = Math.max(2, layout.scale * 3)
  const flipperGap = Math.round(layout.orca.width * 0.17)
  // Whether the handset is up. Exactly one set of flippers is drawn at a time:
  // the pair on the keyboard, or the one holding the telephone. Drawing both
  // gave the orca three hands, which is how it was reported.
  const holding = (Number.isFinite(options.phoneLift) ? options.phoneLift : (kind === 'calling' || kind === 'ringing' ? 1 : 0)) >= 0.2
  if (kind !== 'sleep' && !holding && !(kind === 'calling' || kind === 'ringing')) {
    for (const [offset, phase] of [[0, 0], [flipperGap, 1]]) {
      const down = atKeyboard ? tick % 2 === phase : false
      drawFlipper(grid, flipperX + offset, flipperY - (offset === 0 ? 0 : 4 * layout.scale), flipperSize, down)
    }
  }

  // A flipper up to the face for the night-time rub, drawn with the others so
  // it shares their colour and their size.
  if (rubbing) {
    drawFlipper(grid, layout.orca.x + 9 * layout.scale, layout.orca.y + bob + 15 * layout.scale, flipperSize, false)
  }

  // The telephone is always on the desk, and is lifted for a subagent.
  const ringing = kind === 'ringing'
  const onThePhone = kind === 'calling' || ringing
  const ear = earFor(layout)
  if (ringing) {
    // Shaken, not held still: the telephone is ringing.
    ear.shake = (tick % 4 < 2 ? 1 : -1) * Math.max(1, layout.scale)
  }
  // `phoneLift` is the pickup/hangup animation: 0 on the cradle, 1 at the ear,
  // and whatever is in between while the handset is travelling. Callers that
  // do not animate it get the settled pose.
  const lift = Number.isFinite(options.phoneLift) ? options.phoneLift : onThePhone ? 1 : 0
  ear.lift = lift
  const handset = drawPhone(grid, layout.phone.x, layout.phone.y, layout.phone.width, layout.phone.height, ear)
  if (ringing && lift > 0.5) {
    drawRingArcs(grid, layout.phone.x + Math.round(layout.phone.width / 2), layout.phone.y, layout.scale, frame)
    drawRingArcs(grid, ear.x, ear.y - 4 * layout.scale, layout.scale, frame)
  }

  // On the telephone the orca holds the handset: a flipper runs from the
  // mouthpiece back to the body, drawn over it so the fin reads as gripping.
  if (holding && handset !== undefined) {
    // Anchored at the mouthpiece end of the handset as it is right now, so the
    // fin follows it up and down instead of staying behind at the ear.
    const dx = Math.cos(handset.angle)
    const dy = Math.sin(handset.angle)
    const mouthX = handset.cx - dx * (handset.length / 2)
    const mouthY = handset.cy - dy * (handset.length / 2)
    drawLimb(
      grid,
      Math.round(mouthX),
      Math.round(mouthY + 2 * layout.scale),
      Math.max(2, layout.scale * 2.5),
      8 * layout.scale,
      5 * layout.scale,
      'f'
    )
  }

  // --- effects ------------------------------------------------------------
  if (kind === 'sleep') {
    const s = layout.scale
    for (let index = 0; index < 3; index += 1) {
      const rise = mod(tick + index * 4, CYCLE)
      // Big enough to read from across the room: at two or three pixels a z
      // was a speck.
      const zsize = (4 + index * 2) * s
      // Above the head, on the wall: drawn over the window they were swallowed
      // by the sky.
      const zx = layout.orca.x + (6 + index * 7) * s + Math.floor(rise / 4) * s
      const zy = Math.max(2, layout.orca.y + 10 * s - index * 6 * s - rise * s)
      if (zy + zsize < grid.length && zx + zsize < grid[0].length) drawSleepZ(grid, zx, zy, zsize)
    }
  }

  return grid
}

/** The window above the keyboard, if the scene is wide enough for one. */
function drawTypingWindow(grid, layout) {
  const area = layout.window
  if (area.width < 14 || area.height < 6) return
  drawWindow(grid, area.x, area.y, area.width, area.height)
}

/**
 * Where the typing window's text goes, in terminal-cell coordinates, and how
 * much of it fits.
 *
 * @param {{ width: number, height: number }} size
 */
export function previewArea(size) {
  const layout = layoutFor(size)
  const area = layout.window
  if (area.width < 14 || area.height < 6) return null
  return {
    row: Math.floor(area.y / 2) + 1,
    col: area.x + 2,
    width: Math.max(1, area.width - 4),
    rows: Math.max(1, Math.min(3, Math.floor(area.height / 2) - 2))
  }
}

/**
 * Wrap the tail of some text to a cell budget.
 *
 * The tail is what matters — it is what is being typed right now — so the
 * beginning is dropped rather than the end.
 *
 * @param {string} text
 * @param {number} width cells per line
 * @param {number} rows how many lines fit
 * @returns {string[]}
 */
export function wrapPreview(text, width, rows) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length === 0 || rows <= 0) return []
  const characters = [...clean]
  // A generous tail: enough that the wrapping below always fills `rows` lines.
  const tail = characters.slice(-(width * rows + width))
  const lines = []
  let line = ''
  let used = 0
  for (const character of tail) {
    const cellWidth = displayWidth(character)
    if (used + cellWidth > width && line.length > 0) {
      lines.push(line)
      line = ''
      used = 0
    }
    line += character
    used += cellWidth
  }
  if (line.length > 0) lines.push(line)
  return lines.slice(-rows)
}

/** A small trail of thought dots above the orca's head. */
function drawThoughtDots(grid, layout, frame) {
  const s = layout.scale
  const dots = 1 + mod(Math.floor(frame / 2), 3)
  for (let index = 0; index < dots; index += 1) {
    const dx = layout.orca.x + layout.orca.width - 10 * s + index * 4 * s
    const dy = Math.max(0, layout.orca.y - 4 * s)
    rect(grid, dx, dy, dx + s - 1, dy + s - 1, 'o')
  }
}

/** The document being written: a sheet that gains a line as the pen moves. */
function drawDocument(grid, area, frame) {
  const { x, y, width, height } = area
  rect(grid, x, y, x + width - 1, y + height - 1, 'p')
  rect(grid, x, y, x + width - 1, y, 'o')
  rect(grid, x, y, x, y + height - 1, 'o')
  rect(grid, x + width - 1, y, x + width - 1, y + height - 1, 'o')
  const lines = 1 + mod(Math.floor(frame / 2), Math.max(1, height - 3))
  for (let index = 0; index < lines; index += 1) {
    const ly = y + 1 + index
    if (ly > y + height - 2) break
    rect(grid, x + 2, ly, x + width - 3, ly, 'K')
  }
}

/** A terminal window with a blinking cursor, for a command that is running. */
function drawTerminal(grid, area, frame) {
  const { x, y, width, height } = area
  rect(grid, x, y, x + width - 1, y + height - 1, 'k')
  rect(grid, x, y, x + width - 1, y, 'K')
  const line = Math.max(2, height - 3)
  rect(grid, x + 2, line, x + width - 3, line, 'o')
  const span = Math.max(1, width - 6)
  const cursorX = x + 2 + mod(Math.floor(frame / 2), span)
  rect(grid, x + 2, line + 2, cursorX, line + 2, 'K')
  if (mod(frame, 4) < 2) rect(grid, cursorX + 1, line + 2, cursorX + 1, line + 3, 'a')
}

/**
 * Pack a pixel grid into terminal cells, two pixel rows per cell.
 *
 * @param {string[][]} grid
 * @param {Record<string, string>} palette
 * @returns {{ text: string, sgr: string }[][]}
 */
export function cellsFromGrid(grid, palette) {
  const width = grid[0].length
  const cells = []
  for (let y = 0; y + 1 < grid.length; y += 2) {
    const row = []
    for (let x = 0; x < width; x += 1) {
      const top = grid[y][x]
      const bottom = grid[y + 1][x]
      const glyph = GLYPHS[(top === EMPTY ? 0 : 1) + (bottom === EMPTY ? 0 : 2)]
      let cls = EMPTY
      for (const candidate of CLASS_ORDER) {
        if (top === candidate || bottom === candidate) {
          cls = candidate
          break
        }
      }
      const key = CLASS_KEY[cls]
      const sgr = glyph === ' ' || key === undefined ? '' : (palette?.[key] ?? '')
      row.push({ text: glyph, sgr })
    }
    cells.push(row)
  }
  return cells
}

/** Render one cell row to an ANSI string, merging runs of equal style. */
export function renderCells(row) {
  let out = ''
  let current = null
  let buffer = ''
  const flush = () => {
    if (buffer.length === 0) return
    out += current === '' || current === null ? buffer : `\u001b[${current}m${buffer}\u001b[0m`
    buffer = ''
  }
  for (const cell of row) {
    const sgr = cell.sgr ?? ''
    if (sgr !== current) {
      flush()
      current = sgr
    }
    buffer += cell.text
  }
  flush()
  return out
}

/**
 * Where the bubble's text lines go, in terminal-cell coordinates.
 *
 * @param {number} lines
 * @param {string[]} texts
 * @param {{ width?: number, height?: number }} [size]
 */
export function bubbleLayout(lines, texts, size = {}, layout = null) {
  const list = Array.isArray(texts) ? texts : []
  const text = list.join('\n')
  const geo = bubbleGeometry(list[0] ?? '', list.slice(1).join('\n'), size, layout)
  const grid = canvas(
    Number.isFinite(size?.width) ? size.width : SCENE_W,
    (Number.isFinite(size?.height) ? size.height : SCENE_H / 2) * 2
  )
  drawBubble(grid, geo.x, geo.y, geo.innerWidth, Math.max(2, lines * 2))
  return {
    grid,
    rows: list.map((line, index) => ({
      row: geo.row + index,
      col: geo.col,
      text: truncate(line, geo.innerWidth, '…')
    }))
  }
}

/**
 * How many rows of the *message* the bubble shows before it starts scrolling.
 * The header sits above these and never scrolls: it is what says who is on the
 * line, so losing it to a long instruction would leave the bubble anonymous.
 */
export const BUBBLE_ROWS = 3

/** Rows in the bubble in total: the pinned header plus the scrolling message. */
export const BUBBLE_TOTAL_ROWS = BUBBLE_ROWS + 1

/**
 * Where the bubble sits and how much text fits, for a given message.
 *
 * The box is sized from the whole message so it does not jump about while the
 * text is still being spoken.
 */
export function bubbleGeometry(header, body, size, layout = null) {
  const sceneW = Number.isFinite(size?.width) ? size.width : SCENE_W
  const sceneH = Number.isFinite(size?.height) ? size.height : SCENE_H / 2
  const geometry = layout ?? layoutFor({ width: sceneW, height: sceneH })
  const widest = [String(header ?? ''), ...String(body ?? '').split('\n')]
    .reduce((max, line) => Math.max(max, displayWidth(line)), 0)
  // Anchored over the orca's head. A speech bubble pinned to the corner of the
  // scene, with its tail pointing at nothing, reads as a stray box floating
  // outside the interface.
  let x = Math.max(1, Math.min(geometry.orca.x - 1, sceneW - 24))
  const y = Math.max(0, Math.min(geometry.orca.y - 2, sceneH * 2 - BUBBLE_TOTAL_ROWS * 2 - 6))
  // Where the bubble and the preview window share rows on a small scene, the
  // bubble moves aside rather than being squeezed: a narrow bubble wraps the
  // message into a column and hides what it is trying to say.
  const hudTop = Math.floor(geometry.window.y / 2)
  const hudBottom = Math.floor((geometry.window.y + geometry.window.height) / 2)
  const bubbleTop = Math.floor(y / 2)
  const sharesRows = bubbleTop <= hudBottom && bubbleTop + BUBBLE_TOTAL_ROWS >= hudTop
  const hudRight = geometry.window.x + geometry.window.width
  if (sharesRows && x < hudRight + 2) x = Math.min(hudRight + 2, Math.max(1, sceneW - 24))
  const room = Math.max(16, Math.min(Math.round(sceneW * 0.55), sceneW - x - 5))
  const innerWidth = Math.max(12, Math.min(room, widest + 2))
  return {
    x,
    y,
    innerWidth,
    rows: BUBBLE_TOTAL_ROWS,
    bodyRows: BUBBLE_ROWS,
    col: x + 2,
    row: Math.floor((y + 1) / 2)
  }
}

/** Wrap plain text to a cell budget, honouring explicit newlines. */
export function wrapAll(text, width) {
  const out = []
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    let used = 0
    for (const character of paragraph) {
      const cellWidth = displayWidth(character)
      if (used + cellWidth > width && line.length > 0) {
        out.push(line)
        line = ''
        used = 0
      }
      line += character
      used += cellWidth
    }
    out.push(line)
  }
  return out
}

/**
 * The lines the bubble is showing on this frame.
 *
 * The message is revealed a character at a time — a telephone call is speech,
 * and speech arrives in pieces — and once it is longer than the bubble the
 * window scrolls to keep the newest words in view, then cycles so the start is
 * not lost either.
 *
 * @returns {{ lines: string[], typing: boolean, total: number }}
 */
export function spokenLines(text, width, rows, frame, options = {}) {
  const raw = String(text ?? '')
  if (raw.length === 0) return { lines: [], typing: false, total: 0 }
  const perFrame = Number.isFinite(options.perFrame) ? options.perFrame : 2.5
  // At least one character, so a message is never invisible on its first frame.
  const revealed = raw.slice(0, Math.min(raw.length, Math.max(1, Math.floor(frame * perFrame))))
  const typing = revealed.length < raw.length
  const wrapped = wrapAll(revealed, Math.max(1, width))
  if (wrapped.length <= rows) return { lines: wrapped, typing, total: wrapped.length }
  const maxStart = wrapped.length - rows
  const start = typing ? maxStart : Math.floor(frame / 6) % (maxStart + 1)
  return { lines: wrapped.slice(start, start + rows), typing, total: wrapped.length }
}

/**
 * Compose one complete scene frame.
 *
 * @param {{ kind: string, subagent?: object | null }} work
 * @param {number} frame
 * @param {{ palette?: Record<string, string>, bubbleLines?: string[] | null, size?: { width: number, height: number } }} [options]
 * @returns {{ cells: { text: string, sgr: string }[][], width: number, height: number }}
 */
export function sceneFrame(work, frame, options = {}) {
  const size = options.size ?? { width: SCENE_W, height: SCENE_H / 2 }
  const sky = options.sky ?? skyState(options.clockMs)
  // The sky is the one colour that changes on its own, so it is folded into the
  // palette rather than baked into the art. A palette that names no sky stays
  // colourless, which is what `--no-color` relies on.
  const palette = { ...(options.palette ?? {}) }
  // The sky is the one group of colours that changes on its own, so they are
  // folded into the palette rather than baked into the art.
  for (const [key, value] of Object.entries(sky.colors.sgr)) {
    if (key in palette) palette[key] = value
  }
  const grid = sceneGrid(work, frame, {
    size,
    phoneLift: options.phoneLift,
    sky,
    scene: options.scene,
    sleepFor: options.sleepFor
  })
  const cells = cellsFromGrid(grid, palette)

  const preview = options.previewText ?? null
  if (
    preview !== null &&
    preview !== undefined &&
    String(preview).length > 0 &&
    windowVisible(work?.kind ?? 'sleep', size)
  ) {
    const area = previewArea(size)
    if (area !== null) {
      const rows = wrapPreview(preview, area.width, area.rows)
      rows.forEach((text, index) => {
        const row = area.row + index
        if (row < 0 || row >= cells.length) return
        let x = area.col
        for (const character of text) {
          const cellWidth = displayWidth(character)
          if (x >= 0 && x < cells[row].length) cells[row][x] = { text: character, sgr: palette.text ?? '' }
          for (let extra = 1; extra < cellWidth; extra += 1) {
            if (x + extra >= 0 && x + extra < cells[row].length) cells[row][x + extra] = { text: '', sgr: '' }
          }
          x += cellWidth
        }
      })
    }
  }

  const given = Array.isArray(options.bubbleLines) ? options.bubbleLines : null
  const header = options.bubbleHeader ?? given?.[0] ?? (typeof options.bubbleText === 'string' ? options.bubbleText.split('\n')[0] : null)
  const body = options.bubbleBody ?? (given !== null ? given.slice(1).join('\n') : (typeof options.bubbleText === 'string' ? options.bubbleText.split('\n').slice(1).join('\n') : ''))
  if (header !== null && header !== undefined && String(header).length > 0) {
    const geo = bubbleGeometry(header, body, size, layoutFor(size))
    const boxGrid = canvas(size.width, size.height * 2)
    drawBubble(boxGrid, geo.x, geo.y, geo.innerWidth, geo.rows * 2)
    const boxCells = cellsFromGrid(boxGrid, palette)
    for (let y = 0; y < boxCells.length && y < cells.length; y += 1) {
      for (let x = 0; x < boxCells[y].length; x += 1) {
        if (boxCells[y][x].text !== ' ') cells[y][x] = boxCells[y][x]
      }
    }

    const put = (row, line) => {
      if (row < 0 || row >= cells.length) return
      let x = geo.col
      for (const character of line) {
        const cellWidth = displayWidth(character)
        if (x >= 0 && x < cells[row].length) cells[row][x] = { text: character, sgr: palette.text ?? '' }
        for (let extra = 1; extra < cellWidth; extra += 1) {
          if (x + extra >= 0 && x + extra < cells[row].length) cells[row][x + extra] = { text: '', sgr: '' }
        }
        x += cellWidth
      }
    }

    // The header identifies who is on the line, so it is pinned; only the
    // message below it is spoken and scrolled.
    put(geo.row, truncate(String(header), geo.innerWidth, '…'))
    const spoken = spokenLines(body, geo.innerWidth, geo.bodyRows, options.speechFrame ?? frame, options.speech)
    spoken.lines.forEach((line, index) => put(geo.row + 1 + index, line))
  }

  return { cells, width: size.width, height: size.height, sky }
}
