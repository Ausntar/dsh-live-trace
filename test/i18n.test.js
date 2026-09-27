/**
 * Localization: detection, lookup, and the guarantee that every shipped
 * language covers every key the UI asks for.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTranslator, detectLanguage, dictionary, dictionaryKeys, LANGUAGES, nextLanguage, resolveLanguage, statusText } from '../src/cli/i18n.js'
import { DEFAULT_TRANSLATOR } from '../src/cli/i18n.js'

test('the language is detected from the locale environment', () => {
  assert.equal(detectLanguage({ LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(detectLanguage({ LANG: 'zh' }), 'zh')
  assert.equal(detectLanguage({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(detectLanguage({ LANG: 'de_DE.UTF-8' }), 'en', 'an unrelated locale falls back to English')
  assert.equal(detectLanguage({}), 'en')
  // The dedicated override is consulted first.
  assert.equal(detectLanguage({ DSH_LIVE_TRACE_LANG: 'zh', LANG: 'en_US.UTF-8' }), 'zh')
  // LC_ALL outranks LANG.
  assert.equal(detectLanguage({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }), 'zh')
})

test('an explicit option beats the environment, and auto defers to it', () => {
  assert.equal(resolveLanguage('en', { LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveLanguage('zh', { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(resolveLanguage('auto', { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLanguage(undefined, { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLanguage('ZH-cn', { LANG: 'en_US.UTF-8' }), 'zh', 'a locale-shaped value works too')
  assert.equal(resolveLanguage('klingon', { LANG: 'en_US.UTF-8' }), 'en')
})

test('the language cycles through every shipped language', () => {
  assert.equal(nextLanguage('en'), 'zh')
  assert.equal(nextLanguage('zh'), 'en')
  assert.equal(nextLanguage('unknown'), 'en')
  assert.deepEqual(LANGUAGES, ['en', 'zh'])
})

test('translation substitutes parameters and falls back rather than blanking', () => {
  const { t } = createTranslator('en')
  assert.equal(t('commands.exit', { n: 3 }), 'exit 3')
  assert.equal(t('edits.filePlural', { n: 4 }), '4 files')
  assert.equal(t('no.such.key'), 'no.such.key', 'a missing key is visible, not empty')
  // A missing parameter leaves the placeholder intact so the bug is visible.
  assert.equal(t('commands.exit'), 'exit {n}')

  const zh = createTranslator('zh')
  assert.equal(zh.t('commands.exit', { n: 3 }), '退出 3')
  assert.equal(zh.language, 'zh')
})

test('an unknown language degrades to English', () => {
  const { language, t } = createTranslator('klingon')
  assert.equal(language, 'en')
  assert.equal(t('status.running'), 'running')
})

test('every shipped language defines every key', () => {
  const reference = dictionaryKeys('en').sort()
  for (const language of LANGUAGES) {
    const keys = dictionaryKeys(language).sort()
    assert.deepEqual(keys, reference, `${language} is missing or has extra keys`)
  }
  // No value may be accidentally empty except the deliberate section gap.
  for (const language of LANGUAGES) {
    for (const [key, value] of Object.entries(dictionary(language))) {
      if (key === 'help.general') continue
      assert.equal(typeof value, 'string')
      assert.ok(value.length > 0, `${language}.${key} is empty`)
    }
  }
})

test('the status vocabulary is localized', () => {
  const zh = createTranslator('zh')
  assert.equal(statusText(zh.t, 'running'), '运行中')
  assert.equal(statusText(zh.t, 'tool'), '执行工具')
  assert.equal(statusText(zh.t, 'waiting-approval'), '等待审批')
  assert.equal(statusText(zh.t, 'error'), '出错')
  assert.equal(statusText(zh.t, 'idle'), '空闲')
  assert.equal(statusText(zh.t, 'nonsense'), '空闲')
  assert.equal(statusText(DEFAULT_TRANSLATOR, 'running'), 'running')
})

test('the default translator is English', () => {
  assert.equal(DEFAULT_TRANSLATOR('status.idle'), 'idle')
})

test('every panel header is localized, not just the title bar', async () => {
  const { renderFrame } = await import('../src/cli/renderer.js')
  const { createTheme } = await import('../src/cli/theme.js')
  const { applyRecord, createViewState } = await import('../src/cli/view-state.js')
  const { stripAnsi } = await import('./helpers/util.js')

  const AT = 1_760_000_000_000
  const theme = createTheme({ color: false })
  const build = () => {
    const state = createViewState()
    applyRecord(state, {
      kind: 'hello',
      server: { pid: 1 },
      sessions: [{ id: 's', createdAt: AT, cwd: '/w', title: 'demo' }],
      activeSessionId: 's'
    })
    applyRecord(state, { kind: 'status', sessionId: 's', status: 'tool', turn: 1, step: 2 })
    applyRecord(state, { kind: 'entry', sessionId: 's', entry: { seq: 0, time: AT, tag: 'step', label: 'STEP 1', text: 'working' } })
    return state
  }

  const zh = createTranslator('zh').t
  const englishOnly = ['SESSIONS', 'FILE CHANGES', 'COMMANDS', 'no changes yet', 'No shell commands', 'No sessions yet']
  for (const view of ['trace', 'sessions', 'edits', 'commands']) {
    const text = stripAnsi(
      renderFrame(build(), { cols: 100, rows: 30, theme, now: AT, frame: 0, view, t: zh }).join('\n')
    )
    for (const word of englishOnly) {
      assert.doesNotMatch(text, new RegExp(word), `${view} panel still shows "${word}"`)
    }
  }

  // And the Chinese labels really are the ones that appear.
  const sessions = stripAnsi(renderFrame(build(), { cols: 100, rows: 30, theme, now: AT, frame: 0, view: 'sessions', t: zh }).join('\n'))
  assert.match(sessions, /会话/)
  assert.match(sessions, /活动中/)
})
