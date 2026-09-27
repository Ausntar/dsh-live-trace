/**
 * End-to-end: the real `dsh-live-trace` executable against a real observer
 * socket, exercising discovery, the full-screen board, plain mode, and the
 * failure path when nothing is running.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { serversDir } from '../lib/paths.js'
import { PROTOCOL_VERSION } from '../lib/protocol.js'
import { writeServerRecord } from '../lib/registry.js'
import { TraceHub } from '../lib/tracker.js'
import { createTraceServer, defaultSocketPath } from '../lib/transport.js'
import { displayWidth } from '../src/cli/width.js'
import { makeTempDir, removeTempDir, sleep, stripAnsi, waitFor } from './helpers/util.js'

const BIN = fileURLToPath(new URL('../bin/dsh-live-trace.js', import.meta.url))
// A recent fixed clock keeps the elapsed-time footer realistic.
const AT = Date.now() - 5000

/** Start a fake Harness observer, including its discovery record. */
async function startObserver() {
  const runtimeDir = makeTempDir()
  const socketPath = defaultSocketPath(runtimeDir, process.pid)
  const hub = new TraceHub({ now: () => AT, streamIntervalMs: 40, backlogSize: 200 })
  const server = createTraceServer({
    socketPath,
    runtimeDir,
    hub,
    serverInfo: () => ({ pid: process.pid, version: 'test', profile: 'web', cwd: process.cwd() }),
    heartbeatMs: 60_000
  })
  await server.ready
  writeServerRecord(serversDir(runtimeDir), {
    pid: process.pid,
    socket: socketPath,
    version: 'test',
    profile: 'web',
    cwd: process.cwd(),
    startedAt: AT,
    heartbeat: Date.now(),
    activeSessionId: 'session-cli',
    sessions: [{ id: 'session-cli', createdAt: AT, cwd: process.cwd(), title: 'cli demo' }]
  })
  return { runtimeDir, socketPath, hub, server }
}

/** Every spawned CLI, so a failing assertion cannot leak a running process. */
const spawned = new Set()
after(() => {
  for (const child of spawned) child.kill('SIGKILL')
})

/** Spawn the CLI and collect its output. */
function spawnCli(args, options = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // A fixed locale keeps the assertions stable whatever the host is set to;
    // the language-specific tests override it.
    env: { ...process.env, NO_COLOR: undefined, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...options.env }
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  spawned.add(child)
  child.on('exit', () => spawned.delete(child))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    child,
    exited,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    }
  }
}

/** Populate a hub with the trace the acceptance criteria describe. */
function seedTrace(hub) {
  const session = { id: 'session-cli', header: { createdAt: AT, cwd: process.cwd() }, seq: 0 }
  hub.onSessionCreated(session)
  hub.onSessionEvent(session, { type: 'turn/start', seq: 0, time: AT, data: { turn: 3 } })
  hub.onSessionEvent(session, { type: 'step/start', seq: 1, time: AT + 1, data: { turn: 3, step: 1 } })
  hub.onSessionEvent(session, {
    type: 'user/message',
    seq: 2,
    time: AT + 2,
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '请修复这个 bug' }], source: { kind: 'user' } }
  })
  hub.onSessionEvent(session, {
    type: 'assistant/message',
    seq: 3,
    time: AT + 3,
    data: {
      turn: 3,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '先读取文件再修改。' }], source: { kind: 'model' } },
      stream: [],
      usage: { inputTokens: 1200, outputTokens: 240, totalTokens: 1440 }
    }
  })
  hub.onSessionEvent(session, {
    type: 'tool/call',
    seq: 4,
    time: AT + 4,
    data: { turn: 3, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test","description":"Run the test suite"}' }
  })
  hub.onSessionEvent(session, {
    type: 'tool/result',
    seq: 5,
    time: AT + 5,
    data: {
      turn: 3,
      step: 1,
      message: {
        id: 'r1',
        role: 'tool',
        toolCallId: 'c1',
        content: [{ type: 'text', text: '测试通过 (12 passed)\n[exit code: 0]' }],
        source: { kind: 'tool', callId: 'c1' }
      }
    }
  })
  hub.onSessionEvent(session, { type: 'request/context', seq: 6, time: AT + 6, data: { provider: 'deepseek', model: 'deepseek-flash', capacity: 128000 } })
}

test('--help and --version work without a running Harness', async () => {
  const help = spawnCli(['--help'])
  const helpResult = await help.exited
  assert.equal(helpResult.code, 0)
  assert.match(help.stdout, /dsh-live-trace/)
  assert.match(help.stdout, /--session/)

  const version = spawnCli(['--version'])
  const versionResult = await version.exited
  assert.equal(versionResult.code, 0)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/)
})

test('an unknown option fails with a usage message', async () => {
  const cli = spawnCli(['--nope'])
  const result = await cli.exited
  assert.equal(result.code, 2)
  assert.match(cli.stderr, /unknown option: --nope/)
})

test('with no observer running the command explains what to do', async () => {
  const runtimeDir = makeTempDir()
  try {
    const cli = spawnCli(['--runtime-dir', runtimeDir])
    const result = await cli.exited
    assert.equal(result.code, 1)
    assert.match(cli.stderr, /no running Harness observer found/i)
    assert.match(cli.stderr, /dsh plugin --profile web add/)
  } finally {
    removeTempDir(runtimeDir)
  }
})

test('--list reports the discovered process and its sessions', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--list'])
    const result = await cli.exited
    assert.equal(result.code, 0)
    assert.match(cli.stdout, new RegExp(`pid ${process.pid}`))
    assert.match(cli.stdout, /profile=web/)
    assert.match(cli.stdout, /session-cli/)
    assert.match(cli.stdout, /cli demo/)
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('the full-screen board renders the live trace and quits on q', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--alt-screen', '--interval', '40', '--no-color'])

    await waitFor(() => cli.stdout.includes('dsh-live-trace'), { label: 'first frame', timeoutMs: 5000 })
    // Push a live event after the board is up to prove the stream keeps flowing.
    const session = { id: 'session-cli', header: { createdAt: AT, cwd: process.cwd() }, seq: 7 }
    observer.hub.onSessionEvent(session, { type: 'step/start', seq: 7, time: AT + 7, data: { turn: 3, step: 2 } })

    await waitFor(() => cli.stdout.includes('STEP 2'), { label: 'live update', timeoutMs: 5000 })

    cli.child.stdin.write('q')
    const result = await cli.exited
    assert.equal(result.code, 0)

    const text = stripAnsi(cli.stdout)
    assert.match(text, /Session: /)
    assert.match(text, /Status: /)
    assert.match(text, /\[TURN 3\]/)
    assert.match(text, /\[STEP 1\]/)
    assert.match(text, /\[TOOL\]/)
    assert.match(text, /bash Run the test suite/)
    assert.match(text, /\$ npm test/)
    assert.match(text, /测试通过 \(12 passed\)/)
    assert.match(text, /✓ exit 0/)
    assert.doesNotMatch(text, /\[RESULT\]/, 'the call and its result render as one block')
    assert.match(text, /\(↑1\.2K ↓240\)|Tokens 1\.4K\/128K/)
    assert.match(text, /T3/)
    assert.match(text, /S2/)
    // The board entered and left the alternate screen.
    assert.ok(cli.stdout.includes('\u001b[?1049h'), 'entered the alternate screen')
    assert.ok(cli.stdout.includes('\u001b[?1049l'), 'left the alternate screen')
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('every rendered board row is exactly 80 columns wide', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--alt-screen', '--interval', '40', '--no-color'])
    await waitFor(() => cli.stdout.includes('dsh-live-trace'), { label: 'first frame', timeoutMs: 5000 })
    cli.child.stdin.write('q')
    await cli.exited

    // Reconstruct rows from the last painted frame: each paint is
    // `\x1b[H` + rows joined by CRLF + `\x1b[J` + sync markers.
    const frames = cli.stdout.split('\u001b[?2026h').slice(1)
    assert.ok(frames.length > 0, 'at least one painted frame')
    const last = frames[frames.length - 1]
    const body = last.split('\u001b[?2026l')[0]
    const rows = body.replace('\u001b[H', '').split('\r\n')
    for (const row of rows.slice(0, 24)) {
      const width = displayWidth(stripAnsi(row).replace(/\u001b\[J$/, '').replace(/\u001b\[K$/, ''))
      assert.equal(width, 80, `row width ${width}: ${JSON.stringify(stripAnsi(row))}`)
    }
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('plain mode streams one line per event and can be piped', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--plain'])

    await waitFor(() => cli.stdout.includes('[TOOL]'), { label: 'replayed entries', timeoutMs: 5000 })

    const session = { id: 'session-cli', header: { createdAt: AT, cwd: process.cwd() }, seq: 8 }
    observer.hub.onSessionEvent(session, { type: 'turn/end', seq: 8, time: AT + 8, data: { turn: 3, reason: { kind: 'completed' } } })
    await waitFor(() => cli.stdout.includes('TURN 3 END'), { label: 'streamed entry', timeoutMs: 5000 })

    cli.child.kill('SIGINT')
    await cli.exited

    const lines = cli.stdout.split('\n').filter((line) => line.trim().length > 0)
    assert.ok(lines.length >= 7, `expected several lines, got ${lines.length}`)
    assert.match(lines[0], /^\d{2}:\d{2}:\d{2} \[SESSION\]/)
    assert.match(lines.join('\n'), /\[TOOL\] bash command="npm test"[^\n]*running/, 'the running call is logged')
    assert.match(lines.join('\n'), /\[TOOL\] ✓ bash 测试通过 \(12 passed\)\s+exit 0/, 'then its outcome')
    assert.match(lines.join('\n'), /\$ npm test/)
    assert.doesNotMatch(cli.stdout, /\u001b\[/, 'plain mode emits no escape sequences')
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('the board survives the observer going away and reports it', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--alt-screen', '--interval', '40', '--no-color'])
    await waitFor(() => cli.stdout.includes('dsh-live-trace'), { label: 'first frame', timeoutMs: 5000 })

    await observer.server.close()
    await sleep(120)
    // The client keeps retrying rather than exiting; the board stays usable.
    assert.equal(cli.child.exitCode, null)
    cli.child.stdin.write('q')
    const result = await cli.exited
    assert.equal(result.code, 0)
  } finally {
    removeTempDir(observer.runtimeDir)
  }
})

test('--socket attaches without any discovery record', async () => {
  const runtimeDir = makeTempDir()
  try {
    const socketPath = join(runtimeDir, 'sockets', 'manual.sock')
    const hub = new TraceHub({ now: () => AT })
    const server = createTraceServer({ socketPath, runtimeDir, hub, serverInfo: () => ({ pid: 1 }), heartbeatMs: 60_000 })
    await server.ready
    seedTrace(hub)

    assert.equal(existsSync(join(serversDir(runtimeDir), '1.json')), false)
    const cli = spawnCli(['--socket', socketPath, '--runtime-dir', runtimeDir, '--plain'])
    await waitFor(() => cli.stdout.includes('[TOOL]'), { label: 'manual attach', timeoutMs: 5000 })
    cli.child.kill('SIGINT')
    await cli.exited

    assert.equal(PROTOCOL_VERSION, 1)
    await server.close()
  } finally {
    removeTempDir(runtimeDir)
  }
})

test('several concurrent sessions land on the picker, one lands on the trace', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)
    // A second live session, so choosing is the first thing a viewer must do.
    const second = { id: 'session-second', header: { createdAt: AT + 60_000, cwd: '/tmp' }, seq: 0 }
    observer.hub.onSessionCreated(second)
    writeServerRecord(serversDir(observer.runtimeDir), {
      pid: process.pid,
      socket: observer.socketPath,
      version: 'test',
      profile: 'web',
      cwd: process.cwd(),
      startedAt: AT,
      heartbeat: Date.now(),
      activeSessionId: 'session-cli',
      sessions: [
        { id: 'session-cli', createdAt: AT, cwd: process.cwd(), title: 'cli demo' },
        { id: 'session-second', createdAt: AT + 60_000, cwd: '/tmp', title: 'second' }
      ]
    })

    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--alt-screen', '--no-color', '--interval', '40'])
    await waitFor(() => cli.stdout.includes('SESSIONS'), { label: 'picker landing', timeoutMs: 5000 })
    const first = stripAnsi(cli.stdout)
    assert.match(first, /dsh-live-trace · sessions/, 'the title bar names the panel')
    assert.match(first, /2 known/)
    assert.match(first, /session-second|second/)

    // enter binds the highlighted session and returns to the trace.
    cli.child.stdin.write('\r')
    await waitFor(() => cli.stdout.includes('[TURN 3]') || cli.stdout.includes('[SESSION]'), { label: 'bound trace', timeoutMs: 5000 })
    cli.child.stdin.write('1')
    await waitFor(() => stripAnsi(cli.stdout).includes('dsh-live-trace · trace'), { label: 'back to the trace', timeoutMs: 5000 })

    cli.child.stdin.write('q')
    await cli.exited
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('an explicit --session skips the picker even with several sessions', async () => {
  const observer = await startObserver()
  try {
    const second = { id: 'session-second', header: { createdAt: AT + 60_000, cwd: '/tmp' }, seq: 0 }
    observer.hub.onSessionCreated(second)
    writeServerRecord(serversDir(observer.runtimeDir), {
      pid: process.pid,
      socket: observer.socketPath,
      version: 'test',
      profile: 'web',
      cwd: process.cwd(),
      startedAt: AT,
      heartbeat: Date.now(),
      activeSessionId: 'session-cli',
      sessions: [
        { id: 'session-cli', createdAt: AT, cwd: process.cwd() },
        { id: 'session-second', createdAt: AT + 60_000, cwd: '/tmp' }
      ]
    })

    const cli = spawnCli([
      '--runtime-dir', observer.runtimeDir, '--session', 'session-second',
      '--alt-screen', '--no-color', '--interval', '40'
    ])
    await waitFor(() => stripAnsi(cli.stdout).includes('dsh-live-trace · trace'), { label: 'trace landing', timeoutMs: 5000 })
    assert.doesNotMatch(stripAnsi(cli.stdout), /dsh-live-trace · sessions/)
    cli.child.stdin.write('q')
    await cli.exited
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('the wheel scrolls the trace and a click selects a session', async () => {
  const observer = await startObserver()
  try {
    // A long trace so the body actually overflows and can be scrolled.
    const session = { id: 'session-cli', header: { createdAt: AT, cwd: process.cwd() }, seq: 0 }
    observer.hub.onSessionCreated(session)
    for (let index = 0; index < 60; index += 1) {
      observer.hub.onSessionEvent(session, { type: 'step/start', seq: index, time: AT + index, data: { turn: 1, step: index } })
    }
    observer.hub.onSessionCreated({ id: 'session-second', header: { createdAt: AT + 5000, cwd: '/tmp' }, seq: 0 })
    // The fake observer owns its own discovery record, so refresh it by hand.
    writeServerRecord(serversDir(observer.runtimeDir), {
      pid: process.pid,
      socket: observer.socketPath,
      version: 'test',
      profile: 'web',
      cwd: process.cwd(),
      startedAt: AT,
      heartbeat: Date.now(),
      activeSessionId: 'session-cli',
      sessions: [
        { id: 'session-cli', createdAt: AT, cwd: process.cwd(), title: 'cli demo' },
        { id: 'session-second', createdAt: AT + 5000, cwd: '/tmp', title: 'second' }
      ]
    })

    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--alt-screen', '--no-color', '--interval', '40'])
    await waitFor(() => stripAnsi(cli.stdout).includes('dsh-live-trace'), { label: 'first frame', timeoutMs: 5000 })

    // Two sessions and no --session: the picker is the landing screen.
    await waitFor(() => stripAnsi(cli.stdout).includes('· sessions'), { label: 'picker' })
    assert.ok(cli.stdout.includes('\u001b[?1000h'), 'the mouse is claimed for exact wheel events')

    // A left click on the second session row selects and opens it.
    cli.child.stdin.write('\u001b[<0;10;7M')
    await waitFor(() => stripAnsi(cli.stdout).includes('· trace'), { label: 'click opened the session', timeoutMs: 5000 })

    // Wheel-up over the trace reports the offset it scrolled to.
    cli.child.stdin.write('\u001b[<64;10;7M')
    await waitFor(() => /↑3/.test(stripAnsi(cli.stdout)), { label: 'wheel scrolled three lines', timeoutMs: 5000 })
    cli.child.stdin.write('\u001b[<65;10;7M')
    await waitFor(() => !/↑3/.test(stripAnsi(cli.stdout).split('\r\n').slice(-3).join('\n')), { label: 'wheel down returned', timeoutMs: 5000 })

    cli.child.stdin.write('q')
    await cli.exited
    assert.ok(cli.stdout.includes('\u001b[?1000l'), 'the mouse is released on exit')
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('the UI language follows the locale and can be overridden', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)

    // Auto: a Chinese locale selects Chinese without any flag.
    const zh = spawnCli(['--runtime-dir', observer.runtimeDir, '--alt-screen', '--interval', '40'], {
      env: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' }
    })
    await waitFor(() => stripAnsi(zh.stdout).includes('会话：'), { label: 'zh landing', timeoutMs: 5000 })
    assert.match(stripAnsi(zh.stdout), /状态：/)
    assert.match(stripAnsi(zh.stdout), /dsh-live-trace · 轨迹/, 'the panel name is translated too')
    zh.child.stdin.write('1')
    await waitFor(() => stripAnsi(zh.stdout).includes('· 轨迹'), { label: 'zh trace title', timeoutMs: 5000 })
    zh.child.stdin.write('q')
    await zh.exited

    // An explicit flag beats the locale.
    const en = spawnCli(['--runtime-dir', observer.runtimeDir, '--lang', 'en', '--alt-screen', '--interval', '40'], {
      env: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' }
    })
    await waitFor(() => stripAnsi(en.stdout).includes('Session:'), { label: 'en overrides locale', timeoutMs: 5000 })
    assert.doesNotMatch(stripAnsi(en.stdout), /会话/)
    en.child.stdin.write('q')
    await en.exited

    // And the runtime switch cycles the language without restarting.
    const live = spawnCli(['--runtime-dir', observer.runtimeDir, '--alt-screen', '--interval', '40'])
    await waitFor(() => stripAnsi(live.stdout).includes('Session:'), { label: 'en start', timeoutMs: 5000 })
    live.child.stdin.write('l')
    await waitFor(() => stripAnsi(live.stdout).includes('会话'), { label: 'switch to zh', timeoutMs: 5000 })
    live.child.stdin.write('l')
    await waitFor(() => stripAnsi(live.stdout).includes('Session:'), { label: 'switch back to en', timeoutMs: 5000 })
    live.child.stdin.write('q')
    await live.exited
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('the Chinese UI keeps the exact-width contract', async () => {
  const observer = await startObserver()
  try {
    seedTrace(observer.hub)
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--lang', 'zh', '--alt-screen', '--no-color', '--interval', '40'])
    await waitFor(() => stripAnsi(cli.stdout).includes('会话：'), { label: 'zh frame', timeoutMs: 5000 })
    for (const view of ['1', '4', '3', '2', '?']) {
      cli.child.stdin.write(view)
      await sleep(120)
    }
    cli.child.stdin.write('q')
    await cli.exited

    const frames = cli.stdout.split('\u001b[?2026h').slice(1).map((f) => f.split('\u001b[?2026l')[0])
    assert.ok(frames.length > 0)
    for (const frame of frames) {
      for (const row of frame.split('\r\n').slice(0, 24)) {
        const width = displayWidth(stripAnsi(row).replace(/\u001b\[J$/, '').replace(/\u001b\[K$/, ''))
        assert.equal(width, 80, `row was ${width} columns: ${JSON.stringify(stripAnsi(row))}`)
      }
    }
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('every documented option is actually parsed', async () => {
  const cli = spawnCli(['--thinking-lines', '9', '--lang', 'zh', '--no-mouse', '--help'])
  const result = await cli.exited
  assert.equal(result.code, 0, 'these are accepted options, not errors')
  assert.doesNotMatch(cli.stderr, /unknown option/)

  const bad = spawnCli(['--thinking-lines', 'not-a-number', '--help'])
  await bad.exited
  assert.doesNotMatch(bad.stderr, /unknown option/)

  // The help text must not advertise an option the parser rejects.
  const help = spawnCli(['--help'])
  await help.exited
  const documented = [...help.stdout.matchAll(/^\s{2,}(--[a-z-]+)/gm)].map((match) => match[1])
  assert.ok(documented.length >= 10, `expected a real option list, got ${documented.length}`)
  for (const option of new Set(documented)) {
    const probe = spawnCli([option, '--help'])
    await probe.exited
    assert.doesNotMatch(probe.stderr, /unknown option/, `${option} is documented but not parsed`)
  }
})
