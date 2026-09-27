/**
 * The Unix-socket transport: framing, session routing, replay, and teardown.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'

import { connectTrace } from '../lib/client.js'
import { createLineDecoder, encodeRecord, PROTOCOL_VERSION } from '../lib/protocol.js'
import { TraceHub } from '../lib/tracker.js'
import { createTraceServer, defaultSocketPath } from '../lib/transport.js'
import { makeTempDir, removeTempDir, sleep, waitFor } from './helpers/util.js'

const AT = 1_760_000_000_000

function fakeSession(id, createdAt = AT) {
  return { id, header: { createdAt, cwd: '/workspace' }, seq: 0 }
}

function event(type, data, seq = 0) {
  return { type, seq, time: AT + seq, data }
}

/** Start a hub plus a server on a throwaway socket. */
async function startServer(options = {}) {
  const runtimeDir = makeTempDir()
  const hub = new TraceHub({ now: () => AT, streamIntervalMs: 10, ...options.hub })
  const socketPath = options.socketPath ?? defaultSocketPath(runtimeDir, process.pid)
  const server = createTraceServer({
    socketPath,
    runtimeDir,
    hub,
    serverInfo: () => ({ pid: process.pid, version: 'test' }),
    heartbeatMs: options.heartbeatMs ?? 60_000
  })
  await server.ready
  return { runtimeDir, hub, server, socketPath }
}

/** A promise-returning reader that decodes NDJSON from a raw socket. */
function rawClient(socketPath) {
  const socket = connect(socketPath)
  socket.setEncoding('utf8')
  const decoder = createLineDecoder()
  const records = []
  const waiters = []
  socket.on('data', (chunk) => {
    for (const record of decoder.push(chunk)) {
      records.push(record)
      for (const waiter of waiters.splice(0)) waiter()
    }
  })
  return {
    socket,
    records,
    send: (record) => socket.write(encodeRecord(record)),
    async until(predicate, label = 'record') {
      await waitFor(() => records.some(predicate), { label, timeoutMs: 3000 })
      return records.find(predicate)
    },
    close: () => socket.destroy()
  }
}

test('the line decoder handles split chunks, CRLF, and blank lines', () => {
  const decoder = createLineDecoder()
  assert.deepEqual(decoder.push('{"a":'), [])
  assert.deepEqual(decoder.push('1}\r\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
  assert.throws(() => decoder.push('not json\n'), /malformed JSON/)
})

test('the line decoder refuses a runaway record instead of buffering forever', () => {
  const decoder = createLineDecoder()
  assert.throws(() => decoder.push('x'.repeat(8 * 1024 * 1024 + 1)), /exceeded/)
})

test('a new viewer receives a hello record and the current session list', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    const client = rawClient(socketPath)
    const hello = await client.until((record) => record.kind === 'hello')
    assert.equal(hello.v, PROTOCOL_VERSION)
    assert.equal(hello.server.version, 'test')
    assert.equal(hello.sessions.length, 1)
    assert.equal(hello.sessions[0].id, 's1')
    assert.equal(hello.activeSessionId, 's1')
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('the server reaches only viewers bound to the same session', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    hub.onSessionCreated(fakeSession('s2', AT + 1000))

    const first = rawClient(socketPath)
    await first.until((record) => record.kind === 'hello')
    first.send({ v: PROTOCOL_VERSION, kind: 'select', sessionId: 's1' })
    await first.until((record) => record.kind === 'sessions')

    const second = rawClient(socketPath)
    await second.until((record) => record.kind === 'hello')
    second.send({ v: PROTOCOL_VERSION, kind: 'select', sessionId: 's2' })
    await second.until((record) => record.kind === 'sessions')

    hub.onSessionEvent(fakeSession('s1'), event('turn/start', { turn: 1 }))
    hub.onSessionEvent(fakeSession('s2'), event('turn/start', { turn: 7 }))

    await first.until((record) => record.kind === 'entry' && record.entry.label === 'TURN 1')
    await second.until((record) => record.kind === 'entry' && record.entry.label === 'TURN 7')

    const firstEntries = first.records.filter((record) => record.kind === 'entry')
    const secondEntries = second.records.filter((record) => record.kind === 'entry')
    assert.equal(firstEntries.every((record) => record.sessionId === 's1'), true)
    assert.equal(secondEntries.every((record) => record.sessionId === 's2'), true)

    first.close()
    second.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('selecting a session replays its backlog, status, and usage', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    const session = fakeSession('s1')
    hub.onSessionEvent(session, event('turn/start', { turn: 2 }, 0))
    hub.onSessionEvent(session, event('step/start', { turn: 2, step: 1 }, 1))
    hub.onSessionEvent(session, event('assistant/message', { turn: 2, step: 1, message: { content: [] }, stream: [], usage: { inputTokens: 42 } }, 2))

    const client = rawClient(socketPath)
    await client.until((record) => record.kind === 'hello')
    client.send({ v: PROTOCOL_VERSION, kind: 'select', sessionId: 's1', limit: 10 })

    await client.until((record) => record.kind === 'status')
    const labels = client.records.filter((record) => record.kind === 'entry').map((record) => record.entry.label)
    assert.deepEqual(labels.slice(-3), ['TURN 2', 'STEP 1', 'ASSISTANT'])
    assert.equal(client.records.find((record) => record.kind === 'usage').usage.inputTokens, 42)
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('selecting an unknown session answers with an error and the session list', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    const client = rawClient(socketPath)
    await client.until((record) => record.kind === 'hello')
    client.send({ v: PROTOCOL_VERSION, kind: 'select', sessionId: 'ghost' })
    const error = await client.until((record) => record.kind === 'error')
    assert.match(error.message, /unknown session ghost/)
    assert.equal(error.sessions.length, 1)
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('an unknown client request is ignored rather than fatal', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    const client = rawClient(socketPath)
    await client.until((record) => record.kind === 'hello')
    client.send({ v: PROTOCOL_VERSION, kind: 'from-the-future' })
    client.send({ v: PROTOCOL_VERSION, kind: 'ping' })
    await client.until((record) => record.kind === 'heartbeat' && record.pong === true)
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('heartbeats reach every viewer', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer({ heartbeatMs: 30 })
  try {
    hub.onSessionCreated(fakeSession('s1'))
    const client = rawClient(socketPath)
    await client.until((record) => record.kind === 'heartbeat' && record.pong !== true)
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('stream records are published on the coalescing cadence', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    const agent = { session: fakeSession('s1') }
    const client = rawClient(socketPath)
    await client.until((record) => record.kind === 'hello')
    client.send({ v: PROTOCOL_VERSION, kind: 'select', sessionId: 's1' })
    // The binding is only in effect once the server has answered the selection.
    await client.until((record) => record.kind === 'sessions')

    hub.onAssistantStream(agent, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    for (const chunk of ['译', '中', '流']) {
      hub.onAssistantStream(agent, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: AT, chunk: { type: 'text-delta', index: 0, text: chunk } })
    }
    assert.equal(hub.flushStreams(AT + 100), 1)

    const stream = await client.until((record) => record.kind === 'stream')
    assert.equal(stream.text, '译中流')

    hub.onSessionEvent(fakeSession('s1'), event('assistant/message', { turn: 1, step: 1, message: { content: [] }, stream: [] }, 5))
    await client.until((record) => record.kind === 'stream-end')
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('closing the server unlinks the socket and releases viewers', async () => {
  const { server, socketPath, runtimeDir } = await startServer()
  assert.equal(existsSync(socketPath), true)
  const client = rawClient(socketPath)
  await client.until((record) => record.kind === 'hello')
  assert.equal(server.clientCount(), 1)
  await server.close()
  assert.equal(existsSync(socketPath), false)
  await waitFor(() => client.socket.destroyed, { label: 'viewer socket teardown' })
  // Closing twice is safe: the plugin's disposer may race the instance guard.
  await server.close()
  removeTempDir(runtimeDir)
})

test('the reconnecting client re-attaches and re-selects after the server restarts', async () => {
  const runtimeDir = makeTempDir()
  const socketPath = join(runtimeDir, 'sockets', 'restart.sock')
  const hubA = new TraceHub({ now: () => AT })
  const first = createTraceServer({ socketPath, runtimeDir, hub: hubA, serverInfo: () => ({ pid: 1 }) })
  await first.ready
  hubA.onSessionCreated(fakeSession('s1'))

  const seen = []
  let opens = 0
  const client = connectTrace({
    socketPath,
    sessionId: 's1',
    onRecord: (record) => seen.push(record),
    onOpen: () => {
      opens += 1
    }
  })
  await waitFor(() => seen.some((record) => record.kind === 'hello'), { label: 'first attach' })
  await first.close()

  const hubB = new TraceHub({ now: () => AT })
  const second = createTraceServer({ socketPath, runtimeDir, hub: hubB, serverInfo: () => ({ pid: 2 }) })
  await second.ready
  hubB.onSessionCreated(fakeSession('s1'))
  hubB.onSessionEvent(fakeSession('s1'), event('turn/start', { turn: 5 }))

  await waitFor(() => opens >= 2, { label: 'reconnect', timeoutMs: 5000 })
  await waitFor(() => seen.some((record) => record.kind === 'entry' && record.entry.label === 'TURN 5'), {
    label: 'post-reconnect event',
    timeoutMs: 5000
  })

  client.close()
  await second.close()
  removeTempDir(runtimeDir)
})

test('the client falls back to the server default when its session disappears', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    const seen = []
    const client = connectTrace({ socketPath, sessionId: 's1', onRecord: (record) => seen.push(record) })
    await waitFor(() => seen.some((record) => record.kind === 'hello'), { label: 'attach' })

    hub.onSessionDisposed(fakeSession('s1'))
    hub.onSessionCreated(fakeSession('s2', AT + 1000))
    // Re-selecting the vanished session answers with an error, and the client
    // follows the server's new default rather than going silent.
    hub.onSessionEvent(fakeSession('s2'), event('turn/start', { turn: 9 }))
    await waitFor(() => seen.some((record) => record.kind === 'entry' && record.entry.label === 'TURN 9'), {
      label: 'fallback binding',
      timeoutMs: 3000
    })
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('an empty Harness is not an error for a viewer that names no session', async () => {
  const { server, socketPath, runtimeDir } = await startServer()
  try {
    const client = rawClient(socketPath)
    await client.until((record) => record.kind === 'hello')
    client.send({ v: PROTOCOL_VERSION, kind: 'select' })
    const sessions = await client.until((record) => record.kind === 'sessions')
    assert.deepEqual(sessions.sessions, [])
    assert.equal(sessions.activeSessionId, null)
    assert.equal(client.records.some((record) => record.kind === 'error'), false)
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('a viewer opened before the first session starts following it', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    const seen = []
    const client = connectTrace({ socketPath, sessionId: null, onRecord: (record) => seen.push(record) })
    await waitFor(() => seen.some((record) => record.kind === 'hello'), { label: 'attach' })

    // No session exists yet; the plugin must not treat that as an error.
    await waitFor(() => seen.some((record) => record.kind === 'sessions'), { label: 'empty session list' })
    assert.equal(seen.some((record) => record.kind === 'error'), false)

    hub.onSessionCreated(fakeSession('appears-later'))
    hub.onSessionEvent(fakeSession('appears-later'), event('turn/start', { turn: 4 }))
    await waitFor(() => seen.some((record) => record.kind === 'entry' && record.entry.label === 'TURN 4'), {
      label: 'auto-bound session entry',
      timeoutMs: 5000
    })
    assert.equal(seen.find((record) => record.entry?.label === 'TURN 4').sessionId, 'appears-later')
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('session list records report the binding the viewer actually holds', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    hub.onSessionCreated(fakeSession('s2', AT + 1000))
    const client = rawClient(socketPath)
    await client.until((record) => record.kind === 'hello')
    client.send({ v: PROTOCOL_VERSION, kind: 'select', sessionId: 's1' })
    const bound = await client.until((record) => record.kind === 'sessions')
    assert.equal(bound.boundSessionId, 's1')

    // A later list change is personalized per viewer, not broadcast verbatim.
    hub.onSessionCreated(fakeSession('s3', AT + 2000))
    const updated = await client.until((record) => record.kind === 'sessions' && record.sessions.length === 3)
    assert.equal(updated.boundSessionId, 's1')
    assert.equal(updated.activeSessionId, 's3')
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})

test('attaching replays the backlog exactly once', async () => {
  const { server, hub, socketPath, runtimeDir } = await startServer()
  try {
    hub.onSessionCreated(fakeSession('s1'))
    hub.onSessionEvent(fakeSession('s1'), event('turn/start', { turn: 1 }))
    hub.onSessionEvent(fakeSession('s1'), event('step/start', { turn: 1, step: 1 }))

    const seen = []
    const client = connectTrace({ socketPath, sessionId: 's1', onRecord: (record) => seen.push(record) })
    await waitFor(() => seen.some((record) => record.kind === 'entry' && record.entry.label === 'STEP 1'), { label: 'replay' })
    await sleep(250)

    const turnLabels = seen.filter((record) => record.kind === 'entry' && record.entry.label === 'TURN 1')
    assert.equal(turnLabels.length, 1, 'the opening hello must not trigger a second selection')
    client.close()
  } finally {
    await server.close()
    removeTempDir(runtimeDir)
  }
})
