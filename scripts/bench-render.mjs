#!/usr/bin/env node
/**
 * Frame-cost benchmark.
 *
 * A frame only ever shows the tail of the log, so its cost must not grow with
 * the session. This prints the per-frame cost for growing entry counts; the
 * numbers should stay flat and far below the repaint interval (120 ms by
 * default). It exists because an earlier implementation rendered every entry
 * per frame, which reached seconds on a long session and made scrolling feel
 * laggy.
 *
 *   node scripts/bench-render.mjs
 */

import { renderFrame } from '../src/cli/renderer.js'
import { createTheme } from '../src/cli/theme.js'
import { applyRecord, createViewState } from '../src/cli/view-state.js'

const THEME = createTheme({ color: true })
const AT = Date.now()

function stateWith(entries) {
  const state = createViewState()
  applyRecord(state, {
    kind: 'hello',
    server: { pid: 1 },
    sessions: [{ id: 's', createdAt: AT, title: 'bench' }],
    activeSessionId: 's'
  })
  for (let index = 0; index < entries; index += 1) {
    applyRecord(state, {
      kind: 'entry',
      sessionId: 's',
      entry: {
        seq: index,
        time: AT + index,
        tag: 'assistant',
        label: 'ASSISTANT',
        text: `message ${index}`,
        rawText:
          `## Step ${index}\n\nFixed \`thing ${index}\` in **src/file${index}.ts**.\n\n` +
          `\`\`\`ts\nexport function f${index}(x: number) { return x + ${index} }\n\`\`\`\n\n- item a\n- item b`,
        reasoning: 'thinking about the change '.repeat(6),
        turn: 1,
        step: index
      }
    })
  }
  return state
}

const BUDGET_MS = 30
let worst = 0

for (const count of [50, 200, 1000, 3000, 10_000]) {
  const state = stateWith(count)
  renderFrame(state, { cols: 80, rows: 30, theme: THEME, now: AT, frame: 0 })
  const runs = 5
  const started = process.hrtime.bigint()
  for (let index = 0; index < runs; index += 1) {
    renderFrame(state, { cols: 80, rows: 30, theme: THEME, now: AT, frame: index })
  }
  const perFrame = Number(process.hrtime.bigint() - started) / 1e6 / runs
  worst = Math.max(worst, perFrame)
  console.log(`entries=${String(count).padStart(6)}  per-frame=${perFrame.toFixed(1).padStart(6)}ms`)
}

console.log(`\nworst ${worst.toFixed(1)}ms against a ${BUDGET_MS}ms budget — ${worst < BUDGET_MS ? 'ok' : 'TOO SLOW'}`)
process.exitCode = worst < BUDGET_MS ? 0 : 1
