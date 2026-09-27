/**
 * Markdown rendering: the width contract and the streaming (unterminated
 * fence) contract. Every produced row must fit the requested cell budget, no
 * matter how adversarial the input.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMarkdown } from '../src/cli/markdown.js'
import { sanitize } from '../src/cli/width.js'
import { rowWidth } from '../src/cli/width.js'

const md = {
  heading: '1;38;5;45',
  heading2: '38;5;45',
  bold: '1',
  italic: '3',
  strike: '9',
  link: '4;38;5;39',
  inlineCode: '38;5;180',
  bullet: '38;5;39',
  quote: '38;5;245',
  rule: '38;5;238',
  code: '38;5;252',
  fenceBorder: '38;5;238',
  fenceLang: '38;5;245',
  more: '38;5;245'
}

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

const WIDTHS = [8, 20, 40, 79, 80, 120]

/** Plain text of one row. */
function rowText(row) {
  return row.map((segment) => segment.text).join('')
}

/** Plain text of every row. */
function documentText(rows) {
  return rows.map(rowText).join('\n')
}

/** Every style appearing anywhere in the rows. */
function stylesOf(rows) {
  return new Set(rows.flat().map((segment) => segment.sgr).filter(Boolean))
}

const DOCUMENTS = {
  headings: '# Title\n## Subtitle\n### Third\n#### Fourth\n##### Fifth\n###### Sixth',
  paragraph:
    'A paragraph that is long enough to wrap over several rows at narrow widths and keeps going for a while.\nSecond source line of the same paragraph.',
  lists:
    '- one\n- two with a much longer line that wraps across the available width nicely\n  - nested item\n  - nested two\n- three\n\n1. first\n2. second with trailing text that is long\n3. third',
  quotes:
    '> a quoted line that is long enough to wrap over several rows in a narrow terminal\n> second quoted line\n\n> > nested quote\n> plain continuation',
  table:
    '| Name | Age | City |\n| :--- | ---: | :---: |\n| Alice | 30 | 北京 |\n| Bob | 4 | 🎉 |\n| A very long cell value that will need shrinking | 100 | somewhere |',
  narrowTable: '| a | b | c | d | e | f |\n| - | - | - | - | - | - |\n| 1 | 2 | 3 | 4 | 5 | 6 |',
  fences:
    '```js\nconst x = 1 // hi\nfunction f() { return `tpl ${x}` }\n```\n\n~~~python\ndef g(self):\n    return "unterminated\n~~~\n\n```\nplain text line that is quite long and will need to wrap under the gutter\n```',
  indented:
    'intro\n\n    indented code line that is long enough to wrap with a continuation indent\n    second line\n\nafter',
  inline:
    'This is **bold** and *italic* and `code` and ~~strike~~ and [link](https://example.com/a/very/long/path?q=1) plus https://bare.example/x and <https://auto.example/y>.',
  cjk: '推理中推理中推理中推理中推理中推理中推理中推理中推理中推理中推理中推理中推理中推理中推理中',
  cjkHeading: '# 中文标题与 emoji 🎉 混排',
  rules: '---\n***\n___\n- - -',
  streaming: 'Here is some code:\n```js\nconst y = 2\nfunction g() {\n  return y\n',
  streamingTilde: 'text\n~~~\nunterminated tilde fence\n',
  adversarial:
    'a\u001b[31mred\u001b[0m b\u0007c \\*not italic\\* | | |\n`unclosed code\n[unclosed(https://x\n<not a tag\n' +
    'x'.repeat(300),
  longToken: '```\n' + 'y'.repeat(200) + '\n```',
  mixed: [
    '# Heading with [link](https://x.y) and `code`',
    '',
    '> quote **bold** 中文',
    '',
    '- item `a` **b**',
    '  - nested 推理',
    '',
    '| h1 | h2 |',
    '| -- | -- |',
    '| c1 | c2 |',
    '',
    '```rust',
    "fn f<'a>(x: &'a str) -> u8 { println!(\"{}\", x); 0 }",
    '```',
    '',
    '---',
    '',
    'final https://example.com'
  ].join('\n')
}

test('every row fits every width for the whole document battery', () => {
  for (const width of WIDTHS) {
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const rows = renderMarkdown(document, { width, md, syn })
      for (const row of rows) {
        const measured = rowWidth(row)
        assert.ok(
          measured <= width,
          `${name} @ ${width}: row width ${measured} for ${JSON.stringify(rowText(row))}`
        )
      }
    }
  }
})

test('every row fits every width with adversarial escapes, CJK and emoji', () => {
  const adversarial = [
    '推理中'.repeat(40) + ' 🎉🚀 ' + 'x'.repeat(200),
    '**' + '中文'.repeat(50) + '**',
    '# ' + '推理'.repeat(60),
    '> ' + '🎉'.repeat(80),
    '- ' + '推理🎉'.repeat(60),
    '```js\n' + 'const x = "🎉"; // ' + '中'.repeat(120) + '\n```',
    '| ' + '中'.repeat(60) + ' | b |\n| - | - |\n| c | d |',
    '\u001b[2J\u001b[31m' + 'x'.repeat(100) + '\u001b[0m',
    '[' + 'text'.repeat(50) + '](https://example.com/' + 'p'.repeat(200) + ')',
    '`' + 'c'.repeat(300),
    '\\*'.repeat(200)
  ]
  for (const width of WIDTHS) {
    for (const document of adversarial) {
      const rows = renderMarkdown(document, { width, md, syn })
      for (const row of rows) {
        assert.ok(rowWidth(row) <= width, `width ${width}: ${JSON.stringify(rowText(row))}`)
      }
    }
  }
})

test('an unterminated fence at end of input renders as code, not literal backticks', () => {
  const rows = renderMarkdown(DOCUMENTS.streaming, { width: 40, md, syn })
  const text = documentText(rows)
  assert.ok(text.includes('const y = 2'), text)
  assert.ok(text.includes('return y'), text)
  assert.ok(!text.includes('```'), text)
  // The fence gutter and the info-string header are present.
  assert.ok(text.includes('│'), text)
  assert.ok(rows.flat().some((segment) => segment.sgr === md.fenceBorder))
  assert.ok(rows.flat().some((segment) => segment.sgr === md.fenceLang))
})

test('a tilde fence left open also renders as code', () => {
  const rows = renderMarkdown(DOCUMENTS.streamingTilde, { width: 30, md, syn })
  const text = documentText(rows)
  assert.ok(text.includes('unterminated tilde fence'), text)
  assert.ok(!text.includes('~~~'), text)
})

test('inline styles render the expected text and carry the expected SGR strings', () => {
  const rows = renderMarkdown(
    '**bold** *italic* `code` ~~strike~~ [text](https://example.com) \\*literal\\*',
    { width: 120, md, syn }
  )
  const text = documentText(rows)
  assert.ok(text.includes('bold'))
  assert.ok(text.includes('italic'))
  assert.ok(text.includes('code'))
  assert.ok(text.includes('strike'))
  assert.ok(text.includes('*literal*'))
  assert.ok(!text.includes('**'))
  assert.ok(!text.includes('~~'))

  const styles = stylesOf(rows)
  assert.ok(styles.has(md.bold), 'bold style')
  assert.ok(styles.has(md.italic), 'italic style')
  assert.ok(styles.has(md.inlineCode), 'inline code style')
  assert.ok(styles.has(md.strike), 'strike style')
  assert.ok(styles.has(md.link), 'link style')
})

test('headings drop the marker hash and use the right palette key per level', () => {
  const rows = renderMarkdown('# One\n\n### Three', { width: 40, md, syn })
  const text = documentText(rows)
  assert.ok(text.includes('One'))
  assert.ok(text.includes('Three'))
  assert.ok(!text.includes('#'))
  const styles = stylesOf(rows)
  assert.ok(styles.has(md.heading), 'h1 uses md.heading')
  assert.ok(styles.has(md.heading2), 'h3 uses md.heading2')
})

test('quotes, bullets and rules use their palette keys', () => {
  const rows = renderMarkdown('> quoted\n\n- bullet\n\n---', { width: 40, md, syn })
  const styles = stylesOf(rows)
  assert.ok(styles.has(md.quote), 'quote gutter')
  assert.ok(styles.has(md.bullet), 'bullet marker')
  assert.ok(styles.has(md.rule), 'rule')
  const text = documentText(rows)
  assert.ok(text.includes('│ '), 'quote gutter glyph')
  assert.ok(text.includes('─'), 'rule glyph')
})

test('GFM tables render aligned columns with pipes and stay within width', () => {
  const document = '| Name | Age |\n| :--- | ---: |\n| Alice | 30 |\n| Bob | 7 |'
  const rows = renderMarkdown(document, { width: 40, md, syn })
  assert.equal(rows.length, 3)
  for (const row of rows) {
    const text = rowText(row)
    assert.ok(text.startsWith('│ '), text)
    assert.ok(text.trimEnd().endsWith('│'), text)
    assert.equal(rowWidth(row), text.trimEnd().length, text)
  }
  const text = documentText(rows)
  assert.ok(text.includes('Name'))
  assert.ok(text.includes('Alice'))
  assert.ok(text.includes('30'))
})

test('long code lines wrap under a two-space continuation indent without truncation', () => {
  const token = 'y'.repeat(200)
  const rows = renderMarkdown('```\n' + token + '\n```', { width: 40, md, syn })
  assert.ok(rows.length > 1)
  const rebuilt = rows.map(rowText).join('').replace(/[│ ]/g, '')
  assert.ok(rebuilt.includes(token), rebuilt)
  for (const row of rows) assert.ok(rowWidth(row) <= 40)
})

test('maxLines cuts the output and appends a styled "more lines" row', () => {
  const document = Array.from({ length: 20 }, (_, index) => `Paragraph number ${index}`).join('\n\n')
  const full = renderMarkdown(document, { width: 40, md, syn })
  assert.ok(full.length > 5)

  const rows = renderMarkdown(document, { width: 40, md, syn, maxLines: 5 })
  assert.equal(rows.length, 5)
  const last = rowText(rows[rows.length - 1])
  assert.ok(last.includes('…'), last)
  assert.ok(last.includes('more lines'), last)
  assert.ok(rows.flat().some((segment) => segment.sgr === md.more))
  for (const row of rows) assert.ok(rowWidth(row) <= 40)

  // A cap that is not exceeded leaves the document untouched.
  assert.deepEqual(renderMarkdown('one line', { width: 40, md, syn, maxLines: 10 }), renderMarkdown('one line', { width: 40, md, syn }))
  // A zero cap yields nothing.
  assert.deepEqual(renderMarkdown('one line', { width: 40, md, syn, maxLines: 0 }), [])
  // The "more" row itself is truncated to the width.
  for (const width of WIDTHS) {
    const capped = renderMarkdown(document, { width, md, syn, maxLines: 2 })
    for (const row of capped) assert.ok(rowWidth(row) <= width)
  }
})

test('empty and whitespace-only input return no rows', () => {
  assert.deepEqual(renderMarkdown('', { width: 40, md, syn }), [])
  assert.deepEqual(renderMarkdown('   \n\t\n  ', { width: 40, md, syn }), [])
  assert.deepEqual(renderMarkdown(null, { width: 40, md, syn }), [])
  assert.deepEqual(renderMarkdown(undefined, { width: 40, md, syn }), [])
})

test('missing options and missing palettes never throw and still bound width', () => {
  const rows = renderMarkdown('# Title\n\nbody text', { width: 20 })
  for (const row of rows) assert.ok(rowWidth(row) <= 20)
  const ansi = renderMarkdown('body \u001b[31mred\u001b[0m', { width: 80 })
  assert.ok(documentText(ansi).includes('body red'))
  // A disabled palette (all empty strings) still renders text.
  const disabled = Object.fromEntries(Object.keys(md).map((key) => [key, '']))
  const plain = renderMarkdown('# Hi\n\n**bold** text', { width: 40, md: disabled, syn: disabled })
  assert.ok(documentText(plain).includes('Hi'))
  assert.ok(documentText(plain).includes('bold'))
  assert.ok(plain.flat().every((segment) => segment.sgr === undefined))
})

test('malformed input never throws', () => {
  const malformed = [
    '|',
    '|||',
    '| a |\n| - ',
    '[unclosed',
    '[label](',
    '[label](url',
    '`unclosed',
    '``',
    '**',
    '***',
    '*_~`',
    '> > > > >',
    '- - - - -',
    '1. 2. 3.',
    '```',
    '~~~js',
    '<',
    '<>',
    '\\',
    '######',
    '#'.repeat(100),
    '-'.repeat(100),
    '\u001b[31m',
    '\u0000\u0001\u0002',
    'a'.repeat(5000)
  ]
  for (const document of malformed) {
    for (const width of WIDTHS) {
      let rows
      assert.doesNotThrow(() => {
        rows = renderMarkdown(document, { width, md, syn })
      }, `${JSON.stringify(document.slice(0, 30))} @ ${width}`)
      for (const row of rows) assert.ok(rowWidth(row) <= width)
    }
  }
  for (const value of [0, 42, {}, [], true, Symbol('x')]) {
    assert.doesNotThrow(() => renderMarkdown(value, { width: 20, md, syn }))
  }
})

test('incoming ANSI escapes and control characters are sanitized away', () => {
  const rows = renderMarkdown('> \u001b[31mquoted\u001b[0m\n\n- \u001b]0;t\u0007item', { width: 40, md, syn })
  const text = documentText(rows)
  assert.ok(text.includes('quoted'))
  assert.ok(text.includes('item'))
  assert.equal(text.includes('\u001b'), false)
  for (const row of rows) assert.equal(rowText(row), sanitize(rowText(row)))
})
