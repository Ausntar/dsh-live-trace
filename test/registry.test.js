/**
 * Discovery: how a viewer picks a Harness process and a session among several.
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { expandHomePath, resolveDshHome, resolveRuntimeDir, serversDir, socketsDir } from '../lib/paths.js'
import {
  isProcessAlive,
  newestSession,
  pruneServerRecords,
  readServerRecords,
  removeServerRecord,
  removeServerRecordIfOwner,
  selectServerRecord,
  selectSession,
  serverRecordPath,
  writeServerRecord
} from '../lib/registry.js'
import { makeTempDir, removeTempDir } from './helpers/util.js'

const AT = 1_760_000_000_000

function record(pid, overrides = {}) {
  return { pid, socket: `/run/${pid}.sock`, startedAt: AT, heartbeat: AT, cwd: '/workspace', sessions: [], ...overrides }
}

test('the harness home follows the documented precedence', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/home' }), '/custom/home')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(process.env.HOME ?? '', '.dsh'))
  assert.match(resolveDshHome({}), /\.dsh$/)
})

test('the runtime directory honours its own override before the harness home', () => {
  assert.equal(resolveRuntimeDir({ DSH_HOME: '/h', DSH_LIVE_TRACE_DIR: '/runtime' }), '/runtime')
  assert.equal(resolveRuntimeDir({ DSH_HOME: '/h' }), '/h/live-trace')
  assert.equal(socketsDir('/runtime'), '/runtime/sockets')
  assert.equal(serversDir('/runtime'), '/runtime/servers')
})

test('expandHomePath only rewrites supported tilde prefixes', () => {
  const home = process.env.HOME ?? ''
  assert.equal(expandHomePath('~/x'), join(home, 'x'))
  assert.equal(expandHomePath('~'), home)
  assert.equal(expandHomePath('/abs'), '/abs')
  assert.equal(expandHomePath('~someone/x'), '~someone/x')
})

test('registry records round-trip through the servers directory', () => {
  const dir = makeTempDir()
  try {
    writeServerRecord(dir, record(11))
    writeServerRecord(dir, record(22))
    const records = readServerRecords(dir)
    assert.deepEqual(records.map((item) => item.pid).sort((a, b) => a - b), [11, 22])
    assert.equal(records[0].v, 1, 'the protocol version is stamped on write')

    removeServerRecord(dir, 11)
    assert.deepEqual(readServerRecords(dir).map((item) => item.pid), [22])
    assert.equal(serverRecordPath(dir, 22), join(dir, '22.json'))
  } finally {
    removeTempDir(dir)
  }
})

test('a corrupt or oversized registry record is skipped rather than fatal', () => {
  const dir = makeTempDir()
  try {
    writeFileSync(join(dir, 'broken.json'), '{not json')
    writeFileSync(join(dir, 'empty.json'), '')
    writeServerRecord(dir, record(33))
    assert.deepEqual(readServerRecords(dir).map((item) => item.pid), [33])
  } finally {
    removeTempDir(dir)
  }
})

test('a stale record from a dead process is pruned and unlinked', () => {
  const dir = makeTempDir()
  try {
    const now = Date.now()
    writeServerRecord(dir, record(process.pid, { heartbeat: now }))
    // Stale heartbeat and a pid that cannot exist: genuinely abandoned.
    writeServerRecord(dir, record(2_147_483_646, { heartbeat: now - 10 * 60_000 }))

    const surviving = pruneServerRecords(dir, { now })
    assert.deepEqual(surviving.map((item) => item.pid), [process.pid])
    assert.deepEqual(readServerRecords(dir).map((item) => item.pid), [process.pid])
  } finally {
    removeTempDir(dir)
  }
})

test('a fresh record survives even when its process cannot be signalled', () => {
  const dir = makeTempDir()
  try {
    const now = Date.now()
    // This is what a viewer in another PID namespace sees: a live Harness whose
    // pid it cannot probe. The fresh heartbeat is the proof of life.
    writeServerRecord(dir, record(2_147_483_646, { heartbeat: now }))

    const surviving = pruneServerRecords(dir, { now })
    assert.deepEqual(surviving.map((item) => item.pid), [2_147_483_646])
    assert.equal(readServerRecords(dir).length, 1, 'a read-only listing must not delete a live record')
  } finally {
    removeTempDir(dir)
  }
})

test('a stale record from a live process is kept', () => {
  const dir = makeTempDir()
  try {
    const now = Date.now()
    // Alive but not heartbeating (paused, or briefly descheduled).
    writeServerRecord(dir, record(process.pid, { heartbeat: now - 10 * 60_000 }))
    assert.deepEqual(pruneServerRecords(dir, { now }).map((item) => item.pid), [process.pid])
  } finally {
    removeTempDir(dir)
  }
})

test('alive detection is tolerant and correct', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(2_147_483_646), false)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(Number.NaN), false)
})

test('server selection follows socket, then pid, then cwd, then freshness', () => {
  const records = [
    record(1, { socket: '/run/one.sock', cwd: '/a', heartbeat: AT + 3 }),
    record(2, { socket: '/run/two.sock', cwd: '/b', heartbeat: AT + 9 }),
    record(3, { socket: '/run/three.sock', cwd: '/b', heartbeat: AT + 1 })
  ]

  assert.equal(selectServerRecord(records, { socket: '/run/three.sock' }).pid, 3)
  assert.equal(selectServerRecord(records, { pid: 1 }).pid, 1)
  assert.equal(selectServerRecord(records, { cwd: '/b' }).pid, 2, 'the freshest match for the cwd')
  assert.equal(selectServerRecord(records, {}).pid, 2, 'the freshest overall')
  assert.equal(selectServerRecord([], {}), undefined)
})

test('an explicit socket works with no registry record at all', () => {
  const selected = selectServerRecord([], { socket: '/run/manual.sock', cwd: '/w' })
  assert.equal(selected.socket, '/run/manual.sock')
  assert.deepEqual(selected.sessions, [])
})

test('session selection follows explicit id, then cwd, then the record default', () => {
  const sessions = [
    { id: 'a', createdAt: AT + 1, cwd: '/a' },
    { id: 'b', createdAt: AT + 5, cwd: '/b' },
    { id: 'c', createdAt: AT + 3, cwd: '/b' }
  ]
  const owner = { activeSessionId: 'a', sessions }

  assert.equal(selectSession(owner, { sessionId: 'c' }).id, 'c')
  assert.equal(selectSession(owner, { sessionId: 'missing' }), undefined)
  assert.equal(selectSession(owner, { cwd: '/b' }).id, 'b', 'the newest session in the cwd')
  assert.equal(selectSession(owner, {}).id, 'a', 'the record default beats creation order')
  assert.equal(selectSession({ activeSessionId: 'ghost', sessions }, {}).id, 'b')
  assert.equal(selectSession({ sessions: [] }, {}), undefined)
})

test('newestSession tolerates missing creation times', () => {
  assert.equal(newestSession([{ id: 'x' }, { id: 'y', createdAt: AT }]).id, 'y')
  assert.equal(newestSession([{ id: 'x', createdAt: AT }]).id, 'x')
})

test('a late disposer cannot delete a live generation record', () => {
  const dir = makeTempDir()
  try {
    writeServerRecord(dir, record(process.pid, { socket: '/run/current.sock' }))
    assert.equal(removeServerRecordIfOwner(dir, process.pid, '/run/stale.sock'), false)
    assert.equal(readServerRecords(dir).length, 1)
    assert.equal(removeServerRecordIfOwner(dir, process.pid, '/run/current.sock'), true)
    assert.equal(readServerRecords(dir).length, 0)
  } finally {
    removeTempDir(dir)
  }
})
