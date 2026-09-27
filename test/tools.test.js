/**
 * Structured tool facts: shell command extraction, exit-status parsing, diff
 * narrowing, and output capping.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  capOutput,
  countDiffLines,
  diffLines,
  diffOperationFrom,
  filePathFrom,
  isShellTool,
  narrowFileDiffs,
  parseArguments,
  parseExitStatus,
  shellCallFrom,
  writeCallFrom
} from '../lib/tools.js'

test('shell tools are recognized by name and by namespaced suffix', () => {
  for (const name of ['bash', 'BASH', 'pwsh', 'sh', 'zsh', 'shell', 'terminal', 'local:bash', 'x/y/pwsh']) {
    assert.equal(isShellTool(name), true, name)
  }
  for (const name of ['read_file', 'write', 'edit', 'str_replace_editor', 'grep', '', undefined, 42]) {
    assert.equal(isShellTool(name), false, String(name))
  }
})

test('parseExitStatus mirrors the marker contract', () => {
  assert.deepEqual(parseExitStatus('out\n[exit code: 1]'), { body: 'out', exitCode: 1 })
  assert.deepEqual(parseExitStatus('out\n[killed by signal: SIGKILL]'), { body: 'out', signal: 'SIGKILL' })
  assert.deepEqual(parseExitStatus('out'), { body: 'out', exitCode: 0 })
  assert.deepEqual(parseExitStatus(''), { body: '', exitCode: 0 })
  // Ordinary output that merely mentions a marker is left alone.
  assert.deepEqual(parseExitStatus('[exit code: 1] out'), { body: '[exit code: 1] out', exitCode: 0 })
  // A signal wins over an exit code when both somehow appear.
  assert.deepEqual(parseExitStatus('x\n[exit code: 3]\n[killed by signal: TERM]'), {
    body: 'x\n[exit code: 3]',
    signal: 'TERM'
  })
})

test('parseArguments is total', () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 })
  assert.deepEqual(parseArguments({ a: 1 }), { a: 1 })
  assert.equal(parseArguments('not json'), undefined)
  assert.equal(parseArguments('[1,2]'), undefined)
  assert.equal(parseArguments('null'), undefined)
  assert.equal(parseArguments(undefined), undefined)
  assert.equal(parseArguments(''), undefined)
})

test('shellCallFrom extracts command, description, and cwd', () => {
  assert.deepEqual(shellCallFrom('bash', '{"command":"npm test","description":"Run tests","cwd":"/w"}'), {
    command: 'npm test',
    description: 'Run tests',
    cwd: '/w'
  })
  assert.deepEqual(shellCallFrom('bash', '{"command":"ls"}'), { command: 'ls' })
  assert.equal(shellCallFrom('read_file', '{"command":"ls"}'), undefined, 'not a shell tool')
  assert.equal(shellCallFrom('bash', '{"description":"no command"}'), undefined)
  assert.equal(shellCallFrom('bash', 'broken'), undefined)
})

test('filePathFrom reads whichever key the tool used', () => {
  assert.equal(filePathFrom('{"file_path":"a.ts"}'), 'a.ts')
  assert.equal(filePathFrom('{"path":"b.ts"}'), 'b.ts')
  assert.equal(filePathFrom('{"filePath":"c.ts"}'), 'c.ts')
  assert.equal(filePathFrom('{"command":"ls"}'), undefined)
  assert.equal(filePathFrom('broken'), undefined)
})

test('narrowFileDiffs accepts the documented shape and rejects everything else', () => {
  const good = narrowFileDiffs({ diffs: [{ path: 'a.ts', oldText: 'x', newText: 'y' }] })
  assert.deepEqual(good, [{ path: 'a.ts', oldText: 'x', newText: 'y' }])
  assert.deepEqual(narrowFileDiffs({ diffs: [{ path: 'n.ts', oldText: null, newText: 'y' }] }), [
    { path: 'n.ts', oldText: null, newText: 'y' }
  ])

  assert.equal(narrowFileDiffs(undefined), undefined)
  assert.equal(narrowFileDiffs({}), undefined)
  assert.equal(narrowFileDiffs({ diffs: [] }), undefined)
  assert.equal(narrowFileDiffs({ diffs: 'nope' }), undefined)
  assert.equal(narrowFileDiffs({ diffs: [{ path: 42, newText: 'y' }] }), undefined)
  assert.equal(narrowFileDiffs({ diffs: [{ path: 'a', newText: 7 }] }), undefined)
  assert.equal(narrowFileDiffs({ diffs: [{ path: 'a', oldText: 5, newText: 'y' }] }), undefined)
  // A single malformed hunk does not discard its valid siblings.
  assert.deepEqual(narrowFileDiffs({ diffs: [{ path: 'bad' }, { path: 'ok', oldText: null, newText: 'z' }] }), [
    { path: 'ok', oldText: null, newText: 'z' }
  ])
})

test('diffOperationFrom only accepts the two known operations', () => {
  assert.equal(diffOperationFrom({ operation: 'create' }), 'create')
  assert.equal(diffOperationFrom({ operation: 'update' }), 'update')
  assert.equal(diffOperationFrom({ operation: 'other' }), undefined)
  assert.equal(diffOperationFrom(null), undefined)
})

test('countDiffLines counts added and removed lines', () => {
  assert.deepEqual(countDiffLines([{ oldText: null, newText: 'a\nb' }]), { added: 2, removed: 0 })
  assert.deepEqual(countDiffLines([{ oldText: 'a', newText: 'b' }]), { added: 1, removed: 1 })
  assert.deepEqual(countDiffLines([{ oldText: '', newText: '' }]), { added: 0, removed: 0 })
  assert.deepEqual(
    countDiffLines([
      { oldText: 'a\nb', newText: 'a\nc\nd' },
      { oldText: null, newText: 'e' }
    ]),
    { added: 4, removed: 2 }
  )
})

test('diffLines renders unified-diff display lines', () => {
  const lines = diffLines([
    { path: 'a.ts', oldText: 'old', newText: 'new' },
    { path: 'a.ts', oldText: null, newText: 'added' }
  ])
  assert.deepEqual(lines[0], { kind: 'hunk', text: '@@ a.ts' })
  assert.deepEqual(lines[1], { kind: 'del', text: 'old' })
  assert.deepEqual(lines[2], { kind: 'add', text: 'new' })
  assert.deepEqual(lines[3], { kind: 'gap', text: '⋮' })
  assert.deepEqual(lines[4], { kind: 'hunk', text: '@@ a.ts (new file)' })
  assert.deepEqual(lines[5], { kind: 'add', text: 'added' })
})

test('capOutput keeps the tail and reports what it dropped', () => {
  const body = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n')
  const capped = capOutput(body, { maxLines: 10 })
  assert.equal(capped.lines, 10)
  assert.equal(capped.truncated, true)
  assert.equal(capped.omitted, 40)
  assert.match(capped.text, /^line 40/)
  assert.match(capped.text, /line 49$/)

  const short = capOutput('a\nb', { maxLines: 10 })
  assert.deepEqual(short, { text: 'a\nb', lines: 2, truncated: false, omitted: 0 })

  assert.deepEqual(capOutput(''), { text: '', lines: 0, truncated: false, omitted: 0 })
  assert.deepEqual(capOutput(null), { text: '', lines: 0, truncated: false, omitted: 0 })

  const byChars = capOutput(`head\n${'x'.repeat(500)}`, { maxLines: 100, maxChars: 50 })
  assert.equal(byChars.text.length, 50)
  assert.equal(byChars.truncated, true)
  assert.ok(byChars.omitted >= 1)
})

test('writeCallFrom recovers the applied content a create cannot diff', () => {
  const args = JSON.stringify({ file_path: 'src/new.ts', content: 'export const a = 1\nexport const b = 2' })
  assert.deepEqual(writeCallFrom(args, 'src/new.ts'), {
    filePath: 'src/new.ts',
    content: 'export const a = 1\nexport const b = 2'
  })
  // The path can come from the call's own argument or from the entry.
  assert.equal(writeCallFrom(args).filePath, 'src/new.ts')
  assert.equal(writeCallFrom(JSON.stringify({ content: 'x' }), undefined), undefined)
  assert.equal(writeCallFrom(JSON.stringify({ file_path: 'a.ts' }), 'a.ts'), undefined, 'no content, no whole-file diff')
  assert.equal(writeCallFrom(JSON.stringify({ changed: true }), 'a.ts'), undefined)
  assert.equal(writeCallFrom('broken', 'a.ts'), undefined)
})
