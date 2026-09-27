#!/usr/bin/env node
/**
 * A self-contained run through every animation.
 *
 * `dsh-live-working` draws whatever a live session is doing; this plays each
 * state in turn so you can see them all without waiting for the model to
 * happen to read a file or call a subagent. It feeds the same record shapes the
 * plugin publishes, so it exercises the real state machine and the real scene.
 *
 *   node scripts/demo-working.mjs            # cycle every state
 *   node scripts/demo-working.mjs reading    # hold one state
 */

import { createTranslator, resolveLanguage } from '../src/cli/i18n.js'
import { Screen } from '../src/cli/screen.js'
import { createTheme } from '../src/cli/theme.js'
import { renderCells, sceneFrame, sceneSizeFor } from '../src/cli/working/scene.js'
import { createWorkState, previewOf, reduceWork, WORK_STATES, workStateOf } from '../src/cli/working/state.js'

const wanted = process.argv[2]
const states = WORK_STATES.includes(wanted) ? [wanted] : WORK_STATES
const holdMs = Number(process.env.HOLD_MS ?? 2600)
const theme = createTheme({ color: true })
let translator = createTranslator(resolveLanguage('auto'))

/** Records that put the machine into each state. */
const SCRIPT = {
  sleep: [{ kind: 'status', status: 'idle' }],
  thinking: [{ kind: 'stream', reasoning: 'working through it' }],
  typing: [{ kind: 'stream', text: 'writing the answer' }],
  writing: [{ kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 'w', tool: 'write_file' } }],
  waiting: [{ kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 'b', tool: 'bash' } }],
  reading: [{ kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 'r', tool: 'read_file' } }],
  searching: [{ kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 's', tool: 'web_search' } }],
  calling: [
    {
      kind: 'entry',
      entry: {
        tag: 'tool',
        phase: 'call',
        callId: 't',
        tool: 'task',
        arguments: JSON.stringify({ description: '把 auth 模块里的校验逻辑抽出来，补上单元测试' })
      }
    }
  ]
}

/** Build the machine state for one scripted state. */
function machineFor(kind) {
  const state = createWorkState()
  const now = Date.now()
  for (const record of SCRIPT[kind] ?? []) reduceWork(state, record, now)
  return { state, at: now }
}

const screen = new Screen({ stdout: process.stdout, stdin: process.stdin, altScreen: true, mouse: false })
let index = 0
let frame = 0
let machine = machineFor(states[0])

const draw = () => {
  const { cols, rows } = screen.size()
  const now = machine.state
  const derived = workStateOf(now, machine.at)
  const kind = derived.kind
  const bubble =
    kind === 'calling'
      ? {
          header: translator.t('work.bubbleCalling', { n: 1 }),
          body: 'task(description="把 auth 模块里的校验逻辑抽出来", prompt="补上单元测试，并更新文档与类型定义，确保边界情况也被覆盖")'
        }
      : null
  const scene = sceneFrame({ kind, subagent: derived.subagent }, frame, {
    palette: theme.scene,
    bubbleHeader: bubble?.header ?? null,
    bubbleBody: bubble?.body ?? '',
    speechFrame: frame,
    previewText: previewOf(now),
    size: sceneSizeFor(cols, rows)
  })
  const lines = []
  const top = Math.max(0, Math.floor((rows - scene.height - 2) / 2))
  for (let line = 0; line < top; line += 1) lines.push('')
  const pad = ' '.repeat(Math.max(0, Math.floor((cols - scene.width) / 2)))
  for (const row of scene.cells) lines.push(pad + renderCells(row))
  while (lines.length < rows - 1) lines.push('')
  const label = `  ${translator.t(`work.state.${kind}`)}   (${index + 1}/${states.length})  q to quit`
  lines.push(label)
  screen.paint(lines.slice(0, rows))
}

// Without a TTY there is nothing to watch: print one frame and exit, so the
// script is still useful from a pipe or a test harness.
if (process.stdout.isTTY !== true && process.env.FORCE !== '1') {
  const scene = sceneFrame({ kind: workStateOf(machine.state, machine.at).kind }, 0, { palette: theme.scene })
  for (const row of scene.cells) process.stdout.write(`${renderCells(row)}\n`)
  process.exit(0)
}

screen.enter()
screen.onResize(draw)
draw()

const frames = setInterval(() => {
  frame += 1
  draw()
}, 120)
frames.unref?.()

const advance = setInterval(() => {
  index = (index + 1) % states.length
  machine = machineFor(states[index])
  frame = 0
}, holdMs)
advance.unref?.()

const stop = () => {
  clearInterval(frames)
  clearInterval(advance)
  screen.leave()
  process.exit(0)
}
screen.onKey((key) => {
  if (key === 'q' || key === 'quit' || key === '\u0003') stop()
  if (key === 'l') translator = createTranslator(translator.language === 'zh' ? 'en' : 'zh')
})
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

