/**
 * `dsh-live-working` — a window onto what the orca is doing.
 *
 * The trace dashboard answers "what happened"; this answers "what is it doing
 * right now". It attaches to the same running Harness process as
 * `dsh-live-trace` and draws one animated scene: the orca at its desk, typing,
 * reading, looking things up, on the telephone to a subagent, or asleep.
 *
 * Nothing is sent to the agent. It only reads.
 *
 * @module dsh-live-working/main
 */

import { connectTrace } from '../../../lib/client.js'
import { resolveRuntimeDir, serversDir } from '../../../lib/paths.js'
import { pruneServerRecords, selectServerRecord, selectSession } from '../../../lib/registry.js'
import { shortPath, shortSessionId } from '../format.js'
import { createTranslator, nextLanguage, resolveLanguage } from '../i18n.js'
import { Screen } from '../screen.js'
import { sanitize, truncate } from '../width.js'
import { createTheme } from '../theme.js'
import { applyPickerKey, createPickerState } from './picker.js'
import { bundledRainFile, clampVolume, createRainSound, DEFAULT_VOLUME, VOLUME_STEP } from './sound.js'
import { renderCells, sceneFrame, sceneSizeFor } from './scene.js'
import { createWorkState, previewOf, reduceWork, WORK_STATES, workStateOf } from './state.js'

/** State keys addressable by number key, in a stable order. */
const PIN_KEYS = WORK_STATES

/** Repaint interval, in milliseconds. */
const DEFAULT_INTERVAL = 120

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv) {
  const options = {
    interval: DEFAULT_INTERVAL,
    lang: 'auto',
    sound: false,
    rainVolume: DEFAULT_VOLUME,
    scene: 'room',
    backlog: 20,
    replayLimit: 200,
    color: undefined,
    state: null,
    help: false,
    version: false,
    list: false,
    wait: false,
    session: undefined,
    socket: undefined,
    server: undefined,
    cwd: undefined,
    runtimeDir: undefined
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`missing value for ${arg}`)
      index += 1
      return value
    }
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
      case '--interval': {
        const value = Number.parseInt(next(), 10)
        options.interval = Number.isFinite(value) ? Math.min(2000, Math.max(40, value)) : DEFAULT_INTERVAL
        break
      }
      case '--state':
        options.state = next()
        break
      case '--lang':
        options.lang = next()
        break
      case '--sound':
        options.sound = true
        break
      case '--no-sound':
        options.sound = false
        break
      case '--rain-volume': {
        // A percentage on the command line, a fraction inside.
        const value = Number.parseInt(next(), 10)
        options.rainVolume = clampVolume(Number.isFinite(value) ? value / 100 : DEFAULT_VOLUME)
        break
      }
      case '--scene':
        options.scene = next() === 'nature' ? 'nature' : 'room'
        break
      case '--list':
        options.list = true
        break
      case '--wait':
        options.wait = true
        break
      case '--color':
        options.color = true
        break
      case '--no-color':
        options.color = false
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }
  return options
}

/**
 * The footer's rain note, or an empty string when sound is not relevant.
 *
 * Kept out of `draw` so the level it prints — and the case where the chosen
 * player cannot apply that level to a recording — can be asserted directly
 * rather than by scraping a frame.
 *
 * @param {{ t: (key: string, params?: object) => string }} translator
 * @param {{ available: boolean, enabled: boolean, honoured: boolean, level: number, player: string | null, wet: boolean }} state
 * @returns {string}
 */
export function soundFooter(translator, state) {
  if (!state.available || !(state.wet || state.enabled)) return ''
  const key = state.enabled ? (state.honoured ? 'work.soundOn' : 'work.soundFixed') : 'work.soundOff'
  const note = translator.t(key, { level: state.level, player: state.player ?? '' })
  return `   ${note}`
}

const HELP = `dsh-live-working — a live orca animation for a DeepSeek Harness session

Usage:
  dsh-live-working [options]

The orca sits at a desk with a keyboard, a stack of books and a red telephone.
What it does follows the session: it types while the model works, reads with the
occasional squint while a file is read, leafs through the books while a search
runs, picks up the telephone when a subagent starts, and falls asleep when there
is nothing to do — including when a running command has been silent for a while.

Options:
  -s, --session <id>   bind this session instead of the server's default
      --socket <path>  attach to a known observer socket
      --server <pid>   prefer the Harness process with this pid
      --cwd <path>     prefer the server and session for this working directory
      --runtime-dir <p>  override the runtime directory (default: $DSH_HOME/live-trace)
      --state <name>   pin one animation and do not follow the session
      --interval <ms>  repaint interval (default: 120)
      --lang <code>    UI language: auto, en, or zh (default: auto, from $LANG)
      --sound          play rain noise while it is raining (needs aplay, paplay,
                       sox or ffplay; off by default)
      --rain-volume <p>  rain level, 0-100 (default: 40); aplay cannot change
                       the level of a recording, only of the built-in noise
      --rain-file <p>  use a recording of rain instead of the built-in noise
      --scene <name>   room (a desk by a window) or nature (the whole
                       backdrop is outdoors); default: room
      --list           list discovered observers, then exit
      --wait           poll for an observer instead of exiting
      --no-color       disable ANSI color
  -h, --help           show this help
  -V, --version        show the version

States: ${WORK_STATES.join(', ')}

Keys:
  1-8         pin one of the states above; 0 returns to automatic
  s           choose a session when several are running
  n           rain sound on or off (only when it is raining outside)
  - / +       rain volume down or up (shown in the footer)
  b           background: the room, or the outdoors
  l           switch language
  ?           toggle this help
  q / Ctrl-C  quit

The animation is read-only: it never sends anything to the agent.
`

/**
 * Resolve the server to attach to.
 *
 * @returns {object | null}
 */
async function discover(parsed, registryDir, cwd, stderr) {
  for (;;) {
    const records = pruneServerRecords(registryDir)
    const server = selectServerRecord(records, {
      socket: parsed.socket,
      pid: Number.isFinite(parsed.server) ? parsed.server : undefined,
      cwd: parsed.cwd ?? cwd
    })
    if (server !== undefined) return server
    if (parsed.wait !== true) {
      stderr.write(
        [
          'dsh-live-working: no running Harness observer found.',
          '',
          `Looked in: ${registryDir}`,
          '',
          'This command reads events published by the dsh-live-trace Host plugin.',
          'Enable that plugin in the profile your Harness runs, then try again:',
          '',
          '  dsh plugin --profile web add <path-to>/dsh-live-trace',
          '',
          'Use `--socket <path>` to attach to a known socket directly.',
          ''
        ].join('\n')
      )
      return null
    }
    stderr.write(`dsh-live-working: waiting for an observer in ${registryDir}…\n`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/**
 * Run the animation.
 *
 * @param {{ stdout: NodeJS.WriteStream, stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream, argv?: string[], env?: NodeJS.ProcessEnv }} io
 * @returns {Promise<number>} exit code
 */
export async function run(io) {
  const { stdout, stderr } = io
  const env = io.env ?? process.env
  const argv = io.argv ?? process.argv.slice(2)

  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    stderr.write(`dsh-live-working: ${error.message}\n`)
    return 2
  }

  if (parsed.help === true) {
    stdout.write(HELP)
    return 0
  }
  if (parsed.version === true) {
    const pkg = await import('../../../package.json', { with: { type: 'json' } })
    stdout.write(`${pkg.default.version}\n`)
    return 0
  }

  const runtimeDir = parsed.runtimeDir ?? resolveRuntimeDir(env)
  const registryDir = serversDir(runtimeDir)

  if (parsed.list === true) {
    const records = pruneServerRecords(registryDir)
    stdout.write(`runtime dir: ${runtimeDir}\n`)
    stdout.write(`servers dir: ${registryDir}\n\n`)
    if (records.length === 0) stdout.write('No running Harness observers.\n')
    for (const record of records) {
      stdout.write(`pid ${record.pid}  profile=${record.profile ?? '-'}  cwd=${record.cwd ?? '-'}\n`)
      for (const session of record.sessions ?? []) {
        stdout.write(`  ${session.id === record.activeSessionId ? '*' : ' '} ${session.id}\n`)
      }
    }
    return 0
  }

  const server = await discover(parsed, registryDir, io.cwd ?? process.cwd(), stderr)
  if (server === null) return 1

  const color = parsed.color ?? (env.NO_COLOR === undefined && stdout.isTTY === true)
  const theme = createTheme({ color })
  let translator = createTranslator(resolveLanguage(parsed.lang, env))

  const chosen = selectSession(server, { sessionId: parsed.session, cwd: parsed.cwd ?? io.cwd })
  let sessionId = chosen?.id ?? server.activeSessionId ?? null

  const work = createWorkState()
  let pinned = parsed.state !== null && WORK_STATES.includes(parsed.state) ? parsed.state : null
  let sessions = []
  let sessionLabel = sessionId
  // With several sessions running and no explicit choice, ask rather than
  // guessing: the default is a guess the user cannot see the basis of.
  let picking = parsed.session === undefined || parsed.session === null
  let pickerIndex = 0
  let turn = 0
  let step = 0
  let help = false
  let frame = 0
  // Speech runs on its own clock, so a new message is always spoken from its
  // start rather than appearing fully formed.
  let lastBubble = null
  let bubbleSince = 0
  // The handset's travel between the cradle and the ear. Time-based, so the
  // pickup takes the same half second whatever the repaint interval is.
  let phoneLift = 0
  // How long the current pose has been held. Sleeping uses it to lie the tail
  // down slowly rather than dropping it the instant the eyes shut.
  let lastKind = null
  let kindSince = 0
  let lastDrawAt = Date.now()
  // Off unless asked for. It follows the weather in the window: rain outside,
  // rain inside.
  // Prefer a recording the user pointed at, then the one shipped here, then
  // the synthesised noise.
  const sound = createRainSound({ file: parsed.rainFile ?? bundledRainFile(), volume: parsed.rainVolume })
  if (parsed.sound === true) sound.setEnabled(true)
  let backdrop = parsed.scene === 'nature' ? 'nature' : 'room'

  const client = connectTrace({
    socketPath: server.socket,
    sessionId,
    replayLimit: parsed.replayLimit,
    onRecord: (record) => {
      reduceWork(work, record)
      if (record.kind === 'status') {
        turn = record.turn ?? turn
        step = record.step ?? step
      }
      if (record.kind === 'sessions') {
        sessions = Array.isArray(record.sessions) ? record.sessions : []
        if (record.activeSessionId !== undefined && sessionId === null) sessionLabel = record.activeSessionId
        // Only one session means there is nothing to choose.
        if (sessions.length <= 1) picking = false
        else pickerIndex = createPickerState(sessions, sessionLabel).index
      }
    }
  })

  const screen = new Screen({ stdout, stdin: io.stdin ?? process.stdin, altScreen: true, mouse: false })

  /**
   * What the telephone bubble says.
   *
   * While a call is out it shows the *call as it was written* — the tool name
   * and its arguments — plus where it sits in the queue when several subagents
   * are out at once. When one rings back it shows what it came back with.
   */
  const bubbleFor = (state) => {
    const sub = state.subagent
    if (state.kind === 'ringing') {
      const reply = typeof sub?.reply === 'string' && sub.reply.length > 0 ? sub.reply : translator.t('work.noReply')
      return { header: translator.t('work.bubbleReply', { n: sub?.index ?? 1 }), body: reply }
    }
    const header = sub !== null && sub !== undefined && sub.total > 1
      ? translator.t('work.bubbleQueue', { n: sub.index, total: sub.total, q: sub.queued ?? 0 })
      : translator.t('work.bubbleCalling', { n: sub?.index ?? 1 })
    // The body is the call *as it was written*: the tool name and its
    // arguments, not just the instruction inside it.
    const body = typeof sub?.format === 'string' && sub.format.length > 0
      ? sub.format
      : (typeof sub?.input === 'string' && sub.input.length > 0 ? sub.input : translator.t('work.noInput'))
    return { header, body }
  }

  /** Draw the session chooser, or the scene when a session is settled. */
  const drawPicker = (cols, rows) => {
    const title = `  ${translator.t('working.pick')}`
    const lines = [title, '']
    // Lead with the title, the same way the trace dashboard's session list
    // does. The id is still here — shortened — because it is what you type and
    // the title is not unique.
    sessions.forEach((session, index) => {
      const mark = index === pickerIndex ? '▸' : ' '
      const id = shortSessionId(String(session.id), 20)
      const title = typeof session.title === 'string' && session.title.length > 0 ? `${sanitize(session.title)}  ` : ''
      const cwd = session.cwd === undefined ? '' : `  ${shortPath(String(session.cwd), 36)}`
      const bound = session.id === sessionLabel ? ' *' : '  '
      lines.push(truncate(`  ${mark} ${index + 1}. ${title}${id}${bound}${cwd}`, cols))
    })
    lines.push('')
    lines.push(`  ${translator.t('working.pickKeys')}`)
    const top = Math.max(0, Math.floor((rows - lines.length) / 2))
    const padded = []
    for (let index = 0; index < top; index += 1) padded.push('')
    padded.push(...lines)
    while (padded.length < rows) padded.push('')
    screen.paint(padded.slice(0, rows))
  }

  const draw = () => {
    const { cols, rows } = screen.size()
    if (picking && sessions.length > 1) {
      drawPicker(cols, rows)
      return
    }
    if (cols < 32 || rows < 10) {
      screen.paint(
        [`  ${translator.t('work.tooSmall')}`, ''].concat(
          Array.from({ length: Math.max(0, rows - 2) }, () => '')
        )
      )
      return
    }
    const size = sceneSizeFor(cols, rows)
    const state = workStateOf(work)
    const kind = pinned ?? state.kind
    if (kind !== lastKind) {
      lastKind = kind
      kindSince = frame
    }
    const sleepFor = kind === 'sleep' ? frame - kindSince : 0
    const bubble = kind === 'calling' || kind === 'ringing' ? bubbleFor({ ...state, kind }) : null
    const bubbleKey = bubble === null ? null : `${bubble.header}\n${bubble.body}`
    if (bubbleKey !== lastBubble) {
      lastBubble = bubbleKey
      bubbleSince = frame
    }
    const wanted = kind === 'calling' || kind === 'ringing' ? 1 : 0
    const nowMs = Date.now()
    const elapsed = Math.min(250, Math.max(0, nowMs - lastDrawAt))
    lastDrawAt = nowMs
    const travel = elapsed / 550
    phoneLift = phoneLift < wanted ? Math.min(wanted, phoneLift + travel) : Math.max(wanted, phoneLift - travel)

    const scene = sceneFrame({ kind, subagent: state.subagent }, frame, {
      scene: backdrop,
      phoneLift,
      palette: theme.scene,
      bubbleHeader: bubble?.header ?? null,
      bubbleBody: bubble?.body ?? '',
      speechFrame: frame - bubbleSince,
      sleepFor,
      // While dozing on outstanding subagents the window carries the queue:
      // the call-on-the-line moment is too brief to show it, and the queue is
      // exactly what the orca is waiting on.
      previewText: state.waiting === true
        ? translator.t('work.waitingForSubagents', { n: state.pending ?? 0 })
        : previewOf(work),
      size
    })

    const lines = []
    const top = Math.max(0, Math.floor((rows - scene.height - 1) / 2))
    for (let index = 0; index < top; index += 1) lines.push('')
    for (const row of scene.cells) {
      const text = renderCells(row)
      const pad = Math.max(0, Math.floor((cols - scene.width) / 2))
      lines.push(' '.repeat(pad) + text)
    }
    while (lines.length < rows - 1) lines.push('')

    const stateLabel = translator.t(`work.state.${kind}`)
    const sky = scene.sky
    const clock = sky === undefined ? '' : sky.clock
    const weather = sky === undefined ? '' : translator.t(`work.weather.${sky.weather.kind}`)
    const wet = sky !== undefined && (sky.weather.kind === 'rain' || sky.weather.kind === 'storm')
    sound.update(wet)
    const soundNote = soundFooter(translator, {
      available: sound.available,
      enabled: sound.enabled,
      // Never claim a level that cannot reach the speakers: aplay has no volume
      // argument, so a recording is heard at the level it was recorded at.
      honoured: sound.volumeHonoured,
      level: Math.round(sound.volume * 100),
      player: sound.player,
      wet
    })
    const sceneNote = `   ${translator.t(backdrop === 'nature' ? 'work.sceneNature' : 'work.sceneRoom')}`
    const mode = pinned === null ? translator.t('work.automatic') : translator.t('work.pinned')
    const left = `  ${translator.t('work.title')} · ${stateLabel}${help ? `   ${mode}` : ''}${clock === '' ? '' : `   ${clock} ${weather}`}${sceneNote}${soundNote}`
    const right = `${sessionLabel === null || sessionLabel === undefined ? translator.t('work.noSession') : String(sessionLabel).slice(-12)}  T${turn}·S${step}  ${translator.t('work.helpKey')}:?   `
    const width = Math.max(0, cols - left.length - right.length)
    lines.push(left + ' '.repeat(width) + right)
    screen.paint(lines.slice(0, rows))
  }

  let quitResolve = () => {}
  const done = new Promise((resolve) => {
    quitResolve = resolve
  })

  screen.enter()
  screen.onResize(draw)

  screen.onKey((key) => {
    if (typeof key !== 'string') return
    if (key === 'quit' || key === 'q' || key === '\u0003') {
      quitResolve(0)
      return
    }
    if (picking && sessions.length > 1) {
      const step = applyPickerKey({ index: pickerIndex, count: sessions.length, boundId: sessionLabel }, key, sessions)
      pickerIndex = step.index
      if (step.intent === 'bind' && step.sessionId !== null) {
        // `sessionId` must stay reassignable: this is the line that was a
        // crash when it was declared const.
        sessionId = step.sessionId
        sessionLabel = step.sessionId
        client.select(sessionId)
        picking = false
      } else if (step.intent === 'cancel') {
        picking = false
      }
      draw()
      return
    }
    if (key === 'l') translator = createTranslator(nextLanguage(translator.language))
    else if (key === '?' || key === 'h') help = !help
    else if (key === 'n') sound.toggle()
    else if (key === '-' || key === '_') sound.adjustVolume(-VOLUME_STEP)
    else if (key === '+' || key === '=') sound.adjustVolume(VOLUME_STEP)
    else if (key === 'b') backdrop = backdrop === 'room' ? 'nature' : 'room'
    else if (key === 's' && sessions.length > 1) picking = true
    else if (key === '0') pinned = null
    else if (/^[1-9]$/.test(key)) {
      const candidate = PIN_KEYS[Number(key) - 1]
      if (candidate !== undefined) pinned = candidate
    }
    draw()
  })

  // The sound is a separate process, and an orphaned one keeps raining after
  // this command is gone. Ctrl-C and a signal both skip the normal path, so
  // they are wired to the same cleanup, and `exit` is the last resort.
  const finish = () => {
    sound.stop()
  }
  process.once('exit', finish)
  const onSignal = (signal) => {
    finish()
    screen.leave()
    // Re-raise so the shell sees the real reason, with the default handler.
    process.removeListener(signal, onSignal)
    process.kill(process.pid, signal)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)

  const timer = setInterval(() => {
    frame += 1
    draw()
  }, parsed.interval)
  timer.unref?.()
  draw()

  const code = await done
  clearInterval(timer)
  sound.stop()
  process.removeListener('exit', finish)
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  process.removeListener('SIGHUP', onSignal)
  client.close()
  screen.leave()
  return code
}

export default run
