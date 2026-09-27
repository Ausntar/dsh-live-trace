/**
 * Teardown: what the Harness is left holding after the observer unloads.
 *
 * The plugin's whole contract with the surface it observes is that unloading it
 * leaves nothing behind — no socket, no discovery record, no timer, no
 * listener. These tests assert that directly rather than by inspection:
 *
 * 1. In-process, mount/unmount cycles must not accumulate server instances or
 *    leave a socket or registry record behind.
 * 2. Out-of-process, a program that boots everything and then disposes must
 *    exit *on its own*. An unclosed listening socket or a live interval keeps
 *    the event loop alive, so the process would hang instead of exiting.
 *
 * The second test has teeth: with the disposal call removed it hangs (timeout),
 * which is what a leak looks like.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { instanceCount, hasInstance } from '../lib/instance.js'
import { serversDir, socketsDir } from '../lib/paths.js'
import { readServerRecords } from '../lib/registry.js'
import { loadHarnessRuntime } from './helpers/dsh.js'
import { makeTempDir, removeTempDir, sleep, waitFor } from './helpers/util.js'

const runtime = await loadHarnessRuntime()
const skip = runtime === null ? 'no DeepSeek Harness installation found' : false

/** Paths the generated child program needs, resolved through the test helper. */
const HELPER_URL = new URL('./helpers/dsh.js', import.meta.url).href
const INDEX_URL = new URL('../index.js', import.meta.url).href
const PATHS_URL = new URL('../lib/paths.js', import.meta.url).href
const REGISTRY_URL = new URL('../lib/registry.js', import.meta.url).href
const INSTANCE_URL = new URL('../lib/instance.js', import.meta.url).href

const CHILD_SOURCE = `
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadHarnessRuntime } from ${JSON.stringify(HELPER_URL)}
import { apply } from ${JSON.stringify(INDEX_URL)}
import { serversDir, socketsDir } from ${JSON.stringify(PATHS_URL)}
import { readServerRecords } from ${JSON.stringify(REGISTRY_URL)}
import { instanceCount } from ${JSON.stringify(INSTANCE_URL)}

const runtimeDir = process.argv[2]
const socketPath = join(socketsDir(runtimeDir), process.pid + '.sock')
const runtime = await loadHarnessRuntime()
const ctx = new runtime.Context()
const fiber = ctx.plugin(runtime.sessionPlugin)
while (typeof ctx.sessions?.create !== 'function') await new Promise((r) => setTimeout(r, 10))

const disposer = apply(ctx, { runtimeDir, socketPath, streamIntervalMs: 50, heartbeatMs: 100 })
while (!existsSync(socketPath)) await new Promise((r) => setTimeout(r, 10))

ctx.sessions.create('session-lifecycle', { meta: { cwd: process.cwd() } })
await new Promise((r) => setTimeout(r, 80))

await disposer()
await fiber.dispose()
await new Promise((r) => setTimeout(r, 80))

process.stdout.write(
  JSON.stringify({
    socketGone: !existsSync(socketPath),
    records: readServerRecords(serversDir(runtimeDir)).length,
    instances: instanceCount()
  }) + '\\n'
)
// Deliberately no process.exit(): the event loop must drain by itself.
`

function runChild(scriptPath, runtimeDir, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [scriptPath, runtimeDir],
      { timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr, timedOut: error?.killed === true || error?.signal === 'SIGKILL' })
      }
    )
    void child
  })
}

test('a program that disposes the observer exits on its own', { skip }, async () => {
  const runtimeDir = makeTempDir()
  const scriptPath = join(runtimeDir, 'dispose-and-exit.mjs')
  writeFileSync(scriptPath, CHILD_SOURCE)
  try {
    const result = await runChild(scriptPath, runtimeDir, 20_000)

    assert.equal(result.timedOut, false, `the process hung after disposal — a handle leaked.\n${result.stderr}`)
    assert.equal(result.error, null, `child failed: ${result.error?.message}\n${result.stderr}`)

    const line = result.stdout.trim().split('\n').at(-1)
    const report = JSON.parse(line)
    assert.equal(report.socketGone, true, 'the socket was unlinked')
    assert.equal(report.records, 0, 'the discovery record was removed')
    assert.equal(report.instances, 0, 'no observer instance is retained')
  } finally {
    removeTempDir(runtimeDir)
  }
})

test('mount and unmount cycles leave no residue', { skip }, async () => {
  const runtimeDir = makeTempDir()
  const ctx = new runtime.Context()
  const fiber = ctx.plugin(runtime.sessionPlugin)
  try {
    await waitFor(() => typeof ctx.sessions?.create === 'function', { label: 'session service' })
    const socketPath = join(socketsDir(runtimeDir), `${process.pid}.sock`)
    const registryDir = serversDir(runtimeDir)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const disposer = apply(ctx, { runtimeDir, socketPath, streamIntervalMs: 50, heartbeatMs: 60 })
      assert.equal(typeof disposer, 'function', 'apply returns a disposer')
      await waitFor(() => existsSync(socketPath), { label: `cycle ${cycle} socket` })
      assert.equal(hasInstance(process.pid), true)

      const session = ctx.sessions.create(`session-cycle-${cycle}`, { meta: { cwd: process.cwd() } })
      session.append('turn/start', { turn: 1 })

      await disposer()
      assert.equal(existsSync(socketPath), false, `cycle ${cycle} unlinked the socket`)
      assert.equal(hasInstance(process.pid), false, `cycle ${cycle} released the instance`)
      assert.equal(instanceCount(), 0, `cycle ${cycle} retained no instance`)
      assert.deepEqual(readServerRecords(registryDir), [], `cycle ${cycle} removed the discovery record`)
    }

    // Three generations later the runtime directory holds nothing at all.
    assert.equal(existsSync(socketPath), false)
    assert.deepEqual(readServerRecords(registryDir), [])
  } finally {
    await fiber.dispose()
    removeTempDir(runtimeDir)
  }
})

test('the plugin reports a labeled effect it can unwind', { skip }, async () => {
  const runtimeDir = makeTempDir()
  const ctx = new runtime.Context()
  const fiber = ctx.plugin(runtime.sessionPlugin)
  try {
    await waitFor(() => typeof ctx.sessions?.create === 'function', { label: 'session service' })
    const socketPath = join(socketsDir(runtimeDir), `${process.pid}.sock`)
    const disposer = apply(ctx, { runtimeDir, socketPath })
    await waitFor(() => existsSync(socketPath), { label: 'socket' })

    // Idempotence: a second call must be safe (hot reload can race a disposer).
    await disposer()
    await disposer()
    assert.equal(existsSync(socketPath), false)

    const leftover = readServerRecords(serversDir(runtimeDir))
    assert.deepEqual(leftover, [])
    await sleep(30)
  } finally {
    await fiber.dispose()
    removeTempDir(runtimeDir)
  }
})
