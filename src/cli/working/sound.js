/**
 * Rain, out loud.
 *
 * A terminal cannot make a sound of its own, so this streams synthesised noise
 * to whichever system audio player is installed. It is **off unless asked for**
 * — a command that starts playing audio on its own is a command people stop
 * running — and it only plays while it is actually raining.
 *
 * The noise is generated, not sampled: a low-passed run of pseudo-random
 * samples reads as rain, needs no asset, and can run forever without a loop
 * point.
 *
 * @module dsh-live-working/sound
 */

import { delimiter, dirname, join } from 'node:path'
import { accessSync, constants, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn as spawnProcess } from 'node:child_process'

/** Sample rate of the generated stream. */
export const SAMPLE_RATE = 22_050

/**
 * How loud the rain is out of the box.
 *
 * The recording that ships with the package peaks at -6.1 dBFS, which is a
 * foreground level; at 40% it peaks around -14 dBFS and reads as ambience
 * instead of something to switch off. The level is a fraction, not a
 * percentage, so it is what the player arguments are computed from.
 */
export const DEFAULT_VOLUME = 0.4

/** How much one press of the volume keys moves the level. */
export const VOLUME_STEP = 0.05

/** Full-scale gain of the synthesised noise before the volume is applied. */
export const NOISE_GAIN = 0.18

/** Seed for the synthesised noise, so two runs sound the same. */
export const NOISE_SEED = 0x2f6e2b1

/**
 * Clamp anything to a usable level.
 *
 * A level is a fraction in [0, 1]; a value that is not a number at all falls
 * back to the default rather than to silence or to full scale.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampVolume(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return DEFAULT_VOLUME
  return Math.min(1, Math.max(0, number))
}

/** `paplay --volume` is a linear scale over 0-65536. */
function paplayVolume(volume) {
  return Math.round(clampVolume(volume) * 65_536)
}

/**
 * Players that can take raw PCM on stdin, best first.
 *
 * PulseAudio's `paplay` and ALSA's `aplay` are the common ones on a Linux
 * desktop; `sox` and `ffplay` are the fallbacks for a machine that has neither.
 *
 * `volume` says whether the player can change the level of a *recording* it is
 * given. `paplay`, `sox` and `ffplay` each have an argument for it; `aplay` has
 * none at all, so a recording played through `aplay` is heard at whatever level
 * it was recorded at. The synthesised stream does not depend on this flag: its
 * samples are scaled before they are written, so every player honours the level
 * on that path.
 */
export const PLAYERS = [
  {
    command: 'aplay',
    // aplay has no volume argument, so a file cannot be attenuated.
    volume: false,
    args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', '1', '-'],
    fileArgs: (file) => ['-q', file],
    loops: false
  },
  {
    command: 'paplay',
    volume: true,
    args: ['--raw', `--format=s16le`, `--rate=${SAMPLE_RATE}`, '--channels=1'],
    fileArgs: (file, volume = 1) => [`--volume=${paplayVolume(volume)}`, file],
    loops: false
  },
  {
    command: 'sox',
    volume: true,
    args: ['-q', '-t', 'raw', '-e', 'signed', '-b', '16', '-r', String(SAMPLE_RATE), '-c', '1', '-', '-d'],
    fileArgs: (file, volume = 1) => ['-q', '-v', clampVolume(volume).toFixed(2), file, '-d'],
    loops: false
  },
  {
    command: 'ffplay',
    volume: true,
    args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', '-'],
    // The one player that can loop a file by itself.
    fileArgs: (file, volume = 1) => [
      '-nodisp',
      '-loglevel',
      'quiet',
      '-volume',
      String(Math.round(clampVolume(volume) * 100)),
      '-loop',
      '0',
      file
    ],
    loops: true
  }
]

/**
 * The first player that is actually installed.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {(path: string) => boolean} [isExecutable]
 * @returns {{ command: string, args: string[] } | null}
 */
export function findPlayer(env = process.env, isExecutable = defaultIsExecutable) {
  const directories = String(env?.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0)
  for (const candidate of PLAYERS) {
    for (const directory of directories) {
      if (isExecutable(join(directory, candidate.command))) return candidate
    }
  }
  return null
}

function defaultIsExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The rain recording that ships with the package, if it is there.
 *
 * @returns {string | null}
 */
export function bundledRainFile() {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'rain.ogg')
  return existsSync(path) ? path : null
}

/**
 * A source of rain-like noise.
 *
 * White noise filtered through a one-pole low pass: the top end is rolled off,
 * which is what turns a hiss into rain. The `gain` is what the rain's volume is
 * applied to, so the same generator serves both a quiet and a loud stream.
 *
 * @param {number} [seed]
 * @param {number} [gain] full-scale multiplier, applied before the samples are
 *   written; clamped so an over-driven gain cannot overflow an int16
 * @returns {(buffer: Buffer) => Buffer}
 */
export function createNoiseSource(seed = NOISE_SEED, gain = NOISE_GAIN) {
  let state = seed >>> 0
  let low = 0
  const level = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : NOISE_GAIN
  return function fill(buffer) {
    for (let index = 0; index + 1 < buffer.length; index += 2) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const white = (state / 0xffffffff) * 2 - 1
      low += (white - low) * 0.35
      const sample = Math.max(-1, Math.min(1, low * 1.6))
      const value = Math.max(-32768, Math.min(32767, Math.round(sample * 32767 * level)))
      buffer.writeInt16LE(value, index)
    }
    return buffer
  }
}

/**
 * A rain loop, played through a system player.
 *
 * By default the noise is synthesised and streamed, which needs no asset at
 * all. Given a recording it plays that instead, looping it — the synthesised
 * version exists so the command works on a machine with nothing but a player,
 * not because it is better than a real recording.
 *
 * @param {{ player?: object | null, spawn?: typeof spawnProcess, chunkBytes?: number, intervalMs?: number, file?: string | null, exists?: (path: string) => boolean, volume?: number }} [options]
 */
export function createRainSound(options = {}) {
  const player = options.player === undefined ? findPlayer() : options.player
  const spawn = options.spawn ?? spawnProcess
  const chunkBytes = options.chunkBytes ?? 8192
  const intervalMs = options.intervalMs ?? 180
  const exists = options.exists ?? existsSync
  // A file that is not there is not an error: fall back to the synthesised
  // noise rather than going silent.
  // Undefined means "use whatever is bundled"; an explicit null means silence
  // is preferable to a recording.
  const wanted = options.file === undefined ? bundledRainFile() : options.file
  const file = typeof wanted === 'string' && wanted.length > 0 && exists(wanted) ? wanted : null
  const usesFile = file !== null

  let child = null
  /** Every player process this object has started and not yet reaped. */
  const live = new Set()
  let timer = null
  let enabled = false
  let playing = false
  let restarting = false
  let wetNow = false
  let failures = 0
  let startedAt = 0
  let volume = clampVolume(options.volume === undefined ? DEFAULT_VOLUME : options.volume)
  // The synthesised stream carries its level in its samples, so a change takes
  // effect on the next chunk rather than needing the player restarted.
  let fill = createNoiseSource(NOISE_SEED, NOISE_GAIN * volume)

  const silence = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
    // Kill everything that was ever started, not just the current reference.
    // Exiting only what `child` points at left orphans behind whenever that
    // reference had been replaced, and they kept playing after the command
    // exited.
    for (const process of live) {
      try {
        process.stdin?.end()
      } catch {
        /* already gone */
      }
      try {
        process.kill()
      } catch {
        /* already gone */
      }
    }
    live.clear()
    child = null
    playing = false
  }

  const speak = () => {
    if (child === null || child.stdin === null || child.stdin.destroyed) return
    // Skip a chunk rather than queueing one: a backed-up pipe would drift
    // further and further behind the weather.
    if (child.stdin.writableLength > chunkBytes * 4) return
    try {
      child.stdin.write(fill(Buffer.alloc(chunkBytes)))
    } catch {
      silence()
    }
  }

  const start = () => {
    if (playing || player === null) return
    let started
    try {
      if (usesFile) {
        startedAt = Date.now()
        // The recording's level is the player's own argument; a player that has
        // none ignores the second argument and plays the file as recorded.
        started = spawn(player.command, player.fileArgs(file, volume), { stdio: ['ignore', 'ignore', 'ignore'] })
      } else {
        started = spawn(player.command, player.args, { stdio: ['pipe', 'ignore', 'ignore'] })
      }
    } catch {
      child = null
      return
    }
    child = started
    live.add(started)
    // A process that is no longer the current one must not touch the state.
    // Changing the volume stops the player and starts a new one, and the old
    // one's exit lands *after* the new one is running: without this guard it
    // cleared `child` and `playing`, so the next frame started a third player
    // and the first was never killed.
    started.on('error', () => {
      live.delete(started)
      if (child === started) silence()
    })
    started.on('exit', () => {
      live.delete(started)
      if (child !== started) return
      child = null
      playing = false
      // A player that dies the moment it starts has no audio device, and
      // restarting it forever would be a busy loop. A file that simply ran out
      // lasts its whole length, so it is not counted as a failure.
      const lasted = Date.now() - startedAt
      if (usesFile && lasted < 1000) failures += 1
      if (failures >= 3) return
      // A file that ends has to be started again to keep raining; the players
      // that cannot loop a file themselves need this.
      if (!enabled || restarting || !wetNow) return
      restarting = true
      setTimeout(() => {
        restarting = false
        if (enabled && wetNow) start()
      }, 40).unref?.()
    })
    playing = true
    if (usesFile) return
    speak()
    timer = setInterval(speak, intervalMs)
    // Never keep the process alive: the audio stream must not be the reason a
    // command refuses to exit.
    timer.unref?.()
  }

  return {
    /** Whether an audio player was found at all. */
    get available() {
      return player !== null
    },
    get player() {
      return player === null ? null : player.command
    },
    /** The recording in use, or null when the noise is synthesised. */
    get file() {
      return file
    },
    get enabled() {
      return enabled
    },
    /** Whether sound is coming out right now. */
    get playing() {
      return playing
    },
    /** The current level, a fraction in [0, 1]. */
    get volume() {
      return volume
    },
    /**
     * Whether the level can actually reach the speakers on the current path.
     *
     * The synthesised stream is scaled by this module, so every player honours
     * it. A recording's level is the player's argument, and `aplay` has none —
     * this is false there rather than silently pretending the file is quieter.
     */
    get volumeHonoured() {
      return player !== null && (!usesFile || player.volume === true)
    },
    setEnabled(value) {
      enabled = value === true
      if (!enabled) silence()
      return enabled
    },
    toggle() {
      return this.setEnabled(!enabled)
    },
    /**
     * Change the rain's level.
     *
     * A recording already being played carries the old level in the player's
     * arguments, so it is restarted; the synthesised stream picks the new gain
     * up on its next chunk without a gap.
     *
     * @param {number} value fraction in [0, 1]
     * @returns {number} the level actually set
     */
    setVolume(value) {
      const next = clampVolume(value)
      if (next === volume) return volume
      volume = next
      fill = createNoiseSource(NOISE_SEED, NOISE_GAIN * volume)
      if (playing && usesFile && player?.volume === true) {
        silence()
        if (enabled && wetNow) start()
      }
      return volume
    },
    /**
     * Move the level by a step, for the volume keys.
     *
     * @param {number} delta
     * @returns {number} the level actually set
     */
    adjustVolume(delta) {
      return this.setVolume(volume + (Number.isFinite(delta) ? delta : 0))
    },
    /**
     * Follow the weather. Called every frame, so it must be cheap when nothing
     * has changed.
     *
     * @param {boolean} wet whether it is raining or storming
     */
    update(wet) {
      wetNow = wet === true
      if (enabled && wetNow) start()
      else if (playing) silence()
    },
    stop: silence
  }
}
