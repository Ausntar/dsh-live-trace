/**
 * What is happening outside the window.
 *
 * The world keeps its own clock: **one in-game minute passes per real second**,
 * so a full day takes twenty-four real minutes and there is always something
 * moving up there. Time and weather are both pure functions of the clock, so
 * two viewers watching the same session see the same sky.
 *
 * @module dsh-live-working/sky
 */

/** Minutes in an in-game day. */
export const MINUTES_PER_DAY = 1440

/** In-game minutes per real second. */
export const MINUTES_PER_SECOND = 1

/** Weather the sky can be in. */
export const WEATHER = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow']

/** In-game minutes each spell of weather lasts. */
export const WEATHER_MINUTES = 180

/**
 * The in-game clock, in minutes since midnight.
 *
 * Derived from the wall clock rather than from process start, so the world does
 * not reset every time the command does.
 *
 * @param {number} [realMs]
 * @returns {number} 0 .. 1439
 */
export function gameMinutesAt(realMs = Date.now()) {
  const seconds = Math.floor((Number.isFinite(realMs) ? realMs : Date.now()) / 1000) * MINUTES_PER_SECOND
  return ((seconds % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/** `06:05` for the corner of the window. */
export function clockLabel(minutes) {
  const total = Math.floor(minutes)
  const hours = Math.floor(total / 60) % 24
  const mins = total % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

/** Sky keyframes through the day: in-game minute, then colour. */
const SKY_KEYS = [
  [0, [10, 12, 30]],
  [270, [18, 22, 52]],
  [330, [58, 52, 96]],
  [390, [168, 108, 108]],
  [435, [240, 150, 92]],
  [510, [124, 178, 238]],
  [660, [104, 182, 246]],
  [840, [112, 186, 244]],
  [990, [140, 176, 226]],
  [1050, [250, 152, 88]],
  [1125, [196, 92, 84]],
  [1200, [72, 58, 108]],
  [1290, [24, 26, 58]],
  [1440, [10, 12, 30]]
]

/** Interpolate the two keyframes either side of `minutes`. */
export function skyRgbAt(minutes) {
  const at = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  for (let index = 1; index < SKY_KEYS.length; index += 1) {
    const [endMinute, endRgb] = SKY_KEYS[index]
    if (at > endMinute) continue
    const [startMinute, startRgb] = SKY_KEYS[index - 1]
    const span = endMinute - startMinute
    const t = span <= 0 ? 0 : (at - startMinute) / span
    return [
      Math.round(startRgb[0] + (endRgb[0] - startRgb[0]) * t),
      Math.round(startRgb[1] + (endRgb[1] - startRgb[1]) * t),
      Math.round(startRgb[2] + (endRgb[2] - startRgb[2]) * t)
    ]
  }
  return SKY_KEYS[SKY_KEYS.length - 1][1]
}

/**
 * The nearest xterm-256 colour for an RGB triple.
 *
 * The 6x6x6 cube at 16..231 is coarse but it is the right shape for a sky: it
 * has the blues, and it is a dozen lines rather than a lookup table.
 */
export function xterm256(r, g, b) {
  const step = (value) => Math.max(0, Math.min(5, Math.round((value / 255) * 5)))
  return 16 + 36 * step(r) + 6 * step(g) + step(b)
}

/**
 * How much light the weather takes out of the sky.
 *
 * Rain looks wrong under a clear blue sky: overcast is the whole point of it.
 */
const WEATHER_DIM = { clear: 1, cloudy: 0.82, rain: 0.62, storm: 0.45, fog: 0.72, snow: 0.78 }

/**
 * The sky colour, dimmed by whatever the weather is doing.
 *
 * @param {number} minutes
 * @param {{ kind: string, intensity: number } | null} [weather]
 */
export function skyRgbFor(minutes, weather = null) {
  const [r, g, b] = skyRgbAt(minutes)
  if (weather === null || weather === undefined) return [r, g, b]
  const floor = WEATHER_DIM[weather.kind] ?? 1
  const factor = 1 - (1 - floor) * Math.max(0, Math.min(1, weather.intensity))
  return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)]
}

/** The sky colour as a raw SGR parameter string. */
export function skySgrAt(minutes, weather = null) {
  const [r, g, b] = skyRgbFor(minutes, weather)
  return `38;5;${xterm256(r, g, b)}`
}

/** A 4x4 ordered-dither matrix. Two colours and this makes a gradient. */
export const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
]

/** Is the dither cell at (x, y) dark or light, for a blend of 0..1? */
export function ditherAt(x, y, blend) {
  return (BAYER[((y % 4) + 4) % 4][((x % 4) + 4) % 4] + 0.5) / 16 < blend
}

/**
 * Every colour the window paints with, derived from one sky colour.
 *
 * The sky is never one flat colour: it is darker overhead and lighter towards
 * the horizon, and at dawn and dusk the horizon goes warm while the top stays
 * cold. Two colours and an ordered dither are enough to draw that — a terminal
 * has no alpha, but it does have a grid.
 *
 * @param {number} minutes
 * @param {{ kind: string, intensity: number } | null} [weather]
 */
export function skyColors(minutes, weather = null, sgr = (rgb) => `38;5;${xterm256(...rgb)}`) {
  const base = skyRgbFor(minutes, weather)
  const scale = (factor) => base.map((channel) => Math.max(0, Math.min(255, Math.round(channel * factor))))

  // The room is lit by the window, so its walls follow the sky. A fixed mid
  // grey made midnight look like noon indoors: a great slab of light grey next
  // to a black sky.
  const brightness = skyBrightness(base)
  const light = Math.max(0.16, Math.min(1, brightness / 520))
  const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * t))
  const dim = (rgb, factor) => rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel * factor))))
  // Fog is a haze: the sky's own colour lifted towards white, not a grey slab.
  // A fixed light grey read as a solid band, which is what made it shout.
  const fog = mix(base, [235, 238, 242], 0.34)
  const wall = mix([42, 45, 58], [181, 176, 166], light)
  const wallShade = dim(wall, 0.74)
  const skirting = dim(wall, 0.5)
  const floor = dim(wall, 0.26)
  const low = scale(1.2)
  const phase = phaseAt(minutes)
  if (phase === 'dawn' || phase === 'dusk') {
    // The horizon burns while the top of the sky stays cold.
    low[0] = Math.min(255, low[0] + 45)
    low[2] = Math.max(0, low[2] - 25)
  }
  return {
    top: base,
    low,
    landscape: scale(0.34),
    glow: scale(1.5),
    wall,
    fog,
    sgr: {
      fog: sgr(fog),
      sky: sgr(base),
      skyLow: sgr(low),
      landscape: sgr(scale(0.34)),
      glow: sgr(scale(1.5)),
      wall: sgr(wall),
      wallShade: sgr(wallShade),
      skirting: sgr(skirting),
      floor: sgr(floor)
    }
  }
}

/** How bright the sky is, 0 (black) to 765 (white). */
export function skyBrightness(rgb) {
  return rgb[0] + rgb[1] + rgb[2]
}

/** Where the day is: `night`, `dawn`, `day` or `dusk`. */
export function phaseAt(minutes) {
  const at = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  if (at < 300 || at >= 1260) return 'night'
  if (at < 480) return 'dawn'
  if (at < 1020) return 'day'
  if (at < 1200) return 'dusk'
  return 'night'
}

/**
 * The sun or the moon, as a position across the window.
 *
 * The sun is up from 06:00 to 18:00 and the moon takes the other half, so there
 * is always exactly one body in the sky — and it always rises on the left and
 * sets on the right.
 *
 * @returns {{ body: 'sun' | 'moon', x: number, y: number }}
 */
export function celestialAt(minutes) {
  const at = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const day = at >= 360 && at < 1080
  const t = day ? (at - 360) / 720 : (((at - 1080 + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 720)
  return {
    body: day ? 'sun' : 'moon',
    x: t,
    // A shallow arc: high at the middle of its shift, on the sill at the ends.
    y: Math.sin(Math.PI * t)
  }
}

/** A stable pseudo-random number in [0, 1) from an integer. */
export function hash(value) {
  let x = Math.imul(Math.trunc(value) ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/**
 * The weather right now.
 *
 * Each spell lasts `WEATHER_MINUTES` and is picked from the spell's number, so
 * the sky changes on its own without a random number generator and without
 * disagreeing between two viewers. It fades in and out at the edges so weather
 * does not snap on.
 *
 * @returns {{ kind: string, intensity: number, spell: number }}
 */
export function weatherAt(minutes) {
  const at = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const spell = Math.floor(at / WEATHER_MINUTES)
  const into = at - spell * WEATHER_MINUTES
  const index = Math.floor(hash(spell * 7919) * WEATHER.length) % WEATHER.length
  let kind = WEATHER[index]
  const phase = phaseAt(at)
  // Snow is the same weather as rain, one temperature away.
  if (kind === 'snow' && phase !== 'night') kind = 'rain'
  if (kind === 'rain' && phase === 'night') kind = 'snow'

  // Fade in over the first, and out over the last, eighth of the spell.
  const edge = WEATHER_MINUTES / 8
  const intensity = Math.max(0, Math.min(1, Math.min(into, WEATHER_MINUTES - into) / edge))
  return { kind, intensity, spell }
}

/**
 * Everything the window needs, from one reading of the clock.
 *
 * @param {number} [realMs]
 */
export function skyState(realMs = Date.now()) {
  const minutes = gameMinutesAt(realMs)
  const weather = weatherAt(minutes)
  const celestial = celestialAt(minutes)
  const rgb = skyRgbFor(minutes, weather)
  return {
    minutes,
    clock: clockLabel(minutes),
    phase: phaseAt(minutes),
    weather,
    celestial,
    rgb,
    colors: skyColors(minutes, weather),
    sgr: `38;5;${xterm256(...rgb)}`
  }
}

/* ------------------------------------------------------------------ *
 * Painting it
 * ------------------------------------------------------------------ */

import { canvas, rect } from './props.js'

/** Star positions are stable for a given night, not re-rolled every frame. */
function starAt(index, width, height) {
  return {
    x: Math.floor(hash(index * 3 + 11) * width),
    y: Math.floor(hash(index * 7 + 29) * Math.max(1, height - 2))
  }
}

/** A disc, as an ellipse of whole cells. */
function disc(grid, cx, cy, radius, cls) {
  const r = Math.max(1, Math.round(radius))
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > r * r) continue
      const px = cx + dx
      const py = cy + dy
      if (py < 0 || py >= grid.length || px < 0 || px >= grid[0].length) continue
      grid[py][px] = cls
    }
  }
}

/**
 * The wall the window is set into.
 *
 * Without it the scene floats on whatever the terminal's background happens to
 * be, and anything drawn outside the window — the sleeping `z`s, most of all —
 * has nothing to be read against.
 *
 * @param {{ width: number, height: number }} size in pixels
 * @param {number} deskTop the y of the desk, below which the floor starts
 */
export function drawWall(grid, size, deskTop) {
  const width = grid[0].length
  const wallBottom = Math.max(1, Math.min(grid.length - 1, deskTop + 2))
  rect(grid, 0, 0, width - 1, wallBottom, 'W')
  // Faint vertical paper stripes, so a large flat area is not dead flat.
  for (let x = 3; x < width; x += 9) {
    for (let y = 0; y <= wallBottom; y += 1) grid[y][x] = 'V'
  }
  // Skirting board along the bottom, where the wall meets the floor.
  const skirtingTop = Math.max(0, deskTop - 3)
  rect(grid, 0, skirtingTop, width - 1, deskTop, 'V')
  // Floor, so the desk stands on something.
  if (deskTop + 3 < grid.length) rect(grid, 0, deskTop + 3, width - 1, grid.length - 1, 'Y')
}

/**
 * The view through the window.
 *
 * Drawn back to front: sky, stars, the sun or moon, clouds, then whatever is
 * falling out of them. The frame and its mullions go on last so they cut across
 * everything, which is what makes it read as a window rather than a picture.
 *
 * @param {{ x: number, y: number, width: number, height: number }} area in pixels
 * @param {ReturnType<typeof skyState>} sky
 * @param {number} frame
 */
/**
 * A filled ellipse, clipped to `maxY` so a cloud can have a flat bottom.
 *
 * `disc` draws a circle; a cumulus cloud is three overlapping ellipses and a
 * flat underside, which is what makes it read as a cloud rather than a bar.
 */
function ellipse(view, cx, cy, rx, ry, cls, maxY = Infinity) {
  const ax = Math.max(0.5, rx)
  const ay = Math.max(0.5, ry)
  const x0 = Math.floor(cx - ax)
  const x1 = Math.ceil(cx + ax)
  const y0 = Math.floor(cy - ay)
  const y1 = Math.ceil(cy + ay)
  for (let py = y0; py <= y1; py += 1) {
    if (py < 0 || py >= view.length || py > maxY) continue
    for (let px = x0; px <= x1; px += 1) {
      if (px < 0 || px >= view[0].length) continue
      const nx = (px - cx) / ax
      const ny = (py - cy) / ay
      if (nx * nx + ny * ny > 1) continue
      view[py][px] = cls
    }
  }
}

/** A cumulus: a wide base, two bumps, and a flat bottom. */
function cloudBlob(view, cx, cy, width, height) {
  const base = Math.round(cy + height * 0.45)
  ellipse(view, cx, base - height * 0.2, width * 0.5, height * 0.36, 'L', base)
  ellipse(view, cx - width * 0.22, base - height * 0.42, width * 0.28, height * 0.3, 'L', base)
  ellipse(view, cx + width * 0.24, base - height * 0.34, width * 0.24, height * 0.26, 'L', base)
}

/** The far hills, as a fraction of the pane's height at a given column. */
function ridgeAt(column, width) {
  const x = width <= 1 ? 0 : column / (width - 1)
  return (
    0.7 +
    0.13 * Math.sin(x * Math.PI * 2.3 + 0.7) +
    0.06 * Math.sin(x * Math.PI * 5.1 + 2.1) +
    0.03 * Math.sin(x * Math.PI * 11.4 + 4.2)
  )
}

/* ------------------------------------------------------------------ *
 * Painting the sky, on whatever canvas is handed over
 * ------------------------------------------------------------------ */

/** Gradient sky, stars, and the sun or moon with its halo. */
export function paintSkyBase(view, sky, frame) {
  const innerW = view[0].length
  const innerH = view.length

  // The sky: darker overhead, lighter towards the horizon, with the two colours
  // dithered together so the change is gradual rather than banded.
  for (let row = 0; row < innerH; row += 1) {
    const blend = innerH <= 1 ? 0 : row / (innerH - 1)
    for (let column = 0; column < innerW; column += 1) {
      view[row][column] = ditherAt(column, row, blend) ? 'H' : 'S'
    }
  }

  // Only when the sky is actually dark. Keying off the phase put white dots in
  // a bright orange dawn.
  const dark = skyBrightness(sky.rgb ?? skyRgbFor(sky.minutes, sky.weather)) < 200
  if (dark) {
    const count = Math.floor((innerW * innerH) / 70)
    for (let index = 0; index < count; index += 1) {
      const star = starAt(index, innerW, innerH)
      // A slow twinkle, so the sky is not a static texture.
      if (hash(index * 13 + Math.floor(frame / 24)) < 0.3) continue
      // Two brightnesses: a sky of identical dots looks like a texture.
      view[star.y][star.x] = hash(index * 5) < 0.35 ? 'i' : 'I'
    }
  }

  // Sun or moon, on its arc across the panes — unless the weather is thick
  // enough to hide it, which is what makes heavy weather read as heavy.
  const obscured = { clear: 0, cloudy: 0.2, rain: 0.45, storm: 0.9, fog: 0.8, snow: 0.5 }[sky.weather.kind] ?? 0
  if (obscured * sky.weather.intensity >= 0.5) return

  const body = sky.celestial
  const bx = Math.round(body.x * (innerW - 3)) + 1
  const by = Math.round((1 - body.y) * (innerH - 7)) + 2
  const radius = Math.max(2, Math.round(innerW / 20))

  // A halo, dithered so it fades out rather than stopping dead.
  const halo = radius * 2.4
  // Integer bounds: a fractional loop index reaches the dither matrix as a
  // fractional subscript, which is `undefined`.
  const from = Math.floor(halo)
  for (let py = by - from; py <= by + from; py += 1) {
    for (let px = bx - from; px <= bx + from; px += 1) {
      if (py < 0 || py >= innerH || px < 0 || px >= innerW) continue
      const distance = Math.hypot(px - bx, py - by)
      if (distance <= radius || distance > from) continue
      const strength = 1 - (distance - radius) / (from - radius)
      if (ditherAt(px, py, strength * 0.75)) view[py][px] = 'O'
    }
  }
  // The moon gets the sun's radius: at a third smaller it was a speck.
  disc(view, bx, by, radius, body.body === 'sun' ? 'U' : 'M')
}

/** Cumulus, drifting. */
export function paintClouds(view, sky, frame) {
  const innerW = view[0].length
  const innerH = view.length
  const coverage = { clear: 0, cloudy: 3, rain: 4, storm: 6, fog: 2, snow: 4 }[sky.weather.kind] ?? 0
  const drift = Math.floor(frame / 6)
  for (let index = 0; index < coverage; index += 1) {
    const seed = sky.weather.spell * 31 + index
    const span = 6 + Math.floor(hash(seed) * Math.max(3, innerW / 5))
    const startX = ((Math.floor(hash(seed * 3) * innerW) + drift + index * 9) % (innerW + span * 2)) - span
    const tall = 3 + Math.floor(hash(seed * 7) * 3)
    const cy = 1 + Math.floor(hash(seed * 5) * Math.max(1, innerH / 3))
    cloudBlob(view, startX + span / 2, cy, span, tall)
  }
}

/** Fog and precipitation. */
export function paintWeather(view, sky, frame) {
  const innerW = view[0].length
  const innerH = view.length

  // Fog: a haze gathering towards the bottom of the view. It used to be a dense
  // band over the bottom third, which read as a grey stripe rather than
  // weather. Now it covers a quarter of the pane, is at most half-filled, and
  // thins out as it rises, so it fades into the sky.
  if (sky.weather.kind === 'fog' && sky.weather.intensity > 0.2) {
    const rows = Math.max(1, Math.round((innerH / 4) * sky.weather.intensity))
    const heaviest = 0.46 * sky.weather.intensity
    for (let index = 0; index < rows; index += 1) {
      const row = innerH - 1 - index
      const strength = heaviest * (1 - (index / rows) * 0.75)
      for (let column = 0; column < innerW; column += 1) {
        if (!ditherAt(column, row, strength)) continue
        view[row][column] = 'G'
      }
    }
  }

  const kind = sky.weather.kind
  if (!(kind === 'rain' || kind === 'storm' || kind === 'snow') || sky.weather.intensity <= 0.05) return
  const heavy = kind === 'storm' ? 2 : 1
  // 0.04 of the pane was a downpour of speckle; rain reads better sparse.
  const drops = Math.round(innerW * innerH * 0.012 * sky.weather.intensity * heavy)
  for (let index = 0; index < drops; index += 1) {
    const column = Math.floor(hash(index * 17 + 3) * innerW)
    const speed = kind === 'snow' ? 1 : 3
    const travel = (hash(index * 19 + 5) * (innerH + 8) + Math.floor(frame / speed)) % (innerH + 8)
    const sway = kind === 'snow' ? Math.round(Math.sin((frame + index * 9) / 9) * 1.5) : 0
    // Floored: an array index has to be an integer, and `view[48.7]` is
    // `undefined` — which crashed the viewer on the first storm.
    const px = Math.floor(column + sway)
    const py = Math.floor(travel - 4)
    if (py < 0 || py >= innerH || px < 0 || px >= innerW) continue
    if (kind === 'snow') {
      view[py][px] = 'Z'
    } else {
      // A streak rather than a dot: single pixels at this size read as noise.
      const length = heavy === 2 ? 3 : 2
      for (let step = 0; step < length; step += 1) {
        const row = py + step
        if (row < 0 || row >= innerH) break
        view[row][px] = 'X'
      }
    }
  }
}

/** How far a ridge line deviates from flat, at a given column, in rows. */
function ridgeHeight(column, width, amplitude) {
  return Math.round((ridgeAt(column, width) - 0.7) * amplitude)
}

/** A conifer: a triangle of branches on a short trunk. */
function conifer(view, x, baseY, height) {
  const top = baseY - height
  for (let row = 0; row <= height; row += 1) {
    const y = top + row
    if (y < 0 || y >= view.length) continue
    const half = Math.max(0, Math.round((row / Math.max(1, height)) * (height * 0.36)))
    for (let dx = -half; dx <= half; dx += 1) {
      const px = x + dx
      if (px < 0 || px >= view[0].length) continue
      view[y][px] = 'T'
    }
  }
  for (let row = 1; row <= Math.max(1, Math.round(height * 0.12)); row += 1) {
    const y = baseY + row
    if (y < 0 || y >= view.length) continue
    if (x >= 0 && x < view[0].length) view[y][x] = 'T'
  }
}

/**
 * The whole outdoors: sky from the top of the scene down to the ground, no wall
 * and no window.
 *
 * A room is a frame around a view; this is the view itself, so the same weather
 * covers the whole backdrop instead of being confined to a pane.
 */
export function drawNature(grid, area, sky, frame, options = {}) {
  const { x, y, width, height } = area
  if (width < 8 || height < 10) return

  // Composed on its own canvas and blitted, for the same reason the window is:
  // nothing may spill outside the area it was given.
  const view = canvas(width, height)
  paintSkyBase(view, sky, frame)

  // Where the ground begins. The desk sits just above this, so the horizon
  // lands behind the desk rather than across it.
  const groundTop = options.horizon ?? Math.round(height * 0.8)

  // Two ridges for depth: a far one, then the near ground on top of it. Both
  // run to the bottom of the scene, so the desk stands on ground.
  for (let column = 0; column < width; column += 1) {
    const farTop = groundTop - Math.round(height * 0.1) - ridgeHeight(column, width, height * 0.18)
    for (let row = Math.max(0, farTop); row < height; row += 1) view[row][column] = 'B'
  }
  for (let column = 0; column < width; column += 1) {
    const nearTop = groundTop + ridgeHeight(column + 37, width, height * 0.05)
    for (let row = Math.max(0, nearTop); row < height; row += 1) view[row][column] = 'j'
  }

  const trees = options.trees ?? 9
  for (let index = 0; index < trees; index += 1) {
    const seed = index * 977
    const tx = Math.round(hash(seed) * (width - 1))
    const th = Math.max(4, Math.round(height * (0.1 + hash(seed * 3) * 0.12)))
    conifer(view, tx, groundTop + ridgeHeight(tx + 37, width, height * 0.05), th)
  }

  paintClouds(view, sky, frame)
  paintWeather(view, sky, frame)

  for (let vy = 0; vy < height; vy += 1) {
    for (let vx = 0; vx < width; vx += 1) {
      const cell = view[vy][vx]
      if (cell === '.') continue
      grid[y + vy][x + vx] = cell
    }
  }
}

/* ------------------------------------------------------------------ *
 * The window, which is the same sky seen through an opening
 * ------------------------------------------------------------------ */

export function drawWindowView(grid, area, sky, frame) {
  const { x, y, width, height } = area
  if (width < 6 || height < 6) return

  const innerX = x + 1
  const innerY = y + 1
  const innerW = width - 2
  const innerH = height - 2

  rect(grid, x, y, x + width - 1, y + height - 1, 'S')
  if (innerW < 4 || innerH < 4) return

  // Composed on its own canvas and blitted in afterwards, so a cloud cannot
  // drift out of the opening and wander across the wall.
  const view = canvas(innerW, innerH)
  paintSkyBase(view, sky, frame)
  // The hills the sun sets behind.
  for (let column = 0; column < innerW; column += 1) {
    const top = Math.round(ridgeAt(column, innerW) * (innerH - 1))
    for (let row = Math.max(0, top); row < innerH; row += 1) view[row][column] = 'B'
  }
  paintClouds(view, sky, frame)
  paintWeather(view, sky, frame)

  // Copy the view in, whole cells only.
  for (let vy = 0; vy < innerH; vy += 1) {
    for (let vx = 0; vx < innerW; vx += 1) {
      const cell = view[vy][vx]
      if (cell === '.') continue
      grid[innerY + vy][innerX + vx] = cell
    }
  }

  // Frame and mullions, over the top of all of it.
  const mx = innerX + Math.floor(innerW / 2)
  const my = innerY + Math.floor(innerH / 2)
  rect(grid, mx, innerY, mx, innerY + innerH - 1, 'F')
  rect(grid, innerX, my, innerX + innerW - 1, my, 'F')
  rect(grid, x, y, x + width - 1, y, 'F')
  rect(grid, x, y + height - 1, x + width - 1, y + height - 1, 'F')
  rect(grid, x, y, x, y + height - 1, 'F')
  rect(grid, x + width - 1, y, x + width - 1, y + height - 1, 'F')
}
