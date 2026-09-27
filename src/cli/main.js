/**
 * The `dsh-live-trace` command.
 *
 * The command discovers a running Harness observer, connects to its socket, and
 * renders the live dashboard in either the alternate screen or plain
 * line-oriented mode. It never writes to the Harness and never sends anything
 * but a session selection, a replay request, or a ping.
 *
 * @module dsh-live-trace/main
 */

import { existsSync } from 'node:fs'

import { connectTrace } from '../../lib/client.js'
import { resolveRuntimeDir, serversDir } from '../../lib/paths.js'
import { pruneServerRecords, selectServerRecord, selectSession } from '../../lib/registry.js'
import { createTranslator, nextLanguage, resolveLanguage } from './i18n.js'
import { renderFrame, renderPlainEntry } from './renderer.js'
import { Screen } from './screen.js'
import { createTheme } from './theme.js'
import { activeSession, applyRecord, bindSession, createViewState } from './view-state.js'

const HELP = `dsh-live-trace — read-only live terminal dashboard for DeepSeek Harness sessions

Usage:
  dsh-live-trace [options]

Discovery:
  The dashboard attaches to a running Harness process whose \`dsh-live-trace\`
  plugin is loaded. It reads that process's registry record from
  <runtime-dir>/servers and connects to its socket in <runtime-dir>/sockets.

Options:
  -s, --session <id>     bind this session id instead of the newest active one
      --socket <path>    connect to an explicit plugin socket (skips discovery)
      --server <pid>     prefer the Harness process with this pid
      --cwd <path>       prefer the server and session for this working directory
      --runtime-dir <p>  override the runtime directory (default: $DSH_LIVE_TRACE_DIR
                         or $DSH_HOME/live-trace)
      --backlog <n>      entries to replay on attach (default: 500)
      --interval <ms>    repaint interval (default: 120)
      --lang <code>      UI language: auto, en, or zh (default: auto, from $LANG)
      --thinking-lines <n>  thinking lines shown while collapsed (default: 3)
      --no-mouse         do not claim the mouse; use the terminal's own wheel
                         translation (drag-select then works without Shift)
      --list             list discovered Harness observers and sessions, then exit
      --plain            line-oriented output, one line per event (no full screen)
      --alt-screen       force the full-screen view even when stdout is not a TTY
      --no-color         disable ANSI color
  -h, --help             show this help
  -V, --version          show the version

Keys (full-screen mode):
  q / Ctrl-C  quit        ↑/↓  scroll        PgUp/PgDn  page
  Home/End    oldest/newest    s  next session    p  pause
  r           replay      ?    help
`

/**
 * @param {string[]} argv
 * @returns {{ error?: string, help?: boolean, version?: boolean }}
 */
export function parseArgs(argv) {
  const options = {
    session: undefined,
    socket: undefined,
    server: undefined,
    cwd: undefined,
    runtimeDir: undefined,
    backlog: 500,
    interval: 120,
    thinkingLines: 3,
    mouse: true,
    lang: 'auto',
    list: false,
    plain: false,
    altScreen: false,
    color: undefined,
    wait: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`missing value for ${arg}`)
      index += 1
      return value
    }
    try {
      switch (arg) {
        case '-h':
        case '--help':
          options.help = true
          break
        case '-V':
        case '--version':
          options.version = true
          break
        case '-s':
        case '--session':
          options.session = next()
          break
        case '--socket':
          options.socket = next()
          break
        case '--server':
          options.server = Number.parseInt(next(), 10)
          break
        case '--cwd':
          options.cwd = next()
          break
        case '--runtime-dir':
          options.runtimeDir = next()
          break
        case '--backlog':
          options.backlog = clamp(Number.parseInt(next(), 10), 1, 5000, 500)
          break
        case '--interval':
          options.interval = clamp(Number.parseInt(next(), 10), 40, 2000, 120)
          break
        case '--thinking-lines':
          options.thinkingLines = clamp(Number.parseInt(next(), 10), 1, 200, 3)
          break
        case '--lang':
          options.lang = next()
          break
        case '--mouse':
          options.mouse = true
          break
        case '--no-mouse':
          options.mouse = false
          break
        case '--list':
          options.list = true
          break
        case '--plain':
          options.plain = true
          break
        case '--alt-screen':
          options.altScreen = true
          break
        case '--no-color':
          options.color = false
          break
        case '--color':
          options.color = true
          break
        case '--wait':
          options.wait = true
          break
        default:
          if (arg.startsWith('-')) return { error: `unknown option: ${arg}` }
          return { error: `unexpected argument: ${arg}` }
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return options
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream, env?: NodeJS.ProcessEnv, version?: string, cwd?: string }} [io]
 * @returns {Promise<number>} process exit code
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const env = io.env ?? process.env
  const cwd = io.cwd ?? process.cwd()

  const parsed = parseArgs(argv)
  if (parsed.error !== undefined) {
    stderr.write(`${parsed.error}\n\n${HELP}`)
    return 2
  }
  if (parsed.help === true) {
    stdout.write(HELP)
    return 0
  }
  if (parsed.version === true) {
    stdout.write(`${io.version ?? '0.1.0'}\n`)
    return 0
  }

  const runtimeDir = parsed.runtimeDir !== undefined ? parsed.runtimeDir : resolveRuntimeDir(env)
  const registryDir = serversDir(runtimeDir)

  if (parsed.list === true) {
    printDiscovery(stdout, runtimeDir, registryDir)
    return 0
  }

  const server = await discover(parsed, registryDir, cwd, stderr, { wait: parsed.wait === true })
  if (server === null) return 1

  const session = server.sessions === undefined ? undefined : selectSession(server, { sessionId: parsed.session, cwd: parsed.cwd })
  const socketPath = server.socket

  if (!existsSync(socketPath) && parsed.socket !== undefined) {
    stderr.write(`dsh-live-trace: no socket at ${socketPath}\n`)
    return 1
  }

  const color = parsed.color ?? (env.NO_COLOR === undefined && stdout.isTTY === true)
  const theme = createTheme({ color })
  const translator = createTranslator(resolveLanguage(parsed.lang, env))
  const state = createViewState({ now: Date.now() })
  if (Array.isArray(server.sessions)) state.sessions = server.sessions
  bindSession(state, session?.id ?? null)

  // Landing rule: one session means the trace is what you came for; several
  // concurrent sessions mean choosing is the first thing you need to do. An
  // explicit --session always wins.
  const known = state.sessions.length
  if (parsed.session === undefined && known > 1) {
    state.sessionsOverlay = true
    const boundIndex = state.sessions.findIndex((item) => item.id === state.sessionId)
    state.cursor.sessions = boundIndex === -1 ? 0 : boundIndex
  }

  const isTty = stdout.isTTY === true
  const useFullScreen = parsed.plain !== true && (parsed.altScreen === true || isTty)

  if (!useFullScreen) {
    return await runPlain({ stdout, stderr, socketPath, state, parsed, translator })
  }
  return await runFullScreen({
    stdout,
    stdin: io.stdin ?? process.stdin,
    stderr,
    socketPath,
    state,
    parsed,
    theme,
    translator
  })
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

async function discover(parsed, registryDir, cwd, stderr, options) {
  for (;;) {
    const records = pruneServerRecords(registryDir)
    const server = selectServerRecord(records, {
      socket: parsed.socket,
      pid: Number.isFinite(parsed.server) ? parsed.server : undefined,
      cwd: parsed.cwd ?? cwd
    })
    if (server !== undefined) return server
    if (options.wait !== true) {
      stderr.write(discoveryHelp(registryDir))
      return null
    }
    stderr.write(`dsh-live-trace: no observer yet in ${registryDir}; waiting…\n`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  }
}

function discoveryHelp(registryDir) {
  return [
    'dsh-live-trace: no running Harness observer found.',
    '',
    `Looked in: ${registryDir}`,
    '',
    'The dashboard reads events published by the dsh-live-trace Host plugin.',
    'Install and enable it in the profile your Harness runs, then restart (or',
    'let hot reload pick it up) and run this command again:',
    '',
    '  dsh plugin --profile web add <path-to>/dsh-live-trace',
    '',
    'Use `dsh-live-trace --list` to see what was discovered, or `--socket <path>`',
    'to attach to a known socket directly. Add `--wait` to poll instead of exiting.',
    ''
  ].join('\n')
}

function printDiscovery(stdout, runtimeDir, registryDir) {
  const records = pruneServerRecords(registryDir)
  stdout.write(`runtime dir: ${runtimeDir}\n`)
  stdout.write(`servers dir: ${registryDir}\n\n`)
  if (records.length === 0) {
    stdout.write('No running Harness observers.\n')
    return
  }
  for (const record of records) {
    stdout.write(`pid ${record.pid}  profile=${record.profile ?? '-'}  cwd=${record.cwd ?? '-'}\n`)
    stdout.write(`  socket: ${record.socket}\n`)
    stdout.write(`  version: ${record.version ?? '-'}  heartbeat: ${record.heartbeat ?? '-'}\n`)
    const sessions = Array.isArray(record.sessions) ? record.sessions : []
    if (sessions.length === 0) {
      stdout.write('  sessions: none yet\n')
    } else {
      stdout.write('  sessions:\n')
      for (const session of sessions) {
        const mark = session.id === record.activeSessionId ? '*' : ' '
        const title = session.title !== undefined ? ` "${session.title}"` : ''
        stdout.write(
          `   ${mark} ${session.id}  turn=${session.turn ?? 0} step=${session.step ?? 0}  ${session.cwd ?? ''}${title}\n`
        )
      }
    }
    stdout.write('\n')
  }
}

/* ------------------------------------------------------------------ *
 * Plain mode
 * ------------------------------------------------------------------ */

async function runPlain({ stdout, stderr, socketPath, state, parsed, translator }) {
  const client = connectTrace({
    socketPath,
    sessionId: state.sessionId,
    replayLimit: parsed.backlog,
    onRecord: (record) => {
      const result = applyRecord(state, record)
      // A settled tool block replaces the running row it opened, so plain mode
      // logs both: the call when it starts, the outcome when it lands.
      if (result.kind === 'entry' && (result.appended || result.replaced)) {
        stdout.write(`${renderPlainEntry(state.entries[state.entries.length - 1], 200, translator.t)}\n`)
      }
    },
    onError: (error) => stderr.write(`dsh-live-trace: ${error.message}\n`)
  })
  return await new Promise((resolvePromise) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      client.close()
      resolvePromise(0)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

/* ------------------------------------------------------------------ *
 * Full-screen mode
 * ------------------------------------------------------------------ */

async function runFullScreen({ stdout, stdin, stderr, socketPath, state, parsed, theme, translator }) {
  const screen = new Screen({ stdout, stdin, altScreen: true, mouse: parsed.mouse !== false })
  let paused = false
  let help = false
  let spinner = 0
  let quitResolve
  const done = new Promise((resolvePromise) => {
    quitResolve = resolvePromise
  })

  const client = connectTrace({
    socketPath,
    sessionId: state.sessionId,
    replayLimit: parsed.backlog,
    onRecord: (record) => {
      if (paused && record.kind === 'entry') return
      // No scroll adjustment here on purpose. The trace is bottom-anchored, so
      // an offset of zero already follows new content; forcing it back to zero
      // would yank the view away from anyone reading history.
      applyRecord(state, record)
    },
    onError: () => {
      /* reconnect is automatic; a transient error is not worth a stderr write */
    }
  })

  // The last painted window, so mouse input can map a screen row back to the
  // list item it shows.
  const lastFrame = {}
  let translator2 = translator

  const draw = () => {
    const { cols, rows } = screen.size()
    spinner += 1
    screen.paint(
      renderFrame(
        state,
        {
          cols,
          rows,
          theme,
          now: Date.now(),
          frame: spinner,
          scrollOffset: state.scroll.trace,
          panelOffset: state.scroll[state.sessionsOverlay ? 'sessions' : state.view] ?? 0,
          view: state.view,
          sessionsOverlay: state.sessionsOverlay,
          paused,
          help,
          rawText: state.rawText,
          expandThinking: state.expandThinking,
          thinkingLines: parsed.thinkingLines,
          t: translator2.t
        },
        lastFrame
      )
    )
  }

  screen.enter()
  screen.onResize(draw)

  const pageSize = () => Math.max(1, screen.size().rows - 6)
  const activePanel = () => (state.sessionsOverlay ? 'sessions' : state.view)

  /**
   * Scroll the active panel. Positive means "further down" — toward newer
   * entries in the bottom-anchored trace, toward the end of a top-anchored
   * list. One sign convention keeps the wheel, the arrows, and paging from
   * disagreeing about which way is up.
   */
  const scrollBy = (lines) => {
    const panel = activePanel()
    if (panel === 'trace') {
      state.scroll.trace = Math.max(0, state.scroll.trace - lines)
      return
    }
    const next = (state.scroll[panel] ?? 0) + lines
    state.scroll[panel] = Math.max(0, Math.min(next, Number.MAX_SAFE_INTEGER))
  }

  screen.onKey((key) => {
    if (typeof key !== 'string') {
      // A mouse click selects whatever row it landed on.
      selectClickedItem(state, key, lastFrame, client)
      draw()
      return
    }
    switch (key) {
      case 'quit':
      case 'q':
        quitResolve(0)
        return
      case 'escape':
        // Escape backs out of a panel (or the picker) before it ever quits.
        if (state.sessionsOverlay) state.sessionsOverlay = false
        else if (state.view !== 'trace') state.view = 'trace'
        else quitResolve(0)
        return
      case 'up':
        moveSelection(state, -1)
        break
      case 'down':
        moveSelection(state, 1)
        break
      case 'wheel-up':
      case 'wheel-left':
        // One wheel notch is deliberately three lines: a single line per notch
        // reads as no movement at all on a high-resolution wheel.
        scrollBy(-WHEEL_LINES)
        break
      case 'wheel-down':
      case 'wheel-right':
        scrollBy(WHEEL_LINES)
        break
      case 'page-up':
      case 'ctrl-up':
        scrollBy(-pageSize())
        break
      case 'page-down':
      case 'ctrl-down':
        scrollBy(pageSize())
        break
      case 'home':
        scrollBy(-Number.MAX_SAFE_INTEGER)
        break
      case 'end':
        scrollBy(Number.MAX_SAFE_INTEGER)
        break
      case 'enter':
      case '\r':
      case '\n':
        openSelectedSession(state, client)
        break
      case 'tab':
        cycleView(state, 1)
        break
      case 'm':
        state.rawText = !state.rawText
        break
      case 'e':
        state.expandThinking = !state.expandThinking
        break
      case 'l':
        translator2 = createTranslator(nextLanguage(translator2.language))
        break
      case 'p':
        paused = !paused
        break
      case '?':
        help = !help
        break
      case 'r':
        client.replay(parsed.backlog)
        break
      case '1':
      case 't':
        state.sessionsOverlay = false
        state.view = 'trace'
        break
      case '2':
      case 's':
        state.sessionsOverlay = true
        break
      case '3':
      case 'd':
        state.sessionsOverlay = false
        state.view = 'edits'
        break
      case '4':
      case 'c':
        state.sessionsOverlay = false
        state.view = 'commands'
        break
      default:
        break
    }
    draw()
  })

  const timer = setInterval(draw, parsed.interval)
  timer.unref?.()
  draw()

  const code = await done
  clearInterval(timer)
  client.close()
  screen.leave()
  const session = activeSession(state)
  if (session !== null && stderr.isTTY === true) {
    stdout.write(`dsh-live-trace: detached from ${session.id}\n`)
  }
  return code
}

/** Lines one wheel notch moves. */
const WHEEL_LINES = 3

/**
 * Select the list item a click landed on.
 *
 * Clicks outside the body, on a non-item row (a header or a diff line), or in
 * a panel with no selection are ignored rather than guessed at.
 */
function selectClickedItem(state, event, frame, client) {
  if (event?.type !== 'click') return
  if (!Number.isInteger(frame.start) || !Number.isInteger(frame.bodyRows)) return
  const bodyRow = event.y - 1 - frame.headerRows
  if (bodyRow < 0 || bodyRow >= frame.bodyRows) return
  const item = frame.rowItems?.[frame.start + bodyRow]
  if (item === undefined || item < 0) return

  if (frame.view === 'sessions') {
    state.cursor.sessions = clampIndex(item, state.sessions.length)
    openSelectedSession(state, client)
    return
  }
  if (frame.view === 'edits') {
    state.cursor.edits = clampIndex(item, state.edits.length)
    state.scroll.edits = 0
  }
}

/** Move the cursor in whichever list currently owns the arrow keys. */
function moveSelection(state, delta) {
  const panel = state.sessionsOverlay ? 'sessions' : state.view
  if (panel === 'trace') {
    // Arrows scroll the trace; only the list panels have a cursor.
    state.scroll.trace = Math.max(0, state.scroll.trace - delta)
    return
  }
  if (panel === 'sessions') {
    const count = state.sessions.length
    if (count === 0) return
    state.cursor.sessions = clampIndex(state.cursor.sessions + delta, count)
    return
  }
  if (panel === 'edits') {
    const count = state.edits.length
    if (count === 0) return
    state.cursor.edits = clampIndex(state.cursor.edits + delta, count)
    state.scroll.edits = 0
  }
}

function clampIndex(value, count) {
  return Math.max(0, Math.min(count - 1, value))
}

/** Bind the session under the picker's cursor. */
function openSelectedSession(state, client) {
  const row = state.sessions[state.cursor.sessions]
  if (row === undefined) return
  if (row.id !== state.sessionId) {
    bindSession(state, row.id)
    client.select(row.id)
  }
  state.sessionsOverlay = false
  state.view = 'trace'
}

/**
 * Step through the four panels.
 *
 * The session picker is modelled as an overlay rather than a fourth `view`, so
 * leaving it returns to whichever panel was underneath instead of always to the
 * trace.
 */
function cycleView(state, delta) {
  const order = ['trace', 'sessions', 'edits', 'commands']
  const current = state.sessionsOverlay ? 'sessions' : state.view
  const next = order[(order.indexOf(current) + delta + order.length) % order.length]
  if (next === 'sessions') {
    state.sessionsOverlay = true
  } else {
    state.sessionsOverlay = false
    state.view = next
  }
}


