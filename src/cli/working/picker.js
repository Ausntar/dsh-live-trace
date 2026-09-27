/**
 * The session chooser, as a pure reducer.
 *
 * With several sessions running, guessing which one the user meant is a guess
 * they cannot see the basis of, so `dsh-live-working` asks. The key handling
 * lives here rather than inline in the render loop so it can be tested without
 * a terminal: the parts that have broken in this command have all been in the
 * wiring between a key press and a state change.
 *
 * @module dsh-live-working/picker
 */

/**
 * @typedef {{ index: number, count: number, boundId: string | null }} PickerState
 * @typedef {{ index: number, intent: 'none' | 'bind' | 'cancel', sessionId: string | null }} PickerStep
 */

/** Positive modulo. */
function mod(value, base) {
  if (base <= 0) return 0
  return ((value % base) + base) % base
}

/**
 * A picker positioned on the currently bound session.
 *
 * @param {Array<{ id: string }>} sessions
 * @param {string | null} [boundId]
 * @returns {PickerState}
 */
export function createPickerState(sessions, boundId = null) {
  const list = Array.isArray(sessions) ? sessions : []
  const found = list.findIndex((session) => session?.id === boundId)
  return { index: found >= 0 ? found : 0, count: list.length, boundId: boundId ?? null }
}

/**
 * Apply one key.
 *
 * @param {PickerState} state
 * @param {string} key
 * @param {Array<{ id: string }>} [sessions]
 * @returns {PickerStep}
 */
export function applyPickerKey(state, key, sessions = []) {
  const count = state.count > 0 ? state.count : (Array.isArray(sessions) ? sessions.length : 0)
  const index = mod(state.index, Math.max(1, count))
  const stay = (next = index) => ({ index: next, intent: 'none', sessionId: null })

  switch (key) {
    case 'up':
    case 'k':
      return stay(mod(index - 1, Math.max(1, count)))
    case 'down':
    case 'j':
      return stay(mod(index + 1, Math.max(1, count)))
    case 'home':
      return stay(0)
    case 'end':
      return stay(Math.max(0, count - 1))
    case 'enter':
    case '\r':
    case '\n': {
      const chosen = Array.isArray(sessions) ? sessions[index] : undefined
      const sessionId = chosen?.id ?? null
      return { index, intent: sessionId === null ? 'cancel' : 'bind', sessionId }
    }
    case 'escape':
    case 's':
    case 'q':
      return { index, intent: 'cancel', sessionId: null }
    default:
      return stay()
  }
}
