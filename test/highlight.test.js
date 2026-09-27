/**
 * Syntax highlighting: the character-preservation contract.
 *
 * The highlighter is allowed to be approximate, but it is never allowed to drop
 * or reorder text, and it is never allowed to throw. Every test below is built
 * around that invariant.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SUPPORTED_LANGUAGES,
  highlightCode,
  highlightLine,
  normalizeLanguage
} from '../src/cli/highlight.js'
import { sanitize } from '../src/cli/width.js'

const syn = {
  keyword: '38;5;170',
  string: '38;5;114',
  number: '38;5;180',
  comment: '38;5;243',
  function: '38;5;39',
  type: '38;5;80',
  operator: '38;5;210',
  punctuation: '38;5;245',
  variable: '38;5;252',
  property: '38;5;117',
  tag: '38;5;170',
  attribute: '38;5;180',
  added: '38;5;42',
  removed: '38;5;203',
  meta: '38;5;141'
}

/** Concatenated text of a segment list. */
function textOf(segments) {
  return segments.map((segment) => segment.text).join('')
}

/** Concatenated text carrying one style. */
function styled(segments, sgr) {
  return segments
    .filter((segment) => segment.sgr === sgr)
    .map((segment) => segment.text)
    .join('')
}

const NASTY_LINES = [
  '',
  ' ',
  'const s = \'unterminated',
  'const t = "unterminated',
  'const u = `unterminated ${template',
  '/* unterminated comment',
  '<!-- unterminated comment',
  '"""unterminated triple',
  '推理中 日本語 テキスト 한국어',
  'emoji 🎉🚀✅ mixed 中文',
  '\u001b[31mred\u001b[0m and \u001b]0;title\u0007text',
  '\u0000\u0001\u0007\u007f controls',
  'x'.repeat(2000),
  'a'.repeat(1500) + '🎉' + 'b'.repeat(400),
  'mixed ``` ` ~ ~~ ${} # -- // /* */ <tag attr="v"> &amp;',
  'balanced `inline code` with **bold** and [link](url) and ~~strike~~',
  "SELECT * FROM \"t\" WHERE x = 'y' -- trailing",
  '--- a/file\t+++ b/file',
  '@media (min-width: 10px) { .a { color: #fff; } }',
  '{"k": [1, 2, {"n": null}], "b": true}',
  "fn f<'a>(x: &'a str) -> u8 { println!(\"{}\", x); 0 }",
  'echo "$HOME" -n --flag ${VAR} | grep -v x',
  'def f(self, *args, **kwargs): # note',
  'foo(1) bar.baz(2) obj.prop',
  '{"broken": ',
  '<div class="x" data-y=\'z\'>text &amp; more</div>',
  '---\nkey: value',
  '| a | b |\n| - | - |',
  '# Heading **bold** `code` [l](u)',
  '\\* escaped \\` backtick'
]

test('normalizeLanguage maps every documented alias, and unknown hints to text', () => {
  const table = {
    js: 'js',
    jsx: 'js',
    mjs: 'js',
    cjs: 'js',
    javascript: 'js',
    node: 'js',
    ts: 'ts',
    tsx: 'ts',
    typescript: 'ts',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    shell: 'bash',
    console: 'bash',
    py: 'python',
    python3: 'python',
    yml: 'yaml',
    html: 'html',
    xml: 'html',
    svg: 'html',
    rs: 'rust',
    golang: 'go',
    md: 'markdown',
    markdown: 'markdown',
    patch: 'diff',
    udiff: 'diff',
    jsonc: 'json',
    text: 'text',
    txt: 'text',
    plain: 'text'
  }
  for (const [hint, expected] of Object.entries(table)) {
    assert.equal(normalizeLanguage(hint), expected, `alias ${hint}`)
  }
  assert.equal(normalizeLanguage(''), 'text')
  assert.equal(normalizeLanguage('   '), 'text')
  assert.equal(normalizeLanguage(undefined), 'text')
  assert.equal(normalizeLanguage(null), 'text')
  assert.equal(normalizeLanguage(42), 'text')
  assert.equal(normalizeLanguage({}), 'text')
  assert.equal(normalizeLanguage('brainfuck'), 'text')
  assert.equal(normalizeLanguage('JS'), 'js')
  assert.equal(normalizeLanguage('  TypeScript  '), 'ts')
  // A fence info string may carry extra words; the language is the first token.
  assert.equal(normalizeLanguage('js title="demo"'), 'js')
})

test('SUPPORTED_LANGUAGES lists every required language plus text', () => {
  assert.ok(Array.isArray(SUPPORTED_LANGUAGES))
  for (const required of [
    'js',
    'ts',
    'json',
    'bash',
    'python',
    'diff',
    'css',
    'html',
    'sql',
    'go',
    'rust',
    'yaml',
    'markdown',
    'text'
  ]) {
    assert.ok(SUPPORTED_LANGUAGES.includes(required), `missing ${required}`)
  }
})

test('highlightLine preserves every character for every language', () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    for (const input of NASTY_LINES) {
      const segments = highlightLine(input, lang, syn)
      assert.equal(textOf(segments), sanitize(input), `${lang}: ${JSON.stringify(input.slice(0, 60))}`)
      for (const segment of segments) {
        assert.equal(typeof segment.text, 'string')
        assert.notEqual(segment.text.length, 0)
      }
    }
  }
})

test('highlightLine tolerates a missing palette and a disabled (empty-string) palette', () => {
  const disabled = Object.fromEntries(Object.keys(syn).map((key) => [key, '']))
  for (const palette of [undefined, null, {}, disabled]) {
    const segments = highlightLine('const x = "a" // c', 'js', palette)
    assert.equal(textOf(segments), 'const x = "a" // c')
    for (const segment of segments) {
      assert.ok(segment.sgr === undefined || typeof segment.sgr === 'string')
    }
  }
})

test('highlightCode preserves text across lines and carries block-comment state', () => {
  const code = '/* start\nstill comment\nend */ const x = 1\n// tail'
  const segments = highlightCode(code, 'js', syn)
  assert.equal(textOf(segments), sanitize(code))
  const comments = styled(segments, syn.comment)
  assert.ok(comments.includes('/* start'))
  assert.ok(comments.includes('still comment'))
  assert.ok(comments.includes('end */'))
  assert.ok(comments.includes('// tail'))
  assert.ok(!comments.includes('const x = 1'))
  assert.ok(styled(segments, syn.keyword).includes('const'))
})

test('highlightCode carries Python triple-quote state and survives blank lines', () => {
  const code = '"""\nmulti\nline\n"""\ny = 2'
  const segments = highlightCode(code, 'python', syn)
  assert.equal(textOf(segments), code)
  assert.ok(styled(segments, syn.string).includes('multi'))
  assert.ok(styled(segments, syn.number).includes('2'))
  assert.equal(textOf(highlightCode('a\n\nb', 'js', syn)), 'a\n\nb')
  assert.deepEqual(highlightCode('', 'js', syn), [])
})

test('diff colours whole lines by their prefix', () => {
  const cases = [
    ['+added', syn.added],
    ['+++ b/file.js', syn.added],
    ['-removed', syn.removed],
    ['--- a/file.js', syn.removed],
    ['@@ -1,3 +1,4 @@', syn.meta],
    ['diff --git a/x b/x', syn.meta]
  ]
  for (const [line, sgr] of cases) {
    const segments = highlightLine(line, 'diff', syn)
    assert.equal(textOf(segments), line)
    assert.ok(segments.some((segment) => segment.sgr === sgr), line)
  }
  const context = highlightLine(' unchanged context', 'diff', syn)
  assert.equal(textOf(context), ' unchanged context')
  assert.ok(!context.some((segment) => segment.sgr === syn.added || segment.sgr === syn.removed))
})

test('text and unknown languages return one unstyled segment and never throw', () => {
  assert.deepEqual(highlightLine('hello 推理 🎉', 'text', syn), [{ text: 'hello 推理 🎉' }])
  assert.deepEqual(highlightLine('hello', 'not-a-language', syn), [{ text: 'hello' }])
  for (const input of [null, undefined, 0, {}, []]) {
    assert.doesNotThrow(() => highlightLine(input, 'js', syn))
  }
  assert.equal(textOf(highlightLine('hello', 'nope', syn)), 'hello')
})

test('common tokens are classified per language', () => {
  const js = highlightLine('const n = 0xFF + 1_000; foo(bar.baz) // note', 'js', syn)
  assert.ok(styled(js, syn.keyword).includes('const'))
  assert.ok(styled(js, syn.number).includes('0xFF'))
  assert.ok(styled(js, syn.number).includes('1_000'))
  assert.ok(styled(js, syn.function).includes('foo'))
  assert.ok(styled(js, syn.property).includes('baz'))
  assert.ok(styled(js, syn.comment).includes('// note'))

  const strings = highlightLine('const s = "hi" + \'bye\' + `tpl`', 'js', syn)
  assert.ok(styled(strings, syn.string).includes('"hi"'))
  assert.ok(styled(strings, syn.string).includes("'bye'"))
  assert.ok(styled(strings, syn.string).includes('`tpl`'))

  const ts = highlightLine('interface X { readonly a: string }', 'ts', syn)
  assert.ok(styled(ts, syn.keyword).includes('interface'))
  assert.ok(styled(ts, syn.type).includes('string'))

  const json = highlightLine('{"key": [true, null, 3]}', 'json', syn)
  assert.ok(styled(json, syn.property).includes('"key"'))
  assert.ok(styled(json, syn.keyword).includes('true'))
  assert.ok(styled(json, syn.number).includes('3'))

  const html = highlightLine('<a href="x" data-y>\'t\'</a>', 'html', syn)
  assert.ok(styled(html, syn.tag).includes('a'))
  assert.ok(styled(html, syn.attribute).includes('href'))
  assert.ok(styled(html, syn.string).includes('"x"'))
  const htmlComment = highlightLine('<!-- note --> <b>', 'html', syn)
  assert.ok(styled(htmlComment, syn.comment).includes('<!-- note -->'))
  assert.ok(styled(htmlComment, syn.tag).includes('b'))

  const bash = highlightLine('echo $HOME $1 -n --long ${VAR} $? | grep x', 'bash', syn)
  assert.ok(styled(bash, syn.variable).includes('$HOME'))
  assert.ok(styled(bash, syn.variable).includes('$1'))
  assert.ok(styled(bash, syn.variable).includes('${VAR}'))
  assert.ok(styled(bash, syn.variable).includes('$?'))
  assert.ok(styled(bash, syn.attribute).includes('-n'))
  assert.ok(styled(bash, syn.attribute).includes('--long'))
  assert.ok(styled(bash, syn.function).includes('grep'))

  const python = highlightLine('@decorator', 'python', syn)
  assert.ok(styled(python, syn.meta).includes('@decorator'))
  const self = highlightLine('self.value = 3  # note', 'python', syn)
  assert.ok(styled(self, syn.variable).includes('self'))
  assert.ok(styled(self, syn.property).includes('value'))
  assert.ok(styled(self, syn.comment).includes('# note'))
  assert.ok(styled(self, syn.number).includes('3'))

  const rust = highlightLine("fn f<'a>(x: &'a str) -> u8 { println!(\"{}\", x); 0 }", 'rust', syn)
  assert.ok(styled(rust, syn.keyword).includes('fn'))
  assert.ok(styled(rust, syn.type).includes("'a"))
  assert.ok(styled(rust, syn.type).includes('str'))
  assert.ok(styled(rust, syn.function).includes('println'))

  const css = highlightLine('@media (min-width: 10px) { .a { color: #fff; margin: 0 auto; } }', 'css', syn)
  assert.ok(styled(css, syn.meta).includes('@media'))
  assert.ok(styled(css, syn.property).includes('color'))
  assert.ok(styled(css, syn.number).includes('#fff'))

  const yaml = highlightLine('key: value # comment', 'yaml', syn)
  assert.ok(styled(yaml, syn.property).includes('key'))
  assert.ok(styled(yaml, syn.comment).includes('# comment'))
  const yamlDoc = highlightLine('---', 'yaml', syn)
  assert.ok(styled(yamlDoc, syn.meta).includes('---'))

  const sql = highlightLine('SELECT id FROM users WHERE name = \'x\' -- note', 'sql', syn)
  assert.ok(styled(sql, syn.keyword).includes('SELECT'))
  assert.ok(styled(sql, syn.keyword).includes('FROM'))
  assert.ok(styled(sql, syn.string).includes("'x'"))
  assert.ok(styled(sql, syn.comment).includes('-- note'))

  const go = highlightLine('func main() { var x int = 1 }', 'go', syn)
  assert.ok(styled(go, syn.keyword).includes('func'))
  assert.ok(styled(go, syn.function).includes('main'))
  assert.ok(styled(go, syn.type).includes('int'))

  const markdown = highlightLine('# Title', 'markdown', syn)
  assert.ok(styled(markdown, syn.keyword).includes('#'))
})

test('a 2000-character line tokenizes well under 50ms in every language', () => {
  const line =
    'const value = "a string with some words" + 12345 + 0xFF; // trailing comment ' .repeat(30)
  assert.ok(line.length >= 2000)
  // Warm up the JIT so the measurement reflects the scanner, not startup.
  for (const lang of SUPPORTED_LANGUAGES) highlightLine(line, lang, syn)
  for (const lang of SUPPORTED_LANGUAGES) {
    const start = process.hrtime.bigint()
    highlightLine(line, lang, syn)
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    assert.ok(ms < 50, `${lang} took ${ms.toFixed(2)}ms`)
  }
})
