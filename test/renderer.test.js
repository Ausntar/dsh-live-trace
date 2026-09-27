/**
 * Renderer layout: the 80-column contract and every degenerate size.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBodyLines, composeLR, groupRepeats, renderFrame, renderPlainEntry, renderPlainLines, MIN_COLS, MIN_ROWS } from '../src/cli/renderer.js'
import { createTheme } from '../src/cli/theme.js'
import { applyRecord, createViewState } from '../src/cli/view-state.js'
import { displayWidth, renderRow, rowWidth } from '../src/cli/width.js'
import { stripAnsi } from './helpers/util.js'

const AT = 1_760_000_000_000
const THEME = createTheme({ color: true })

/** Build a realistic state using the shapes the plugin actually puts on the wire. */
export function sampleState() {
  const state = createViewState()
  applyRecord(state, {
    kind: 'hello',
    server: { pid: 4242, profile: 'web', cwd: '/home/developer/DeepseekHarness', version: '0.1.7-rc.1' },
    sessions: [
      {
        id: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45',
        createdAt: AT,
        cwd: '/home/developer/DeepseekHarness',
        title: 'live trace plugin',
        turn: 3,
        step: 2,
        activity: 'tool',
        lastEventAt: AT
      },
      { id: 'session-other', createdAt: AT - 1000, cwd: '/tmp', title: 'other work', turn: 10, step: 1, activity: 'running' }
    ],
    activeSessionId: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45'
  })
  const sessionId = state.sessionId
  const push = (entry) => applyRecord(state, { kind: 'entry', sessionId, entry: { seq: 0, time: AT, ...entry } })

  push({ tag: 'turn', label: 'TURN 3', event: 'turn/start', text: 'turn started', turn: 3 })
  push({ tag: 'step', label: 'STEP 1', text: 'model call started', turn: 3, step: 1 })
  push({
    tag: 'assistant',
    label: 'ASSISTANT',
    text: '已完成修改并验证通过。',
    rawText: '**已完成**修改并验证通过。\n\n- 新增 `src/auth.ts`\n- 测试通过',
    reasoning: '先读取文件再决定改动范围',
    turn: 3,
    step: 1
  })

  // A tool call and its result share a key, so only the settled block remains.
  push({
    tag: 'tool',
    label: 'TOOL',
    phase: 'call',
    key: 'tool:c1',
    callId: 'c1',
    tool: 'read_file',
    filePath: 'src/index.ts',
    text: 'read_file path="src/index.ts"',
    turn: 3,
    step: 1
  })
  push({
    tag: 'tool',
    label: 'TOOL',
    phase: 'result',
    key: 'tool:c1',
    callId: 'c1',
    tool: 'read_file',
    filePath: 'src/index.ts',
    text: '返回 234 行',
    rawText: '返回 234 行',
    ok: true,
    level: 'success',
    durationMs: 120,
    turn: 3,
    step: 1
  })

  push({ tag: 'step', label: 'STEP 2', text: 'model call started', turn: 3, step: 2 })
  const shell = { command: 'npm test', description: 'Run the test suite' }
  push({
    tag: 'tool',
    label: 'TOOL',
    phase: 'call',
    key: 'tool:c2',
    callId: 'c2',
    tool: 'bash',
    shell,
    text: 'bash command="npm test"',
    turn: 3,
    step: 2
  })
  push({
    tag: 'tool',
    label: 'TOOL',
    phase: 'result',
    key: 'tool:c2',
    callId: 'c2',
    tool: 'bash',
    shell,
    shellStatus: { exitCode: 0 },
    output: { text: 'PASS src/auth.test.ts\n✓ 12 passed', lines: 2, truncated: false, omitted: 0 },
    text: '测试通过 (12 passed)',
    rawText: '测试通过 (12 passed)\n[exit code: 0]',
    ok: true,
    level: 'success',
    durationMs: 3400,
    turn: 3,
    step: 2
  })
  push({ tag: 'approval', label: 'APPROVAL', text: 'bash — runs outside the sandbox', level: 'warn' })
  push({ tag: 'error', label: 'ERROR', text: 'provider exploded', level: 'error' })
  push({
    tag: 'assistant',
    label: 'ASSISTANT',
    text: '已完成修改并验证通过。',
    rawText: '已完成修改并验证通过。',
    turn: 3,
    step: 2
  })

  const longPath = 'a/very/long/path/that/keeps/going/and/going/and/going/until/it/must/wrap.ts'
  push({
    tag: 'tool',
    label: 'TOOL',
    phase: 'call',
    key: 'tool:c3',
    callId: 'c3',
    tool: 'write_file',
    filePath: longPath,
    text: `write_file path="${longPath}"`,
    turn: 3,
    step: 2
  })
  push({
    tag: 'tool',
    label: 'TOOL',
    phase: 'result',
    key: 'tool:c3',
    callId: 'c3',
    tool: 'write_file',
    filePath: longPath,
    text: 'written',
    rawText: 'written',
    ok: false,
    level: 'error',
    detail: 'EACCES: permission denied',
    operation: 'update',
    diffs: [{ path: 'src/auth.ts', oldText: 'const a = 1', newText: 'const a = 2\nexport const b = 3' }],
    durationMs: 40,
    turn: 3,
    step: 2
  })

  applyRecord(state, { kind: 'edits', sessionId, edits: [
    { path: 'src/auth.ts', added: 12, removed: 3, operation: 'update', calls: 2, hunks: [
      { path: 'src/auth.ts', oldText: 'const a = 1', newText: 'const a = 2' }
    ] },
    { path: 'src/new.ts', added: 8, removed: 0, operation: 'create', calls: 1, hunks: [
      { path: 'src/new.ts', oldText: null, newText: 'export const x = 1' }
    ] }
  ] })
  applyRecord(state, {
    kind: 'status',
    sessionId,
    status: 'running',
    agentStatus: 'running',
    turn: 3,
    step: 2,
    maxStep: 2,
    since: AT + 1000,
    streamActive: true
  })
  applyRecord(state, {
    kind: 'usage',
    sessionId,
    usage: { inputTokens: 3800, outputTokens: 420, totalTokens: 4220 },
    contextWindow: 128000
  })
  applyRecord(state, { kind: 'stream', sessionId, turn: 3, step: 2, text: '正在检查测试结果…', reasoning: '考虑是否需要补充回归测试' })
  return state
}

/** Every printable character the frame shows, with escape sequences removed. */
function frameText(lines) {
  return lines.map(stripAnsi).join('\n')
}

test('a frame has exactly one row per terminal row', () => {
  const state = sampleState()
  for (const rows of [MIN_ROWS, 12, 24, 40, 60]) {
    const lines = renderFrame(state, { cols: 80, rows, theme: THEME, now: AT + 12_300, frame: 3 })
    assert.equal(lines.length, rows, `rows=${rows}`)
  }
})

test('every frame row occupies exactly the terminal width', () => {
  const state = sampleState()
  for (const cols of [24, 25, 30, 40, 60, 79, 80, 100, 132, 200]) {
    for (const rows of [MIN_ROWS, 20, 24, 40]) {
      const lines = renderFrame(state, { cols, rows, theme: THEME, now: AT + 12_300, frame: 3 })
      assert.equal(lines.length, rows)
      lines.forEach((line, index) => {
        const width = displayWidth(stripAnsi(line))
        assert.equal(width, cols, `cols=${cols} rows=${rows} line=${index} width=${width}`)
      })
    }
  }
})

test('CJK content never breaks row alignment', () => {
  const state = createViewState()
  applyRecord(state, {
    kind: 'hello',
    server: { pid: 1 },
    sessions: [{ id: 's', createdAt: AT, cwd: '/工作目录/项目', title: '中文标题' }],
    activeSessionId: 's'
  })
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's',
    entry: { seq: 1, time: AT, tag: 'assistant', label: 'ASSISTANT', text: '中文推理中'.repeat(20) }
  })
  for (const cols of [40, 80]) {
    const lines = renderFrame(state, { cols, rows: 24, theme: THEME, now: AT, frame: 0 })
    for (const line of lines) assert.equal(displayWidth(stripAnsi(line)), cols)
  }
})

test('the frame shows the documented labels, status, and footer figures', () => {
  const state = sampleState()
  const text = frameText(renderFrame(state, { cols: 100, rows: 30, theme: THEME, now: AT + 12_300, frame: 3 }))

  assert.match(text, /dsh-live-trace/)
  assert.match(text, /Session: /)
  assert.match(text, /Status: /)
  assert.match(text, /running/)
  assert.match(text, /\[TURN 3\]/)
  assert.match(text, /\[STEP 1\]/)
  assert.match(text, /\[STEP 2\]/)
  assert.match(text, /\[TOOL\]/)
  assert.doesNotMatch(text, /\[RESULT\]/, 'a settled call and its result are one block')
  assert.match(text, /\[ASSISTANT\]/)
  assert.match(text, /\[APPROVAL\]/)
  assert.match(text, /\[ERROR\]/)
  assert.match(text, /✓/)
  assert.match(text, /✗/)
  assert.match(text, /T3/)
  assert.match(text, /S2/)
  assert.match(text, /Tokens /)
  assert.match(text, /4\.2K/)
  assert.match(text, /128K/)
  assert.match(text, /12\.3s/)
})

test('a turn opening renders as a full-width rule', () => {
  const state = sampleState()
  const lines = renderFrame(state, { cols: 80, rows: 30, theme: THEME, now: AT, frame: 0 }).map(stripAnsi)
  const rule = lines.find((line) => line.includes('[TURN 3]'))
  assert.ok(rule !== undefined)
  assert.match(rule, /─/)
})

test('the live thinking indicator appears while streaming and disappears when settled', () => {
  const state = sampleState()
  const withStream = frameText(renderFrame(state, { cols: 100, rows: 30, theme: THEME, now: AT, frame: 0 }))
  // Reasoning and visible output stream on their own rows.
  assert.match(withStream, /thinking ┊ 考虑是否需要补充回归测试/)
  assert.match(withStream, /writing ┊ 正在检查测试结果/)

  applyRecord(state, { kind: 'stream-end', sessionId: state.sessionId })
  const withoutStream = frameText(renderFrame(state, { cols: 100, rows: 30, theme: THEME, now: AT, frame: 0 }))
  assert.doesNotMatch(withoutStream, /thinking ┊/)
  assert.doesNotMatch(withoutStream, /writing ┊/)
})

test('untrusted content cannot inject escape sequences into the frame', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's',
    entry: {
      seq: 1,
      time: AT,
      tag: 'assistant',
      label: 'ASSISTANT',
      text: '\u001b[2J\u001b[Hpwned\u0007'
    }
  })
  const lines = renderFrame(state, { cols: 80, rows: 24, theme: THEME, now: AT, frame: 0 })
  const text = stripAnsi(lines.join('\n'))
  assert.doesNotMatch(text, /pwned[\s\S]*\u001b\[2J/)
  // The escape bytes themselves never survive; only the renderer's own SGR codes remain.
  const raw = lines.join('\n')
  const unexpected = raw.replace(/\u001b\[[0-9;]*m/g, '')
  assert.doesNotMatch(unexpected, /\u001b/)
})

test('a terminal below the minimum size explains itself instead of drawing garbage', () => {
  const state = sampleState()
  const lines = renderFrame(state, { cols: MIN_COLS - 1, rows: MIN_ROWS - 1, theme: THEME, now: AT, frame: 0 })
  assert.equal(lines.length, MIN_ROWS - 1)
  const text = stripAnsi(lines.join('\n'))
  assert.match(text, /too small/i)
  assert.match(text, new RegExp(`${MIN_COLS}`))
})

test('scrolling offsets the window and reports how much is hidden', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  for (let index = 0; index < 40; index += 1) {
    applyRecord(state, {
      kind: 'entry',
      sessionId: 's',
      entry: { seq: index, time: AT, tag: 'step', label: `STEP ${index}`, text: `event number ${index}` }
    })
  }

  const bottom = renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0, scrollOffset: 0 }).map(stripAnsi)
  const scrolled = renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0, scrollOffset: 10 }).map(stripAnsi)

  const bottomText = bottom.join('\n')
  const scrolledText = scrolled.join('\n')
  assert.notDeepEqual(bottom, scrolled)
  // Pinned to the bottom: newest entry visible, no explicit offset reported.
  assert.match(bottomText, /STEP 39/)
  assert.doesNotMatch(bottomText, /↑10/)
  // Scrolled up ten lines: the newest entry is off-screen and the offset is shown.
  assert.match(scrolledText, /↑10/)
  assert.doesNotMatch(scrolledText, /STEP 39/)
})

test('an over-large scroll offset saturates instead of overflowing', () => {
  const state = sampleState()
  const lines = renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0, scrollOffset: 99_999 })
  for (const line of lines) assert.equal(displayWidth(stripAnsi(line)), 80)
})

test('paused mode is visible in the footer', () => {
  const state = sampleState()
  const text = frameText(renderFrame(state, { cols: 100, rows: 24, theme: THEME, now: AT, frame: 0, paused: true }))
  assert.match(text, /paused/)
})

test('the help overlay replaces the body and keeps the frame aligned', () => {
  const state = sampleState()
  const lines = renderFrame(state, { cols: 80, rows: 24, theme: THEME, now: AT, frame: 0, help: true })
  assert.equal(lines.length, 24)
  for (const line of lines) assert.equal(displayWidth(stripAnsi(line)), 80)
  assert.match(frameText(lines), /Key bindings/)
})

test('a disconnected empty board still renders a coherent frame', () => {
  const state = createViewState()
  const lines = renderFrame(state, { cols: 80, rows: 24, theme: THEME, now: AT, frame: 0 })
  assert.equal(lines.length, 24)
  for (const line of lines) assert.equal(displayWidth(stripAnsi(line)), 80)
  assert.match(frameText(lines), /Connecting/)
})

test('a monochrome theme emits no SGR sequences', () => {
  const theme = createTheme({ color: false })
  const lines = renderFrame(sampleState(), { cols: 80, rows: 24, theme, now: AT, frame: 0 })
  assert.doesNotMatch(lines.join('\n'), /\u001b/)
  for (const line of lines) assert.equal(displayWidth(line), 80)
})

test('plain mode produces one bounded line per entry', () => {
  const state = sampleState()
  const lines = renderPlainLines(state, { cols: 60 })
  assert.equal(lines.length, state.entries.length)
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 60, `plain line exceeded 60: ${line}`)
    assert.doesNotMatch(line, /\u001b/)
  }
  const joined = lines.join('\n')
  assert.match(joined, /\[TOOL\] ✓/)
  assert.match(joined, /\[TOOL\] ✗/)
  assert.match(joined, /exit 0/)
  assert.doesNotMatch(joined, /\[RESULT\]/, 'a settled call and its result are one line, not two')
  assert.match(lines[0], /^\d{2}:\d{2}:\d{2} /)
})

test('renderPlainEntry reports tool duration and exit status', () => {
  const line = renderPlainEntry(
    { at: AT, tag: 'tool', phase: 'result', label: 'TOOL', text: 'ok', ok: true, durationMs: 1500, shell: { command: 'ls' }, shellStatus: { exitCode: 0 } },
    200
  )
  assert.match(line, /✓ ok/)
  assert.match(line, /exit 0/)
  assert.match(line, /1\.5s/)

  const legacy = renderPlainEntry({ at: AT, tag: 'result', label: 'RESULT', text: 'ok', ok: true, durationMs: 1500 }, 200)
  assert.match(legacy, /✓ ok/, 'a result entry with no merged block still shows its mark')
})

test('composeLR keeps both ends when there is room and degrades predictably when not', () => {
  const wide = composeLR([{ text: 'left' }], [{ text: 'right' }], 20)
  assert.equal(rowWidth(wide), 20)
  assert.equal(
    wide.map((segment) => segment.text).join(''),
    'left           right'
  )

  const narrow = composeLR([{ text: 'a'.repeat(30) }], [{ text: 'right' }], 20)
  assert.ok(rowWidth(narrow) <= 20)

  const tiny = composeLR([{ text: 'a'.repeat(30) }], [{ text: 'r'.repeat(30) }], 10)
  assert.ok(rowWidth(tiny) <= 10)
})

test('runs of identical entries collapse into one counted line', () => {
  const groups = groupRepeats([
    { tag: 'meta', label: 'NOISE', text: 'same', time: AT },
    { tag: 'meta', label: 'NOISE', text: 'same', time: AT + 10 },
    { tag: 'meta', label: 'NOISE', text: 'same', time: AT + 20 },
    { tag: 'step', label: 'STEP 1', text: 'model call started', time: AT + 30 },
    { tag: 'meta', label: 'NOISE', text: 'different', time: AT + 40 }
  ])
  assert.equal(groups.length, 3)
  assert.equal(groups[0].count, 3)
  assert.equal(groups[0].entry.at ?? groups[0].entry.time, AT + 20, 'the newest occurrence supplies the time')
  assert.equal(groups[1].count, 1)
  assert.equal(groups[2].count, 1)
  assert.deepEqual(groupRepeats([]), [])
})

test('a counted run renders as ×N without breaking alignment', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  for (let index = 0; index < 4; index += 1) {
    applyRecord(state, {
      kind: 'entry',
      sessionId: 's',
      entry: { seq: index, time: AT + index, tag: 'meta', label: 'NOISE', text: 'repeating bookkeeping record' }
    })
  }
  const lines = renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0 })
  for (const line of lines) assert.equal(displayWidth(stripAnsi(line)), 80)
  const text = frameText(lines)
  assert.match(text, /×4 repeating bookkeeping record/)
  // The four entries became a single body line.
  assert.equal(frameText(lines).split('repeating bookkeeping record').length - 1, 1)
})

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

test('every panel keeps the exact-width contract at every size', () => {
  const state = sampleState()
  for (const view of ['trace', 'sessions', 'edits', 'commands']) {
    for (const cols of [24, 30, 40, 60, 80, 132]) {
      for (const rows of [MIN_ROWS, 20, 30]) {
        const lines = renderFrame(state, { cols, rows, theme: THEME, now: AT, frame: 0, view })
        assert.equal(lines.length, rows, `${view} ${cols}x${rows}`)
        lines.forEach((line, index) => {
          assert.equal(displayWidth(stripAnsi(line)), cols, `${view} ${cols}x${rows} line ${index}`)
        })
      }
    }
  }
})

test('the sessions panel lists every session and marks the bound one', () => {
  const state = sampleState()
  const text = frameText(renderFrame(state, { cols: 100, rows: 24, theme: THEME, now: AT, frame: 0, view: 'sessions' }))
  assert.match(text, /SESSIONS/)
  assert.match(text, /live trace plugin/)
  assert.match(text, /other work/)
  assert.match(text, /running/)
  assert.match(text, /2 known/)
  assert.match(text, /●/, 'the bound session is marked')
})

test('the sessions panel explains an empty Harness instead of showing a blank box', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [], activeSessionId: null })
  const text = frameText(renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0, view: 'sessions' }))
  assert.match(text, /No sessions yet/)
})

test('the edits panel shows totals and the selected file diff', () => {
  const state = sampleState()
  const text = frameText(renderFrame(state, { cols: 90, rows: 26, theme: THEME, now: AT, frame: 0, view: 'edits' }))
  assert.match(text, /FILE CHANGES/)
  assert.match(text, /2 files/)
  assert.match(text, /\+20 −3/, 'aggregate counts')
  assert.match(text, /src\/auth\.ts/)
  assert.match(text, /src\/new\.ts/)
  assert.match(text, /@@ src\/auth\.ts/)
  assert.match(text, /- const a = 1/)
  assert.match(text, /\+ const a = 2/)
})

test('the edits panel explains an untouched session', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  const text = frameText(renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0, view: 'edits' }))
  assert.match(text, /No file changes recorded/)
})

test('the commands panel shows each command with its output and exit status', () => {
  const state = sampleState()
  const text = frameText(renderFrame(state, { cols: 90, rows: 30, theme: THEME, now: AT, frame: 0, view: 'commands' }))
  assert.match(text, /COMMANDS/)
  assert.match(text, /npm test/)
  assert.match(text, /Run the test suite/)
  assert.match(text, /PASS src\/auth\.test\.ts/)
  assert.match(text, /exit 0/)
  assert.match(text, /3\.4s/)
})

test('the commands panel explains a session that ran nothing', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  const text = frameText(renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0, view: 'commands' }))
  assert.match(text, /No shell commands/)
})

/* ------------------------------------------------------------------ *
 * Merged tool blocks and markdown
 * ------------------------------------------------------------------ */

test('a tool result replaces the row its call opened', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  const send = (entry) => applyRecord(state, { kind: 'entry', sessionId: 's', entry: { seq: 0, time: AT, ...entry } })

  send({ tag: 'tool', label: 'TOOL', phase: 'call', key: 'tool:x', tool: 'bash', shell: { command: 'ls' }, text: 'bash' })
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].phase, 'call')

  send({ tag: 'tool', label: 'TOOL', phase: 'result', key: 'tool:x', tool: 'bash', shell: { command: 'ls' }, ok: true, durationMs: 12, text: 'done' })
  assert.equal(state.entries.length, 1, 'the settled block reuses the row')
  assert.equal(state.entries[0].phase, 'result')
  assert.equal(state.entries[0].durationMs, 12)

  const text = frameText(renderFrame(state, { cols: 90, rows: 20, theme: THEME, now: AT, frame: 0 }))
  assert.match(text, /✓/)
  assert.match(text, /exit 0/)
  assert.doesNotMatch(text, /running/, 'the stale running marker is gone')
})

test('assistant prose is rendered as markdown, and raw mode turns it off', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's',
    entry: {
      seq: 0,
      time: AT,
      tag: 'assistant',
      label: 'ASSISTANT',
      text: '已完成修改并验证通过。 - 新增 src/auth.ts',
      rawText: '# 结果\n\n**已完成**修改并验证通过。\n\n- 新增 `src/auth.ts`',
      reasoning: '先看代码再决定',
      turn: 1,
      step: 1
    }
  })

  const styled = frameText(renderFrame(state, { cols: 80, rows: 26, theme: THEME, now: AT, frame: 0 }))
  assert.match(styled, /结果/, 'the heading text renders without its marker')
  assert.doesNotMatch(styled, /^# 结果$/m)
  assert.match(styled, /已完成修改并验证通过/)
  assert.match(styled, /• 新增 src\/auth\.ts/, 'the bold runs into the list item')
  assert.match(styled, /┊ 先看代码再决定/, 'thinking gets its own gutter')

  const raw = frameText(renderFrame(state, { cols: 80, rows: 26, theme: THEME, now: AT, frame: 0, rawText: true }))
  assert.match(raw, /# 结果/, 'raw mode shows the markdown source')
  assert.match(raw, /\*\*已完成\*\*/)
})

test('a code fence in an assistant message is syntax highlighted', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's',
    entry: {
      seq: 0,
      time: AT,
      tag: 'assistant',
      label: 'ASSISTANT',
      text: 'export const answer = 42',
      rawText: '```ts\nexport const answer = 42\n```',
      turn: 1,
      step: 1
    }
  })
  const ansi = renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0 }).join('\n')
  assert.match(stripAnsi(ansi), /export const answer = 42/)
  assert.ok(ansi.includes(`\u001b[${THEME.syn.keyword}m`), 'the keyword carries the syntax palette')
})

test('entries from an older plugin (no phase) still render correctly', () => {
  // Before the merged-block protocol, a call was tagged `tool` and its result
  // `result`, with no `phase` at all. The viewer must not read a running call as
  // finished just because the marker is missing.
  const plainRunning = renderPlainEntry({ at: AT, tag: 'tool', label: 'TOOL', text: 'bash command="ls"', tool: 'bash' }, 200)
  assert.match(plainRunning, /\[TOOL\] bash command="ls"/)
  assert.match(plainRunning, /running/)
  assert.doesNotMatch(plainRunning, /✓/)

  const plainSettled = renderPlainEntry({ at: AT, tag: 'result', label: 'RESULT', text: '返回 234 行', tool: 'read_file', ok: true, durationMs: 120 }, 200)
  assert.match(plainSettled, /\[RESULT\] ✓ read_file 返回 234 行/)

  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  for (const entry of [
    { seq: 0, time: AT, tag: 'tool', label: 'TOOL', text: 'bash command="ls"', callId: 'old-1', tool: 'bash' },
    { seq: 1, time: AT + 1, tag: 'result', label: 'RESULT', text: 'ok', callId: 'old-1', tool: 'bash', ok: true, durationMs: 50 }
  ]) {
    applyRecord(state, { kind: 'entry', sessionId: 's', entry })
  }
  const text = frameText(renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0 }))
  assert.match(text, /\[TOOL\]\s+bash command="ls"/, 'the running call renders as a call')
  assert.match(text, /\[RESULT\]/, 'and its result keeps its own label')
  assert.match(text, /✓/)
})

/* ------------------------------------------------------------------ *
 * Windowing, thinking, and command highlighting
 * ------------------------------------------------------------------ */

/** A state with `count` assistant entries, each rendering several rows. */
function longState(count) {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  for (let index = 0; index < count; index += 1) {
    applyRecord(state, {
      kind: 'entry',
      sessionId: 's',
      entry: {
        seq: index,
        time: AT + index,
        tag: 'assistant',
        label: 'ASSISTANT',
        text: `message ${index}`,
        rawText: `## Step ${index}\n\nFixed \`thing ${index}\`.\n\n- a\n- b`,
        turn: 1,
        step: index
      }
    })
  }
  return state
}

test('a windowed trace paints exactly the rows the full render would', () => {
  const state = longState(60)
  const context = { contentWidth: 76, theme: THEME, now: AT, frame: 0, options: {} }
  const full = buildBodyLines(state, context)

  for (const rows of [10, 20, 30]) {
    const bodyRows = rows - 6
    for (const scrollOffset of [0, 1, 5, 40, 500]) {
      const frame = renderFrame(state, { cols: 80, rows, theme: THEME, now: AT, frame: 0, scrollOffset }, {})
      const maxTop = Math.max(0, full.length - bodyRows)
      const start = Math.max(0, maxTop - Math.min(scrollOffset, maxTop))
      const expected = full.slice(start, start + bodyRows)
      // Frame rows carry the box border and right padding; compare the content.
      const painted = frame.slice(3, 3 + bodyRows).map((line) => stripAnsi(line).slice(2, -2).replace(/\s+$/, ''))

      assert.equal(painted.length, bodyRows)
      expected.forEach((row, index) => {
        assert.equal(painted[index], stripAnsi(renderRow(row)).replace(/\s+$/, ''), `rows=${rows} offset=${scrollOffset} row=${index}`)
      })
    }
  }
})

test('the windowed renderer only touches the entries it paints', () => {
  const state = longState(4000)
  const started = process.hrtime.bigint()
  const frames = 10
  for (let index = 0; index < frames; index += 1) {
    renderFrame(state, { cols: 80, rows: 30, theme: THEME, now: AT, frame: index })
  }
  const perFrame = Number(process.hrtime.bigint() - started) / 1e6 / frames
  // The original implementation rendered the whole log per frame (seconds at
  // this size); a generous bound still catches that regression.
  assert.ok(perFrame < 60, `expected a frame under 60ms, took ${perFrame.toFixed(1)}ms`)
})

test('thinking is visible by default and only a key press collapses it', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  const reasoning = Array.from({ length: 20 }, (_, index) => `reasoning line ${index}`).join('\n\n')
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's',
    entry: { seq: 0, time: AT, tag: 'assistant', label: 'ASSISTANT', text: 'answer', rawText: 'answer', reasoning, turn: 1, step: 1 }
  })

  // Default: the whole block is on screen, so the trace follows the model's
  // reasoning without the reader having to open it.
  const byDefault = frameText(renderFrame(state, { cols: 80, rows: 200, theme: THEME, now: AT, frame: 0 }))
  assert.match(byDefault, /reasoning line 0/)
  assert.match(byDefault, /reasoning line 19/, 'the tail is shown too')
  assert.match(byDefault, /e\s+to collapse/)

  // Only an explicit toggle folds it.
  const collapsed = frameText(
    renderFrame(state, { cols: 80, rows: 30, theme: THEME, now: AT, frame: 0, expandThinking: false })
  )
  assert.match(collapsed, /reasoning line 0/)
  assert.doesNotMatch(collapsed, /reasoning line 19/)
  assert.match(collapsed, /more lines\s+e\s+to expand/)

  const tighter = frameText(
    renderFrame(state, { cols: 80, rows: 30, theme: THEME, now: AT, frame: 0, expandThinking: false, thinkingLines: 1 })
  )
  assert.match(tighter, /reasoning line 0/)
  assert.doesNotMatch(tighter, /reasoning line 1$/)
})

test('shell commands are syntax highlighted in the trace', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's',
    entry: {
      seq: 0,
      time: AT,
      tag: 'tool',
      label: 'TOOL',
      phase: 'result',
      tool: 'bash',
      shell: { command: 'npm test --silent && echo "done"', description: 'Run the tests' },
      output: { text: 'ok', lines: 1, truncated: false, omitted: 0 },
      ok: true,
      durationMs: 900
    }
  })
  const ansi = renderFrame(state, { cols: 90, rows: 20, theme: THEME, now: AT, frame: 0 }).join('\n')
  const plain = stripAnsi(ansi)
  assert.match(plain, /\$ npm test --silent && echo "done"/)
  assert.ok(ansi.includes(`\u001b[${THEME.syn.function}m`), 'the command name is coloured')
  assert.ok(ansi.includes(`\u001b[${THEME.syn.string}m`), 'the quoted argument is coloured')
})

test('a long command wraps with a hanging indent and no prompt repeat', () => {
  const state = createViewState()
  applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions: [{ id: 's', createdAt: AT }], activeSessionId: 's' })
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's',
    entry: {
      seq: 0,
      time: AT,
      tag: 'tool',
      label: 'TOOL',
      phase: 'call',
      tool: 'bash',
      shell: { command: `echo ${'x'.repeat(200)}` },
      text: 'bash'
    }
  })
  const lines = renderFrame(state, { cols: 80, rows: 20, theme: THEME, now: AT, frame: 0 }).map(stripAnsi)
  assert.equal(lines.filter((line) => line.includes('$ echo')).length, 1, 'the prompt appears once')
  for (const line of lines) assert.equal(displayWidth(line), 80)
})

test('live thinking is a readable block, not one line', () => {
  const state = createViewState()
  applyRecord(state, {
    kind: 'hello',
    server: { pid: 1, profile: 'web', cwd: '/tmp', version: '1' },
    sessions: [{ id: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45', createdAt: AT, cwd: '/tmp', title: 't', turn: 1, step: 1, activity: 'running', lastEventAt: AT }],
    activeSessionId: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45'
  })
  // Long reasoning, still streaming: nothing has been committed yet.
  state.stream = {
    reasoning: Array.from({ length: 12 }, (_, index) => `第${index + 1}步：先看调用方，再决定是否要拆出独立模块。`).join(''),
    text: ''
  }
  const lines = renderFrame(state, { cols: 80, rows: 30, theme: THEME, now: AT, frame: 0 })
  const thinking = lines.filter((line) => stripAnsi(line).includes('┊'))

  assert.ok(thinking.length >= 8, `live thinking occupied only ${thinking.length} rows`)
  // It is wrapped, not a single long line cut short.
  for (const line of thinking) assert.ok(displayWidth(stripAnsi(line)) <= 80, 'and never wider than the screen')
  const text = thinking.map(stripAnsi).join('\n')
  assert.match(text, /第1步/, 'the block starts where the reasoning does')
  // Word wrapping can split a number across rows, so check the ending rather
  // than a phrase that may straddle a line break.
  // The panel border trails every row, so the ending is checked within the row.
  assert.match(stripAnsi(thinking.at(-1)), /独立模块。/, 'and reaches the newest part')
})

test('a long error never squeezes the session out of the header', () => {
  const state = createViewState()
  applyRecord(state, {
    kind: 'hello',
    server: { pid: 1, profile: 'web', cwd: '/tmp', version: '1' },
    sessions: [{
      id: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45',
      createdAt: AT,
      cwd: '/mnt/ubuntu/home/coder/代码/FloatLight',
      title: '全自然环境与房间没有区别，声音素材放在工作区里',
      turn: 1,
      step: 1,
      activity: 'error',
      lastEventAt: AT
    }],
    activeSessionId: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45'
  })
  state.status = { status: 'error', error: '连接中断'.repeat(20) }

  for (const cols of [60, 72, 80, 100, 120, 200]) {
    const header = stripAnsi(renderFrame(state, { cols, rows: 24, theme: THEME, now: AT, frame: 0 })[1])
    // The session is the one thing the header exists to tell you. Ids are shown
    // tail-first, so the tail is what must survive.
    assert.match(header, /8d66-0bb3b8c30c45/, `at ${cols} columns the session vanished: ${JSON.stringify(header)}`)
    assert.ok(displayWidth(header) <= cols, `at ${cols} columns the header overflowed`)
  }
})

test('the header still gives up the title before the id', () => {
  const state = createViewState()
  applyRecord(state, {
    kind: 'hello',
    server: { pid: 1, profile: 'web', cwd: '/tmp', version: '1' },
    sessions: [{ id: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45', createdAt: AT, cwd: '/tmp', title: '一个非常长的会话标题'.repeat(4), turn: 1, step: 1, activity: 'idle', lastEventAt: AT }],
    activeSessionId: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45'
  })
  const header = stripAnsi(renderFrame(state, { cols: 64, rows: 24, theme: THEME, now: AT, frame: 0 })[1])
  assert.match(header, /8d66-0bb3b8c30c45/, 'the id survives')
  assert.equal(header.includes('一个非常长的会话标题'.repeat(4)), false, 'the title is what gets cut')
  assert.match(header, /Status/, 'and the status is still there')
})

test('live thinking is formatted, not shown as its own syntax', () => {
  const state = createViewState()
  applyRecord(state, {
    kind: 'hello',
    server: { pid: 1, profile: 'web', cwd: '/tmp', version: '1' },
    sessions: [{ id: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45', createdAt: AT, cwd: '/tmp', title: 't', turn: 1, step: 1, activity: 'running', lastEventAt: AT }],
    activeSessionId: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45'
  })
  state.stream = {
    reasoning: '这里要**加粗**，还有 `code` 和 [链接](http://example.com/x)。结束。',
    text: ''
  }
  const lines = renderFrame(state, { cols: 100, rows: 30, theme: THEME, now: AT, frame: 0 })
  const thinking = lines.filter((line) => stripAnsi(line).includes('┊')).map(stripAnsi).join('\n')

  assert.ok(thinking.length > 0, 'there is live thinking')
  // Markdown is rendered, the way the committed block renders it.
  assert.equal(thinking.includes('**'), false, 'bold markers are not shown')
  assert.equal(thinking.includes('`'), false, 'code ticks are not shown')
  assert.equal(thinking.includes('](http://example.com/x)'), false, 'link syntax is not shown')
  assert.match(thinking, /加粗/, 'the words are still there')
  assert.match(thinking, /code/)
  assert.match(thinking, /链接/)
})

test('nothing in the live thinking spills over the header or the width', () => {
  // The complaint that started this: a messy thinking block squeezing the
  // session out of the header. Whatever the reasoning contains, the frame must
  // stay inside the terminal and the session must stay on screen.
  const awkward = [
    `https://example.com/${'a'.repeat(140)}`,
    'a'.repeat(240),
    '```js\nconst x = 1\n```',
    '| 列一 | 列二 |\n| --- | --- |\n| 1 | 2 |',
    '**粗体** 和 `代码` '.repeat(40)
  ]
  for (const reasoning of awkward) {
    for (const cols of [40, 60, 80, 120]) {
      const state = createViewState()
      applyRecord(state, {
        kind: 'hello',
        server: { pid: 1, profile: 'web', cwd: '/tmp', version: '1' },
        sessions: [{ id: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45', createdAt: AT, cwd: '/home/developer/DeepseekHarness', title: '实时观察', turn: 1, step: 1, activity: 'running', lastEventAt: AT }],
        activeSessionId: 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45'
      })
      state.stream = { reasoning, text: '' }
      state.status = { status: 'error', error: '连接中断'.repeat(12) }

      const lines = renderFrame(state, { cols, rows: 30, theme: THEME, now: AT, frame: 0 }).map(stripAnsi)
      for (const [index, line] of lines.entries()) {
        assert.ok(displayWidth(line) <= cols, `cols ${cols}: line ${index} is ${displayWidth(line)} wide`)
      }
      // At 40 columns something has to give, but not the whole session.
      assert.match(lines[1], /session|…/, `cols ${cols}: the session vanished from the header`)
    }
  }
})
