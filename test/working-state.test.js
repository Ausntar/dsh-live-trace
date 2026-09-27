/**
 * The activity state machine: what the orca should be doing, given the session.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CALL_MS,
  callFormat,
  classifyTool,
  createWorkState,
  parseSubagentNotice,
  reduceWork,
  RING_MS,
  SILENT_MS,
  WORK_STATES,
  workStateOf
} from '../src/cli/working/state.js'

const AT = 1_760_000_000_000

/** A tool call entry in the shape the plugin publishes. */
const call = (tool, extra = {}) => ({
  kind: 'entry',
  sessionId: 's',
  entry: { tag: 'tool', phase: 'call', callId: `c-${tool}`, tool, ...extra }
})

/** Its matching result. */
const result = (tool, extra = {}) => ({
  kind: 'entry',
  sessionId: 's',
  entry: { tag: 'tool', phase: 'result', callId: `c-${tool}`, tool, ok: true, ...extra }
})

/** Feed a list of records to a fresh model. */
function run(records, now = AT) {
  const state = createWorkState()
  for (const record of records) reduceWork(state, record, now)
  return state
}

test('tools are classified into the work they imply', () => {
  assert.equal(classifyTool('bash'), 'shell')
  assert.equal(classifyTool('shell'), 'shell')
  assert.equal(classifyTool('read_file'), 'read')
  assert.equal(classifyTool('ReadFile'), 'read')
  assert.equal(classifyTool('read-file'), 'read')
  assert.equal(classifyTool('glob'), 'read')
  assert.equal(classifyTool('web_search'), 'search')
  assert.equal(classifyTool('web_fetch'), 'search')
  assert.equal(classifyTool('task'), 'subagent')
  assert.equal(classifyTool('spawn_agent'), 'subagent')
  assert.equal(classifyTool('write_file'), 'write')
  assert.equal(classifyTool('edit_file'), 'write')
  assert.equal(classifyTool('something_unknown'), null)
  assert.equal(classifyTool(undefined), null)
  assert.equal(classifyTool(42), null)
})

test('an idle session sleeps', () => {
  assert.equal(workStateOf(createWorkState(), AT).kind, 'sleep')
  assert.equal(workStateOf(run([{ kind: 'status', status: 'idle' }]), AT).kind, 'sleep')
})

test('each tool steers the animation to its own state', () => {
  assert.equal(workStateOf(run([call('read_file')]), AT).kind, 'reading')
  assert.equal(workStateOf(run([call('web_search')]), AT).kind, 'searching')
  assert.equal(workStateOf(run([call('write_file')]), AT).kind, 'writing')
  assert.equal(workStateOf(run([call('task')]), AT).kind, 'calling')
  assert.equal(workStateOf(run([call('bash')]), AT).kind, 'waiting')
  assert.equal(workStateOf(run([call('mystery_tool')]), AT).kind, 'typing')
})

test('a settled tool stops owning the state', () => {
  const state = run([call('read_file'), result('read_file')])
  assert.equal(workStateOf(state, AT).kind, 'sleep')
})

test('a command that is silent for long enough puts the orca to sleep', () => {
  const started = run([call('bash')])
  assert.equal(workStateOf(started, AT).kind, 'waiting')
  assert.equal(workStateOf(started, AT + SILENT_MS - 1).kind, 'waiting', 'still awake just before the threshold')
  assert.equal(workStateOf(started, AT + SILENT_MS).kind, 'sleep', 'asleep once it has been quiet for the threshold')

  // Output keeps it awake: a noisy command is still work.
  const chatty = createWorkState()
  reduceWork(chatty, call('bash'), AT)
  for (let index = 0; index < 5; index += 1) {
    reduceWork(chatty, result('bash'), AT + index * (SILENT_MS / 2))
    reduceWork(chatty, call('bash'), AT + index * (SILENT_MS / 2) + 1)
  }
  const last = AT + 4 * (SILENT_MS / 2)
  assert.equal(workStateOf(chatty, last + SILENT_MS - 500).kind, 'waiting', 'recent output keeps it awake')
})

test('streaming reasoning and prose are different kinds of work', () => {
  const thinking = run([{ kind: 'stream', text: '', reasoning: 'let me think' }])
  assert.equal(workStateOf(thinking, AT).kind, 'thinking')

  const typing = run([{ kind: 'stream', text: 'writing code', reasoning: '' }])
  assert.equal(workStateOf(typing, AT).kind, 'typing')

  // Reasoning wins while both are present: it is the earlier phase.
  const both = run([{ kind: 'stream', text: 'answer', reasoning: 'why' }])
  assert.equal(workStateOf(both, AT).kind, 'thinking')
})

test('a session status alone still drives the animation', () => {
  assert.equal(workStateOf(run([{ kind: 'status', status: 'running' }]), AT).kind, 'typing')
  assert.equal(workStateOf(run([{ kind: 'status', status: 'tool' }]), AT).kind, 'waiting')
  assert.equal(workStateOf(run([{ kind: 'status', status: 'waiting-approval' }]), AT).kind, 'thinking')
  assert.equal(workStateOf(run([{ kind: 'status', status: 'idle' }]), AT).kind, 'sleep')
})

test('subagents are counted and their instructions captured', () => {
  const state = createWorkState()
  reduceWork(state, { kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 'a', tool: 'task', arguments: { description: 'refactor auth' } } }, AT)
  let now = workStateOf(state, AT)
  assert.equal(now.kind, 'calling')
  assert.equal(now.subagent.index, 1)
  assert.equal(now.subagent.input, 'refactor auth')

  // A second, concurrent subagent gets number two; the input comes from
  // whichever key the call actually used.
  // The plugin sends the arguments as a raw JSON string, which is the shape
  // that must work against a live session.
  reduceWork(state, { kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 'b', tool: 'subagent', arguments: JSON.stringify({ prompt: '  tidy   the\n tests  ' }) } }, AT + 1)
  now = workStateOf(state, AT + 1)
  assert.equal(now.subagent.index, 2)
  assert.equal(now.subagent.input, 'tidy the tests', 'the instruction is flattened to one line')
})

test('a subagent call with no arguments still produces a bubble', () => {
  const state = run([{ kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 'a', tool: 'task' } }])
  const now = workStateOf(state, AT)
  assert.equal(now.kind, 'calling')
  assert.equal(now.subagent.index, 1)
  assert.equal(now.subagent.input, null)
})

test('every state the machine can produce is one the scene can draw', () => {
  const produced = new Set()
  const cases = [
    [],
    [{ kind: 'status', status: 'running' }],
    [{ kind: 'stream', reasoning: 'x' }],
    [{ kind: 'stream', text: 'x' }],
    [call('write_file')],
    [call('bash')],
    [call('read_file')],
    [call('web_search')],
    [call('task')]
  ]
  for (const records of cases) produced.add(workStateOf(run(records), AT).kind)
  // And the silent-command case, which needs the clock moved.
  produced.add(workStateOf(run([call('bash')]), AT + SILENT_MS).kind)
  for (const kind of produced) assert.ok(WORK_STATES.includes(kind), `${kind} is not a drawable state`)
  assert.deepEqual([...WORK_STATES].sort(), [...new Set(WORK_STATES)].sort())
})

test('malformed records never break the model', () => {
  const state = createWorkState()
  for (const record of [null, undefined, 42, 'nope', {}, { kind: 'entry' }, { kind: 'entry', entry: { tag: 'tool' } }]) {
    assert.doesNotThrow(() => reduceWork(state, record, AT))
  }
  assert.ok(WORK_STATES.includes(workStateOf(state, AT).kind))
})

/* ------------------------------------------------------------------ *
 * The telephone: queue, call format, callback, and dozing
 * ------------------------------------------------------------------ */

const subagentCall = (callId, args, tool = 'task') => ({
  kind: 'entry',
  sessionId: 's',
  entry: { tag: 'tool', phase: 'call', callId, tool, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
})
const subagentResult = (callId, text, tool = 'task') => ({
  kind: 'entry',
  sessionId: 's',
  entry: { tag: 'tool', phase: 'result', callId, tool, ok: true, output: { text, lines: 1, truncated: false, omitted: 0 } }
})

test('the bubble shows the call as written, not just the instruction', () => {
  const formatted = callFormat('task', JSON.stringify({
    description: 'refactor auth',
    prompt: '把 auth 模块里的校验逻辑抽出来'
  }))
  assert.equal(formatted, 'task(description="refactor auth", prompt="把 auth 模块里的校验逻辑抽出来")')

  // Every shape the plugin can hand over must produce something readable.
  assert.equal(callFormat('task', undefined), 'task()')
  assert.equal(callFormat('task', '{}'), 'task()')
  assert.equal(callFormat('task', 'not json'), 'task(not json)')
  assert.equal(callFormat('task', { prompt: 'hi' }), 'task(prompt="hi")')
  assert.equal(callFormat(undefined, { prompt: 'hi' }), 'subagent(prompt="hi")')
  assert.match(callFormat('task', { prompt: 'x'.repeat(200) }), /…"\)$/, 'long values are clipped')
  assert.equal(callFormat('task', { n: 3, flag: true, nothing: null }), 'task(n=3, flag=true, nothing=null)')
})

test('several subagents queue up and the bubble knows its place', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'first' }), AT)
  reduceWork(state, subagentCall('b', { description: 'second' }), AT + 1)
  reduceWork(state, subagentCall('c', { description: 'third' }), AT + 2)

  const now = workStateOf(state, AT + 2)
  assert.equal(now.kind, 'calling')
  assert.equal(now.subagent.index, 3, 'the newest call is the one on the line')
  assert.equal(now.subagent.total, 3, 'and it knows how many were dispatched')
  assert.equal(now.subagent.queued, 2, 'the other two are still queued')

  // Settling one leaves the others queued.
  reduceWork(state, subagentResult('b', 'b is done'), AT + 3)
  assert.equal(state.subagentOrder.length, 3, 'the queue keeps its order')
  assert.equal(pendingSubagentsFor(state), 2)
})

/** Count of subagents still out. */
function pendingSubagentsFor(state) {
  let count = 0
  for (const record of state.subagents.values()) if (record.status === 'pending') count += 1
  return count
}

test('a finished subagent rings back with its own words', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'first' }), AT)
  assert.equal(workStateOf(state, AT).kind, 'calling')

  reduceWork(state, subagentResult('a', '重构完成，12 个测试全部通过。', 'task'), AT + 100)
  const ringing = workStateOf(state, AT + 200)
  assert.equal(ringing.kind, 'ringing', 'the telephone rings when a subagent hangs up')
  assert.equal(ringing.subagent.index, 1)
  assert.equal(ringing.subagent.reply, '重构完成，12 个测试全部通过。', 'the reply is the subagent\'s own text')

  // The ringing stops on its own.
  assert.equal(workStateOf(state, AT + 100 + RING_MS).kind, 'sleep', 'and it settles afterwards')
})

test('a reply with no text still rings, with a placeholder', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'first' }), AT)
  reduceWork(state, subagentResult('a', ''), AT + 1)
  const now = workStateOf(state, AT + 2)
  assert.equal(now.kind, 'ringing')
  assert.equal(now.subagent.reply, '')
})

test('with work handed out and nothing to do, the orca dozes until the phone rings', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'first' }), AT)
  // The dispatch itself is the active tool; once it clears, the orca is idle.
  reduceWork(state, { kind: 'status', status: 'idle' }, AT + 1)
  state.activeTool = null

  const dozing = workStateOf(state, AT + 2)
  assert.equal(dozing.kind, 'sleep', 'nothing to do but wait for the call back')
  assert.equal(dozing.waiting, true, 'and the scene knows why')

  // The telephone wakes it.
  reduceWork(state, subagentResult('a', 'done'), AT + 3)
  assert.equal(workStateOf(state, AT + 4).kind, 'ringing')
})

test('a busy parent does not doze just because subagents are out', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'first' }), AT)
  reduceWork(state, { kind: 'status', status: 'running' }, AT + 1)
  state.activeTool = null
  assert.equal(workStateOf(state, AT + 2).kind, 'typing', 'there is still work to do')
})

/* ------------------------------------------------------------------ *
 * Background subagents: dispatch acknowledgement vs the real answer
 * ------------------------------------------------------------------ */

const dispatchAck = (callId, handle) => ({
  kind: 'entry',
  sessionId: 's',
  entry: {
    tag: 'tool',
    phase: 'result',
    callId,
    tool: 'subagent',
    ok: true,
    output: { text: `started subagent ${handle}`, lines: 1, truncated: false, omitted: 0 }
  }
})
const agentNotice = (handle, answer) => ({
  kind: 'entry',
  sessionId: 's',
  entry: { tag: 'user', label: 'CONTEXT', text: `Agent ${handle} sent a message: ${answer}` }
})

test('a background dispatch is an acknowledgement, not the answer', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  // The tool returns immediately with a handle. That is not the subagent
  // finishing, and treating it as one emptied the queue and rang the phone.
  reduceWork(state, dispatchAck('a', 'aaaa-1111'), AT + 10)

  // The work has only been handed out, so the call is still in the queue and
  // nothing has rung. The handset is still in the flipper for a moment — the
  // acknowledgement arrives at once, so without that hold the gesture is never
  // seen — and then the orca dozes until it rings.
  const justAfter = workStateOf(state, AT + 20)
  assert.notEqual(justAfter.kind, 'ringing', 'an acknowledgement is not an answer')
  assert.equal(justAfter.kind, 'calling', 'the handset is still held right after the call')

  const now = workStateOf(state, AT + 20 + CALL_MS)
  assert.equal(now.kind, 'sleep')
  assert.equal(now.waiting, true, 'dozing until the telephone rings')
  assert.equal(state.subagents.get('a').status, 'pending', 'and it keeps its place in the queue')
  assert.equal(state.subagents.get('a').handle, 'aaaa-1111')
  assert.equal(state.lastReply, null, 'nothing has rung yet')
})

test('two background subagents queue up while both are out', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  reduceWork(state, dispatchAck('a', 'aaaa-1111'), AT + 1)
  reduceWork(state, subagentCall('b', { description: 'B' }), AT + 2)
  reduceWork(state, dispatchAck('b', 'bbbb-2222'), AT + 3)

  assert.equal(pendingSubagentsFor(state), 2, 'both are out at once')
  assert.equal(state.subagentCount, 2, 'and both were counted')
  // While the handset is still held the queue is right there in the bubble.
  const now = workStateOf(state, AT + 4)
  assert.equal(now.kind, 'calling')
  assert.equal(now.subagent.total, 2)
  assert.equal(now.subagent.queued, 1)
  // And once it is back on the cradle, the desk still knows both are out.
  const later = workStateOf(state, AT + 4 + CALL_MS)
  assert.equal(later.kind, 'sleep')
  assert.equal(later.waiting, true)
  // A dispatch that has not been acknowledged yet is the active call, and it
  // carries the queue.
  reduceWork(state, subagentCall('c', { description: 'C' }), AT + 5)
  const third = workStateOf(state, AT + 5)
  assert.equal(third.kind, 'calling')
  assert.equal(third.subagent.total, 3)
  assert.equal(third.subagent.queued, 2, 'the other two are queued behind it')
})

test('each background subagent rings back separately, with its own answer', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  reduceWork(state, dispatchAck('a', 'aaaa-1111'), AT + 1)
  reduceWork(state, subagentCall('b', { description: 'B' }), AT + 2)
  reduceWork(state, dispatchAck('b', 'bbbb-2222'), AT + 3)

  reduceWork(state, agentNotice('aaaa-1111', 'A 号完成：12 个测试通过。'), AT + 100)
  const first = workStateOf(state, AT + 101)
  assert.equal(first.kind, 'ringing')
  assert.equal(first.subagent.index, 1)
  assert.equal(first.subagent.reply, 'A 号完成：12 个测试通过。')
  assert.equal(pendingSubagentsFor(state), 1, 'the other is still out')

  reduceWork(state, agentNotice('bbbb-2222', 'B 号完成：补了 6 个用例。'), AT + 200)
  const second = workStateOf(state, AT + 201)
  assert.equal(second.kind, 'ringing')
  assert.equal(second.subagent.index, 2)
  assert.match(second.subagent.reply, /B 号完成/)
  assert.equal(pendingSubagentsFor(state), 0, 'and now the queue is empty')
})

test('the longer "finished" notice is understood too', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  reduceWork(state, dispatchAck('a', 'aaaa-1111'), AT + 1)
  reduceWork(state, {
    kind: 'entry',
    sessionId: 's',
    entry: {
      tag: 'user',
      label: 'CONTEXT',
      text: 'Background subagent aaaa-1111 finished and will do no further work unless you send it more.\n\nIts closing message:\n\nA 号完成：全部通过。'
    }
  }, AT + 100)
  const now = workStateOf(state, AT + 101)
  assert.equal(now.kind, 'ringing')
  assert.equal(now.subagent.reply, 'A 号完成：全部通过。')
})

test('a blocking subagent still answers with its tool result', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  reduceWork(state, subagentResult('a', '重构完成，12 个测试通过。'), AT + 10)
  const now = workStateOf(state, AT + 11)
  assert.equal(now.kind, 'ringing', 'a blocking call answers in the result itself')
  assert.equal(now.subagent.reply, '重构完成，12 个测试通过。')
})

test('an unrelated message does not ring the telephone', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  reduceWork(state, dispatchAck('a', 'aaaa-1111'), AT + 1)
  reduceWork(state, { kind: 'entry', sessionId: 's', entry: { tag: 'user', text: '普通用户消息' } }, AT + 2)
  assert.equal(state.lastReply, null, 'an ordinary message does not ring the telephone')
  assert.equal(state.subagents.get('a').status, 'pending', 'and the call is still in the queue')

  const parsed = parseSubagentNotice('普通用户消息')
  assert.equal(parsed, null)
  assert.equal(parseSubagentNotice('Agent un-parseable'), null)
  assert.equal(parseSubagentNotice(''), null)
  assert.equal(parseSubagentNotice(undefined), null)
})

test('the dozing pose reports how many calls are still out', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  reduceWork(state, dispatchAck('a', 'aaaa-1111'), AT + 1)
  reduceWork(state, subagentCall('b', { description: 'B' }), AT + 2)
  reduceWork(state, dispatchAck('b', 'bbbb-2222'), AT + 3)

  const dozing = workStateOf(state, AT + 4 + CALL_MS)
  assert.equal(dozing.kind, 'sleep')
  assert.equal(dozing.pending, 2, 'the queue is still two deep while it naps')

  reduceWork(state, agentNotice('aaaa-1111', 'A 完成。'), AT + 9000)
  reduceWork(state, agentNotice('bbbb-2222', 'B 完成。'), AT + 9001)
  assert.equal(workStateOf(state, AT + 9002).kind, 'ringing')
  assert.equal(workStateOf(state, AT + 9002 + RING_MS).pending, 0, 'and nothing is left out')
})

/* ------------------------------------------------------------------ *
 * Replay: history must not be mistaken for what is happening now
 * ------------------------------------------------------------------ */

test('replaying an old callback does not ring the telephone', () => {
  // This is what starting the command does: the whole backlog arrives at once.
  // Every record carries its own time, and a callback from an hour ago is not
  // news.
  const state = createWorkState()
  const wall = Date.now()
  const old = wall - 278_000

  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'tool', phase: 'call', callId: 'a', tool: 'task', arguments: { description: 'A' }, time: old }
  }, wall)
  reduceWork(state, {
    kind: 'entry',
    entry: {
      tag: 'tool',
      phase: 'result',
      callId: 'a',
      tool: 'subagent',
      output: { text: 'started subagent h1' },
      time: old
    }
  }, wall)
  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'user', label: 'CONTEXT', text: 'Agent h1 sent a message: 早就完成了', time: old }
  }, wall)

  assert.equal(state.lastReply.at, old, 'the reply is stamped with when it happened')
  const now = workStateOf(state, wall)
  assert.notEqual(now.kind, 'ringing', 'history must not ring the telephone on startup')
  assert.equal(now.kind, 'sleep')
})

test('replaying the same backlog twice is idempotent', () => {
  const wall = Date.now()
  const old = wall - 600_000
  const backlog = [
    { kind: 'entry', entry: { tag: 'tool', phase: 'call', callId: 'a', tool: 'task', arguments: { description: 'A' }, time: old } },
    { kind: 'entry', entry: { tag: 'tool', phase: 'result', callId: 'a', tool: 'subagent', output: { text: 'started subagent h1' }, time: old } },
    { kind: 'entry', entry: { tag: 'user', label: 'CONTEXT', text: 'Agent h1 sent a message: 完成', time: old } }
  ]
  const state = createWorkState()
  for (const record of backlog) reduceWork(state, record, wall)
  const first = workStateOf(state, wall).kind
  for (const record of backlog) reduceWork(state, record, wall)
  const second = workStateOf(state, wall).kind
  assert.equal(first, second, 'a reconnect must not turn history into a new event')
  assert.notEqual(second, 'ringing')
})

test('a callback that really is happening now still rings', () => {
  const wall = Date.now()
  const state = createWorkState()
  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'tool', phase: 'call', callId: 'a', tool: 'task', arguments: { description: 'A' }, time: wall - 3000 }
  }, wall)
  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'tool', phase: 'result', callId: 'a', tool: 'subagent', output: { text: 'started subagent h1' }, time: wall - 2000 }
  }, wall)
  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'user', label: 'CONTEXT', text: 'Agent h1 sent a message: 刚刚完成', time: wall }
  }, wall)

  const now = workStateOf(state, wall)
  assert.equal(now.kind, 'ringing')
  assert.equal(now.subagent.reply, '刚刚完成')
  // And it stops ringing on schedule.
  assert.equal(workStateOf(state, wall + RING_MS).kind, 'sleep')
})

test('a command that went quiet long ago is not treated as a fresh silence', () => {
  const wall = Date.now()
  const state = createWorkState()
  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'tool', phase: 'call', callId: 'b', tool: 'bash', arguments: { command: 'npm test' }, time: wall - 600_000 }
  }, wall)
  // The command started long ago and has said nothing since, so of course it is
  // silent — the answer for "what is happening now" is not "waiting".
  assert.equal(state.activeTool.at, wall - 600_000)
})

test('the handset is held long enough to see the call', () => {
  const state = createWorkState()
  reduceWork(state, subagentCall('a', { description: 'A' }), AT)
  // During the call itself.
  assert.equal(workStateOf(state, AT).kind, 'calling')
  reduceWork(state, dispatchAck('a', 'aaaa-1111'), AT + 1)

  // Held afterwards, so the pickup animation is not a single frame.
  for (const offset of [0, 100, 1000, CALL_MS - 100]) {
    assert.equal(workStateOf(state, AT + 1 + offset).kind, 'calling', `${offset}ms after the call`)
  }
  // Then the handset goes back on the cradle and it dozes.
  assert.equal(workStateOf(state, AT + 1 + CALL_MS).kind, 'sleep')

  // A callback interrupts the hold: answering beats holding.
  reduceWork(state, agentNotice('aaaa-1111', 'A 完成。'), AT + 1 + CALL_MS - 100)
  assert.equal(workStateOf(state, AT + 1 + CALL_MS).kind, 'ringing')
})

test('the hold is not shown when there is no subagent', () => {
  // A plain command must not leave the handset up.
  const state = createWorkState()
  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'tool', phase: 'call', callId: 'b', tool: 'bash', arguments: { command: 'ls' } }
  }, AT)
  assert.equal(workStateOf(state, AT).kind, 'waiting')
  reduceWork(state, {
    kind: 'entry',
    entry: { tag: 'tool', phase: 'result', callId: 'b', tool: 'bash', ok: true, output: { text: 'a\nb', lines: 2, truncated: false, omitted: 0 } }
  }, AT + 10)
  assert.equal(workStateOf(state, AT + 20).kind, 'sleep')
})
