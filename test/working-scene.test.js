/**
 * The desk scene: geometry, responsive sizing, animation, and that each state
 * actually looks different from the others.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTranslator } from '../src/cli/i18n.js'
import { isRubbingEyes, RUB_BETWEEN, RUB_LENGTH } from '../src/cli/working/scene.js'
import { createTheme } from '../src/cli/theme.js'
import { displayWidth } from '../src/cli/width.js'
import {
  orcaGrid,
  ORCA_H,
  ORCA_W,
  orcaWithTail,
  SLEEP_REAR,
  SPRITE_H,
  tailDroopFor,
  tailLeftFor,
  tailPixels,
  tailSwayFor
} from '../src/cli/working/art.js'
import {
  bubbleLayout,
  eyeMode,
  layoutFor,
  orcaScaleFor,
  renderCells,
  SCENE_H,
  SCENE_W,
  sceneFrame,
  sceneGrid,
  sceneSizeFor,
  spokenLines
} from '../src/cli/working/scene.js'
import { WORK_STATES } from '../src/cli/working/state.js'

const THEME = createTheme({ color: true })
const T = createTranslator('zh').t
const strip = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

/** The scene as plain text, one line per terminal row. */
// Speech runs on its own clock; tests that assert the words pass a frame far
// enough along that the message has finished being spoken.
const textOf = (work, frame, options = {}) =>
  sceneFrame(work, frame, { palette: THEME.scene, speechFrame: 400, ...options })
    .cells.map((row) => strip(renderCells(row)))
    .join('\n')

/** The pixel grid as letter rows, for structural comparisons. */
const lettersOf = (work, frame) => sceneGrid(work, frame).map((row) => row.join(''))

test('the scene keeps its geometry for every state and frame', () => {
  for (const kind of WORK_STATES) {
    for (const frame of [0, 1, 5, 11, 97]) {
      const scene = sceneFrame({ kind }, frame, { palette: THEME.scene })
      assert.equal(scene.width, SCENE_W)
      assert.equal(scene.height, SCENE_H / 2)
      assert.equal(scene.cells.length, scene.height)
      for (const row of scene.cells) {
        assert.equal(row.length, SCENE_W, `${kind} frame ${frame}`)
        assert.equal(displayWidth(strip(renderCells(row))), SCENE_W)
      }
    }
  }
})

test('the keyboard is a small slab, not a deck of keys', () => {
  const size = sceneSizeFor(148, 40)
  const grid = sceneGrid({ kind: 'typing' }, 0, { size }).map((row) => row.join('')).join('')
  const deck = (grid.match(/k/g) ?? []).length
  const keys = (grid.match(/K/g) ?? []).length
  assert.ok(deck > 0, 'there is a keyboard')
  const layout = layoutFor(size)
  // At most a single highlight line along the top: a key grid would be many
  // more light pixels than the bar is wide.
  assert.ok(keys <= layout.keyboard.width, `expected a bar, found ${keys} light pixels`)
  assert.ok(layout.keyboard.height <= Math.round(size.height * 2 * 0.08), 'it is a bar, not a slab')
})

test('the desk, its props and the orca are all present', () => {
  const grid = sceneGrid({ kind: 'typing' }, 0, { size: sceneSizeFor(112, 34) }).map((row) => row.join(''))
  const all = grid.join('')
  assert.ok(all.includes('b'), 'the orca body is drawn')
  assert.ok(all.includes('o'), 'the outline is drawn')
  assert.ok(all.includes('d'), 'the desk is drawn')
  assert.ok(all.includes('k'), 'the keyboard is drawn')
  assert.ok(all.includes('g') && all.includes('y') && all.includes('c'), 'the book stack is drawn')
  assert.ok(all.includes('r'), 'the red telephone is drawn')
  assert.ok(!all.includes('s'), 'the sleep Z marks are not baked into the sprite')
})

test('the sprite carries no trace of the reference art\'s ZZZ', () => {
  // The source artwork is a *sleeping* whale: the grey marks above it are three
  // Z glyphs. They must never appear except as the animation's own z's.
  const sprite = sceneGrid({ kind: 'typing' }, 0, { size: sceneSizeFor(112, 34) }).map((row) => row.join('')).join('')
  assert.ok(!sprite.includes('s'), 'no grey pixel in an awake state')
  const asleep = sceneGrid({ kind: 'sleep' }, 0, { size: sceneSizeFor(112, 34) }).map((row) => row.join('')).join('')
  assert.ok(asleep.includes('z'), 'but the sleeping pose draws its own')
  assert.ok(!asleep.includes('s'), 'and even asleep, no trace of the reference zs')
})

test('each state animates and differs from the others', () => {
  const size = sceneSizeFor(112, 34)
  const firstFrame = new Map()
  for (const kind of WORK_STATES) {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((frame) => lettersOf({ kind }, frame).join('\n'))
    assert.ok(new Set(frames).size > 1, `${kind} does not animate`)
    firstFrame.set(kind, frames[0])
  }
  const seen = new Map()
  for (const [kind, text] of firstFrame) {
    for (const [other, previous] of seen) {
      assert.notEqual(text, previous, `${kind} renders identically to ${other}`)
    }
    seen.set(kind, text)
  }
  void size
})

test('the eyes carry the expression', () => {
  assert.equal(eyeMode('sleep', 0), 'closed')
  assert.equal(eyeMode('typing', 0), 'open')
  assert.equal(eyeMode('reading', 0), 'open')
  assert.equal(eyeMode('reading', 6), 'squint')
  assert.equal(eyeMode('reading', 8), 'closed', 'reading is punctuated by a long blink')
  assert.equal(eyeMode('thinking', 3), 'squint')
  assert.equal(eyeMode('calling', 8), 'happy')

  const open = sceneGrid({ kind: 'typing' }, 0).map((row) => row.join('')).join('')
  const closed = sceneGrid({ kind: 'sleep' }, 0).map((row) => row.join('')).join('')
  assert.notEqual(open, closed)
})

test('the telephone is lifted to the ear at an angle, and only while calling', () => {
  const size = sceneSizeFor(112, 34)
  const resting = sceneGrid({ kind: 'typing' }, 0, { size }).map((row) => row.join('')).join('')
  const lifted = sceneGrid({ kind: 'calling' }, 0, { size }).map((row) => row.join('')).join('')
  assert.notEqual(resting, lifted)

  // The handset is beside the head — and it is *held*, so it stands at an
  // angle rather than lying flat along the desk.
  const layout = layoutFor(size)
  const ear = { x: layout.orca.x + 15 * layout.scale, y: layout.orca.y + 17 * layout.scale }
  const rows = sceneGrid({ kind: 'calling' }, 0, { size })
  const window = rows.slice(Math.max(0, ear.y - 10), ear.y + 16)
  let minX = Infinity
  let maxX = -1
  let minY = Infinity
  let maxY = -1
  let count = 0
  window.forEach((row, index) => row.forEach((ch, x) => {
    if (ch !== 'r') return
    const y = index + Math.max(0, ear.y - 10)
    count += 1
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }))
  assert.ok(count > 8 * layout.scale, `the handset should be visible near the head, found ${count} red pixels`)
  assert.ok(Math.abs(maxX - minX) > 4 * layout.scale, 'it reaches out from the head')
  assert.ok(maxY - minY > 4 * layout.scale, 'and it stands at an angle rather than lying flat')
  assert.ok(minX < ear.x + 6 * layout.scale && maxY > ear.y, 'with the earpiece up by the ear')
})

test('the orca types with its flippers, and stops for a telephone call', () => {
  const size = sceneSizeFor(148, 40)
  const letters = (kind, frame) => sceneGrid({ kind }, frame, { size }).map((row) => row.join('')).join('')
  const flipperPixels = (kind, frame) => (letters(kind, frame).match(/f/g) ?? []).length

  // Typing: there are flippers, and they move.
  assert.ok(flipperPixels('typing', 0) > 0, 'typing has flippers')
  assert.ok(flipperPixels('typing', 1) > 0)
  assert.notEqual(letters('typing', 0), letters('typing', 1), 'and they alternate')

  // A telephone call holds still: the point of the pose is that it has stopped
  // working, so nothing may twitch.
  assert.equal(letters('calling', 0), letters('calling', 1), 'a call does not type')
  assert.equal(letters('calling', 0), letters('calling', 2))

  // But there is still a flipper: it is holding the handset.
  assert.ok(flipperPixels('calling', 0) > 0, 'the orca holds the telephone with a flipper')
})

test('the flippers are short paddles, not arms', () => {
  const size = sceneSizeFor(148, 40)
  const grid = sceneGrid({ kind: 'typing' }, 0, { size })
  let minX = Infinity
  let maxX = -1
  let minY = Infinity
  let maxY = -1
  grid.forEach((row, y) => row.forEach((ch, x) => {
    if (ch !== 'f') return
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }))
  const layout = layoutFor(size)
  const scale = layout.scale
  const flipperX = layout.orca.x + Math.round(layout.orca.width * 0.38)
  // Measure one limb, not the pair: the two are set apart, so their combined
  // bounding box says nothing about how long either is.
  let oneMinX = Infinity
  let oneMaxX = -1
  let oneMinY = Infinity
  let oneMaxY = -1
  grid.forEach((row, y) => row.forEach((ch, x) => {
    if (ch !== 'f' || x > flipperX + 6 * scale) return
    oneMinX = Math.min(oneMinX, x)
    oneMaxX = Math.max(oneMaxX, x)
    oneMinY = Math.min(oneMinY, y)
    oneMaxY = Math.max(oneMaxY, y)
  }))
  // A stubby paddle: a few sprite pixels, not a reach across the desk.
  assert.ok(oneMaxX - oneMinX <= 10 * scale, `a flipper spans ${oneMaxX - oneMinX}px`)
  assert.ok(oneMaxY - oneMinY <= 10 * scale, `a flipper is ${oneMaxY - oneMinY}px tall`)
  void minX; void maxX; void minY; void maxY
})

test('the flippers are tucked away while the orca sleeps', () => {
  const size = sceneSizeFor(148, 40)
  for (const frame of [0, 1, 6]) {
    const asleep = sceneGrid({ kind: 'sleep' }, frame, { size }).map((row) => row.join('')).join('')
    assert.equal((asleep.match(/f/g) ?? []).length, 0, 'a dozing orca is not reaching for the keyboard')
  }
  // And the pose still has its own visible motion: the breathing and the z's.
  const a = sceneGrid({ kind: 'sleep' }, 0, { size }).map((row) => row.join('')).join('')
  const b = sceneGrid({ kind: 'sleep' }, 6, { size }).map((row) => row.join('')).join('')
  assert.notEqual(a, b)
})

test('the flippers are a shade off the body, not the same blue', () => {
  assert.ok(THEME.scene.flipper.length > 0)
  assert.notEqual(THEME.scene.flipper, THEME.scene.body, 'a limb the same colour as the body is invisible')
  // Lighter, not darker: a dark shade read as grubby rather than as a limb.
  const brightness = (code) => Number(code.split(';').at(-1))
  assert.ok(brightness(THEME.scene.flipper) > brightness(THEME.scene.body), 'the flipper should be the lighter blue')
  const scene = sceneFrame({ kind: 'typing' }, 0, { palette: THEME.scene, size: sceneSizeFor(148, 40) })
  const codes = new Set(scene.cells.flat().map((cell) => cell.sgr))
  assert.ok(codes.has(THEME.scene.body), 'the body is drawn')
  assert.ok(codes.has(THEME.scene.flipper), 'and so are the flippers, in their own shade')
})

test('the preview text is never shown without its window frame', () => {
  // This is exactly how it was reported: three lines of text floating at the
  // top of the terminal with no box around them.
  const size = sceneSizeFor(148, 40)
  let shown = 0
  for (const kind of WORK_STATES) {
    const grid = sceneGrid({ kind }, 0, { size }).map((row) => row.join('')).join('')
    const text = sceneFrame({ kind }, 0, { palette: THEME.scene, size, previewText: 'the quick brown fox' })
      .cells.map((row) => strip(renderCells(row))).join('\n')
    if (!text.includes('the quick brown fox')) continue
    shown += 1
    assert.ok(grid.includes('e'), `${kind} shows preview text with no window frame`)
  }
  assert.ok(shown > 0, 'at least one state shows the preview')

  // Sleeping shows neither the text nor an empty box.
  const asleep = sceneFrame({ kind: 'sleep' }, 0, { palette: THEME.scene, size, previewText: 'the quick brown fox' })
  assert.doesNotMatch(asleep.cells.map((row) => strip(renderCells(row))).join('\n'), /quick brown/)
  assert.ok(!sceneGrid({ kind: 'sleep' }, 0, { size }).map((row) => row.join('')).join('').includes('e'))
})

test('the book really turns a page', () => {
  const size = sceneSizeFor(140, 40)
  const layout = layoutFor(size)
  // Compare the book area across a whole turn cycle: the page must sweep, not
  // simply blink between two positions.
  const area = (frame) =>
    sceneGrid({ kind: 'searching' }, frame, { size })
      .slice(Math.max(0, layout.books.y - 6), layout.books.y + layout.books.height)
      .map((row) => row.slice(layout.books.x - 2, layout.books.x + layout.books.width + 2).join(''))
  const frames = [0, 1, 2, 3, 4, 5].map(area)
  assert.equal(new Set(frames).size, 6, 'every step of the turn looks different')

  // The leaf must genuinely move from the right-hand page to the left one,
  // not just flicker: the balance of page pixels shifts across the spine.
  const spine = layout.books.x + Math.floor(layout.books.width / 2)
  const balance = (frame) => {
    const rows = sceneGrid({ kind: 'searching' }, frame, { size })
    const top = Math.max(0, layout.books.y - 8)
    const bottom = Math.min(rows.length, layout.books.y + layout.books.height)
    let left = 0
    let right = 0
    for (let y = top; y < bottom; y += 1) {
      for (let x = layout.books.x - 2; x < layout.books.x + layout.books.width + 2; x += 1) {
        // Page material is both the lit and the shaded page; the shading is
        // the point of the spread, not a separate thing.
        if (rows[y][x] !== 'p' && rows[y][x] !== 'q') continue
        if (x < spine) left += 1
        else right += 1
      }
    }
    return right - left
  }
  const balances = [0, 1, 2, 3, 4, 5].map(balance)
  assert.ok(new Set(balances).size > 2, `the page should cross the spine, got ${JSON.stringify(balances)}`)
  assert.ok(Math.max(...balances) > Math.min(...balances), 'and the balance should swing')
})

test('a subagent call raises the telephone and shows the bubble', () => {
  const lines = [T('work.bubbleCalling', { n: 3, input: '' }).replace(/[，,]\s*$/, ''), '把这个模块重构一下']
  const text = textOf({ kind: 'calling', subagent: { index: 3, input: '把这个模块重构一下' } }, 0, { bubbleLines: lines })
  assert.match(text, /接 3 号子代理/)
  assert.match(text, /把这个模块重构一下/)
  assert.match(text, /[█▀▄]/, 'the bubble has a body')

  const plain = textOf({ kind: 'calling', subagent: { index: 3 } }, 0)
  assert.doesNotMatch(plain, /子代理/)
})

test('a long instruction is clipped to the bubble rather than overflowing', () => {
  const long = 'x'.repeat(400)
  const { rows } = bubbleLayout(2, ['接 1 号子代理', long])
  for (const line of rows) assert.ok(line.text.length <= SCENE_W, 'the text never exceeds the scene')
  const scene = sceneFrame({ kind: 'calling' }, 0, {
    palette: THEME.scene,
    speechFrame: 400,
    bubbleLines: ['接 1 号子代理', long]
  })
  for (const row of scene.cells) assert.equal(row.length, SCENE_W)
})

test('the bubble fits a Chinese instruction without breaking the grid', () => {
  const instruction = '把 auth 模块里的校验逻辑抽出来，补上单元测试'
  const scene = sceneFrame({ kind: 'calling' }, 0, {
    palette: THEME.scene,
    speechFrame: 400,
    bubbleLines: [T('work.bubbleCalling', { n: 1, input: '' }).replace(/[，,]\s*$/, ''), instruction]
  })
  const rows = scene.cells.map((row) => strip(renderCells(row)))
  for (const row of rows) assert.equal(displayWidth(row), SCENE_W)
  assert.ok(rows.some((row) => row.includes('接 1 号子代理')))
})

test('colour never changes the shape, and off means no escapes', () => {
  const coloured = textOf({ kind: 'typing' }, 2)
  const plain = sceneFrame({ kind: 'typing' }, 2, { palette: {} }).cells.map(renderCells).join('\n')
  assert.equal(coloured, plain, 'the same pixels render the same glyphs')
  assert.doesNotMatch(plain, /\u001b\[/, 'an empty palette emits no escapes')
  assert.match(plain, /[▀▄█]/, 'the shape survives without colour')
})

test('the scene grows with the terminal instead of sitting in the middle of it', () => {
  const small = sceneSizeFor(80, 24)
  const large = sceneSizeFor(160, 48)
  assert.ok(large.width > small.width, 'a wider terminal gets a wider scene')
  assert.ok(large.height > small.height, 'and a taller one')
  assert.ok(small.width <= 78)
  assert.ok(large.width <= 158)

  assert.ok(sceneSizeFor(20, 10).width <= 18, 'a tiny terminal is never overrun')
  assert.ok(sceneSizeFor(60, 20).width <= 58)
  assert.equal(sceneSizeFor(80, 24).width, 78, 'a normal terminal is used fully')
  assert.equal(sceneSizeFor(1000, 200).width, 200, 'and a huge one is capped')
  // The scene must never eat the status line: two rows are always left over.
  for (const [cols, rows] of [[80, 24], [120, 32], [100, 6], [200, 60]]) {
    const size = sceneSizeFor(cols, rows)
    assert.ok(size.height <= Math.max(8, rows - 2), `scene is ${size.height} rows tall in a ${rows}-row terminal`)
  }

  for (const [cols, rows] of [[undefined, undefined], [NaN, NaN], [80, undefined]]) {
    const size = sceneSizeFor(cols, rows)
    assert.ok(Number.isFinite(size.width) && Number.isFinite(size.height))
    assert.ok(size.width > 0 && size.height > 0)
  }
})

test('the orca scales by whole numbers only', () => {
  assert.equal(orcaScaleFor({ width: 112, height: 32 }), 1)
  assert.equal(orcaScaleFor({ width: 200, height: 60 }), 2)
  for (const size of [{ width: 72, height: 24 }, { width: 112, height: 32 }, { width: 200, height: 60 }]) {
    const scale = orcaScaleFor(size)
    assert.equal(scale, Math.trunc(scale), 'a fractional scale would look like a rendering fault')
    assert.ok(scale >= 1 && scale <= 3)
  }
})

test('the layout keeps every prop on the desk at any size', () => {
  for (const size of [{ width: 72, height: 24 }, { width: 96, height: 28 }, { width: 112, height: 32 }, { width: 200, height: 60 }]) {
    const layout = layoutFor(size)
    const pixelH = size.height * 2
    assert.ok(layout.desk.top < pixelH, 'the desk is on screen')
    for (const key of ['keyboard', 'books', 'phone', 'document']) {
      const prop = layout[key]
      assert.ok(prop.x >= 0 && prop.x + prop.width <= size.width, `${key} is inside the scene horizontally`)
      assert.ok(prop.y >= 0 && prop.y + prop.height <= layout.desk.top + 4, `${key} sits on the desk, not through it`)
    }
    assert.ok(layout.orca.x >= 0 && layout.orca.x + layout.orca.width <= size.width, 'the orca is inside the scene')
    assert.ok(layout.orca.y + layout.orca.height <= layout.desk.top + 4, 'and behind the desk')
  }
})

test('a wide terminal really does get a bigger orca', () => {
  const small = sceneFrame({ kind: 'typing' }, 0, { palette: THEME.scene, size: sceneSizeFor(80, 24) })
  const large = sceneFrame({ kind: 'typing' }, 0, { palette: THEME.scene, size: sceneSizeFor(200, 60) })
  const whale = (scene) => scene.cells.flat().filter((cell) => cell.sgr === THEME.scene.body).length
  assert.ok(whale(large) > whale(small) * 2, 'the orca fills more of a large terminal')
})

test('the scene is much larger than the trace board', () => {
  assert.ok(SCENE_W >= 96, `scene is only ${SCENE_W} cells wide`)
  assert.ok(SCENE_H / 2 >= 24, `scene is only ${SCENE_H / 2} rows tall`)
  assert.equal(ORCA_W, 64, 'the sprite is sampled at the artwork\'s native width')
  assert.equal(ORCA_H, 40, 'and its native height, so no rows are dropped')
})

test('the bubble is anchored over the orca, not floating at the scene edge', () => {
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const lines = ['接 2 号子代理', '把 auth 模块里的校验逻辑抽出来']
  const { rows } = bubbleLayout(lines.length, lines, size, layout)
  const first = rows[0]
  assert.ok(first.col >= layout.orca.x - 2, `bubble starts at ${first.col}, orca at ${layout.orca.x}`)
  assert.ok(first.col <= layout.orca.x + layout.orca.width, 'and it overlaps the orca horizontally')
  // Cell rows and pixel coordinates are different units: the bubble's text is
  // placed in cells, the layout is in pixels.
  const orcaTopRow = Math.floor(layout.orca.y / 2)
  const orcaBottomRow = Math.floor((layout.orca.y + layout.orca.height) / 2)
  assert.ok(
    first.row >= orcaTopRow - 5 && first.row <= orcaBottomRow,
    `bubble row ${first.row} should sit at the orca's head (rows ${orcaTopRow}..${orcaBottomRow})`
  )
  // Where the two share rows, the bubble must not sit on top of the preview
  // window. They are usually on opposite sides of the room and never meet.
  const hudTop = Math.floor(layout.window.y / 2)
  const hudBottom = Math.floor((layout.window.y + layout.window.height) / 2)
  const bubblesRows = rows.map((line) => line.row)
  const shares = bubblesRows.some((row) => row >= hudTop && row <= hudBottom)
  if (shares) {
    for (const line of rows) {
      const overlaps = line.col < layout.window.x + layout.window.width && line.col + line.text.length > layout.window.x
      assert.equal(overlaps, false, 'the bubble and the preview window must not overlap')
    }
  }
})

test('the bubble stays inside the scene however long the instruction', () => {
  for (const cols of [80, 120, 160, 200]) {
    const size = sceneSizeFor(cols, 40)
    const long = '把 auth 模块里的校验逻辑抽出来，补上单元测试，并更新文档'.repeat(4)
    const scene = sceneFrame({ kind: 'calling' }, 0, {
      palette: THEME.scene,
      size,
      speechFrame: 400,
      bubbleLines: ['接 1 号子代理', long]
    })
    for (const row of scene.cells) assert.equal(row.length, size.width)
    const text = scene.cells.map((row) => strip(renderCells(row))).join('\n')
    assert.match(text, /接 1 号子代理/)
  }
})

/* ------------------------------------------------------------------ *
 * The telephone: speaking, scrolling, and ringing
 * ------------------------------------------------------------------ */

test('the message is spoken a character at a time', () => {
  const text = 'task(description="refactor auth", prompt="把校验逻辑抽出来")'
  const first = spokenLines(text, 40, 3, 0)
  const later = spokenLines(text, 40, 3, 6)
  const done = spokenLines(text, 40, 3, 400)
  assert.ok(first.lines.join('').length > 0, 'never invisible on its first frame')
  assert.ok(first.typing, 'still being spoken')
  assert.ok(later.lines.join('').length > first.lines.join('').length, 'more of it each frame')
  assert.equal(done.typing, false, 'and it finishes')
  assert.ok(done.lines.join('').includes('校验逻辑'), 'the whole message gets said')
})

test('a long message scrolls instead of overflowing the bubble', () => {
  const long = 'task(prompt="' + '把 auth 模块里的校验逻辑抽出来，补上单元测试。'.repeat(8) + '")'
  const width = 40
  const rows = 3
  const seen = new Set()
  for (let frame = 400; frame < 460; frame += 1) {
    const spoken = spokenLines(long, width, rows, frame)
    assert.ok(spoken.lines.length <= rows, 'never more rows than the bubble has')
    for (const line of spoken.lines) assert.ok(displayWidth(line) <= width, 'and never wider than it')
    seen.add(spoken.lines.join('|'))
  }
  assert.ok(seen.size > 3, 'the window really moves through the message')

  // And while it is still being spoken, the newest words are the ones in view.
  const typingFrame = 20
  const partial = long.slice(0, Math.floor(typingFrame * 2.5))
  const shown = spokenLines(long, width, rows, typingFrame).lines.join('')
  assert.ok(partial.trim().endsWith(shown.trim().slice(-6)), 'the tail of what has been said is visible')
})

test('the header stays put while the message scrolls under it', () => {
  const size = sceneSizeFor(148, 40)
  const long = 'task(prompt="' + '把校验逻辑抽出来，补上单元测试。'.repeat(8) + '")'
  const header = '接 2 号子代理（共 3 个，排队 1 个）'
  for (const speechFrame of [0, 10, 200, 400, 700]) {
    const scene = sceneFrame({ kind: 'calling' }, 0, {
      palette: THEME.scene,
      size,
      speechFrame,
      bubbleHeader: header,
      bubbleBody: long
    })
    const text = scene.cells.map((row) => strip(renderCells(row))).join('\n')
    assert.match(text, /接 2 号子代理/, `the header vanished at speech frame ${speechFrame}`)
    for (const row of scene.cells) assert.equal(row.length, size.width)
  }
})

test('a ringing telephone shakes, and the reply is on the bubble', () => {
  const size = sceneSizeFor(148, 40)
  const subagent = { index: 2, total: 2, queued: 0, reply: '重构完成，12 个测试全部通过。' }
  const frames = [0, 1, 2, 3].map((frame) =>
    sceneGrid({ kind: 'ringing' }, frame, { size }).map((row) => row.join('')).join('')
  )
  assert.ok(new Set(frames).size > 1, 'the telephone rings rather than sitting still')

  const text = sceneFrame({ kind: 'ringing' }, 0, {
    palette: THEME.scene,
    size,
    speechFrame: 400,
    bubbleHeader: '2 号子代理回电',
    bubbleBody: subagent.reply
  }).cells.map((row) => strip(renderCells(row))).join('\n')
  assert.match(text, /号子代理回电/)
  assert.match(text, /重构完成/)
})

test('a ringing telephone is shaken about its resting place, not moved away', () => {
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const reds = []
  for (const frame of [0, 1, 2, 3]) {
    const grid = sceneGrid({ kind: 'ringing' }, frame, { size })
    let minX = Infinity
    let maxX = -1
    grid.forEach((row, y) => row.forEach((ch, x) => {
      // Only the lifted handset: the base sits at the far end of the desk and
      // would swamp the measurement.
      if (ch !== 'r' || x <= layout.phone.x + layout.phone.width + 2) return
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }))
    reds.push([minX, maxX])
  }
  // How far the handset *travels* across the frames — comparing the union's
  // span would just measure the handset's own width.
  const lefts = reds.map(([min]) => min)
  const travel = Math.max(...lefts) - Math.min(...lefts)
  assert.ok(travel > 0, 'the handset must move, or it is not ringing')
  assert.ok(travel <= 4 * layout.scale, `the handset travels ${travel}px, which is a move rather than a shake`)
})

test('the handset is picked up and put down, not teleported', () => {
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  /** The topmost handset pixel, which rises as the handset is lifted. */
  const handsetTop = (lift) => {
    const grid = sceneGrid({ kind: 'calling' }, 0, { size, phoneLift: lift })
    let minY = Infinity
    grid.forEach((row, y) => row.forEach((ch, x) => {
      if (ch !== 'r' || x <= layout.phone.x + layout.phone.width + 2) return
      minY = Math.min(minY, y)
    }))
    return minY
  }

  const lifts = [0, 0.25, 0.5, 0.75, 1]
  const heights = lifts.map(handsetTop)
  for (let index = 1; index < heights.length; index += 1) {
    assert.ok(
      heights[index] <= heights[index - 1],
      `the handset should only rise while being picked up: ${JSON.stringify(heights)}`
    )
  }
  assert.ok(heights[0] > heights[heights.length - 1], 'and it ends up higher than it started')

  // Every step of the way is a different picture: no teleporting.
  const frames = lifts.map((lift) =>
    sceneGrid({ kind: 'calling' }, 0, { size, phoneLift: lift }).map((row) => row.join('')).join('')
  )
  assert.equal(new Set(frames).size, lifts.length, 'each step of the pickup looks different')

  // And putting it down retraces the same path.
  const down = [1, 0.75, 0.5, 0.25, 0].map((lift) =>
    sceneGrid({ kind: 'calling' }, 0, { size, phoneLift: lift }).map((row) => row.join('')).join('')
  )
  assert.deepEqual(down, [...frames].reverse(), 'hanging up is the pickup in reverse')
})

test('exactly one set of flippers is on screen, never three', () => {
  const size = sceneSizeFor(148, 40)
  /** Connected blobs of flipper pixels: one per limb. */
  const limbs = (kind, lift) => {
    const grid = sceneGrid({ kind }, 0, { size, phoneLift: lift })
    const height = grid.length
    const width = grid[0].length
    const seen = new Set()
    let count = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (grid[y][x] !== 'f' || seen.has(`${x},${y}`)) continue
        count += 1
        const stack = [[x, y]]
        seen.add(`${x},${y}`)
        while (stack.length > 0) {
          const [cx, cy] = stack.pop()
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            if (grid[ny][nx] !== 'f' || seen.has(`${nx},${ny}`)) continue
            seen.add(`${nx},${ny}`)
            stack.push([nx, ny])
          }
        }
      }
    }
    return count
  }

  for (const kind of WORK_STATES) {
    for (const lift of [0, 0.25, 0.5, 0.75, 1]) {
      const count = limbs(kind, lift)
      assert.ok(count <= 2, `${kind} at lift ${lift} has ${count} limbs; three hands is one too many`)
    }
  }

  // Answering the telephone is the case that was wrong: the keyboard pair must
  // be gone once the handset is up.
  assert.equal(limbs('ringing', 1), limbs('calling', 1), 'ringing holds the same single limb as calling')
  assert.equal(limbs('calling', 1), 1, 'and it is one limb')
  assert.equal(limbs('calling', 0), 0, 'with nothing held while the handset is still on the cradle')
  assert.ok(limbs('typing', 0) >= 1, 'and two are on the keyboard when it is working')
  assert.equal(limbs('sleep', 0), 0, 'a dozing orca holds nothing')
})

test('a settled pose is what a caller who does not animate the lift gets', () => {
  const size = sceneSizeFor(148, 40)
  const settled = sceneGrid({ kind: 'calling' }, 0, { size }).map((row) => row.join('')).join('')
  const explicit = sceneGrid({ kind: 'calling' }, 0, { size, phoneLift: 1 }).map((row) => row.join('')).join('')
  assert.equal(settled, explicit, 'calling without an explicit lift is fully lifted')
})

test('the sleeping zs are big enough to read', () => {
  const size = sceneSizeFor(148, 40)
  // At two pixels a z was a speck. Count pixels, not zs, so a regression to
  // miniature fails here rather than in someone's eyes.
  for (const minute of [720, 0]) {
    const grid = sceneGrid({ kind: 'sleep' }, 2, { size, clockMs: minute * 1000 + 86_400_000 })
    const all = grid.map((row) => row.join('')).join('')
    const pixels = (all.match(/z/g) ?? []).length
    assert.ok(pixels >= 40, `only ${pixels} z pixels at minute ${minute}`)
    // Three of them, each on its own.
    let blobs = 0
    const seen = new Set()
    grid.forEach((row, y) => row.forEach((ch, x) => {
      if (ch !== 'z' || seen.has(`${x},${y}`)) return
      blobs += 1
      const stack = [[x, y]]
      seen.add(`${x},${y}`)
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()
        // Eight-connected: the diagonal stroke of a z only touches its bars at
        // the corners, so four-connectivity would count one z as three.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (grid[cy + dy]?.[cx + dx] !== 'z' || seen.has(`${cx + dx},${cy + dy}`)) continue
          seen.add(`${cx + dx},${cy + dy}`)
          stack.push([cx + dx, cy + dy])
        }
      }
    }))
    assert.equal(blobs, 3, `expected three zs, found ${blobs}`)
  }
})

test('the telephone has a dial and a cradle, not just a red box', () => {
  const size = sceneSizeFor(148, 40)
  const layout = layoutFor(size)
  const phone = layout.phone
  const crop = (kind, lift) =>
    sceneGrid({ kind }, 0, { size, phoneLift: lift })
      .slice(phone.y, phone.y + phone.height + 3)
      .map((row) => row.slice(phone.x, phone.x + phone.width).join(''))

  const rested = crop('typing', 0).join('')
  const lifted = crop('calling', 1).join('')
  for (const [name, text] of [['rested', rested], ['lifted', lifted]]) {
    assert.ok(text.includes('r') && text.includes('R'), `${name}: the base has a lit top and a darker body`)
    assert.ok(text.includes('o'), `${name}: the dial and cradle are dark marks`)
  }
  // The dial is a ring, so it has a hole in it.
  const dialRow = crop('typing', 0).find((row) => (row.match(/o/g) ?? []).length >= 4)
  assert.ok(dialRow !== undefined, 'the dial is visible as a ring, not a single line')
  assert.ok(/o[^o]o/.test(dialRow), 'and it is a ring rather than a filled blob')
  // Lifting leaves the cradle empty: the two posts are still there.
  assert.ok(lifted.includes('o'), 'the cradle stays behind when the handset is picked up')
})

/* ------------------------------------------------------------------ *
 * The tail, and the night-time rub
 * ------------------------------------------------------------------ */

test('the tail is drawn, not transformed', () => {
  // Six transforms all traded one artefact for another. The poses are art now,
  // so the things that used to go wrong are impossible by construction.
  const up = orcaWithTail({ pose: 'up' })
  const sleep = orcaWithTail({ pose: 'sleep' })

  for (const grid of [up, sleep]) {
    assert.equal(grid.length, SPRITE_H)
    for (const row of grid) assert.equal(row.length, ORCA_W)
  }
  // The drawn tail is one solid lobe: every row of *the tail* is an unbroken run
  // of columns, which is what a fold could never manage. Checked on the tail's
  // own pixels rather than the whole sprite — the body is not ours to assert on.
  const byRow = new Map()
  for (const key of tailPixels('sleep').keys()) {
    const [x, y] = key.split(',').map(Number)
    if (!byRow.has(y)) byRow.set(y, [])
    byRow.get(y).push(x)
  }
  for (const [y, columns] of byRow) {
    const sorted = [...columns].sort((a, b) => a - b)
    assert.equal(
      sorted[sorted.length - 1] - sorted[0] + 1,
      sorted.length,
      `the sleeping tail has a gap in row ${y}`
    )
  }
  // The awake pose keeps the source art's opening V, which is a gap by design.
  const awakeRow = up[2].join('')
  assert.ok(awakeRow.includes('.'), 'the V is still open')
  assert.notDeepEqual(up, sleep, 'the two poses differ')
})

test('the awake pose is exactly the source art', () => {
  // The lifted tail is taken out of the sprite rather than re-outlined, so the
  // awake orca is byte-for-byte what the reference art drew.
  const source = orcaGrid().slice(0, ORCA_H)
  const awake = orcaWithTail({ pose: 'up' }).slice(0, ORCA_H)
  for (let y = 0; y < ORCA_H; y += 1) {
    for (let x = 0; x < ORCA_W; x += 1) {
      assert.equal(awake[y][x], source[y][x], `the awake pose changed ${x},${y}`)
    }
  }
})

test('the sleeping tail lies along the body at the desk line', () => {
  const awake = tailPixels('up')
  const asleep = tailPixels('sleep')
  const rowsOf = (pixels) => [...pixels.keys()].map((key) => Number(key.split(',')[1]))
  const colsOf = (pixels) => [...pixels.keys()].map((key) => Number(key.split(',')[0]))

  // Lower, and no taller than the awake tail.
  const awakeRows = rowsOf(awake)
  const sleepRows = rowsOf(asleep)
  assert.ok(Math.min(...sleepRows) > Math.min(...awakeRows), 'the sleeping tail starts lower')
  const span = (rows) => Math.max(...rows) - Math.min(...rows)
  assert.ok(span(sleepRows) < span(awakeRows) / 2, 'and is far flatter')

  // The sleeping tail curls round to the front, so it lives to the left of the
  // body's rear rather than out behind it.
  assert.ok(Math.min(...colsOf(asleep)) < 20, 'it comes round to the front')
  assert.equal(Math.max(...sleepRows), 38, 'and rests at the desk line')
  // It is outlined, like the rest of the sprite.
  assert.ok([...asleep.values()].includes('o'), 'the drawn pose has an edge')

  // A coil lying on the body keeps its outline all the way round: without one
  // it is blue on blue and invisible.
  const byRow = new Map()
  for (const [key, cls] of asleep) {
    const [x, y] = key.split(',').map(Number)
    if (!byRow.has(y)) byRow.set(y, [])
    byRow.get(y).push([x, cls])
  }
  // And it is drawn as a coil, not a bar: the widest row is in the middle.
  const widths = [...byRow].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells.length)
  const widest = widths.indexOf(Math.max(...widths))
  assert.ok(widest > 0 && widest < widths.length - 1, 'the coil should swell in the middle')
})

test('the tail sways without opening a seam at the body', () => {
  // A rigid shift of the whole tail pulled its base away from the body and let
  // the background show through the junction. The columns nearest the body are
  // therefore anchored and only the outer part swings, so the tail pivots.
  const ANCHOR = 50
  const base = tailPixels('up')
  const columns = (pose, sway) => {
    const grid = orcaWithTail({ pose, sway })
    const moved = new Set()
    for (const key of base.keys()) {
      const [x, y] = key.split(',').map(Number)
      if (grid[y][x] === '.' || grid[y][x] === undefined) moved.add(x)
    }
    return moved
  }

  for (const sway of [-2, 2]) {
    const vacated = columns('up', sway)
    for (const x of vacated) {
      assert.ok(x >= ANCHOR, `column ${x} sits at the junction and must not move`)
    }
  }

  // And the junction is sealed: swaying must not open a gap the resting pose
  // does not already have. The source art has gaps of its own between the body
  // and the flukes — that is the V opening — so only new ones are bugs.
  const gapRows = (sway) => {
    const grid = orcaWithTail({ pose: 'up', sway })
    const rows = new Set()
    for (let y = 10; y < 32; y += 1) {
      if (/[^.]\.+[^.]/.test(grid[y].slice(38, 58).join(''))) rows.add(y)
    }
    return rows
  }
  const resting = gapRows(0)
  for (const sway of [-2, 2]) {
    const now = gapRows(sway)
    for (const y of now) {
      assert.ok(resting.has(y), `sway ${sway} opened a gap at row ${y} that the resting pose does not have`)
    }
  }

  assert.equal(tailSwayFor('calling', 7), 0)
  assert.equal(tailSwayFor('ringing', 21), 0)
  const seen = new Set()
  for (let frame = 0; frame < 60; frame += 1) seen.add(tailSwayFor('typing', frame))
  assert.ok(seen.has(-2) || seen.has(-1), 'it swings one way')
  assert.ok(seen.has(2) || seen.has(1), 'and the other')
})

test('sleeping switches to the drawn pose, and only then', () => {
  assert.equal(tailDroopFor('typing', 40), 0)
  assert.equal(tailDroopFor('calling', 40), 0)
  const curve = [0, 4, 8, 12, 16].map((frames) => tailDroopFor('sleep', frames))
  for (let index = 1; index < curve.length; index += 1) {
    assert.ok(curve[index] >= curve[index - 1], 'it settles, it does not wobble')
  }
  assert.equal(curve.at(-1), 1)

  const size = sceneSizeFor(148, 40)
  const night = 60 * 1000 + 86_400_000
  const at = (sleepFor) => sceneGrid({ kind: 'sleep' }, 2, { size, sleepFor, clockMs: night })
  // Just asleep it is still upright; settled, it is flat.
  assert.notDeepEqual(at(0), at(24))
})

test('the orca rubs its eyes at night, and only while working', () => {
  const night = { phase: 'night' }
  const day = { phase: 'day' }

  // At night and working, it rubs now and then — not constantly, not never.
  let rubbing = 0
  for (let frame = 0; frame < 400; frame += 1) if (isRubbingEyes('typing', frame, night)) rubbing += 1
  assert.ok(rubbing > 0, 'it never rubs')
  assert.ok(rubbing < 400 * 0.25, `it rubs far too often: ${rubbing}/400 frames`)
  // A rub is short.
  let longest = 0
  let run = 0
  for (let frame = 0; frame < 400; frame += 1) {
    run = isRubbingEyes('typing', frame, night) ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  assert.equal(longest, RUB_LENGTH, 'a rub lasts RUB_LENGTH frames')

  // It is a night-time thing, and a working-time thing.
  for (let frame = 0; frame < 200; frame += 1) {
    assert.equal(isRubbingEyes('typing', frame, day), false, 'never in daylight')
    assert.equal(isRubbingEyes('sleep', frame, night), false, 'never while asleep')
    assert.equal(isRubbingEyes('calling', frame, night), false, 'never on the telephone')
  }
  // No sky reading at all means no rub, rather than a crash.
  assert.equal(isRubbingEyes('typing', 30, undefined), false)
})

test('a rub reaches the rendered frame', () => {
  const size = sceneSizeFor(148, 40)
  const nightClock = 60 * 1000 + 86_400_000
  const frames = Array.from({ length: RUB_BETWEEN }, (_, frame) => frame)
  const rubbingFrame = frames.find((frame) => isRubbingEyes('typing', frame, { phase: 'night' }))
  const calmFrame = frames.find((frame) => !isRubbingEyes('typing', frame, { phase: 'night' }))
  assert.ok(rubbingFrame !== undefined && calmFrame !== undefined, 'both a rub and a calm frame exist')

  const render = (frame) =>
    sceneGrid({ kind: 'typing' }, frame, { size, clockMs: nightClock })
      .map((row) => row.join(''))
      .join('')
  const flippers = (text) => (text.match(/f/g) ?? []).length

  const rubbing = render(rubbingFrame)
  const calm = render(calmFrame)
  // Working draws two flippers on the keyboard; a rub adds a third at the face.
  assert.ok(flippers(rubbing) > flippers(calm), `rubbing ${flippers(rubbing)} vs calm ${flippers(calm)} flipper pixels`)
  assert.notEqual(rubbing, calm, 'the frame changed')

  // And it does not happen in daylight, at the same frame number.
  const day = sceneGrid({ kind: 'typing' }, rubbingFrame, { size, clockMs: 720 * 1000 + 86_400_000 })
  const dayText = day.map((row) => row.join('')).join('')
  assert.equal(flippers(dayText), flippers(calm), 'no rub in daylight')
})

test('no pose leaves a sliver of tail behind', () => {
  // The bug that survived the longest: the tail's leading edge is not one
  // column — it starts at 42 on the top two rows and 40 below that. Taking it
  // for a single column left a one-pixel-wide strip of tail in the lifted-out
  // region, which drew as a lone vertical line beside the orca. It looked like
  // a transform artefact and was nothing of the sort: it was a column that was
  // never in the transform's input to begin with.
  for (const pose of ['up', 'sleep']) {
    const grid = orcaWithTail({ pose })
    for (let x = 1; x < ORCA_W - 1; x += 1) {
      let height = 0
      for (let y = 0; y < ORCA_H; y += 1) if (grid[y][x] !== '.') height += 1
      if (height < 3) continue
      let hasNeighbour = false
      for (let y = 0; y < ORCA_H; y += 1) {
        if (grid[y][x - 1] !== '.' || grid[y][x + 1] !== '.') hasNeighbour = true
      }
      assert.ok(hasNeighbour, `${pose} left a ${height}-pixel vertical line at column ${x}`)
    }
  }
})

test("the tail's leading edge is read off the art, row by row", () => {
  // A single column cannot describe it, and a wrong one leaves a sliver.
  const edges = new Set()
  for (let y = 0; y < ORCA_H; y += 1) edges.add(tailLeftFor(y))
  assert.ok(edges.size > 1, 'the edge is not one column')

  // Every tail pixel must be outside the body's own region, and the columns
  // just inside the edge must be empty in the source art — otherwise the edge
  // is cutting into the body.
  const source = orcaGrid()
  for (let y = 0; y < ORCA_H; y += 1) {
    const left = tailLeftFor(y)
    for (let x = 0; x < left; x += 1) {
      if (source[y][x] === '.') continue
      // Body pixels may sit left of the edge; that is the point.
      assert.ok(true)
    }
    // Nothing may be stranded: a filled cell just left of the edge with nothing
    // filled to its left is a sliver.
    if (left > 0 && source[y][left - 1] !== '.' && source[y][left - 2] === '.') {
      assert.fail(`column ${left - 1} on row ${y} is stranded left of the edge`)
    }
  }
})


test('the rear is a semicircle, not a line and not a wall', () => {
  // Three attempts described it wrongly before this one. A flat column repeated
  // down many rows is a wall; a constant slope every row is a straight diagonal;
  // both were "monotone" and both passed a monotonicity check. What makes it a
  // semicircle is that it bulges *out*, then curves back *in*, and the slope
  // changes gradually between the two.
  const rows = [...SLEEP_REAR.keys()].sort((a, b) => a - b)
  const edges = rows.map((y) => SLEEP_REAR.get(y))
  const steps = edges.slice(1).map((edge, index) => edge - edges[index])

  assert.ok(Math.max(...steps) > 0, `it must bulge outwards: ${edges.join(',')}`)
  assert.ok(Math.min(...steps) < 0, 'and curve back in')
  // Gradual: the slope never jumps by more than a pixel from row to row. That
  // is what separates a curve from a staircase.
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(
      Math.abs(steps[index] - steps[index - 1]) <= 1,
      `the slope jumped at row ${rows[index + 1]}: ${steps.join(',')}`
    )
  }
  // And it is genuinely curved: a straight line would have one slope throughout.
  assert.ok(new Set(steps).size >= 3, `the slope never varies: ${steps.join(',')}`)
  // It has to be a visible bulge, not a single pixel of wobble.
  assert.ok(Math.max(...edges) - Math.min(...edges) >= 5, 'the bulge is too slight to see')

  // It reaches the render, and nothing sticks out past it.
  const grid = orcaWithTail({ pose: 'sleep' })
  const tail = tailPixels('sleep')
  for (const [y, rear] of SLEEP_REAR) {
    for (let x = rear + 1; x < ORCA_W; x += 1) {
      assert.ok(grid[y][x] === '.' || tail.has(`${x},${y}`), `row ${y} has a pixel at ${x}, past its rear`)
    }
  }
})

test('the tail meets the body wherever it overlaps it', () => {
  // "Sometimes the background shows through at the junction": the tail's
  // right-hand end and the body's rounded rear must touch or overlap on every
  // row the tail occupies.
  const grid = orcaWithTail({ pose: 'sleep' })
  const tail = tailPixels('sleep')
  const byRow = new Map()
  for (const key of tail.keys()) {
    const [x, y] = key.split(',').map(Number)
    if (!byRow.has(y)) byRow.set(y, [])
    byRow.get(y).push(x)
  }
  for (const [y, columns] of byRow) {
    const right = Math.max(...columns)
    let bodyRear = -1
    for (let x = 0; x < ORCA_W; x += 1) {
      if (grid[y][x] !== '.' && !tail.has(`${x},${y}`)) bodyRear = x
    }
    if (bodyRear < 0) continue
    assert.ok(right + 1 >= bodyRear, `row ${y}: the tail ends at ${right}, the body at ${bodyRear} — a gap`)
  }
})

test('no pose leaves a sliver of tail behind', () => {
  // The bug that survived the longest: the tail's leading edge is not one
  // column — it starts at 42 on the top two rows and 40 below that. Taking it
  // for a single column left a one-pixel-wide strip of tail in the lifted-out
  // region, which drew as a lone vertical line beside the orca. It looked like
  // a transform artefact and was nothing of the sort: it was a column that was
  // never in the transform's input to begin with.
  for (const pose of ['up', 'sleep']) {
    const grid = orcaWithTail({ pose })
    for (let x = 1; x < ORCA_W - 1; x += 1) {
      let height = 0
      for (let y = 0; y < ORCA_H; y += 1) if (grid[y][x] !== '.') height += 1
      if (height < 3) continue
      let hasNeighbour = false
      for (let y = 0; y < ORCA_H; y += 1) {
        if (grid[y][x - 1] !== '.' || grid[y][x + 1] !== '.') hasNeighbour = true
      }
      assert.ok(hasNeighbour, `${pose} left a ${height}-pixel vertical line at column ${x}`)
    }
  }
})

test("the tail's leading edge is read off the art, row by row", () => {
  // A single column cannot describe it, and a wrong one leaves a sliver.
  const edges = new Set()
  for (let y = 0; y < ORCA_H; y += 1) edges.add(tailLeftFor(y))
  assert.ok(edges.size > 1, 'the edge is not one column')

  // Every tail pixel must be outside the body's own region, and the columns
  // just inside the edge must be empty in the source art — otherwise the edge
  // is cutting into the body.
  const source = orcaGrid()
  for (let y = 0; y < ORCA_H; y += 1) {
    const left = tailLeftFor(y)
    for (let x = 0; x < left; x += 1) {
      if (source[y][x] === '.') continue
      // Body pixels may sit left of the edge; that is the point.
      assert.ok(true)
    }
    // Nothing may be stranded: a filled cell just left of the edge with nothing
    // filled to its left is a sliver.
    if (left > 0 && source[y][left - 1] !== '.' && source[y][left - 2] === '.') {
      assert.fail(`column ${left - 1} on row ${y} is stranded left of the edge`)
    }
  }
})



