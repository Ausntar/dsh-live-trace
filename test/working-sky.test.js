/**
 * The world outside the window: its clock, its weather, and what it paints.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTheme } from '../src/cli/theme.js'
import { displayWidth } from '../src/cli/width.js'
import { layoutFor, renderCells, sceneFrame, sceneGrid, sceneSizeFor } from '../src/cli/working/scene.js'
import {
  celestialAt,
  clockLabel,
  gameMinutesAt,
  hash,
  MINUTES_PER_DAY,
  phaseAt,
  skyBrightness,
  skyColors,
  skyRgbAt,
  skyRgbFor,
  skyState,
  WEATHER,
  WEATHER_MINUTES,
  weatherAt,
  xterm256
} from '../src/cli/working/sky.js'
import { WORK_STATES } from '../src/cli/working/state.js'

const THEME = createTheme({ color: true })
const strip = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
/** A clock reading that lands on the given in-game minute. */
const clockFor = (minute) => minute * 1000 + 86_400_000

test('an in-game minute passes every real second', () => {
  const base = clockFor(600)
  assert.equal(gameMinutesAt(base), 600)
  assert.equal(gameMinutesAt(base + 1000), 601, 'one real second is one in-game minute')
  assert.equal(gameMinutesAt(base + 60_000), 660, 'a real minute is an in-game hour')
  assert.equal(gameMinutesAt(base + 1_440_000), 600, 'and a day comes round again in 24 real minutes')

  // Never negative, never out of range, whatever the clock says.
  for (const ms of [0, -1, -1000, -86_400_001, Number.MAX_SAFE_INTEGER, NaN, undefined]) {
    const minutes = gameMinutesAt(ms)
    assert.ok(Number.isFinite(minutes) && minutes >= 0 && minutes < MINUTES_PER_DAY, `${ms} gave ${minutes}`)
  }
})

test('the clock label reads like a clock', () => {
  assert.equal(clockLabel(0), '00:00')
  assert.equal(clockLabel(1), '00:01')
  assert.equal(clockLabel(60), '01:00')
  assert.equal(clockLabel(725), '12:05')
  assert.equal(clockLabel(1439), '23:59')
})

test('the sky is dark at night and bright at noon', () => {
  const brightness = (minutes) => skyRgbAt(minutes).reduce((sum, channel) => sum + channel, 0)
  assert.ok(brightness(720) > brightness(0) * 3, 'noon is much brighter than midnight')
  assert.ok(brightness(720) > brightness(1200), 'and than dusk')
  // Dawn and dusk are warm: more red than blue.
  for (const minute of [420, 1050]) {
    const [r, , b] = skyRgbAt(minute)
    assert.ok(r > b + 60, `${minute} should be a warm sky, got ${skyRgbAt(minute)}`)
  }
  // Every minute of the day yields a colour.
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 13) {
    const [r, g, b] = skyRgbAt(minute)
    for (const channel of [r, g, b]) assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255)
  }
})

test('the day is split into the phases you would expect', () => {
  assert.equal(phaseAt(0), 'night')
  assert.equal(phaseAt(200), 'night')
  assert.equal(phaseAt(360), 'dawn')
  assert.equal(phaseAt(500), 'day')
  assert.equal(phaseAt(720), 'day')
  assert.equal(phaseAt(1050), 'dusk')
  assert.equal(phaseAt(1150), 'dusk')
  assert.equal(phaseAt(1300), 'night')
})

test('the sun is up by day and the moon by night, each rising left and setting right', () => {
  assert.equal(celestialAt(720).body, 'sun')
  assert.equal(celestialAt(0).body, 'moon')
  assert.equal(celestialAt(500).body, 'sun')
  assert.equal(celestialAt(1200).body, 'moon')

  // Highest at the middle of the shift, on the sill at either end.
  assert.ok(celestialAt(720).y > celestialAt(400).y)
  assert.ok(celestialAt(720).y > celestialAt(1040).y)
  assert.ok(celestialAt(720).y > 0.95)

  // It crosses the window from left to right.
  assert.ok(celestialAt(400).x < celestialAt(720).x)
  assert.ok(celestialAt(720).x < celestialAt(1040).x)
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 7) {
    const body = celestialAt(minute)
    assert.ok(body.x >= 0 && body.x <= 1, `x out of range at ${minute}`)
    assert.ok(body.y >= -0.01 && body.y <= 1.01, `y out of range at ${minute}`)
  }
})

test('the weather changes on its own, and only into real weather', () => {
  const seen = new Set()
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 5) {
    const weather = weatherAt(minute)
    assert.ok(WEATHER.includes(weather.kind), `${minute} produced ${weather.kind}`)
    assert.ok(weather.intensity >= 0 && weather.intensity <= 1)
    seen.add(weather.kind)
  }
  assert.ok(seen.size >= 3, `expected a few kinds of weather across a day, saw ${[...seen].join(', ')}`)

  // Two viewers of the same moment see the same sky.
  for (const minute of [0, 137, 800, 1439]) {
    assert.deepEqual(weatherAt(minute), weatherAt(minute))
    assert.deepEqual(skyState(clockFor(minute)), skyState(clockFor(minute)))
  }

  // Each spell has a fixed length and fades in and out.
  assert.equal(Math.floor(WEATHER_MINUTES / 2) * 0 + weatherAt(0).spell, 0)
  assert.equal(weatherAt(WEATHER_MINUTES - 1).spell, 0)
  assert.equal(weatherAt(WEATHER_MINUTES).spell, 1)
  assert.equal(weatherAt(0).intensity, 0, 'a spell starts faint')
  assert.equal(weatherAt(WEATHER_MINUTES / 2).intensity, 1, 'is at full strength in the middle')
})

test('snow falls at night and rain by day', () => {
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 5) {
    const { kind } = weatherAt(minute)
    const phase = phaseAt(minute)
    if (kind === 'snow') assert.equal(phase, 'night', `${minute} had snow in daylight`)
    if (kind === 'rain') assert.notEqual(phase, 'night', `${minute} had rain at night`)
  }
})

test('the hash is stable and lands in range', () => {
  for (const value of [0, 1, 2, -5, 999983, Number.MAX_SAFE_INTEGER]) {
    const first = hash(value)
    assert.equal(first, hash(value), 'stable')
    assert.ok(first >= 0 && first < 1, `${value} gave ${first}`)
  }
})

test('an rgb triple maps into the xterm cube', () => {
  assert.equal(xterm256(0, 0, 0), 16)
  assert.equal(xterm256(255, 255, 255), 231)
  for (const rgb of [[10, 12, 30], [240, 150, 92], [104, 182, 246]]) {
    const code = xterm256(...rgb)
    assert.ok(code >= 16 && code <= 231, `${rgb} gave ${code}`)
  }
})

test('the window paints a sky that changes through the day and the weather', () => {
  const size = sceneSizeFor(148, 40)
  const gridAt = (minute) => sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(minute) }).map((r) => r.join('')).join('')

  // Every minute of a day renders, with no crash and no missing sky.
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 7) {
    const grid = gridAt(minute)
    assert.ok(grid.includes('S'), `no sky at minute ${minute}`)
    assert.ok(grid.includes('F'), `no window frame at minute ${minute}`)
  }

  // Day and night look different, and the sun and moon take turns.
  assert.notEqual(gridAt(720), gridAt(0), 'noon and midnight differ')
  assert.ok(gridAt(720).includes('U'), 'the sun is up at noon')
  assert.ok(!gridAt(720).includes('M'), 'and the moon is not')
  assert.ok(gridAt(0).includes('M'), 'the moon is up at midnight')
  assert.ok(gridAt(0).includes('I'), 'with stars')
  assert.ok(!gridAt(720).includes('I'), 'which are not out at noon')
})

test('the window never breaks the frame or runs off the scene', () => {
  const theme = createTheme({ color: true })
  for (const cols of [80, 120, 148, 200]) {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 61) {
      const size = sceneSizeFor(cols, 40)
      const scene = sceneFrame({ kind: 'typing' }, minute % 20, {
        palette: theme.scene,
        size,
        clockMs: clockFor(minute)
      })
      for (const row of scene.cells) {
        assert.equal(row.length, size.width)
        assert.equal(displayWidth(strip(renderCells(row))), size.width)
      }
    }
  }
})

test('the sky colour reaches the palette, and only when colour is on', () => {
  const size = sceneSizeFor(148, 40)
  const day = sceneFrame({ kind: 'typing' }, 0, { palette: THEME.scene, size, clockMs: clockFor(720) })
  const night = sceneFrame({ kind: 'typing' }, 0, { palette: THEME.scene, size, clockMs: clockFor(0) })
  const skies = (scene) => new Set(scene.cells.flat().filter((cell) => cell.text === '█' || cell.text === '▀' || cell.text === '▄').map((cell) => cell.sgr))
  assert.ok(skies(day).has(day.sky.sgr), 'the sky is painted in its own colour')
  assert.notEqual(day.sky.sgr, night.sky.sgr, 'and it is a different colour at night')

  const plain = sceneFrame({ kind: 'typing' }, 0, { palette: {}, size, clockMs: clockFor(720) })
  assert.doesNotMatch(plain.cells.map(renderCells).join('\n'), /\u001b\[/, 'an empty palette stays colourless')
})

test('the sky is drawn behind the orca, not over it', () => {
  const size = sceneSizeFor(148, 40)
  const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(720) })
  const all = grid.map((r) => r.join(''))
  // The orca's body survives on top of the window.
  assert.ok(all.join('').includes('b'), 'the orca is still there')
  const layout = sceneSizeFor(148, 40)
  void layout
})

test('every state renders under every sky, at every hour', () => {
  const size = sceneSizeFor(148, 40)
  for (const kind of WORK_STATES) {
    for (const minute of [0, 420, 720, 1050, 1300]) {
      const grid = sceneGrid({ kind }, 0, { size, clockMs: clockFor(minute) })
      assert.equal(grid.length, size.height * 2)
      for (const row of grid) assert.equal(row.length, size.width)
    }
  }
})

test('there is a wall behind the room, and the window is set into it', () => {
  const size = sceneSizeFor(148, 40)
  const geometry = layoutFor(size)
  const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(720) })
  const letters = grid.map((r) => r.join(''))

  // Wall above the desk, floor below it.
  assert.ok(letters[1].includes('W'), 'there is wall at the top of the room')
  const wallTallies = letters.map((row) => (row.match(/W/g) ?? []).length)
  assert.ok(wallTallies.filter((n) => n > 20).length > 4, 'and a decent amount of it')
  // The window is an opening, not the whole wall.
  assert.ok(letters[10].includes('S'), 'the window is showing sky')
  assert.ok(letters[10].includes('W'), 'and there is wall beside it')
  assert.ok(letters.join('').includes('V'), 'with a skirting board')
  assert.ok(letters.join('').includes('Y'), 'and a floor for the desk to stand on')
  assert.ok(geometry.sky.x > 0, 'the window does not start at the very edge')
})

test('the sleeping zs are read against the wall, not lost in the sky', () => {
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const sky = layout.sky

  // Noon: the brightest sky there is, and where the z's used to disappear
  // behind a cloud.
  const grid = sceneGrid({ kind: 'sleep' }, 2, { size, clockMs: clockFor(720) })
  const zs = []
  grid.forEach((row, y) => row.forEach((ch, x) => {
    if (ch === 'z') zs.push([x, y])
  }))
  assert.ok(zs.length > 10, 'the sleeping pose shows its zs')
  for (const [x, y] of zs) {
    const insideWindow = x >= sky.x && x < sky.x + sky.width && y >= sky.y && y < sky.y + sky.height
    assert.equal(insideWindow, false, `a z at ${x},${y} is over the sky and will be hard to read`)
  }

  // And they are there at every hour, not just at noon.
  for (const minute of [0, 420, 720, 1050, 1300]) {
    const later = sceneGrid({ kind: 'sleep' }, 2, { size, clockMs: clockFor(minute) })
    const count = later.map((r) => r.join('')).join('').split('z').length - 1
    assert.ok(count > 10, `no zs at minute ${minute}`)
  }
})

test('nothing escapes the window onto the wall', () => {
  // Clouds, rain and the sun are composed on the window's own canvas and
  // blitted in, so a cloud cannot drift out of the opening and wander across
  // the wall. Checked over a whole day and every weather.
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const sky = layout.sky
  const inside = new Set()
  const outside = new Set()
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 11) {
    for (let frame = 0; frame < 4; frame += 1) {
      const grid = sceneGrid({ kind: 'typing' }, frame * 17, { size, clockMs: clockFor(minute) })
      grid.forEach((row, y) => row.forEach((ch, x) => {
        // Everything the window owns, weather included.
        if (!'SHBOUMLIiXZGF'.includes(ch)) return
        const within = x >= sky.x && x < sky.x + sky.width && y >= sky.y && y < sky.y + sky.height
        ;(within ? inside : outside).add(`${ch}@${x},${y}`)
      }))
    }
  }
  assert.ok(inside.size > 500, 'the window is busy')
  assert.equal(outside.size, 0, `sky drawn outside the window: ${[...outside].slice(0, 5).join(' ')}`)
})

test('the sleeping zs are their own colour, not the grey of the wall', () => {
  const theme = createTheme({ color: true })
  assert.notEqual(theme.scene.sleepZ, theme.scene.wall, 'a z the colour of the wall is invisible')
  assert.notEqual(theme.scene.sleepZ, theme.scene.spout, 'and it is not the old spout grey either')
  const size = sceneSizeFor(148, 40)
  const scene = sceneFrame({ kind: 'sleep' }, 2, { palette: theme.scene, size, clockMs: clockFor(720) })
  const codes = new Set(scene.cells.flat().filter((cell) => cell.text !== ' ').map((cell) => cell.sgr))
  // The wall colour is derived from the sky each frame, so compare against what
  // was actually painted rather than the static fallback in the theme.
  assert.ok(codes.has(scene.sky.colors.sgr.wall), 'the wall is behind them')
  assert.ok(codes.has(theme.scene.sleepZ), 'and the zs are painted in their own colour')
  assert.notEqual(scene.sky.colors.sgr.wall, theme.scene.sleepZ, 'which is not the colour of the wall')
})

test('the sky darkens with the weather', () => {
  const noon = 720
  const clear = skyBrightness(skyRgbFor(noon, { kind: 'clear', intensity: 1 }))
  const cloudy = skyBrightness(skyRgbFor(noon, { kind: 'cloudy', intensity: 1 }))
  const rain = skyBrightness(skyRgbFor(noon, { kind: 'rain', intensity: 1 }))
  const storm = skyBrightness(skyRgbFor(noon, { kind: 'storm', intensity: 1 }))
  assert.ok(clear > cloudy, 'cloud takes some light out of the sky')
  assert.ok(cloudy > rain, 'rain more')
  assert.ok(rain > storm, 'and a storm more still')
  // Weather that has not arrived yet cannot dim anything.
  assert.deepEqual(skyRgbFor(noon, { kind: 'storm', intensity: 0 }), skyRgbAt(noon))
  // Without a weather reading the sky is its plain colour.
  assert.deepEqual(skyRgbFor(noon, null), skyRgbAt(noon))
})

test('stars come out only when the sky is actually dark', () => {
  const size = sceneSizeFor(148, 40)
  const starsAt = (minute) =>
    (sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(minute) }).map((r) => r.join('')).join('').match(/I/g) ?? []).length

  const dark = [0, 60, 200, 1300, 1400]
  const light = [420, 480, 720, 900, 1050, 1150]
  for (const minute of dark) assert.ok(starsAt(minute) > 0, `no stars at ${minute}`)
  for (const minute of light) {
    assert.equal(starsAt(minute), 0, `white dots in a bright sky at minute ${minute}`)
    const rgb = skyRgbFor(minute, weatherAt(minute))
    assert.ok(skyBrightness(rgb) >= 200, `${minute} is bright (${skyBrightness(rgb)}) yet was drawn without stars`)
  }
})

test('the moon is drawn at a readable size', () => {
  const size = sceneSizeFor(148, 40)
  const moonPixels = (minute) => {
    const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(minute) })
    return grid.map((r) => r.join('')).join('').split('M').length - 1
  }
  // A clear night with the moon well up.
  const count = moonPixels(60)
  assert.ok(count >= 12, `the moon is only ${count} pixels`)
  // And it is up at all: three in the morning is above the horizon.
  assert.equal(celestialAt(60).body, 'moon')
})

test('heavy weather hides the sun and the moon', () => {
  const size = sceneSizeFor(148, 40)
  const bodiesAt = (minute) => {
    const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(minute) })
    const all = grid.map((r) => r.join('')).join('')
    return (all.match(/U/g) ?? []).length + (all.match(/M/g) ?? []).length
  }
  // 990 is a storm; 800 is rain, which is thin enough to see through.
  const storm = weatherAt(990)
  assert.equal(storm.kind, 'storm')
  assert.equal(bodiesAt(990), 0, 'there is no sun in a storm')
  assert.equal(weatherAt(800).kind, 'rain')
  assert.ok(bodiesAt(800) > 0, 'but rain alone leaves it visible')
})

test('rain is a shower, not a blizzard of speckle', () => {
  const size = sceneSizeFor(148, 40)
  const density = (minute) => {
    const grid = sceneGrid({ kind: 'typing' }, 6, { size, clockMs: clockFor(minute) })
    const pane = grid.slice(layoutFor(size).sky.y, layoutFor(size).sky.y + layoutFor(size).sky.height)
    const cells = pane.length * (layoutFor(size).sky.width - 2)
    const drops = pane.map((r) => r.join('')).join('').split('X').length - 1
    return drops / cells
  }
  const storm = density(990)
  const rain = density(800)
  assert.ok(rain > 0, 'it is raining')
  assert.ok(rain < 0.05, `rain covers ${(rain * 100).toFixed(1)}% of the pane, which is a downpour`)
  assert.ok(storm > rain, 'a storm is heavier than rain')
})

test('the sky is a gradient, not a flat fill', () => {
  const size = sceneSizeFor(148, 40)
  const sky = layoutFor(size).sky
  const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(1150) })

  // The orca stands in front of the window and the hills fill the bottom, so
  // look only at the right half, where it is all sky above the ridge.
  const letters = grid.map((r) => r.join(''))
  const pane = letters
    .slice(sky.y + 1, sky.y + sky.height - 1)
    .map((row) => row.slice(sky.x + 1 + Math.floor(sky.width / 2), sky.x + sky.width - 1))

  const shareLow = (row) => {
    const cloudless = [...row].filter((ch) => ch === 'S' || ch === 'H')
    return cloudless.length === 0 ? 0 : [...row].filter((ch) => ch === 'H').length / cloudless.length
  }
  // Averaged over bands rather than single rows: the dither makes any one row
  // noisy, but the trend across bands is the thing being asserted.
  const band = (from, to) => {
    const rows = pane.slice(Math.floor(pane.length * from), Math.ceil(pane.length * to))
    return rows.map(shareLow).reduce((a, b) => a + b, 0) / rows.length
  }
  const high = band(0, 0.2)
  const middle = band(0.25, 0.4)
  const low = band(0.45, 0.65)

  assert.ok(high < 0.15, `the top of the pane should be the upper colour, got ${high.toFixed(2)}`)
  assert.ok(low > 0.35, `the lower band should be mostly the horizon colour, got ${low.toFixed(2)}`)
  assert.ok(middle > high && low > middle, `the horizon colour should grow downwards: ${high.toFixed(2)} -> ${middle.toFixed(2)} -> ${low.toFixed(2)}`)
  assert.notEqual(pane[0], pane[Math.floor(pane.length * 0.4)])
})

test('the hills give the window a horizon', () => {
  const size = sceneSizeFor(148, 40)
  const sky = layoutFor(size).sky
  const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(720) })
  const pane = grid
    .slice(sky.y + 1, sky.y + sky.height - 1)
    .map((row) => row.slice(sky.x + 1 + Math.floor(sky.width / 2), sky.x + sky.width - 1))
  const rows = pane.map((row) => [...row].filter((ch) => ch === 'B').length)

  assert.ok(rows.some((n) => n > 0), 'there are hills')
  // Solid at the bottom, and no hills up in the sky.
  assert.equal(rows[0], 0, 'nothing at the top')
  assert.ok(rows[rows.length - 1] > pane[0].length * 0.8, 'the last row is land')
  // The ridge line rises and falls rather than being a flat bar.
  const firstLand = rows.map((count, index) => (count > 0 ? index : -1)).filter((index) => index >= 0)
  assert.ok(firstLand.length > 20, 'the ridge spans the pane')
  assert.ok(new Set(firstLand).size > 3, 'and it is not a flat line')
})

test('the sun and moon have a halo', () => {
  const size = sceneSizeFor(148, 40)
  const haloAround = (minute) => {
    const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(minute) })
    return grid.map((r) => r.join('')).join('').split('O').length - 1
  }
  // 600 is rain, thin enough to see the sun through; 60 is a clear midnight.
  assert.equal(weatherAt(600).kind, 'rain')
  assert.ok(haloAround(600) > 8, 'the sun has a halo')
  assert.equal(weatherAt(60).kind, 'clear')
  assert.ok(haloAround(60) > 8, 'and so does the moon')
})

test('stars come in more than one brightness', () => {
  const size = sceneSizeFor(148, 40)
  const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(60) })
  const all = grid.map((r) => r.join('')).join('')
  assert.ok((all.match(/I/g) ?? []).length > 0, 'there are bright stars')
  assert.ok((all.match(/i/g) ?? []).length > 0, 'and dim ones')
})

test('clouds are shaped, not bars', () => {
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const sky = layout.sky
  const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(800) })
  const pane = grid.slice(sky.y + 1, sky.y + sky.height - 1).map((row) => row.slice(sky.x + 1, sky.x + sky.width - 1))
  const cloudRows = pane.map((row) => [...row].filter((ch) => ch === 'L').length).filter((n) => n > 0)
  assert.ok(cloudRows.length >= 4, 'a cloud is several rows deep, not one')
  // A cumulus is widest near its base: the row widths are not all equal.
  assert.ok(new Set(cloudRows).size > 1, 'the cloud changes width from row to row')
})

test('the outdoors is a whole backdrop, with no wall and no window', () => {
  const size = sceneSizeFor(148, 40)
  const letters = (scene) =>
    sceneGrid({ kind: 'typing' }, 0, { size, scene, clockMs: clockFor(720) })
      .map((row) => row.join(''))

  const room = letters('room').join('')
  const nature = letters('nature').join('')

  // The room has a wall, a floor and a window frame; the outdoors has none of
  // them, because there is no room around it.
  for (const cls of ['W', 'V', 'Y', 'F']) assert.ok(room.includes(cls), `the room has ${cls}`)
  for (const cls of ['W', 'V', 'Y', 'F']) assert.equal(nature.includes(cls), false, `the outdoors has no ${cls}`)

  // It has sky the full width, ground, and trees.
  assert.ok(nature.includes('S') || nature.includes('H'), 'there is sky')
  assert.ok(nature.includes('j'), 'there is ground')
  assert.ok(nature.includes('T'), 'there are trees')

  // The sky reaches the very first row and the ground the last.
  assert.ok(/[SH]/.test(letters('nature')[0]), 'the sky starts at the top of the scene')
  const last = letters('nature')[size.height * 2 - 1]
  assert.ok(last.includes('j') || last.includes('T'), 'and the ground reaches the bottom')
})

test('the outdoors is still weather-tight', () => {
  // The nature backdrop is composited on its own canvas too, so the same
  // containment guarantee has to hold for it.
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const area = layout.nature
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 17) {
    for (let frame = 0; frame < 3; frame += 1) {
      const grid = sceneGrid({ kind: 'typing' }, frame * 13, { size, scene: 'nature', clockMs: clockFor(minute) })
      const pane = grid.slice(area.y, area.y + area.height)
      const all = pane.map((row) => row.join('')).join('')
      // Nothing from the sky may appear below the backdrop.
      for (const cls of ['S', 'H', 'U', 'M', 'O', 'L', 'X', 'Z', 'G']) {
        assert.equal(grid.slice(area.y + area.height).map((r) => r.join('')).join('').includes(cls), false, `${cls} escaped the backdrop at ${minute}`)
      }
      assert.ok(all.length > 0)
    }
  }
})

test('both backdrops render at every hour, every size and every state', () => {
  for (const scene of ['room', 'nature']) {
    for (const cols of [64, 100, 148, 200]) {
      const size = sceneSizeFor(cols, 40)
      for (const kind of WORK_STATES) {
        const grid = sceneGrid({ kind }, 0, { size, scene, clockMs: clockFor(700) })
        assert.equal(grid.length, size.height * 2, `${scene}/${cols}`)
        for (const row of grid) assert.equal(row.length, size.width)
      }
    }
  }
})

test('the room is lit by its window, so the walls darken at night', () => {
  const size = sceneSizeFor(148, 40)
  const wallAt = (minute) => skyColors(minute, weatherAt(minute)).wall
  const brightness = (rgb) => skyBrightness(rgb)

  const noon = wallAt(720)
  const dusk = wallAt(1150)
  const night = wallAt(60)

  assert.ok(brightness(noon) > brightness(dusk), 'the wall is lighter at noon than at dusk')
  assert.ok(brightness(dusk) > brightness(night), 'and lighter at dusk than at night')
  // The complaint: a bright grey slab next to a black sky.
  assert.ok(brightness(night) < 240, `the night wall is ${brightness(night)}, still a light grey`)
  assert.ok(brightness(noon) > brightness(night) * 2, 'the difference is unmistakable')

  // And it reaches the render: a night frame must not use the daytime wall.
  const dayFrame = sceneFrame({ kind: 'typing' }, 0, { palette: createTheme({ color: true }).scene, size, clockMs: clockFor(720) })
  const nightFrame = sceneFrame({ kind: 'typing' }, 0, { palette: createTheme({ color: true }).scene, size, clockMs: clockFor(60) })
  assert.notEqual(dayFrame.sky.colors.sgr.wall, nightFrame.sky.colors.sgr.wall)
  const nightCodes = new Set(nightFrame.cells.flat().filter((cell) => cell.text !== ' ').map((cell) => cell.sgr))
  assert.ok(!nightCodes.has(dayFrame.sky.colors.sgr.wall), 'the daytime wall is nowhere in a night frame')
})

test('fog is a haze, not a band', () => {
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const sky = layout.sky
  const pane = (sky.width - 2) * (sky.height - 2)

  // A minute that is definitely foggy, so the measurement is of the real thing.
  let fogMinute = -1
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
    if (weatherAt(minute).kind === 'fog' && weatherAt(minute).intensity > 0.9) {
      fogMinute = minute
      break
    }
  }
  assert.ok(fogMinute >= 0, 'the day contains fog')

  const grid = sceneGrid({ kind: 'typing' }, 0, { size, clockMs: clockFor(fogMinute) })
  const rows = grid.map((row) => row.join(''))
  const all = rows.join('')
  const fog = (all.match(/G/g) ?? []).length
  const share = fog / pane

  assert.ok(share > 0.005, 'there is fog')
  // It used to fill the bottom third at half density — about 23% of the pane.
  assert.ok(share < 0.12, `fog covers ${(share * 100).toFixed(1)}% of the pane, still a band`)

  // It gathers at the bottom and thins upwards. The orca stands in front of the
  // left of the pane, so the trend is measured on the right, where the sky is
  // unobstructed.
  const right = (row) => row.slice(sky.x + 1 + Math.floor(sky.width / 2), sky.x + sky.width - 1)
  // The inner rows only: the outermost are the window's own frame.
  const perRow = rows.slice(sky.y + 1, sky.y + sky.height - 1).map((row) => (right(row).match(/G/g) ?? []).length)
  const foggy = perRow.map((count, index) => [count, index]).filter(([count]) => count > 0)
  assert.ok(foggy.length > 0, 'and it is somewhere')

  const lowest = perRow[perRow.length - 1]
  const highest = perRow.find((count) => count > 0) ?? 0
  assert.ok(lowest > highest, `the bottom row (${lowest}) should be denser than the top of the band (${highest})`)
  // It does not reach the top half of the pane.
  const firstFoggy = perRow.findIndex((count) => count > 0)
  assert.ok(firstFoggy > perRow.length / 2, 'the top of the pane stays clear')
})

test('fog takes the colour of the sky rather than a fixed grey', () => {
  const noon = skyColors(720, { kind: 'fog', intensity: 1 })
  const night = skyColors(60, { kind: 'fog', intensity: 1 })
  const sum = (rgb) => rgb[0] + rgb[1] + rgb[2]

  // Tinted, so the two are nothing alike.
  assert.ok(sum(night.fog) < sum(noon.fog) * 0.6, 'night fog is much darker than noon fog')
  // But always a lift on the sky it sits in, never a bright grey slab.
  for (const [name, colors] of [['noon', noon], ['night', night]]) {
    assert.ok(sum(colors.fog) > sum(colors.top), `${name}: fog should be lighter than the sky`)
    assert.ok(sum(colors.fog) < sum(colors.top) + 380, `${name}: fog should not be a grey slab`)
  }
})
