/**
 * The per-session trace state machine: position, activity, stream coalescing,
 * backlog retention, and replay snapshots.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../lib/protocol.js'
import { TraceHub } from '../lib/tracker.js'

const AT = 1_760_000_000_000

function makeHub(options = {}) {
  return new TraceHub({ now: () => AT, ...options })
}

function fakeSession(id, overrides = {}) {
  return {
    id,
    header: { createdAt: AT, cwd: '/workspace', ...overrides },
    seq: 0
  }
}

function event(type, data, seq = 0) {
  return { type, seq, time: AT + seq, data }
}

function collect(hub) {
  const records = []
  hub.subscribe((record) => records.push(record))
  return records
}

test('every emitted record carries the protocol version', () => {
  const hub = makeHub()
  const records = collect(hub)
  hub.onSessionCreated(fakeSession('s1'))
  assert.ok(records.length > 0)
  for (const record of records) assert.equal(record.v, PROTOCOL_VERSION)
})

test('session creation announces the session and emits a session list', () => {
  const hub = makeHub()
  const records = collect(hub)
  hub.onSessionCreated(fakeSession('s1'), 'startup')

  assert.equal(hub.activeSessionId, 's1')
  const entry = records.find((record) => record.kind === 'entry')
  assert.equal(entry.sessionId, 's1')
  assert.equal(entry.entry.label, 'SESSION')

  const sessions = records.find((record) => record.kind === 'sessions')
  assert.equal(sessions.sessions.length, 1)
  assert.equal(sessions.activeSessionId, 's1')
})

test('a session seen only through an event is adopted rather than dropped', () => {
  const hub = makeHub()
  const records = collect(hub)
  const unannounced = fakeSession('late')
  hub.onSessionEvent(unannounced, event('turn/start', { turn: 1 }))
  const entries = records.filter((record) => record.kind === 'entry')
  assert.ok(entries.some((record) => record.sessionId === 'late' && record.entry.label === 'SESSION'))
  assert.ok(entries.some((record) => record.sessionId === 'late' && record.entry.label === 'TURN 1'))
})

test('turn and step position is tracked, and maxStep resets per turn', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const state = hub.stateOf('s1')

  hub.onSessionEvent(fakeSession('s1'), event('turn/start', { turn: 3 }, 0))
  assert.equal(state.turn, 3)
  assert.equal(state.step, 0)
  assert.equal(state.activity, 'running')

  hub.onSessionEvent(fakeSession('s1'), event('step/start', { turn: 3, step: 1 }, 1))
  hub.onSessionEvent(fakeSession('s1'), event('step/end', { turn: 3, step: 1 }, 2))
  hub.onSessionEvent(fakeSession('s1'), event('step/start', { turn: 3, step: 2 }, 3))
  assert.equal(state.step, 2)
  assert.equal(state.maxStep, 2)

  hub.onSessionEvent(fakeSession('s1'), event('turn/end', { turn: 3, reason: { kind: 'completed' } }, 4))
  assert.equal(state.activity, 'idle')
  assert.equal(state.step, 0)

  hub.onSessionEvent(fakeSession('s1'), event('turn/start', { turn: 4 }, 5))
  assert.equal(state.maxStep, 0)
})

test('activity follows tools and approvals', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const state = hub.stateOf('s1')
  const session = fakeSession('s1')

  hub.onSessionEvent(session, event('turn/start', { turn: 1 }))
  hub.onSessionEvent(session, event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, 1))
  assert.equal(state.activity, 'tool')

  hub.onSessionEvent(session, event('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [], toolCallId: 'c1' } }, 2))
  assert.equal(state.activity, 'running')

  hub.onSessionEvent(session, event('approval/asked', { id: 'ap1', toolName: 'bash' }, 3))
  assert.equal(state.activity, 'waiting-approval')
  assert.equal(state.pendingApprovals.size, 1)

  hub.onSessionEvent(session, event('approval/decided', { id: 'ap1', outcome: 'allowed-once' }, 4))
  assert.equal(state.pendingApprovals.size, 0)
  assert.equal(state.activity, 'running')
})

test('an agent error is sticky until the next turn opens', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const state = hub.stateOf('s1')
  const agent = { session: fakeSession('s1') }

  hub.onSessionEvent(agent.session, event('turn/start', { turn: 1 }))
  hub.onAgentError({ agent, turn: 1, step: 1, error: new Error('provider down') })
  assert.equal(state.activity, 'error')
  assert.equal(state.lastError, 'provider down')

  hub.onSessionEvent(agent.session, event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'y' } } }))
  hub.onSessionEvent(agent.session, event('turn/start', { turn: 2 }))
  assert.equal(state.activity, 'running')
  assert.equal(state.lastError, null)
})

test('an idle agent status flips a running session to idle but never hides an error', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const state = hub.stateOf('s1')
  const agent = { session: fakeSession('s1') }

  hub.onSessionEvent(agent.session, event('turn/start', { turn: 1 }))
  hub.onAgentStatus(agent, 'idle')
  assert.equal(state.activity, 'idle')

  hub.onAgentError({ agent, turn: 1, step: 1, error: 'boom' })
  hub.onAgentStatus(agent, 'idle')
  assert.equal(state.activity, 'error')
})

test('streaming chunks coalesce and are only published on the flush cadence', () => {
  const hub = makeHub({ streamIntervalMs: 500 })
  hub.onSessionCreated(fakeSession('s1'))
  const agent = { session: fakeSession('s1') }
  const records = collect(hub)

  hub.onAssistantStream(agent, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
  hub.onAssistantStream(agent, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: AT, chunk: { type: 'text-delta', index: 0, text: 'Hel' } })
  hub.onAssistantStream(agent, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: AT, chunk: { type: 'text-delta', index: 0, text: 'lo' } })

  assert.equal(records.filter((record) => record.kind === 'stream').length, 0, 'no per-chunk publication')
  assert.equal(hub.flushStreams(AT + 100), 0, 'too soon to flush')
  assert.equal(hub.flushStreams(AT + 600), 1)

  const stream = records.find((record) => record.kind === 'stream')
  assert.equal(stream.text, 'Hello')
  assert.equal(stream.turn, 1)
  assert.equal(stream.step, 1)

  // Nothing new: no duplicate publication.
  assert.equal(hub.flushStreams(AT + 1200), 0)

  hub.onAssistantStream(agent, { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: AT, chunk: { type: 'reasoning-delta', index: 1, text: 'hmm' } })
  assert.equal(hub.flushStreams(AT + 1300), 1)
  const second = records.filter((record) => record.kind === 'stream').at(-1)
  assert.equal(second.text, 'Hello')
  assert.equal(second.reasoning, 'hmm')
})

test('a block-end chunk supplies text when no delta did, without duplicating', () => {
  const hub = makeHub({ streamIntervalMs: 10 })
  hub.onSessionCreated(fakeSession('s1'))
  const agent = { session: fakeSession('s1') }
  const records = collect(hub)

  hub.onAssistantStream(agent, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
  hub.onAssistantStream(agent, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: AT, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'assembled' } } })
  hub.flushStreams(AT + 100)
  assert.equal(records.find((record) => record.kind === 'stream').text, 'assembled')

  hub.onAssistantStream(agent, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: AT, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'assembled' } } })
  assert.equal(hub.flushStreams(AT + 200), 0, 'a repeated block-end for the same index adds nothing')
})

test('an assistant message settles and clears the live stream', () => {
  const hub = makeHub({ streamIntervalMs: 10 })
  hub.onSessionCreated(fakeSession('s1'))
  const session = fakeSession('s1')
  const agent = { session }
  const records = collect(hub)

  hub.onAssistantStream(agent, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
  hub.onAssistantStream(agent, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: AT, chunk: { type: 'text-delta', index: 0, text: 'partial' } })
  hub.flushStreams(AT + 100)

  hub.onSessionEvent(session, event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] }, stream: [] }, 9))
  assert.equal(hub.stateOf('s1').stream, null)
  assert.equal(records.filter((record) => record.kind === 'stream-end').length, 1)
  assert.equal(hub.flushStreams(AT + 500), 0)
})

test('usage is accumulated across steps and reported with the context window', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const session = fakeSession('s1')
  const records = collect(hub)

  hub.onSessionEvent(session, event('request/context', { provider: 'p', model: 'm', capacity: 128000 }, 0))
  hub.onSessionEvent(session, event('assistant/message', { turn: 1, step: 1, message: { content: [] }, stream: [], usage: { inputTokens: 1000, outputTokens: 200 } }, 1))
  hub.onSessionEvent(session, event('assistant/message', { turn: 1, step: 2, message: { content: [] }, stream: [], usage: { inputTokens: 500, outputTokens: 100 } }, 2))

  const usage = records.filter((record) => record.kind === 'usage').at(-1)
  assert.equal(usage.usage.inputTokens, 1500)
  assert.equal(usage.usage.outputTokens, 300)
  assert.equal(usage.contextWindow, 128000)
  assert.equal(hub.stateOf('s1').provider, 'p')
})

test('the backlog is a bounded ring buffer', () => {
  const hub = makeHub({ backlogSize: 5 })
  hub.onSessionCreated(fakeSession('s1'))
  const session = fakeSession('s1')
  for (let index = 0; index < 20; index += 1) {
    hub.onSessionEvent(session, event('step/start', { turn: 1, step: index }, index))
  }
  const state = hub.stateOf('s1')
  assert.equal(state.entries.length, 5)
  assert.equal(state.entries.at(-1).step, 19)
})

test('snapshot replays the recent backlog plus current status and usage', () => {
  const hub = makeHub({ backlogSize: 100 })
  hub.onSessionCreated(fakeSession('s1'))
  const session = fakeSession('s1')
  hub.onSessionEvent(session, event('turn/start', { turn: 2 }, 0))
  hub.onSessionEvent(session, event('assistant/message', { turn: 2, step: 1, message: { content: [] }, stream: [], usage: { inputTokens: 42 } }, 1))

  const snapshot = hub.snapshot('s1', 10)
  assert.ok(snapshot.some((record) => record.kind === 'entry' && record.entry.label === 'TURN 2'))
  assert.ok(snapshot.some((record) => record.kind === 'usage' && record.usage.inputTokens === 42))
  assert.ok(snapshot.some((record) => record.kind === 'status' && record.turn === 2))
  assert.deepEqual(hub.snapshot('nope'), [])
})

test('disposal closes the session and moves the default binding', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  hub.onSessionCreated(fakeSession('s2', { createdAt: AT + 1000 }))
  assert.equal(hub.activeSessionId, 's2')

  const records = collect(hub)
  hub.onSessionDisposed(fakeSession('s2'))
  assert.equal(hub.stateOf('s2'), undefined)
  assert.equal(hub.activeSessionId, 's1')
  assert.ok(records.some((record) => record.kind === 'sessions' && record.sessions.length === 1))
})

test('the most recently active session becomes the default binding', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  hub.onSessionCreated(fakeSession('s2', { createdAt: AT + 1000 }))
  assert.equal(hub.activeSessionId, 's2')
  hub.onSessionEvent(fakeSession('s1'), event('turn/start', { turn: 1 }, 0))
  assert.equal(hub.activeSessionId, 's1')
})

test('a subscriber that throws cannot break the hub', () => {
  const hub = makeHub()
  const good = []
  hub.subscribe(() => {
    throw new Error('broken viewer')
  })
  hub.subscribe((record) => good.push(record))
  hub.onSessionCreated(fakeSession('s1'))
  assert.ok(good.length > 0)
})

test('unsubscribing stops delivery, which is what plugin unload relies on', () => {
  const hub = makeHub()
  const records = collect(hub)
  const unsubscribe = hub.subscribe(() => {})
  unsubscribe()
  const before = records.length
  hub.onSessionCreated(fakeSession('s1'))
  assert.ok(records.length > before)
})

test('a session title event updates the summary the header reads', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const records = collect(hub)
  hub.onSessionEvent(fakeSession('s1'), event('session/title', { title: '解释一下这个插件', messageSeqs: [1] }))
  assert.equal(hub.stateOf('s1').info.title, '解释一下这个插件')
  const sessions = records.filter((record) => record.kind === 'sessions').at(-1)
  assert.equal(sessions.sessions[0].title, '解释一下这个插件')
  assert.ok(records.some((record) => record.kind === 'entry' && record.entry.label === 'TITLE'))
})

test('a created file becomes a whole-file diff from the call arguments', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const session = fakeSession('s1')

  hub.onSessionEvent(
    session,
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'w1',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'src/new.ts', content: 'export const a = 1\nexport const b = 2' })
    })
  )
  hub.onSessionEvent(
    session,
    event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          id: 'r1',
          role: 'tool',
          toolCallId: 'w1',
          content: [{ type: 'text', text: 'wrote src/new.ts' }],
          source: { kind: 'tool', callId: 'w1' }
        },
        // What the fs tool actually reports for a brand-new file.
        meta: { operation: 'create', diffs: [] }
      },
      1
    )
  )

  const state = hub.stateOf('s1')
  assert.equal(state.edits.length, 1, 'the creation is recorded as an edit')
  assert.equal(state.edits[0].path, 'src/new.ts')
  assert.equal(state.edits[0].operation, 'create')
  assert.equal(state.edits[0].added, 2, 'the applied content supplies the added lines')
  assert.equal(state.edits[0].removed, 0)
  assert.equal(state.edits[0].hunks[0].oldText, null, 'a create has no prior text')
})

test('an update keeps the hunks the tool reported', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const session = fakeSession('s1')
  hub.onSessionEvent(
    session,
    event('tool/call', { turn: 1, step: 1, callId: 'w2', name: 'edit', arguments: '{"file_path":"a.ts"}' })
  )
  hub.onSessionEvent(
    session,
    event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: { id: 'r2', role: 'tool', toolCallId: 'w2', content: [], source: { kind: 'tool', callId: 'w2' } },
        meta: { operation: 'update', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new\nextra' }] }
      },
      1
    )
  )
  const edit = hub.stateOf('s1').edits[0]
  assert.equal(edit.path, 'a.ts')
  assert.equal(edit.added, 2)
  assert.equal(edit.removed, 1)
  assert.equal(edit.hunks.length, 1)
})

test('editing the same file twice accumulates into one record', () => {
  const hub = makeHub()
  hub.onSessionCreated(fakeSession('s1'))
  const session = fakeSession('s1')
  for (const [index, callId] of ['a', 'b'].entries()) {
    hub.onSessionEvent(session, event('tool/call', { turn: 1, step: 1, callId, name: 'edit', arguments: '{"file_path":"a.ts"}' }, index * 2))
    hub.onSessionEvent(
      session,
      event(
        'tool/result',
        {
          turn: 1,
          step: 1,
          message: { id: `r${callId}`, role: 'tool', toolCallId: callId, content: [], source: { kind: 'tool', callId } },
          meta: { operation: 'update', diffs: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] }
        },
        index * 2 + 1
      )
    )
  }
  const state = hub.stateOf('s1')
  assert.equal(state.edits.length, 1)
  assert.equal(state.edits[0].calls, 2)
  assert.equal(state.edits[0].hunks.length, 2)
})
