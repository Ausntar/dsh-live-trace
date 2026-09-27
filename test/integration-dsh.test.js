/**
 * Integration: the real `@deepseek-ai/dsh-session` plugin, the real event bus,
 * the real socket, and this package's observer.
 *
 * This is the test that proves the plugin works against the shipped Harness
 * rather than a fixture: sessions are created and appended through the genuine
 * `SessionStore`, and the assertions read what a viewer actually receives.
 *
 * The suite skips (rather than fails) on a machine with no Harness install.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apply, resolveConfig, version } from '../index.js'
import { connectTrace } from '../lib/client.js'
import { socketsDir, serversDir } from '../lib/paths.js'
import { readServerRecords, pruneServerRecords } from '../lib/registry.js'
import { loadHarnessRuntime } from './helpers/dsh.js'
import { makeTempDir, removeTempDir, waitFor } from './helpers/util.js'

const runtime = await loadHarnessRuntime()
const skip = runtime === null ? 'no DeepSeek Harness installation found' : false

/**
 * A disposable test fixture: a real Cordis context driving the real session
 * store, our plugin's effects, any connected viewers, and one temp directory.
 */
async function fixture() {
  const runtimeDir = makeTempDir()
  const ctx = new runtime.Context()
  const sessionFiber = ctx.plugin(runtime.sessionPlugin)
  await waitFor(() => typeof ctx.sessions?.create === 'function', { label: 'session service', timeoutMs: 5000 })

  /** @type {Array<() => void>} */
  const disposers = [() => sessionFiber.dispose()]

  const socketPath = join(socketsDir(runtimeDir), `${process.pid}.sock`)
  const attachObserver = async (config = {}) => {
    const disposer = apply(ctx, { runtimeDir, socketPath, streamIntervalMs: 60, heartbeatMs: 120, backlogSize: 200, ...config })
    if (typeof disposer === 'function') disposers.push(disposer)
    await waitFor(() => existsSync(socketPath), { label: 'observer socket', timeoutMs: 5000 })
    return socketPath
  }

  /** Connect a viewer that the fixture will always close. */
  const attachViewer = (sessionId) => {
    const records = []
    const client = connectTrace({
      socketPath,
      sessionId,
      replayLimit: 200,
      onRecord: (record) => records.push(record)
    })
    disposers.push(() => client.close())
    return {
      client,
      records,
      async until(predicate, label) {
        await waitFor(() => records.some(predicate), { label, timeoutMs: 6000 })
        return records.find(predicate)
      },
      labels: () => records.filter((record) => record.kind === 'entry').map((record) => record.entry.label),
      entry: (label) => records.find((record) => record.kind === 'entry' && record.entry.label === label)?.entry
    }
  }

  return {
    ctx,
    runtimeDir,
    socketPath,
    attachObserver,
    attachViewer,
    async dispose() {
      for (const disposer of disposers.reverse()) {
        try {
          await disposer()
        } catch {
          /* teardown is best effort in a failing test */
        }
      }
      removeTempDir(runtimeDir)
    }
  }
}

test('the observer publishes real session events to a viewer over the socket', { skip }, async () => {
  const f = await fixture()
  try {
    await f.attachObserver()
    const session = f.ctx.sessions.create('session-live-trace-main', { meta: { cwd: '/home/developer/DeepseekHarness' } })
    const seen = f.attachViewer('session-live-trace-main')

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'user/message',
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '请修复这个 bug' }], source: { kind: 'user' } },
      { surfaceOp: 'append' }
    )
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'text', text: '先读取文件再修改。' },
            { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"src/index.ts"}' }
          ],
          source: { kind: 'model' }
        },
        stream: [],
        usage: { inputTokens: 1200, outputTokens: 240, totalTokens: 1440 }
      },
      { surfaceOp: 'append' }
    )
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"src/index.ts"}' })
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          id: 'r1',
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: '返回 234 行' }],
          source: { kind: 'tool', callId: 'call-1' }
        }
      },
      { surfaceOp: 'append' }
    )
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await seen.until((record) => record.kind === 'entry' && record.entry.label === 'TURN 1 END')

    const labels = seen.labels()
    for (const expected of ['SESSION', 'TURN 1', 'STEP 1', 'USER', 'ASSISTANT', 'TOOL', 'TURN 1 END']) {
      assert.ok(labels.includes(expected), `missing ${expected} in ${JSON.stringify(labels)}`)
    }
    // The call and its result reach the wire as two records that share a key,
    // which is what lets the viewer render them as one row.
    const toolRecords = seen.records.filter((record) => record.kind === 'entry' && record.entry?.tag === 'tool')
    assert.equal(toolRecords.length, 2, 'the call and its settlement both arrive')
    assert.equal(toolRecords[0].entry.phase, 'call')
    assert.equal(toolRecords[1].entry.phase, 'result')
    assert.equal(toolRecords[0].entry.key, toolRecords[1].entry.key)
    assert.equal(labels.includes('RESULT'), false, 'results merge into the tool block, not their own label')

    assert.equal(seen.entry('USER').text, '请修复这个 bug')
    assert.equal(seen.entry('ASSISTANT').text, '先读取文件再修改。')
    // `entry()` finds the first TOOL record, which is the call; the settled
    // block is the one that carries the outcome.
    const tool = toolRecords[1].entry
    assert.equal(tool.phase, 'result')
    assert.equal(tool.tool, 'read_file')
    assert.equal(tool.callId, 'call-1')
    assert.equal(tool.filePath, 'src/index.ts')
    assert.equal(tool.ok, true)
    assert.equal(tool.text, '返回 234 行')
    assert.equal(typeof tool.durationMs, 'number', 'the plugin stamps the duration')
    assert.equal(seen.entry('TURN 1 END').text, 'completed')

    const usage = await seen.until((record) => record.kind === 'usage' && record.usage.inputTokens >= 1200)
    assert.equal(usage.usage.outputTokens, 240)

    const status = await seen.until((record) => record.kind === 'status' && record.turn === 1)
    assert.ok(['running', 'tool', 'idle'].includes(status.status))
  } finally {
    await f.dispose()
  }
})

test('the observer publishes a discovery record a viewer can resolve', { skip }, async () => {
  const f = await fixture()
  try {
    await f.attachObserver()
    f.ctx.sessions.create('session-discovery', { meta: { cwd: '/workspace/discovery' } })

    const registryDir = serversDir(f.runtimeDir)
    await waitFor(
      () => readServerRecords(registryDir).some((record) => (record.sessions ?? []).some((s) => s.id === 'session-discovery')),
      { label: 'registry record naming the new session', timeoutMs: 5000 }
    )

    const record = pruneServerRecords(registryDir).find((item) => item.pid === process.pid)
    assert.ok(record !== undefined, 'this process published a registry record')
    assert.equal(record.pid, process.pid)
    assert.equal(record.cwd, process.cwd())
    assert.equal(record.version, version)
    assert.ok(record.socket.startsWith(join(f.runtimeDir, 'sockets')))
    assert.equal(record.activeSessionId, 'session-discovery')
  } finally {
    await f.dispose()
  }
})

test('live assistant streaming reaches the viewer as coalesced text', { skip }, async () => {
  const f = await fixture()
  try {
    await f.attachObserver()
    const session = f.ctx.sessions.create('session-streaming', { meta: { cwd: '/workspace' } })
    const seen = f.attachViewer('session-streaming')
    await seen.until((record) => record.kind === 'hello')

    const agent = { session }
    f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 } })
    for (const text of ['推理', '中', '……']) {
      f.ctx.emit('agent/assistant-stream', {
        agent,
        frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } }
      })
    }

    const stream = await seen.until((record) => record.kind === 'stream' && record.text.length > 0, 'coalesced stream record')
    assert.equal(stream.text, '推理中……')
    assert.equal(stream.turn, 1)
    assert.equal(stream.step, 1)

    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '推理中……完成' }], source: { kind: 'model' } },
        stream: []
      },
      { surfaceOp: 'append' }
    )
    await seen.until((record) => record.kind === 'stream-end', 'stream settlement')
    assert.equal(seen.entry('ASSISTANT').text, '推理中……完成')
  } finally {
    await f.dispose()
  }
})

test('agent status, errors, and approvals drive the live status', { skip }, async () => {
  const f = await fixture()
  try {
    await f.attachObserver()
    const session = f.ctx.sessions.create('session-status', { meta: { cwd: '/workspace' } })
    const seen = f.attachViewer('session-status')
    await seen.until((record) => record.kind === 'hello')

    const agent = { session }
    session.append('turn/start', { turn: 1 })
    f.ctx.emit('agent/status', { agent, status: 'running' })

    session.append('approval/asked', { id: 'ap-1', toolName: 'bash', reason: 'runs outside the sandbox' })
    await seen.until((record) => record.kind === 'status' && record.status === 'waiting-approval', 'approval wait')
    assert.equal(seen.entry('APPROVAL').text, 'bash — runs outside the sandbox')

    session.append('approval/decided', { id: 'ap-1', outcome: 'rejected' })
    await seen.until((record) => record.kind === 'status' && record.status === 'running', 'resume after decision')

    f.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('provider exploded') })
    const errorStatus = await seen.until((record) => record.kind === 'status' && record.status === 'error', 'error status')
    assert.equal(errorStatus.error, 'provider exploded')
    assert.equal(seen.entry('ERROR').text, 'provider exploded')
  } finally {
    await f.dispose()
  }
})

test('unloading the plugin removes its socket and discovery record', { skip }, async () => {
  const f = await fixture()
  try {
    await f.attachObserver()
    const registryDir = serversDir(f.runtimeDir)
    await waitFor(() => readServerRecords(registryDir).length > 0, { label: 'registry record' })
    assert.equal(existsSync(f.socketPath), true)

    await f.dispose()

    assert.equal(existsSync(f.socketPath), false, 'the socket is unlinked on unload')
    assert.equal(readServerRecords(registryDir).length, 0, 'the registry record is removed on unload')
  } catch (error) {
    await f.dispose()
    throw error
  }
})

test('two observer generations in one process share the socket path safely', { skip }, async () => {
  const f = await fixture()
  try {
    await f.attachObserver()
    // A hot-reload generation binds the same path; the previous one must yield.
    await f.attachObserver()

    const session = f.ctx.sessions.create('session-reload', { meta: { cwd: '/workspace' } })
    const seen = f.attachViewer('session-reload')
    session.append('turn/start', { turn: 1 })
    await seen.until((record) => record.kind === 'entry' && record.entry.label === 'TURN 1', 'reloaded observer delivery')

    const record = JSON.parse(readFileSync(join(serversDir(f.runtimeDir), `${process.pid}.json`), 'utf8'))
    assert.equal(record.socket, f.socketPath)
  } finally {
    await f.dispose()
  }
})

test('configuration is validated defensively and disabling registers nothing', async () => {
  assert.equal(resolveConfig({ enabled: true }).enabled, true)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ streamIntervalMs: 1 }).streamIntervalMs, 50, 'clamped to the minimum')
  assert.equal(resolveConfig({ streamIntervalMs: 10_000_000 }).streamIntervalMs, 60_000, 'clamped to the maximum')
  assert.equal(resolveConfig({ backlogSize: 'nonsense' }).backlogSize, 2000)
  assert.equal(resolveConfig(undefined).showUnknownEvents, false)
  assert.equal(resolveConfig({ showUnknownEvents: true }).showUnknownEvents, true)
  assert.equal(resolveConfig({ textLimit: 5 }).textLimit, 120)
})
