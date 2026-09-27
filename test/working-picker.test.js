/**
 * The session chooser's key handling.
 *
 * This is a pure reducer precisely so the bind path can be tested without a
 * terminal. Both bugs found in this command so far were in the wiring between a
 * key press and a state change: a picker that could not bind, and a scene that
 * ate the status line.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { applyPickerKey, createPickerState } from '../src/cli/working/picker.js'

const SESSIONS = [
  { id: 'session-first', cwd: '/a' },
  { id: 'session-second', cwd: '/b' },
  { id: 'session-third', cwd: '/c' }
]

test('the picker opens on the session that is currently bound', () => {
  assert.equal(createPickerState(SESSIONS, 'session-second').index, 1)
  assert.equal(createPickerState(SESSIONS, 'session-third').index, 2)
  assert.equal(createPickerState(SESSIONS, 'not-there').index, 0, 'an unknown binding falls back to the first')
  assert.equal(createPickerState(SESSIONS, null).index, 0)
  assert.equal(createPickerState([], null).index, 0)
  assert.equal(createPickerState(undefined, null).count, 0)
})

test('the arrows walk the list and wrap around', () => {
  const state = createPickerState(SESSIONS, 'session-first')
  assert.equal(applyPickerKey(state, 'down', SESSIONS).index, 1)
  assert.equal(applyPickerKey({ ...state, index: 2 }, 'down', SESSIONS).index, 0, 'wraps forward')
  assert.equal(applyPickerKey(state, 'up', SESSIONS).index, 2, 'wraps backward')
  assert.equal(applyPickerKey({ ...state, index: 2 }, 'home', SESSIONS).index, 0)
  assert.equal(applyPickerKey(state, 'end', SESSIONS).index, 2)
  // j/k work too, for anyone used to them.
  assert.equal(applyPickerKey(state, 'j', SESSIONS).index, 1)
  assert.equal(applyPickerKey(state, 'k', SESSIONS).index, 2)
})

test('enter binds the highlighted session', () => {
  // Every accept key, because a terminal may deliver any of them.
  for (const key of ['enter', '\r', '\n']) {
    const step = applyPickerKey(createPickerState(SESSIONS, 'session-first'), key, SESSIONS)
    assert.equal(step.intent, 'bind')
    assert.equal(step.sessionId, 'session-first')
  }
  const second = applyPickerKey(createPickerState(SESSIONS, 'session-second'), '\r', SESSIONS)
  assert.equal(second.intent, 'bind')
  assert.equal(second.sessionId, 'session-second', 'the highlighted session is the one bound')
})

test('escape and s cancel without binding', () => {
  for (const key of ['escape', 's', 'q']) {
    const step = applyPickerKey(createPickerState(SESSIONS, 'session-second'), key, SESSIONS)
    assert.equal(step.intent, 'cancel', `${key} cancels`)
    assert.equal(step.sessionId, null)
    assert.equal(step.index, 1, 'and does not move the highlight')
  }
})

test('an unbound key changes nothing', () => {
  const state = createPickerState(SESSIONS, 'session-second')
  for (const key of ['x', '1', '?', 'tab', 'page-up', '']) {
    const step = applyPickerKey(state, key, SESSIONS)
    assert.equal(step.intent, 'none', `${key} does nothing`)
    assert.equal(step.index, 1)
  }
})

test('binding with no sessions to choose is a cancel, not a crash', () => {
  const step = applyPickerKey(createPickerState([], null), '\r', [])
  assert.equal(step.intent, 'cancel')
  assert.equal(step.sessionId, null)
  // A highlight left past the end (sessions closed under us) must not throw.
  const stale = applyPickerKey({ index: 7, count: 2, boundId: null }, '\r', SESSIONS.slice(0, 2))
  assert.equal(stale.intent, 'bind')
  assert.equal(stale.sessionId, 'session-second')
})

test('the reducer never mutates the state it is given', () => {
  const state = createPickerState(SESSIONS, 'session-first')
  const frozen = Object.freeze({ ...state })
  assert.doesNotThrow(() => applyPickerKey(frozen, 'down', SESSIONS))
  assert.doesNotThrow(() => applyPickerKey(frozen, '\r', SESSIONS))
  assert.equal(frozen.index, 0)
})
