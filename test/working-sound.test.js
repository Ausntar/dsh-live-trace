/**
 * Rain, out loud: player detection, the noise itself, and when it plays.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  bundledRainFile,
  clampVolume,
  createNoiseSource,
  createRainSound,
  DEFAULT_VOLUME,
  findPlayer,
  NOISE_GAIN,
  PLAYERS,
  SAMPLE_RATE,
  VOLUME_STEP
} from '../src/cli/working/sound.js'

/** Stand in for a spawned audio player. */
function fakeSpawn() {
  const calls = []
  const spawn = (command, args) => {
    const child = new EventEmitter()
    child.command = command
    child.args = args
    child.written = 0
    child.killed = false
    child.chunks = []
    child.stdin = {
      destroyed: false,
      writableLength: 0,
      write(buffer) {
        child.written += buffer.length
        child.chunks.push(Buffer.from(buffer))
        return true
      },
      end() {
        child.stdin.destroyed = true
      }
    }
    child.kill = () => {
      child.killed = true
    }
    calls.push(child)
    return child
  }
  return { spawn, calls }
}

/** Mean absolute sample of a 16-bit mono buffer: one number for "how loud". */
function meanLevel(buffer) {
  let sum = 0
  let samples = 0
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    sum += Math.abs(buffer.readInt16LE(index))
    samples += 1
  }
  return sum / samples
}

/** The argument a player uses for a given level, found by value. */
function flagAfter(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

test('a player is looked for in PATH, best first', () => {
  // Only installed in /usr/bin: the fake has to respect the directory, or
  // every path looks present.
  const present = (names) => (path) => path.startsWith('/usr/bin/') && names.some((name) => path.endsWith(`/${name}`))
  assert.equal(findPlayer({ PATH: '/usr/bin:/bin' }, present(['aplay']))?.command, 'aplay')
  assert.equal(findPlayer({ PATH: '/usr/bin' }, present(['paplay']))?.command, 'paplay')
  assert.equal(findPlayer({ PATH: '/usr/bin' }, present(['ffplay']))?.command, 'ffplay')
  // Order is by preference, not by what PATH happens to list first.
  assert.equal(findPlayer({ PATH: '/usr/bin' }, present(['ffplay', 'aplay']))?.command, 'aplay')
  assert.equal(findPlayer({ PATH: '/nowhere' }, present(['aplay'])), null, 'not where it looked')
  assert.equal(findPlayer({}, () => true), null)
  assert.equal(findPlayer(undefined, () => false), null)
  // Every candidate can take raw PCM on stdin.
  for (const player of PLAYERS) assert.ok(player.args.includes('-') || player.args.some((a) => a.startsWith('--raw')), player.command)
})

test('the noise is rain-shaped, not silence and not a square wave', () => {
  const fill = createNoiseSource(1234)
  const buffer = fill(Buffer.alloc(4096))
  let min = 32767
  let max = -32768
  let sum = 0
  const samples = buffer.length / 2
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const value = buffer.readInt16LE(index)
    min = Math.min(min, value)
    max = Math.max(max, value)
    sum += Math.abs(value)
  }
  const mean = sum / samples
  assert.ok(max > 0 && min < 0, 'it goes both ways')
  assert.ok(mean > 200 && mean < 8000, `mean level ${mean} should be audible but not deafening`)
  assert.ok(max < 32767, 'and it never clips')
  assert.ok(buffer.length === 4096)

  // Deterministic from a seed, different across seeds.
  assert.deepEqual(createNoiseSource(7)(Buffer.alloc(64)), createNoiseSource(7)(Buffer.alloc(64)))
  assert.notDeepEqual(createNoiseSource(7)(Buffer.alloc(64)), createNoiseSource(8)(Buffer.alloc(64)))
})

test('with no player installed nothing is spawned and nothing throws', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: null, spawn })
  assert.equal(sound.available, false)
  assert.equal(sound.setEnabled(true), true, 'the choice is still remembered')
  sound.update(true)
  sound.update(false)
  sound.stop()
  assert.equal(calls.length, 0)
})

test('sound only comes out while it is raining, and only when switched on', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[0], spawn, file: null, chunkBytes: 256, intervalMs: 10_000 })

  // Off by default: weather must not start playing anything.
  sound.update(true)
  assert.equal(calls.length, 0, 'rain alone is not enough')
  assert.equal(sound.enabled, false)

  sound.setEnabled(true)
  sound.update(false)
  assert.equal(calls.length, 0, 'and being switched on is not enough either')

  sound.update(true)
  assert.equal(calls.length, 1, 'rain and the switch together start it')
  assert.equal(sound.playing, true)
  assert.equal(calls[0].command, 'aplay')
  assert.ok(calls[0].written > 0, 'and it is being fed samples')

  // Calling update again must not stack up players.
  sound.update(true)
  assert.equal(calls.length, 1)

  // The rain stops, so the sound does.
  sound.update(false)
  assert.equal(sound.playing, false)
  assert.equal(calls[0].killed, true)
  assert.equal(calls[0].stdin.destroyed, true)

  // And a toggle stops it even mid-downpour.
  sound.update(true)
  assert.equal(calls.length, 2)
  sound.toggle()
  assert.equal(sound.enabled, false)
  sound.update(true)
  assert.equal(sound.playing, false)
})

test('a player that dies is not written to again', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[0], spawn, file: null, chunkBytes: 128, intervalMs: 10_000 })
  sound.setEnabled(true)
  sound.update(true)
  const child = calls[0]
  child.emit('error', new Error('no sound card'))
  assert.equal(sound.playing, false)
  assert.doesNotThrow(() => sound.update(true))
  assert.equal(sound.playing, true, 'and it can start again')
})

test('a recording is played instead of the synthesised noise', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({
    player: PLAYERS[0],
    spawn,
    file: '/sounds/rain.wav',
    exists: () => true
  })
  assert.equal(sound.file, '/sounds/rain.wav')

  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1)
  // The file is handed to the player, and nothing is streamed into it.
  assert.deepEqual(calls[0].args, PLAYERS[0].fileArgs('/sounds/rain.wav'))
  assert.equal(calls[0].written, 0, 'a recording needs no synthesised samples')
})

test('a file that is not there falls back to the noise rather than going quiet', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({
    player: PLAYERS[0],
    spawn,
    file: '/sounds/missing.wav',
    exists: () => false,
    chunkBytes: 64
  })
  assert.equal(sound.file, null, 'the missing file is dropped')
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1, 'and the synthesised noise still plays')
  assert.deepEqual(calls[0].args, PLAYERS[0].args)
  assert.ok(calls[0].written > 0)
})

test('a recording that ends is started again while it is still raining', async () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[0], spawn, file: '/rain.wav', exists: () => true })
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1)

  // The player exits when the file runs out.
  calls[0].emit('exit', 0)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(calls.length, 2, 'it rains again')

  // But not once the rain has stopped.
  sound.update(false)
  calls[1].emit('exit', 0)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(calls.length, 2, 'no restart when it is not raining')
})

test('the looping players are the ones that say so', () => {
  for (const player of PLAYERS) {
    assert.equal(typeof player.fileArgs, 'function', `${player.command} can play a file`)
    assert.equal(typeof player.loops, 'boolean')
  }
  assert.equal(PLAYERS.find((p) => p.command === 'ffplay').loops, true)
  for (const player of PLAYERS.filter((p) => !p.loops)) {
    // Everyone else has to be restarted, so their file args must terminate.
    assert.ok(player.fileArgs('/rain.wav').includes('/rain.wav'))
  }
})

test('the bundled recording is used when nothing else is named', () => {
  const bundled = bundledRainFile()
  assert.ok(bundled, 'the package ships a rain recording')
  assert.match(bundled, /rain\.ogg$/)

  const sound = createRainSound({ player: PLAYERS[3] })
  assert.equal(sound.file, bundled, 'and it is the default source')
  assert.equal(sound.playing, false, 'but still silent until asked')

  // An explicit file wins; an explicit null means the synthesised noise.
  assert.equal(createRainSound({ player: PLAYERS[3], file: '/elsewhere/rain.ogg', exists: () => true }).file, '/elsewhere/rain.ogg')
  assert.equal(createRainSound({ player: PLAYERS[3], file: null }).file, null)
})

test('the bundled recording is a real, non-empty audio file', () => {
  const bundled = bundledRainFile()
  const bytes = readFileSync(bundled)
  assert.ok(bytes.length > 10_000, `only ${bytes.length} bytes`)
  // No test can listen to it, so check the container and the level instead.
  assert.equal(bytes.toString('ascii', 0, 4), 'OggS', 'it is an Ogg stream')
  assert.ok(bytes.includes(Buffer.from('vorbis')), 'carrying Vorbis audio')
  // A silent file would defeat the whole point.
  assert.notEqual(bytes.subarray(0, 4096).toString('hex'), bytes.subarray(-4096).toString('hex'))
})

test('a player that cannot open a sound device is not restarted forever', async () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[3], spawn, file: '/rain.ogg', exists: () => true })
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1)

  // Die immediately, three times over: that is a machine with no audio device.
  for (let round = 0; round < 4; round += 1) {
    calls.at(-1).emit('exit', 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  assert.equal(calls.length, 3, 'it gives up instead of spinning')
  // Not playing, but the switch is still remembered.
  assert.equal(sound.enabled, true)
  assert.equal(sound.playing, false)
})

test('the default level is a fraction below full scale, and clamps sanely', () => {
  assert.equal(DEFAULT_VOLUME, 0.4, 'the shipped default')
  assert.ok(DEFAULT_VOLUME > 0 && DEFAULT_VOLUME < 1)
  assert.equal(VOLUME_STEP, 0.05)
  assert.equal(clampVolume(0.25), 0.25)
  assert.equal(clampVolume(-3), 0)
  assert.equal(clampVolume(9), 1)
  assert.equal(clampVolume(Number.NaN), DEFAULT_VOLUME, 'garbage falls back to the default')
  assert.equal(clampVolume('0.5'), 0.5, 'a numeric string still works')

  const { spawn } = fakeSpawn()
  assert.equal(createRainSound({ player: PLAYERS[3], spawn, file: null }).volume, DEFAULT_VOLUME)
  assert.equal(createRainSound({ player: PLAYERS[3], spawn, file: null, volume: 0.1 }).volume, 0.1)
  assert.equal(createRainSound({ player: PLAYERS[3], spawn, file: null, volume: 5 }).volume, 1)
})

test('the default ffplay command asks for 40, not ffplay\'s own 100', () => {
  const { spawn, calls } = fakeSpawn()
  const bundled = bundledRainFile()
  const sound = createRainSound({ player: PLAYERS[3], spawn, file: bundled })
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1)
  // The exact command the bundled recording is played with. It used to carry
  // no `-volume` at all, which means ffplay's full 100.
  assert.deepEqual(calls[0].args, ['-nodisp', '-loglevel', 'quiet', '-volume', '40', '-loop', '0', bundled])
  assert.equal(sound.volume, DEFAULT_VOLUME)
  assert.equal(sound.volumeHonoured, true)
  // And raising the level is reflected in the argument, not silently dropped.
  sound.setVolume(0.75)
  assert.equal(flagAfter(calls[1].args, '-volume'), '75')
})

test('every player with a volume argument is given the level', () => {
  for (const [command, expected] of [['paplay', '--volume=16384'], ['sox', '0.25'], ['ffplay', '25']]) {
    const player = PLAYERS.find((candidate) => candidate.command === command)
    const { spawn, calls } = fakeSpawn()
    const sound = createRainSound({ player, spawn, file: '/rain.ogg', exists: () => true, volume: 0.25 })
    sound.setEnabled(true)
    sound.update(true)
    assert.equal(calls.length, 1, `${command} was started`)
    assert.ok(
      calls[0].args.includes(expected),
      `${command} args ${JSON.stringify(calls[0].args)} should carry ${expected}`
    )
    assert.ok(calls[0].args.includes('/rain.ogg'), `${command} still plays the recording`)
    assert.equal(sound.volumeHonoured, true, `${command} can change a recording`)
  }

  // The mapping, directly on the players, so it is not a coincidence of spawn.
  assert.deepEqual(PLAYERS[1].fileArgs('/a', 0.4), ['--volume=26214', '/a'])
  assert.deepEqual(PLAYERS[2].fileArgs('/a', 0.4), ['-q', '-v', '0.40', '/a', '-d'])
  assert.equal(flagAfter(PLAYERS[3].fileArgs('/a', 0.4), '-volume'), '40')
  // The synthesised stream carries its level in the samples, so its command
  // line is unchanged whatever the level is.
  for (const player of PLAYERS) {
    assert.ok(!player.args.some((arg) => arg.startsWith('--volume') || arg === '-volume'), player.command)
  }
})

test('the synthesised stream is quieter at the default than at full volume', () => {
  const sampleAt = (volume) => {
    const { spawn, calls } = fakeSpawn()
    // aplay has no player volume at all, so this can only be the sample scaling.
    const sound = createRainSound({
      player: PLAYERS[0],
      spawn,
      file: null,
      chunkBytes: 4096,
      intervalMs: 10_000,
      volume
    })
    sound.setEnabled(true)
    sound.update(true)
    assert.ok(calls[0].chunks.length > 0, 'a chunk was written')
    return meanLevel(calls[0].chunks[0])
  }

  const full = sampleAt(1)
  assert.equal(sampleAt(1), full, 'the same seed and gain give the same stream')
  const quiet = sampleAt(DEFAULT_VOLUME)
  assert.ok(quiet > 0, 'still not silence')
  // The samples are the same stream scaled, so the level is exactly the ratio.
  assert.ok(
    Math.abs(quiet / full - DEFAULT_VOLUME) < 0.02,
    `${quiet} / ${full} should be about ${DEFAULT_VOLUME}`
  )
  // Not a token cut: genuinely at least a factor of two down in amplitude.
  assert.ok(quiet < full * 0.5, `${quiet} should be well under half of ${full}`)
  // The generator's own default gain is the old full-scale one, so nothing that
  // asked for `createNoiseSource(seed)` got quieter behind its back.
  assert.equal(meanLevel(createNoiseSource(1234)(Buffer.alloc(4096))), meanLevel(createNoiseSource(1234, NOISE_GAIN)(Buffer.alloc(4096))))
})

test('a running synthesised stream picks up a new level without restarting', async () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[0], spawn, file: null, chunkBytes: 2048, intervalMs: 10 })
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1)
  const before = meanLevel(calls[0].chunks.at(-1))
  sound.setVolume(0.8)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(calls.length, 1, 'no restart: the samples carry the level')
  const after = meanLevel(calls[0].chunks.at(-1))
  assert.ok(after > before * 1.5, `${before} -> ${after}: the stream got louder`)
  sound.stop()
})

test('a running recording is restarted when the level changes, so the new argument is used', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[3], spawn, file: '/rain.ogg', exists: () => true })
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(flagAfter(calls[0].args, '-volume'), '40')
  sound.setVolume(0.8)
  assert.equal(calls.length, 2, 'the old player is replaced, or the level would never be heard')
  assert.equal(calls[1].killed, false)
  assert.equal(flagAfter(calls[1].args, '-volume'), '80')
  assert.equal(sound.playing, true)
  assert.equal(sound.volume, 0.8)
  sound.stop()
})

test('a player that cannot change a recording says so instead of pretending', () => {
  const { spawn, calls } = fakeSpawn()
  const file = createRainSound({ player: PLAYERS[0], spawn, file: '/rain.wav', exists: () => true })
  assert.equal(file.volume, DEFAULT_VOLUME, 'the level is still remembered')
  assert.equal(file.volumeHonoured, false, 'aplay has no volume argument, so it cannot apply it to a file')
  file.setEnabled(true)
  file.update(true)
  // And it does not fake an argument aplay would reject or misread.
  assert.deepEqual(calls[0].args, ['-q', '/rain.wav'])
  file.stop()

  // The same player does honour the level when the samples are synthesised.
  assert.equal(createRainSound({ player: PLAYERS[0], spawn, file: null }).volumeHonoured, true)
  assert.equal(createRainSound({ player: null, spawn }).volumeHonoured, false)
  for (const command of ['paplay', 'sox', 'ffplay']) {
    const player = PLAYERS.find((candidate) => candidate.command === command)
    assert.equal(
      createRainSound({ player, spawn, file: '/rain.ogg', exists: () => true }).volumeHonoured,
      true,
      command
    )
  }
})

/* ------------------------------------------------------------------ *
 * Changing the volume mid-rain
 * ------------------------------------------------------------------ */

test('changing the volume leaves exactly one player running', () => {
  // The bug this pins down: setVolume stops the player and starts a new one,
  // and the *old* one's exit event lands after the new one is running. It used
  // to clear the shared state, and the next frame started another player — two
  // rain sounds at once.
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[3], spawn, file: '/rain.ogg', exists: () => true })
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1)
  const first = calls[0]

  sound.setVolume(0.8)
  assert.equal(calls.length, 2, 'the level change restarts the player')
  const second = calls[1]
  assert.notEqual(first, second)

  // The old player finally reports that it died.
  first.emit('exit', null)
  assert.equal(sound.playing, true, 'a stale exit must not stop the new player')

  // And it must not make the next frame start a third.
  sound.update(true)
  sound.update(true)
  assert.equal(calls.length, 2, `three players were started: ${calls.length}`)

  // Only one is alive.
  assert.equal(calls.filter((call) => call.killed === false).length, 1)
  sound.stop()
})

test('stopping kills every player it ever started', () => {
  // The second half of the same bug: with the reference lost, stop() had
  // nothing to kill and the sound carried on after the command exited.
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[3], spawn, file: '/rain.ogg', exists: () => true })
  sound.setEnabled(true)
  sound.update(true)
  for (const level of [0.8, 0.6, 0.9]) sound.setVolume(level)

  assert.ok(calls.length > 1, 'the volume changes restarted the player')
  sound.stop()
  for (const [index, call] of calls.entries()) {
    assert.equal(call.killed, true, `player ${index} was left running`)
    assert.equal(call.stdin.destroyed, true, `player ${index} still has its pipe open`)
  }
})

test('a level change while it is not raining starts nothing', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[3], spawn, file: '/rain.ogg', exists: () => true })
  sound.setEnabled(true)
  sound.setVolume(0.7)
  assert.equal(calls.length, 0, 'no weather, no player')
  sound.update(false)
  assert.equal(calls.length, 0)
  assert.equal(sound.playing, false)
})

test('the same level twice does not restart the player', () => {
  const { spawn, calls } = fakeSpawn()
  const sound = createRainSound({ player: PLAYERS[3], spawn, file: '/rain.ogg', exists: () => true })
  sound.setEnabled(true)
  sound.update(true)
  assert.equal(calls.length, 1)
  sound.setVolume(sound.volume)
  sound.setVolume(Infinity)
  assert.equal(calls.length, 1, 'a no-op level change should not restart anything')
  sound.stop()
})
