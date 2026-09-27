/**
 * The viewer's view model: wire records in, renderable state out.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { activeSession, applyRecord, bindSession, createViewState, MAX_VIEW_ENTRIES, usageTotal } from '../src/cli/view-state.js'

const AT = 1_760_000_000_000

function entry(overrides) {
  return { seq: 0, time: AT, tag: 'meta', label: 'META', text: 'x', ...overrides }
}

function seedHello(state, sessions, activeSessionId) {
  return applyRecord(state, { kind: 'hello', server: { pid: 1 }, sessions, activeSessionId })
}

test('hello binds the server default session and stores server identity', () => {
  const state = createViewState()
  const result = seedHello(
    state,
    [
      { id: 's2', createdAt: AT + 10 },
      { id: 's1', createdAt: AT }
    ],
    's2'
  )
  assert.equal(result.changed, true)
  assert.equal(state.sessionId, 's2')
  assert.equal(state.server.pid, 1)
  assert.equal(state.connected, true)
})

test('hello falls back to the first session when the active id is unknown', () => {
  const state = createViewState()
  seedHello(state, [{ id: 'only', createdAt: AT }], 'missing')
  assert.equal(state.sessionId, 'only')
})

test('entries for another session are ignored', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  const result = applyRecord(state, { kind: 'entry', sessionId: 'other', entry: entry({ seq: 1 }) })
  assert.equal(result.changed, false)
  assert.equal(state.entries.length, 0)
})

test('entries for the bound session append and get a stable key', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 1, tag: 'turn', label: 'TURN 1' }) })
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 2, tag: 'step', label: 'STEP 1' }) })

  assert.equal(state.entries.length, 2)
  assert.notEqual(state.entries[0].key, state.entries[1].key)
  assert.equal(state.entries[1].at, AT)
})

test('a tool result picks up its duration from the matching call', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's1',
    entry: entry({ seq: 1, tag: 'tool', label: 'TOOL', callId: 'c1', tool: 'bash', time: AT })
  })
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's1',
    entry: entry({ seq: 2, tag: 'result', label: 'RESULT', callId: 'c1', ok: true, time: AT + 1500 })
  })
  assert.equal(state.entries[1].durationMs, 1500)
  assert.equal(state.pendingCalls.size, 0)
})

test('an unpaired tool result still gets a duration when exactly one call is open', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 1, tag: 'tool', label: 'TOOL', callId: 'c1', time: AT }) })
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 2, tag: 'result', label: 'RESULT', ok: true, time: AT + 400 }) })
  assert.equal(state.entries[1].durationMs, 400)
})

test('turn start and end drive the elapsed-time anchor', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 1, tag: 'turn', label: 'TURN 4', event: 'turn/start', time: AT + 5 }) })
  assert.equal(state.turnStartedAt, AT + 5)
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 2, tag: 'turn', label: 'TURN 4 END', event: 'turn/end', time: AT + 9 }) })
  assert.equal(state.turnStartedAt, null)
})

test('stream lifecycle sets and clears the thinking indicator', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  applyRecord(state, { kind: 'stream', sessionId: 's1', turn: 1, step: 2, text: 'thinking about it', reasoning: '' })
  assert.equal(state.stream.text, 'thinking about it')
  applyRecord(state, { kind: 'stream-end', sessionId: 's1' })
  assert.equal(state.stream, null)
})

test('status and usage records are session-scoped', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  applyRecord(state, { kind: 'status', sessionId: 's1', status: 'tool', turn: 2, step: 3, maxStep: 4 })
  assert.equal(state.status.status, 'tool')
  assert.equal(state.status.maxStep, 4)

  applyRecord(state, { kind: 'usage', sessionId: 's1', usage: { inputTokens: 100, outputTokens: 50 }, contextWindow: 128000 })
  assert.equal(state.contextWindow, 128000)
  assert.equal(usageTotal(state.usage), 150)

  const before = state.status.status
  applyRecord(state, { kind: 'status', sessionId: 'other', status: 'error' })
  assert.equal(state.status.status, before)
})

test('the session list changing drops a binding to a vanished session', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 1 }) })
  assert.equal(state.entries.length, 1)

  applyRecord(state, { kind: 'sessions', sessions: [{ id: 's2', createdAt: AT + 5 }], activeSessionId: 's2' })
  assert.equal(state.sessionId, 's2')
  assert.equal(state.entries.length, 0)
})

test('bindSession resets every derived field', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }, { id: 's2', createdAt: AT + 1 }], 's1')
  applyRecord(state, { kind: 'entry', sessionId: 's1', entry: entry({ seq: 1 }) })
  applyRecord(state, { kind: 'stream', sessionId: 's1', text: 'partial' })
  applyRecord(state, { kind: 'usage', sessionId: 's1', usage: { inputTokens: 10 } })

  bindSession(state, 's2')
  assert.equal(state.sessionId, 's2')
  assert.deepEqual(state.entries, [])
  assert.equal(state.stream, null)
  assert.deepEqual(state.usage, {})
  assert.equal(state.status.status, 'idle')
  assert.equal(activeSession(state).id, 's2')
})

test('malformed and unknown records are inert', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  assert.equal(applyRecord(state, null).changed, false)
  assert.equal(applyRecord(state, 'nonsense').changed, false)
  assert.equal(applyRecord(state, { kind: 'future-record' }).changed, false)
  assert.equal(state.entries.length, 0)
})

test('heartbeats and errors update connection state', () => {
  const state = createViewState()
  seedHello(state, [], null)
  assert.equal(applyRecord(state, { kind: 'heartbeat', at: AT }).changed, false)
  const result = applyRecord(state, { kind: 'error', message: 'unknown session' })
  assert.equal(result.changed, true)
  assert.equal(state.serverError, 'unknown session')
})

test('the scrollback ring buffer trims without losing the key index', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  // Overflow the viewer's own buffer, which is what a long session does.
  const overflow = MAX_VIEW_ENTRIES + 50
  for (let index = 0; index < overflow; index += 1) {
    applyRecord(state, {
      kind: 'entry',
      sessionId: 's1',
      entry: { seq: index, time: AT + index, tag: 'step', label: `STEP ${index}`, text: `e${index}` }
    })
  }
  assert.equal(state.entries.length, MAX_VIEW_ENTRIES)
  assert.equal(state.droppedEntries, 50)
  assert.equal(state.entries.at(-1).text, `e${overflow - 1}`)

  // A keyed update must still land on the right row after the trim.
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's1',
    entry: { seq: 0, time: AT, tag: 'tool', label: 'TOOL', phase: 'call', key: 'tool:tail', tool: 'bash', text: 'bash' }
  })
  const before = state.entries.length
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's1',
    entry: { seq: 1, time: AT + 1, tag: 'tool', label: 'TOOL', phase: 'result', key: 'tool:tail', tool: 'bash', text: 'done', ok: true }
  })
  assert.equal(state.entries.length, before, 'the result replaced its own row')
  assert.equal(state.entries.at(-1).phase, 'result')
  assert.equal(state.entries.at(-1).key, 'tool:tail')
})

test('a keyed update after trimming does not touch an unrelated row', () => {
  const state = createViewState()
  seedHello(state, [{ id: 's1', createdAt: AT }], 's1')
  // Stay just under the cap so the append is the only change.
  for (let index = 0; index < MAX_VIEW_ENTRIES - 1; index += 1) {
    applyRecord(state, {
      kind: 'entry',
      sessionId: 's1',
      entry: { seq: index, time: AT + index, tag: 'step', label: `STEP ${index}`, text: `e${index}` }
    })
  }
  const snapshot = state.entries.map((entry) => entry.text)
  applyRecord(state, {
    kind: 'entry',
    sessionId: 's1',
    entry: { seq: 0, time: AT, tag: 'tool', label: 'TOOL', phase: 'call', key: 'tool:fresh', tool: 'bash', text: 'bash' }
  })
  assert.deepEqual(state.entries.slice(0, -1).map((entry) => entry.text), snapshot, 'existing rows are untouched')
  assert.equal(state.droppedEntries, 0)
})
