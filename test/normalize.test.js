/**
 * Event normalization: the mapping from a raw Harness event to what the
 * dashboard shows.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MUTED_EVENT_TYPES,
  accumulateUsage,
  agentStatusValue,
  clip,
  collapse,
  contentText,
  describeError,
  isMutedEventType,
  normalizeAgentCreated,
  normalizeAgentError,
  normalizeSessionCreated,
  normalizeSessionEvent,
  sessionInfo,
  summarizeToolArguments,
  turnEndReasonText
} from '../lib/normalize.js'
import { formatTokens } from '../src/cli/format.js'
import { usageTotal } from '../src/cli/view-state.js'

const AT = 1_760_000_000_000

/** Wrap raw event data in the real append-feed envelope. */
function event(type, data, seq = 0) {
  return { type, seq, time: AT + seq, data }
}

function firstEntry(type, data, options) {
  const result = normalizeSessionEvent(event(type, data), options)
  assert.equal(result.entries.length, 1, `expected one entry for ${type}`)
  return result
}

test('collapse and clip produce one bounded line', () => {
  assert.equal(collapse('a\n\nb\tc   d'), 'a b c d')
  assert.equal(collapse(null), '')
  assert.equal(clip('x'.repeat(50), 10).length, 10)
  assert.equal(clip('short', 10), 'short')
})

test('turn/start renders the documented [TURN n] label', () => {
  const { entries } = normalizeSessionEvent(event('turn/start', { turn: 3 }, 7))
  const entry = entries[0]
  assert.equal(entry.label, 'TURN 3')
  assert.equal(entry.tag, 'turn')
  assert.equal(entry.turn, 3)
  assert.equal(entry.seq, 7)
  assert.equal(entry.time, AT + 7)
  assert.equal(entry.event, 'turn/start')
})

test('turn/end renders the reason and colors failures', () => {
  const completed = firstEntry('turn/end', { turn: 3, reason: { kind: 'completed' } }).entries[0]
  assert.equal(completed.label, 'TURN 3 END')
  assert.equal(completed.text, 'completed')
  assert.equal(completed.level, 'success')

  const errored = firstEntry('turn/end', {
    turn: 3,
    reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } }
  }).entries[0]
  assert.equal(errored.level, 'error')
  assert.match(errored.text, /RATE_LIMIT: slow down/)

  const aborted = firstEntry('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'user' } }).entries[0]
  assert.equal(aborted.text, 'aborted (user)')
})

test('step boundaries carry turn and step', () => {
  const start = firstEntry('step/start', { turn: 2, step: 4 }).entries[0]
  assert.equal(start.label, 'STEP 4')
  assert.equal(start.tag, 'step')
  assert.deepEqual([start.turn, start.step], [2, 4])

  const end = firstEntry('step/end', { turn: 2, step: 4 }).entries[0]
  assert.equal(end.label, 'STEP 4 END')
})

test('user/message flattens text blocks and marks injected context', () => {
  const user = firstEntry('user/message', {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: 'please\nrefactor this' }],
    source: { kind: 'user' }
  }).entries[0]
  assert.equal(user.label, 'USER')
  assert.equal(user.tag, 'user')
  assert.equal(user.text, 'please refactor this')
  assert.equal(user.detail, undefined)

  const injected = firstEntry('user/message', {
    id: 'm2',
    role: 'user',
    content: [{ type: 'text', text: 'file changed: src/a.ts' }],
    source: { kind: 'file-change' }
  }).entries[0]
  assert.equal(injected.label, 'CONTEXT')
  assert.equal(injected.detail, 'source: file-change')
})

test('assistant/message excludes tool calls and reports usage', () => {
  const result = normalizeSessionEvent(
    event('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'weighing options' },
          { type: 'text', text: 'Done. I edited two files.' },
          { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"x"}' }
        ]
      },
      stream: [],
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }
    })
  )
  const entry = result.entries[0]
  assert.equal(entry.tag, 'assistant')
  assert.equal(entry.label, 'ASSISTANT')
  // `text` is the compact one-line form; `rawText` carries the markdown.
  assert.equal(entry.text, 'Done. I edited two files.')
  assert.equal(entry.rawText, 'Done. I edited two files.')
  assert.equal(entry.reasoning, 'weighing options')
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 })
})

test('assistant/message marks an interrupted step', () => {
  const entry = normalizeSessionEvent(
    event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'half' }] }, stream: [], interrupted: true })
  ).entries[0]
  assert.equal(entry.label, 'ASSISTANT (interrupted)')
  assert.equal(entry.level, 'warn')
})

test('tool/call summarizes JSON arguments into one line', () => {
  const entry = firstEntry('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'read_file',
    arguments: '{"path":"src/index.ts","limit":234}'
  }).entries[0]
  assert.equal(entry.label, 'TOOL')
  assert.equal(entry.tag, 'tool')
  assert.equal(entry.tool, 'read_file')
  assert.equal(entry.callId, 'call-1')
  assert.match(entry.text, /^read_file path="src\/index\.ts" limit=234$/)
})

test('summarizeToolArguments survives malformed and non-object arguments', () => {
  assert.equal(summarizeToolArguments('not json'), 'not json')
  assert.equal(summarizeToolArguments(''), '')
  assert.equal(summarizeToolArguments(undefined), '')
  assert.equal(summarizeToolArguments('"a string"'), '"a string"')
  assert.equal(summarizeToolArguments('{"a":{"b":1}}'), 'a={"b":1}')
  assert.ok(summarizeToolArguments(`{"blob":"${'x'.repeat(400)}"}`, 40).length <= 40)
})

test('a tool result merges into its call block and keeps exit status', () => {
  const call = firstEntry('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'read_file',
    arguments: '{"path":"src/index.ts"}'
  }).entries[0]
  assert.equal(call.phase, 'call')
  assert.equal(call.key, 'tool:call-1')
  assert.equal(call.filePath, 'src/index.ts')

  // Settling the call: the normalizer receives the in-flight call as context
  // and produces a result entry carrying the same key, so the viewer replaces
  // the running row instead of leaving two halves behind.
  const result = normalizeSessionEvent(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r1',
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'returned 234 lines' }],
        source: { kind: 'tool', callId: 'call-1' }
      }
    }),
    {},
    { pendingTool: { name: 'read_file', filePath: 'src/index.ts', at: AT } }
  ).entries[0]
  assert.equal(result.tag, 'tool')
  assert.equal(result.phase, 'result')
  assert.equal(result.key, 'tool:call-1')
  assert.equal(result.label, 'TOOL')
  assert.equal(result.tool, 'read_file')
  assert.equal(result.ok, true)
  assert.equal(result.text, 'returned 234 lines')
  assert.equal(result.filePath, 'src/index.ts')
})

test('a shell result splits output from its exit status', () => {
  const result = normalizeSessionEvent(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r2',
        role: 'tool',
        toolCallId: 'c2',
        content: [{ type: 'text', text: '2 tests failed\n[exit code: 1]' }],
        source: { kind: 'tool', callId: 'c2' }
      }
    }),
    {},
    { pendingTool: { name: 'bash', shell: { command: 'npm test', description: 'Run tests' }, at: AT } }
  ).entries[0]

  assert.equal(result.tool, 'bash')
  assert.equal(result.shell.command, 'npm test')
  assert.equal(result.shellStatus.exitCode, 1)
  assert.equal(result.output.text, '2 tests failed', 'the marker is not part of the output body')
  assert.equal(result.ok, false, 'a non-zero exit is not reported as a tool error, but it is not a success either')
  assert.equal(result.level, 'error')
})

test('a killed command reports its signal', () => {
  const result = normalizeSessionEvent(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r3',
        role: 'tool',
        toolCallId: 'c3',
        content: [{ type: 'text', text: 'partial\n[killed by signal: SIGKILL]' }],
        source: { kind: 'tool', callId: 'c3' }
      }
    }),
    {},
    { pendingTool: { name: 'bash', shell: { command: 'sleep 999' }, at: AT } }
  ).entries[0]
  assert.equal(result.shellStatus.signal, 'SIGKILL')
  assert.equal(result.output.text, 'partial')
})

test('a tool failure keeps its error identity', () => {
  const failed = normalizeSessionEvent(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r4',
        role: 'tool',
        toolCallId: 'call-2',
        isError: true,
        content: [{ type: 'text', text: 'command failed' }],
        source: { kind: 'tool', toolName: 'bash' }
      },
      error: { name: 'ToolError', code: 'EXIT_1', reason: 'exit code 1' }
    }),
    {},
    { pendingTool: { name: 'bash', at: AT } }
  ).entries[0]
  assert.equal(failed.ok, false)
  assert.equal(failed.level, 'error')
  assert.equal(failed.detail, 'EXIT_1: exit code 1')
})

test('an orphaned result still reads as a result', () => {
  const orphan = firstEntry('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'r5',
      role: 'tool',
      toolCallId: 'never-seen',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'tool', toolName: 'read_file' }
    }
  }).entries[0]
  assert.equal(orphan.label, 'RESULT')
  assert.equal(orphan.phase, 'result')
  assert.equal(orphan.tool, 'read_file')
})

test('file-edit metadata is narrowed into diffs', () => {
  const entry = normalizeSessionEvent(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r6',
        role: 'tool',
        toolCallId: 'c6',
        content: [{ type: 'text', text: 'wrote 3 lines' }],
        source: { kind: 'tool', callId: 'c6' }
      },
      meta: { operation: 'create', diffs: [{ path: 'src/new.ts', oldText: null, newText: 'a\nb' }] }
    }),
    {},
    { pendingTool: { name: 'write', filePath: 'src/new.ts', at: AT } }
  ).entries[0]
  assert.equal(entry.operation, 'create')
  assert.equal(entry.diffs.length, 1)
  assert.equal(entry.diffs[0].path, 'src/new.ts')
  assert.equal(entry.diffs[0].oldText, null)

  // Malformed metadata degrades instead of throwing.
  const malformed = normalizeSessionEvent(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'r7', role: 'tool', toolCallId: 'c7', content: [], source: { kind: 'tool' } },
      meta: { diffs: [{ path: 42 }] }
    })
  ).entries[0]
  assert.equal(malformed.diffs, undefined)
})

test('approval events are visible and flagged', () => {
  const asked = firstEntry('approval/asked', { id: 'ap1', toolName: 'bash', reason: 'runs outside the sandbox' }).entries[0]
  assert.equal(asked.tag, 'approval')
  assert.equal(asked.level, 'warn')
  assert.equal(asked.text, 'bash — runs outside the sandbox')

  const decided = firstEntry('approval/decided', { id: 'ap1', outcome: 'rejected' }).entries[0]
  assert.equal(decided.level, 'error')
  assert.equal(decided.text, 'decision: rejected')
})

test('system and request metadata are suppressed by default and opt-in otherwise', () => {
  const system = event('system/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'You are…' }] } })
  assert.equal(normalizeSessionEvent(system).entries.length, 0)
  assert.equal(normalizeSessionEvent(system, { showSystemMessages: true }).entries[0].label, 'SYSTEM')

  const header = event('request/header', { header: {}, reason: 'initial' })
  assert.equal(normalizeSessionEvent(header).entries.length, 0)
  assert.equal(normalizeSessionEvent(header, { showRequestMetadata: true }).entries[0].label, 'HEADER')
})

test('request/context reports the context window without adding a line by default', () => {
  const result = normalizeSessionEvent(event('request/context', { provider: 'deepseek', model: 'deepseek-flash', capacity: 128000 }))
  assert.equal(result.entries.length, 0)
  assert.deepEqual(result.context, { provider: 'deepseek', model: 'deepseek-flash', capacity: 128000 })
})

test('unknown event types stay quiet by default and can be opted into', () => {
  const unknown = event('compaction/start', { reason: 'context full' })
  assert.equal(normalizeSessionEvent(unknown).entries.length, 0, 'hidden by default')
  const shown = normalizeSessionEvent(unknown, { showUnknownEvents: true }).entries[0]
  assert.equal(shown.label, 'COMPACTION/START')
  assert.equal(shown.text, 'context full')
})

test('the session title is surfaced and reported for the header', () => {
  const result = normalizeSessionEvent(
    event('session/title', { title: '解释一下这个插件', messageSeqs: [8], source: { kind: 'fallback' } })
  )
  assert.equal(result.sessionTitle, '解释一下这个插件')
  assert.equal(result.entries[0].label, 'TITLE')
  assert.equal(result.entries[0].text, '解释一下这个插件')
  assert.equal(normalizeSessionEvent(event('session/title', { title: '' })).sessionTitle, undefined)
})

test('startup policy records render as one compact line each', () => {
  assert.equal(normalizeSessionEvent(event('permission/preset', { preset: 'danger-full-access' })).entries[0].text, 'preset=danger-full-access')
  assert.equal(normalizeSessionEvent(event('sandbox/mode', { mode: 'workspace-write' })).entries[0].text, 'sandbox=workspace-write')
  assert.equal(normalizeSessionEvent(event('approval/policy', { policy: 'ask' })).entries[0].text, 'approval=ask')
  assert.equal(normalizeSessionEvent(event('sandbox/mode', {})).entries[0].text, 'sandbox=default')
})

test('contentText handles every block type defensively', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image', attachment: { name: 'shot.png' } }]), 'a [image shot.png]')
  assert.equal(contentText([{ type: 'file', attachment: { fileName: 'spec.pdf' } }]), '[file spec.pdf]')
  assert.equal(contentText([{ type: 'mystery' }]), '[mystery]')
  assert.equal(contentText('plain string'), 'plain string')
  assert.equal(contentText(null), '')
  assert.equal(contentText([{ type: 'reasoning', text: 'hidden' }]), '')
  assert.equal(contentText([{ type: 'reasoning', text: 'shown' }], { includeReasoning: true }), 'shown')
})

test('agent error normalization works for arbitrary thrown values', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.equal(describeError({ code: 'X', message: 'y' }), 'X: y')
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError(null), 'unknown error')
  const entry = normalizeAgentError({ turn: 2, step: 3, error: new Error('provider exploded'), time: AT }).entries[0]
  assert.equal(entry.tag, 'error')
  assert.equal(entry.label, 'ERROR')
  assert.equal(entry.level, 'error')
  assert.deepEqual([entry.turn, entry.step], [2, 3])
})

test('session and agent lifecycle render metadata', () => {
  const session = {
    id: 'session-abc',
    header: { createdAt: AT, cwd: '/w', origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' },
    seq: 12
  }
  const created = normalizeSessionCreated(session, 'resume')
  assert.equal(created.entry.tag, 'session')
  assert.match(created.entry.text, /opened \(resume\)/)
  assert.deepEqual(sessionInfo(session), {
    id: 'session-abc',
    createdAt: AT,
    cwd: '/w',
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'standard',
    seq: 12
  })

  const agent = normalizeAgentCreated({ options: { provider: 'deepseek-official', model: 'deepseek-flash' } }, 'startup')
  assert.equal(agent.entry.label, 'MODEL')
  assert.equal(agent.entry.text, 'deepseek-official/deepseek-flash (startup)')
  assert.equal(normalizeAgentCreated({ options: {} }).entry, null)
})

test('agent status maps onto the two lifecycle values', () => {
  assert.equal(agentStatusValue('running'), 'running')
  assert.equal(agentStatusValue('idle'), 'idle')
  assert.equal(agentStatusValue('anything-else'), 'idle')
})

test('usage accumulation and formatting', () => {
  const totals = {}
  accumulateUsage(totals, { inputTokens: 100, outputTokens: 20 })
  accumulateUsage(totals, { inputTokens: 50, outputTokens: 10, totalTokens: 90 })
  assert.equal(totals.inputTokens, 150)
  assert.equal(totals.outputTokens, 30)
  assert.equal(usageTotal(totals), 90)
  assert.equal(usageTotal({ inputTokens: 10, outputTokens: 5 }), 15)

  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(947), '947')
  assert.equal(formatTokens(4200), '4.2K')
  assert.equal(formatTokens(128000), '128K')
  assert.equal(formatTokens(1_300_000), '1.3M')
})

test('turnEndReasonText covers every documented reason', () => {
  assert.equal(turnEndReasonText({ kind: 'completed' }), 'completed')
  assert.equal(turnEndReasonText({ kind: 'blocked' }), 'blocked')
  assert.equal(turnEndReasonText({ kind: 'max-tokens' }), 'max output tokens reached')
  assert.equal(turnEndReasonText({ kind: 'something-new' }), 'something-new')
  assert.equal(turnEndReasonText(null), 'ended')
})

test('internal transport bookkeeping is hidden by default and configurable', () => {
  const delivery = event('session-log-deepseek/delivery-accepted', {
    sessionId: 'session-x',
    sessionFormatVersion: 4,
    throughSeq: 13
  })
  assert.equal(normalizeSessionEvent(delivery).entries.length, 0, 'hidden by default')
  assert.equal(
    normalizeSessionEvent(delivery, { mutedEventTypes: [], showUnknownEvents: true }).entries.length,
    1,
    'visible when unmuted'
  )
  assert.equal(
    normalizeSessionEvent(delivery, { mutedEventTypes: ['session-log-deepseek/*'], showUnknownEvents: true }).entries.length,
    0,
    'an explicit prefix pattern applies even when unknown events are shown'
  )
  assert.equal(
    normalizeSessionEvent(delivery, { mutedEventTypes: ['other/*'], showUnknownEvents: true }).entries.length,
    1,
    'an unrelated pattern does not hide it'
  )

  assert.equal(isMutedEventType('session-log-deepseek/delivery-accepted'), true)
  assert.equal(isMutedEventType('session-log-deepseek/anything'), true)
  assert.equal(isMutedEventType('compaction/start'), false)
  assert.equal(isMutedEventType('anything', []), false)
  assert.equal(isMutedEventType(undefined), false)
  assert.deepEqual(DEFAULT_MUTED_EVENT_TYPES, ['session-log-deepseek/*'])
})
