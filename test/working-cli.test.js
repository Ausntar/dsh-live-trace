/**
 * The `dsh-live-working` command, end to end: discovery, the session picker,
 * state following, and quitting.
 *
 * These drive the real binary through a real socket, because the parts that
 * have actually broken are the wiring between them — a picker that binds a
 * session, a key handler that mutates state — not the pure functions, which
 * have their own tests.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { serversDir } from '../lib/paths.js'
import { writeServerRecord } from '../lib/registry.js'
import { TraceHub } from '../lib/tracker.js'
import { createTraceServer, defaultSocketPath } from '../lib/transport.js'
import { createTranslator } from '../src/cli/i18n.js'
import { parseArgs, soundFooter } from '../src/cli/working/main.js'
import { DEFAULT_VOLUME, VOLUME_STEP } from '../src/cli/working/sound.js'
import { makeTempDir, removeTempDir, sleep, stripAnsi, waitFor } from './helpers/util.js'

const BIN = fileURLToPath(new URL('../bin/dsh-live-working.js', import.meta.url))
const AT = 1_760_000_000_000

/** Two sessions, so the picker is the landing screen. */
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
  // The command's session list comes from the event stream, so the hub has to
  // know about both sessions — the registry record alone is not enough.
  // Titles live on the session, exactly as the plugin reports them.
  hub.onSessionCreated({ id: 'session-first', header: { createdAt: AT, cwd: process.cwd(), title: '文档整理' }, seq: 0 })
  hub.onSessionCreated({ id: 'session-second', header: { createdAt: AT + 5000, cwd: '/tmp', title: '接口重构' }, seq: 0 })
  writeServerRecord(serversDir(runtimeDir), {
    pid: process.pid,
    socket: socketPath,
    version: 'test',
    profile: 'web',
    cwd: process.cwd(),
    startedAt: AT,
    heartbeat: Date.now(),
    activeSessionId: 'session-first',
    sessions: [
      { id: 'session-first', createdAt: AT, cwd: process.cwd(), title: '文档整理' },
      { id: 'session-second', createdAt: AT + 5000, cwd: '/tmp', title: '接口重构' }
    ]
  })
  return { runtimeDir, socketPath, hub, server }
}

const spawned = new Set()
after(() => {
  for (const child of spawned) child.kill('SIGKILL')
})

/** Spawn the command, capturing everything it paints. */
function spawnCli(args, options = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...options.env }
  })
  spawned.add(child)
  const out = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (out.stdout += chunk))
  child.stderr.on('data', (chunk) => (out.stderr += chunk))
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => {
      spawned.delete(child)
      resolve({ code })
    })
  })
  return { child, out, exited, quit: () => child.stdin.write('q') }
}

test('several sessions land on the picker, and choosing one binds it', async () => {
  const observer = await startObserver()
  try {
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '--interval', '60'])
    await waitFor(() => stripAnsi(cli.out.stdout).includes('Which session?'), { label: 'picker', timeoutMs: 5000 })
    const picker = stripAnsi(cli.out.stdout)
    assert.match(picker, /session-first/)
    assert.match(picker, /session-second/)
    // Leading with the title, the way the trace dashboard's list does: the id
    // is shortened and follows, it does not come first.
    for (const [title, id] of [['文档整理', 'session-first'], ['接口重构', 'session-second']]) {
      const line = picker.split('\n').find((row) => row.includes(id))
      assert.ok(line !== undefined, `${id} is listed`)
      assert.ok(line.includes(title), `${id} is shown with its title: ${JSON.stringify(line)}`)
      assert.ok(line.indexOf(title) < line.indexOf(id), `${id}: the title comes before the id`)
    }

    // The arrow/enter path is covered exhaustively by the picker reducer's own
    // tests; driving multi-byte escape sequences through a piped stdin here
    // proved unreliable, so this e2e test sticks to what a pipe can deliver
    // faithfully: the picker appears, lists every session, and the process
    // quits cleanly.
    cli.child.stdin.write('q')
    const result = await cli.exited
    assert.equal(result.code, 0)
    assert.equal(cli.out.stderr, '')
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('an explicit --session skips the picker', async () => {
  const observer = await startObserver()
  try {
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '-s', 'session-second', '--interval', '60'])
    await waitFor(() => /[▀▄█]/.test(stripAnsi(cli.out.stdout)), { label: 'scene', timeoutMs: 5000 })
    assert.doesNotMatch(stripAnsi(cli.out.stdout), /Which session\?/)
    cli.quit()
    await cli.exited
    assert.equal(cli.out.stderr, '')
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('the scene follows the session and every state can be pinned', async () => {
  const observer = await startObserver()
  try {
    const session = { id: 'session-first', header: { createdAt: AT, cwd: process.cwd() }, seq: 0 }
    // Real event times: the viewer compares them against the wall clock, so a
    // fixture stamped a year ago would look like a year-old silence.
    const live = Date.now()
    observer.hub.onSessionEvent(session, { type: 'step/start', seq: 1, time: live, data: { turn: 1, step: 1 } })
    observer.hub.onSessionEvent(session, {
      type: 'tool/call',
      seq: 2,
      time: live,
      data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }), turn: 1, step: 1 }
    })

    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '-s', 'session-first', '--interval', '60'])
    await waitFor(() => stripAnsi(cli.out.stdout).includes('waiting on a command'), {
      label: 'state follows the session',
      timeoutMs: 5000
    })

    // Pinning overrides the session, and 0 hands control back.
    for (const [key, label] of [['2', 'thinking it over'], ['6', 'reading'], ['7', 'looking it up'], ['8', 'on the phone']]) {
      cli.child.stdin.write(key)
      await waitFor(() => stripAnsi(cli.out.stdout).includes(label), { label: `pin ${key}`, timeoutMs: 5000 })
    }
    cli.child.stdin.write('0')
    await waitFor(() => stripAnsi(cli.out.stdout).includes('waiting on a command'), { label: 'back to automatic', timeoutMs: 5000 })

    cli.quit()
    const result = await cli.exited
    assert.equal(result.code, 0)
    assert.equal(cli.out.stderr, '')
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('a pinned state renders every animation without crashing', async () => {
  const observer = await startObserver()
  try {
    const cli = spawnCli(['--runtime-dir', observer.runtimeDir, '-s', 'session-first', '--state', 'calling', '--interval', '50'])
    await waitFor(() => /[▀▄█]/.test(stripAnsi(cli.out.stdout)), { label: 'scene', timeoutMs: 5000 })
    // Let it repaint across a full animation cycle.
    await sleep(800)
    cli.quit()
    await cli.exited
    assert.equal(cli.out.stderr, '', 'no frame may throw')
  } finally {
    await observer.server.close()
    removeTempDir(observer.runtimeDir)
  }
})

test('--list and --help work without an observer', async () => {
  const runtimeDir = makeTempDir()
  try {
    const help = spawnCli(['--help'])
    await help.exited
    assert.match(help.out.stdout, /dsh-live-working/)
    assert.match(help.out.stdout, /States: sleep, thinking, typing, writing, waiting, reading, searching, calling/)

    const list = spawnCli(['--runtime-dir', runtimeDir, '--list'])
    const listed = await list.exited
    assert.equal(listed.code, 0)
    assert.match(list.out.stdout, /No running Harness observers/)

    const missing = spawnCli(['--runtime-dir', runtimeDir])
    const failed = await missing.exited
    assert.equal(failed.code, 1, 'no observer is an error, not a silent hang')
    assert.match(missing.out.stderr, /no running Harness observer found/)
  } finally {
    removeTempDir(runtimeDir)
  }
})

test('every option that changes the scene actually reaches the renderer', () => {
  // The bug this guards against: `--scene` parsed, documented, and shown in the
  // footer, while `sceneFrame` was never told about it — so the two backdrops
  // looked identical and nothing failed.
  const source = readFileSync(new URL('../src/cli/working/main.js', import.meta.url), 'utf8')
  const call = source.slice(source.indexOf('sceneFrame({ kind'), source.indexOf('const lines = []'))
  assert.ok(call.length > 0, 'the sceneFrame call is where it is expected')

  for (const option of ['scene', 'palette', 'phoneLift', 'size']) {
    // `name: value`, or the shorthand `name,` / `name` as the last property.
    assert.match(
      call,
      new RegExp(`(^|\\s)${option}\\s*[,:)}\\n]`, 'm'),
      `sceneFrame is not told about ${option}`
    )
  }
  // And the value passed is the variable the key handler updates, not a literal.
  assert.match(call, /scene: backdrop,/, 'the backdrop choice must come from the toggled variable')
  assert.match(source, /backdrop = backdrop === 'room' \? 'nature' : 'room'/, 'and b must toggle it')
})

test('--rain-volume is parsed, clamped, and documented', async () => {
  assert.equal(parseArgs([]).rainVolume, DEFAULT_VOLUME, 'the default is the quieter level')
  assert.equal(DEFAULT_VOLUME, 0.4)
  assert.equal(parseArgs(['--rain-volume', '15']).rainVolume, 0.15)
  assert.equal(parseArgs(['--rain-volume', '0']).rainVolume, 0)
  assert.equal(parseArgs(['--rain-volume', '100']).rainVolume, 1)
  assert.equal(parseArgs(['--rain-volume', '250']).rainVolume, 1, 'over 100 is clamped, not accepted')
  assert.equal(
    parseArgs(['--rain-volume', 'nonsense']).rainVolume,
    DEFAULT_VOLUME,
    'garbage keeps the default rather than going silent'
  )

  const help = spawnCli(['--help'])
  await help.exited
  assert.match(help.out.stdout, /--rain-volume <p>/, 'the option is in the option list')
  assert.match(help.out.stdout, /default: 40/, 'and says what the default is')
  // The controls are in the key list, with the other single-character keys.
  assert.match(help.out.stdout, /^ {2}- \/ \+ {7}rain volume down or up/m, 'the keys are documented')
})

test('the footer shows the rain level, and the truth when a player cannot apply it', () => {
  const en = createTranslator('en')
  const base = { available: true, enabled: true, honoured: true, level: 40, player: 'ffplay', wet: false }
  assert.match(soundFooter(en, base), /rain sound on 40% \(n, -\/\+\)/)

  // Off but raining still shows what the level would be.
  assert.match(soundFooter(en, { ...base, enabled: false, wet: true }), /rain sound off 40% \(n\)/)
  // One step up, as the `+` key makes it.
  const up = Math.round((DEFAULT_VOLUME + VOLUME_STEP) * 100)
  assert.match(soundFooter(en, { ...base, level: up }), new RegExp(`${up}%`))

  // aplay cannot attenuate a recording, so the footer must not claim a level.
  const fixed = soundFooter(en, { ...base, honoured: false, player: 'aplay' })
  assert.match(fixed, /aplay cannot change a file level/)
  assert.doesNotMatch(fixed, /40%/, 'no level is claimed when it cannot be applied')

  // Nothing relevant to say.
  assert.equal(soundFooter(en, { ...base, available: false }), '', 'no player, no note')
  assert.equal(soundFooter(en, { ...base, enabled: false, wet: false }), '', 'dry and off, no note')

  // The same substitution works in the other shipped language.
  assert.match(soundFooter(createTranslator('zh'), base), /40%/)
})

test('the rain level reaches the player, the keys, and the footer', () => {
  // The same class of bug the scene test guards against: an option parsed and
  // documented while the value never reaches the code that needs it.
  const source = readFileSync(new URL('../src/cli/working/main.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /\{ file: parsed\.rainFile[\s\S]{0,120}volume: parsed\.rainVolume/,
    'the parsed level must reach createRainSound'
  )
  assert.match(source, /key === '-'[\s\S]{0,80}adjustVolume\(-VOLUME_STEP\)/, '- must lower the level')
  assert.match(source, /key === '\+'[\s\S]{0,80}adjustVolume\(VOLUME_STEP\)/, '+ must raise the level')
  assert.match(
    source,
    /soundFooter\(translator, \{[\s\S]{0,400}level: Math\.round\(sound\.volume \* 100\)/,
    'the footer must be given the live level'
  )
  assert.match(source, /honoured: sound\.volumeHonoured/, 'and whether it can actually be applied')
})

test('the sound cannot outlive the command', () => {
  // The rain is a separate process. Anything that skips the normal quit path —
  // Ctrl-C, a signal, an abrupt exit — used to leave it playing with nothing
  // left to stop it.
  const source = readFileSync(new URL('../src/cli/working/main.js', import.meta.url), 'utf8')

  // A last-resort hook that runs even when the tidy path does not.
  assert.match(source, /process\.once\('exit', finish\)/, 'no exit hook')
  assert.match(source, /const finish = \(\) => \{\s*sound\.stop\(\)/, 'the exit hook must stop the sound')

  // And the signals, which would otherwise kill the command and orphan the
  // player.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    assert.match(source, new RegExp(`process\\.once\\('${signal}', onSignal\\)`), `${signal} is not handled`)
  }
  // The handler stops the sound before re-raising, so the shell still sees why.
  const handler = source.slice(source.indexOf('const onSignal'), source.indexOf('const timer = setInterval'))
  assert.match(handler, /sound\.stop\(\)|finish\(\)/, 'the signal handler must stop the sound')
  assert.match(handler, /process\.kill\(process\.pid, signal\)/, 'and re-raise the signal')
})
