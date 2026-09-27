/**
 * The props on the desk: a keyboard, a stack of books and a red telephone.
 *
 * Everything here is composed from a few primitives rather than stored as pixel
 * grids, so each prop can move, open or light up between frames. All
 * coordinates are pixels in the scene grid; the renderer packs two pixel rows
 * into each terminal cell. Sizes are passed in, so the same prop works at any
 * scale.
 *
 * Classes: `.` transparent, `d` desk wood, `D` desk shadow, `k` keyboard deck,
 * `K` keycap, `a` lit key, `r` telephone red, `R` telephone shadow, `p` page,
 * `q` page in shadow, `Q` deep shadow, `g`/`y`/`c` book covers, `o` dark line,
 * `n` bubble border, `N` bubble fill, `e` window edge, `E` window fill,
 * `t` text.
 *
 * @module dsh-live-working/props
 */

/** A blank pixel canvas. */
export function canvas(width, height) {
  return Array.from({ length: Math.max(1, height) }, () => new Array(Math.max(1, width)).fill('.'))
}

/** Fill an inclusive rectangle. */
export function rect(grid, x0, y0, x1, y1, cls) {
  const height = grid.length
  const width = grid[0].length
  for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x += 1) grid[y][x] = cls
  }
}

/** Draw a rectangle outline. */
export function frame(grid, x0, y0, x1, y1, cls) {
  rect(grid, x0, y0, x1, y0, cls)
  rect(grid, x0, y1, x1, y1, cls)
  rect(grid, x0, y0, x0, y1, cls)
  rect(grid, x1, y0, x1, y1, cls)
}

/** Draw a ring of whole cells, for a dial. */
export function ring(grid, cx, cy, radius, cls) {
  const r = Math.max(1, Math.round(radius))
  const inner = (r - 1) * (r - 1)
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const d = dx * dx + dy * dy
      if (d > r * r || d < inner) continue
      const px = cx + dx
      const py = cy + dy
      if (py < 0 || py >= grid.length || px < 0 || px >= grid[0].length) continue
      grid[py][px] = cls
    }
  }
}

/** Copy a grid onto a canvas at an offset, optionally only onto empty pixels. */
export function blit(target, source, dx, dy, only) {
  const height = target.length
  const width = target[0].length
  for (let y = 0; y < source.length; y += 1) {
    for (let x = 0; x < source[y].length; x += 1) {
      const ch = source[y][x]
      if (ch === '.') continue
      const tx = x + dx
      const ty = y + dy
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue
      if (only !== undefined && !only(target[ty][tx])) continue
      target[ty][tx] = ch
    }
  }
}

/** The desk: a top surface, a darker front edge, and two legs. */
export function drawDesk(grid, top, left, right, thickness) {
  const height = grid.length
  const slab = Math.max(2, thickness)
  rect(grid, left, top, right, top + slab - 1, 'd')
  rect(grid, left, top + slab, right, top + slab + 2, 'D')
  const legTop = top + slab + 3
  if (legTop < height) {
    const legWidth = Math.max(2, Math.round((right - left) * 0.04))
    rect(grid, left + 3, legTop, left + 3 + legWidth, height - 1, 'D')
    rect(grid, right - 3 - legWidth, legTop, right - 3, height - 1, 'D')
  }
}

/**
 * A keyboard lying flat on the desk, seen from the front and slightly above.
 *
 * Drawn as a **trapezoid**: the far edge is narrower than the near edge, and
 * the rows of keycaps shrink towards the back. A plain rectangle reads as a
 * picture of a keyboard pasted onto the desk rather than an object on it.
 *
 * `phase` sweeps which keys are lit; a negative phase leaves the deck alone,
 * for the states where the orca has its hands off it.
 */
export function drawKeyboard(grid, x, y, width, height, phase) {
  // A small dark bar. An earlier version drew a perspective deck with rows of
  // keycaps, which at this size was a grey mass that read as neither a
  // keyboard nor anything else; a plain slab on the desk is clearer.
  const h = Math.max(2, height)
  rect(grid, x, y, x + width - 1, y + h - 1, 'k')
  rect(grid, x, y, x + width - 1, y, 'K')
  rect(grid, x, y + h - 1, x + width - 1, y + h - 1, 'D')
  // A single travelling highlight, so a keyboard that is being used still
  // looks alive without drawing keys.
  void phase
}

/**
 * A pectoral flipper, drawn over the orca's shoulder.
 *
 * The sampled sprite is a side view with no separate limb, so a flipper that
 * moves has to be drawn: the reference artwork cannot animate something it does
 * not depict.
 *
 * @param {number} size scale in pixels
 * @param {boolean} down whether the tip is on the keys
 */
export function drawFlipper(grid, x, y, size, down, cls = 'f') {
  const s = Math.max(1, size)
  // Deliberately stubby. A longer reach reads as a spindly arm rather than a
  // pectoral fin.
  drawLimb(grid, x, y, s, 2 * s, (down ? 2 : 1) * s, cls)
}

/**
 * A thick limb drawn along a direction, from `(x, y)` towards `(x + dx, y + dy)`.
 *
 * @param {number} size thickness scale in pixels
 */
export function drawLimb(grid, x, y, size, dx, dy, cls = 'f') {
  const s = Math.max(1, size)
  const steps = Math.max(1, Math.round(Math.hypot(dx, dy)))
  const thickness = Math.max(2, Math.round(s * 1.3))
  for (let step = 0; step <= steps; step += 1) {
    const cx = x + Math.round((dx * step) / steps)
    const cy = y + Math.round((dy * step) / steps)
    rect(grid, cx, cy, cx + thickness - 1, cy + thickness - 1, cls)
  }
}

/**
 * The little window that shows what the orca is typing.
 *
 * A frame and a dark interior; the text is written by the caller, because
 * glyphs are not pixels.
 *
 * @returns {{ x: number, y: number, width: number, height: number }} the inner
 *   area in pixels where text may be placed
 */
export function drawWindow(grid, x, y, width, height) {
  rect(grid, x, y, x + width - 1, y + height - 1, 'e')
  rect(grid, x + 1, y + 1, x + width - 2, y + height - 2, 'E')
  // Title bar, so it reads as a window rather than a hole.
  rect(grid, x + 1, y + 1, x + width - 2, y + 1, 'e')
  return { x: x + 2, y: y + 2, width: Math.max(1, width - 4), height: Math.max(1, height - 3) }
}

/**
 * An open book: two pages either side of a spine, with shading, and a page
 * part-way through turning.
 *
 * The shading is the point. Real pages are all the same white, but a book is
 * not lit evenly: the gutter between the pages falls into shadow, the leaf
 * away from the light is darker than the one facing it, and a page caught
 * mid-turn is edge-on and darker still. Without that the spread reads as a
 * blank rectangle.
 */
export function drawOpenBook(grid, x, y, width, height, phase) {
  const bottom = y + height - 1
  const top = y + 1
  const pageBottom = bottom - 1
  const spine = x + Math.floor(width / 2)

  rect(grid, x, y, x + width - 1, bottom, 'o')
  // Left page catches the light; the right page is turned away from it.
  rect(grid, x + 1, top, spine - 1, pageBottom, 'p')
  rect(grid, spine + 1, top, x + width - 2, pageBottom, 'q')
  // Gutter shadow either side of the spine.
  rect(grid, spine - 2, top, spine - 1, pageBottom, 'q')
  rect(grid, spine + 1, top, spine + 2, pageBottom, 'Q')
  rect(grid, spine, top, spine, pageBottom, 'o')
  // The block of pages under the spread.
  rect(grid, x + 1, bottom, x + width - 2, bottom, 'Q')

  const half = Math.max(2, Math.floor((width - 3) / 2))
  const steps = 6
  const step = ((Math.trunc(phase) % steps) + steps) % steps
  const turning = step < steps / 2 ? 'q' : 'p'
  if (step < steps / 2) {
    // Lifting off the right-hand side and folding towards the spine: the leaf
    // is edge-on, so it is the darkest thing on the spread.
    const fold = Math.round((half * step * 2) / steps)
    const edge = spine + half - fold
    rect(grid, edge, top, spine + half, pageBottom, 'q')
    rect(grid, edge, top, spine + half, top, 'o')
    rect(grid, edge, top, edge, pageBottom, 'Q')
  } else {
    // Landing on the left, widening away from the spine, picking the light up
    // as it flattens.
    const grow = Math.round((half * (step - steps / 2) * 2) / steps)
    rect(grid, spine - grow, top, spine, pageBottom, turning)
    rect(grid, spine - grow, top, spine, top, 'o')
    rect(grid, spine - grow, top, spine - grow, pageBottom, 'Q')
  }
}

/** A stack of closed books. `open` puts an open, page-turning book on top. */
export function drawBooks(grid, x, y, width, height, open, phase) {
  const covers = ['g', 'y', 'c']
  const thickness = Math.max(2, Math.floor((height - 1) / 3))
  let cursor = y + height - 1
  for (let index = 0; index < 3; index += 1) {
    const bottom = cursor
    const top = Math.max(y, cursor - thickness + 1)
    rect(grid, x, top, x + width - 1, bottom, covers[index])
    rect(grid, x, top, x + width - 1, top, 'o')
    // Page block on the fore edge, with the bottom book in shadow.
    rect(grid, x + width - 2, top + 1, x + width - 1, bottom, index === 0 ? 'Q' : 'p')
    cursor = top - 1
  }
  if (open) drawOpenBook(grid, x, y - Math.max(5, height - 4), width, Math.max(4, thickness + 2), phase)
}

/**
 * A handset: a bar with a bulb at each end, drawn at an angle.
 *
 * The angle is what makes the pickup readable. Snapping the handset from lying
 * flat to standing at the ear is a teleport; rotating it there is an action.
 *
 * @param {number} angle radians, 0 being horizontal with the earpiece right
 */
export function drawHandset(grid, cx, cy, length, thickness, angle) {
  const t = Math.max(1, Math.round(thickness))
  const steps = Math.max(2, Math.round(length))
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  for (let index = 0; index <= steps; index += 1) {
    const along = (index / steps - 0.5) * length
    const px = Math.round(cx + dx * along - (t - 1) / 2)
    const py = Math.round(cy + dy * along - (t - 1) / 2)
    rect(grid, px, py, px + t - 1, py + t - 1, 'r')
  }
  // Earpiece and mouthpiece: bulbs at either end.
  const bulb = Math.max(t, Math.round(t * 1.6))
  for (const direction of [-1, 1]) {
    const ex = Math.round(cx + dx * direction * (length / 2))
    const ey = Math.round(cy + dy * direction * (length / 2))
    rect(grid, ex - Math.floor(bulb / 2), ey - Math.floor(bulb / 2), ex + Math.floor(bulb / 2), ey + Math.floor(bulb / 2), 'r')
  }
}

/**
 * A red telephone on its cradle, with the handset anywhere between resting and
 * held to the ear.
 *
 * `at.lift` runs 0 (lying on the cradle) to 1 (at the ear); everything between
 * is the handset on its way up or down. The cord follows whichever end is the
 * mouthpiece at that moment.
 *
 * @param {{ x: number, y: number, scale: number, lift?: number, shake?: number } | null} at
 */
export function drawPhone(grid, x, y, width, height, at) {
  const s = Math.max(1, Math.round(at?.scale ?? 1))
  const raw = Number.isFinite(at?.lift) ? at.lift : (at === null || at === undefined ? 0 : 1)
  const lift = Math.max(0, Math.min(1, raw))
  // Smoothstep: the handset eases off the cradle and eases onto the ear.
  const eased = lift * lift * (3 - 2 * lift)
  const shake = Number.isFinite(at?.shake) ? Math.round(at.shake) : 0

  // The base: a body with a lit top surface, so it has a front and a top rather
  // than being a red rectangle.
  const baseTop = y + Math.round(height * 0.45)
  const baseH = Math.max(3, y + height - baseTop)
  const capH = Math.max(1, Math.round(baseH * 0.28))
  rect(grid, x, baseTop, x + width - 1, y + height - 1, 'R')
  rect(grid, x, baseTop, x + width - 1, baseTop + capH - 1, 'r')
  rect(grid, x + 1, baseTop + capH, x + width - 2, y + height - 2, 'r')
  rect(grid, x, y + height - 1, x + width - 1, y + height - 1, 'R')

  // The dial, on the front face.
  const dialR = Math.max(1, Math.round(Math.min(width, baseH) * 0.24))
  ring(grid, x + Math.max(2, Math.round(width * 0.3)), baseTop + capH + Math.max(1, Math.round((baseH - capH) * 0.45)), dialR, 'o')

  // The cradle: two nubs the handset rests between.
  const cradleY = Math.max(0, baseTop - Math.max(2, Math.round(baseH * 0.45)))
  rect(grid, x + 1, cradleY, x + 1, baseTop - 1, 'o')
  rect(grid, x + width - 2, cradleY, x + width - 2, baseTop - 1, 'o')

  // Where the handset rests, and where it ends up.
  const restCx = x + (width - 1) / 2
  const restCy = cradleY - 1.5 * s
  const restLength = width - 2
  const run = 6 * s
  const drop = 13 * s
  const earX = at?.x ?? restCx
  const earY = at?.y ?? restCy
  const heldCx = earX - run / 2 + shake
  const heldCy = earY + drop / 2
  const heldLength = Math.hypot(run, drop)

  const cx = restCx + (heldCx - restCx) * eased
  const cy = restCy + (heldCy - restCy) * eased
  const angle = (-Math.atan2(drop, run)) * eased
  const length = restLength + (heldLength - restLength) * eased

  drawHandset(grid, cx, cy, length, Math.max(1, Math.round(2.4 * s)), angle)

  // Cord, from the mouthpiece end down to the base. It slackens as the handset
  // rises, which is most of what sells the movement.
  const dirX = Math.cos(angle)
  const dirY = Math.sin(angle)
  const fromX = Math.round(cx - dirX * (length / 2))
  const fromY = Math.round(cy - dirY * (length / 2))
  const span = Math.max(1, 10 * s)
  for (let step = 0; step <= span; step += 1) {
    const ratio = step / span
    const sag = Math.round(Math.sin(Math.PI * ratio) * (3 * s + Math.round(eased * 3 * s)))
    const px = Math.round(fromX + (x + width - 2 - fromX) * ratio)
    const py = fromY + Math.round((baseTop - fromY) * ratio) + sag
    if (py >= 0 && py < grid.length && px >= 0 && px < grid[0].length) grid[py][px] = 'R'
  }

  return { cx, cy, angle, length }
}

/**
 * A speech bubble with a tail, sized to the text it will hold.
 *
 * @returns {{ x: number, y: number, width: number, height: number }} the inner
 *   area, in pixels, where text may be placed
 */
export function drawBubble(grid, x, y, innerWidth, innerHeight) {
  const x1 = Math.min(grid[0].length - 1, x + innerWidth + 3)
  const y1 = Math.min(grid.length - 1, y + innerHeight + 1)
  rect(grid, x + 1, y, x1 - 1, y, 'n')
  rect(grid, x + 1, y1, x1 - 1, y1, 'n')
  rect(grid, x, y + 1, x, y1 - 1, 'n')
  rect(grid, x1, y + 1, x1, y1 - 1, 'n')
  rect(grid, x + 1, y + 1, x1 - 1, y1 - 1, 'N')
  const tailX = x + 4
  for (let step = 0; step < 3; step += 1) {
    const row = y1 + 1 + step
    if (row >= grid.length) break
    grid[row][Math.max(0, tailX - step)] = 'n'
    grid[row][Math.max(0, tailX - step + 1)] = 'N'
  }
  // Text must stop one cell short of the right border, or the last glyph
  // overwrites it.
  return { x: x + 2, y: y + 1, width: Math.max(1, x1 - x - 4), height: innerHeight }
}

/** A cartoon `z`, rising, for the sleeping pose. */
export function drawSleepZ(grid, x, y, size) {
  rect(grid, x, y, x + size, y, 'z')
  rect(grid, x, y + size, x + size, y + size, 'z')
  for (let step = 0; step <= size; step += 1) {
    const cx = x + size - step
    const cy = y + step
    if (cy < grid.length && cx >= 0 && cx < grid[0].length) grid[cy][cx] = 'z'
  }
}

/**
 * Ringing arcs: two short dashes either side of the telephone, growing and
 * fading, which is what makes a ringing telephone read as ringing rather than
 * as a telephone that happens to be shaking.
 *
 * @param {{ x: number, y: number, size: number, frame: number }} at
 */
export function drawRingArcs(grid, x, y, size, frame) {
  const s = Math.max(1, size)
  const phase = ((Math.trunc(frame) % 8) + 8) % 8
  const reach = 2 + Math.floor(phase / 2)
  for (const direction of [-1, 1]) {
    for (let index = 0; index < 3; index += 1) {
      const cx = x + direction * (reach + index) * 2 * s
      const cy = y - index * s
      if (cy < 0 || cy >= grid.length || cx < 0 || cx >= grid[0].length) continue
      rect(grid, cx, cy, cx, cy + s, 'a')
    }
  }
}
