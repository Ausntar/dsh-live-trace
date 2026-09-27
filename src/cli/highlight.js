/**
 * Zero-dependency syntax highlighting for the dashboard's code panes.
 *
 * The highlighter never emits escape sequences: it returns {@link Segment}
 * lists whose `sgr` fields are raw SGR parameter strings handed to
 * `renderRow()` in `width.js`. Every palette value may be the empty string
 * (color disabled), which this module normalizes to "no style".
 *
 * The one hard invariant is *character preservation*: for any input line `l`,
 *
 *     highlightLine(l, lang, syn).map((s) => s.text).join('') === sanitize(l)
 *
 * The scanner achieves this structurally — it walks the sanitized line and
 * emits contiguous slices, so a malformed string, an unterminated comment or a
 * stray control character can never drop or duplicate text. Unknown languages
 * degrade to plain text rather than throwing.
 *
 * @module dsh-live-trace/highlight
 */

import { sanitize } from './width.js'

/**
 * @typedef {{ text: string, sgr?: string }} Segment
 */

/** Shared empty set so every config has a Set to query. */
const EMPTY_SET = new Set()

/** Sticky word regex for C-like identifiers. */
const RE_WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y
/** CSS identifiers may start with one or two dashes and contain dashes. */
const RE_WORD_CSS = /(?:--|-)?[A-Za-z_][A-Za-z0-9_-]*/y
/** Numbers: hex / binary / octal / decimal / fraction / exponent, optional BigInt `n`. */
const RE_NUMBER =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?\d[\d_]*)?)(?:[nN])?/y
/** CSS numbers may carry a unit (`10px`) or a percentage (`50%`). */
const RE_NUMBER_UNITS =
  /(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?\d+)?(?:%|[A-Za-z]+)?/y
/** Bash `-x` / `--long-flag`. */
const RE_DASH_FLAG = /--?[A-Za-z][A-Za-z0-9-]*/y
/** Multi-character operators first, then the single-character operator class. */
const RE_OPERATOR =
  /(?:=>|->|::|\.\.\.|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\*\*|<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|\+\+|--|[-+*/%=<>!&|^~])/y
/** Structural punctuation. */
const RE_PUNCT = /[()[\]{},;.:?]/y
/** YAML/JSON-ish key colon: `key:` followed by whitespace or a flow bracket. */
const RE_STRICT_COLON_TAIL = /^[\s[{,}\]]/
/** CSS hex colour. */
const RE_HEX_COLOR = /^#[0-9a-fA-F]{3,8}/
/** Diff hunk header. */
const RE_HUNK = /^@@/

function set(...items) {
  return new Set(items)
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9'
}

function isWordStart(ch) {
  return typeof ch === 'string' && /[A-Za-z_$]/.test(ch)
}

/**
 * Resolve a palette entry to a style, collapsing `''`/missing/`undefined` to
 * "unstyled" so disabled colors merge cleanly.
 * @param {Record<string, string> | undefined | null} palette
 * @param {string | undefined} key
 * @returns {string | undefined}
 */
function styleOf(palette, key) {
  if (key === undefined || palette === null || palette === undefined) return undefined
  const value = palette[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Append text to a segment list, merging with the previous segment when the
 * style is identical. Unstyled runs are stored without an `sgr` key.
 * @param {Segment[]} out
 * @param {string} text
 * @param {string | undefined} sgr
 */
function pushSegment(out, text, sgr) {
  if (text.length === 0) return
  const style = sgr === '' ? undefined : sgr
  const last = out[out.length - 1]
  if (last !== undefined && last.sgr === style) {
    last.text += text
    return
  }
  if (style === undefined) out.push({ text })
  else out.push({ text, sgr: style })
}

/** Count a run of identical characters starting at `index`. */
function countRun(line, index, ch) {
  let end = index
  while (end < line.length && line[end] === ch) end += 1
  return end - index
}

/** Match a config word at `index`, or `null`. */
function readWord(line, index, cfg) {
  const re = cfg.wordPattern ?? RE_WORD
  re.lastIndex = index
  const match = re.exec(line)
  return match === null ? null : match[0]
}

/** Strict key colon: whitespace or a flow bracket must follow. */
function isStrictKeyColon(line, index) {
  if (line[index] !== ':') return false
  const next = line[index + 1]
  if (next === undefined) return true
  return RE_STRICT_COLON_TAIL.test(next)
}

/** Fill in the shared scanner defaults. */
function makeConfig(partial) {
  return {
    lineComments: [],
    blockComments: [],
    tripleStrings: [],
    strings: [],
    templates: [],
    keywords: EMPTY_SET,
    types: EMPTY_SET,
    literals: EMPTY_SET,
    builtins: EMPTY_SET,
    selfWords: EMPTY_SET,
    globals: EMPTY_SET,
    ...partial
  }
}

/* ------------------------------------------------------------------ *
 * Per-language token sets
 * ------------------------------------------------------------------ */

const JS_KEYWORDS = set(
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'of', 'return', 'set', 'static', 'switch', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield'
)
const JS_TYPES = set(
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'Date', 'Error',
  'EvalError', 'Float32Array', 'Float64Array', 'Function', 'Int8Array',
  'Int16Array', 'Int32Array', 'JSON', 'Map', 'Math', 'Number', 'Object',
  'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set',
  'String', 'Symbol', 'SyntaxError', 'TypeError', 'Uint8Array',
  'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'URIError', 'WeakMap',
  'WeakSet'
)
const JS_LITERALS = set('true', 'false', 'null', 'undefined', 'NaN', 'Infinity')
const JS_BUILTINS = set(
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'require',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'fetch'
)
const JS_GLOBALS = set(
  'console', 'process', 'globalThis', 'window', 'document', 'global', 'module',
  'exports', '__dirname', '__filename', 'Buffer'
)
const JS_CONFIG = makeConfig({
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: ["'", '"'],
  templates: ['`'],
  keywords: JS_KEYWORDS,
  types: JS_TYPES,
  literals: JS_LITERALS,
  builtins: JS_BUILTINS,
  globals: JS_GLOBALS,
  decorators: true
})

const TS_KEYWORDS = new Set([
  ...JS_KEYWORDS,
  'abstract', 'declare', 'enum', 'implements', 'infer', 'interface', 'is',
  'keyof', 'module', 'namespace', 'override', 'private', 'protected', 'public',
  'readonly', 'satisfies', 'type', 'unique', 'using', 'accessor'
])
const TS_TYPES = new Set([
  ...JS_TYPES,
  'any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol',
  'unknown'
])
const TS_CONFIG = makeConfig({ ...JS_CONFIG, keywords: TS_KEYWORDS, types: TS_TYPES })

const JSON_CONFIG = makeConfig({
  strings: ['"'],
  literals: set('true', 'false', 'null'),
  jsonKeys: true
})

const BASH_KEYWORDS = set(
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'select', 'time', 'coproc', 'return',
  'local', 'declare', 'typeset', 'export', 'readonly', 'unset', 'shift', 'exit',
  'break', 'continue', 'eval', 'exec', 'trap', 'set', 'source'
)
const BASH_BUILTINS = set(
  'echo', 'printf', 'read', 'cd', 'pwd', 'ls', 'cat', 'grep', 'sed', 'awk',
  'cut', 'sort', 'uniq', 'head', 'tail', 'wc', 'tr', 'find', 'xargs', 'mkdir',
  'rmdir', 'rm', 'cp', 'mv', 'touch', 'chmod', 'chown', 'ln', 'tar', 'gzip',
  'curl', 'wget', 'git', 'npm', 'pnpm', 'yarn', 'node', 'python', 'python3',
  'pip', 'make', 'docker', 'sudo', 'env', 'which', 'type', 'test', 'true',
  'false', 'kill', 'jobs', 'wait', 'sleep', 'date', 'basename', 'dirname',
  'realpath', 'tee', 'diff', 'patch'
)
const BASH_CONFIG = makeConfig({
  lineComments: ['#'],
  strings: ["'", '"'],
  keywords: BASH_KEYWORDS,
  builtins: BASH_BUILTINS,
  dollarVariables: true,
  dashFlags: true
})

const PYTHON_KEYWORDS = set(
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case'
)
const PYTHON_TYPES = set(
  'int', 'float', 'complex', 'str', 'bytes', 'bytearray', 'bool', 'list',
  'tuple', 'dict', 'set', 'frozenset', 'range', 'object', 'type', 'memoryview'
)
const PYTHON_BUILTINS = set(
  'print', 'len', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min', 'max',
  'abs', 'sorted', 'reversed', 'open', 'input', 'isinstance', 'issubclass',
  'getattr', 'setattr', 'hasattr', 'delattr', 'super', 'next', 'iter', 'any',
  'all', 'repr', 'format', 'id', 'round', 'divmod', 'pow', 'hash', 'callable',
  'vars', 'dir', 'globals', 'locals', 'exec', 'compile', 'staticmethod',
  'classmethod', 'property', 'ord', 'chr', 'hex', 'oct', 'bin'
)
const PYTHON_CONFIG = makeConfig({
  lineComments: ['#'],
  tripleStrings: ['"""', "'''"],
  strings: ["'", '"'],
  keywords: PYTHON_KEYWORDS,
  types: PYTHON_TYPES,
  literals: set('True', 'False', 'None', 'NotImplemented', 'Ellipsis'),
  builtins: PYTHON_BUILTINS,
  selfWords: set('self', 'cls'),
  decorators: true
})

const GO_KEYWORDS = set(
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
  'var'
)
const GO_TYPES = set(
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8',
  'uint16', 'uint32', 'uint64', 'uintptr', 'any', 'comparable'
)
const GO_BUILTINS = set(
  'make', 'len', 'cap', 'new', 'append', 'copy', 'delete', 'panic', 'recover',
  'print', 'println', 'close', 'complex', 'real', 'imag', 'min', 'max', 'clear'
)
const GO_CONFIG = makeConfig({
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: ['"', "'"],
  templates: ['`'],
  keywords: GO_KEYWORDS,
  types: GO_TYPES,
  literals: set('true', 'false', 'nil', 'iota'),
  builtins: GO_BUILTINS
})

const RUST_KEYWORDS = set(
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match',
  'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
  'struct', 'super', 'trait', 'type', 'unsafe', 'use', 'where', 'while', 'union',
  'macro', 'yield', 'try'
)
const RUST_TYPES = set(
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128',
  'usize', 'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option',
  'Result', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'Mutex', 'RwLock',
  'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'Cow', 'Pin', 'PhantomData',
  'Ok', 'Err', 'Some', 'None'
)
const RUST_BUILTINS = set(
  'println', 'print', 'eprintln', 'eprint', 'format', 'vec', 'panic', 'assert',
  'assert_eq', 'assert_ne', 'debug_assert', 'write', 'writeln', 'matches',
  'todo', 'unimplemented', 'unreachable', 'include_str', 'include_bytes', 'env',
  'cfg', 'stringify', 'concat', 'dbg'
)
const RUST_CONFIG = makeConfig({
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: ['"', "'"],
  keywords: RUST_KEYWORDS,
  types: RUST_TYPES,
  literals: set('true', 'false'),
  builtins: RUST_BUILTINS,
  macros: true,
  lifetime: true
})

const SQL_KEYWORDS = set(
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'UPDATE', 'DELETE', 'CREATE',
  'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
  'OUTER', 'FULL', 'CROSS', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN',
  'LIKE', 'BETWEEN', 'EXISTS', 'DISTINCT', 'UNION', 'ALL', 'GROUP', 'BY',
  'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'SET', 'PRIMARY', 'KEY',
  'FOREIGN', 'REFERENCES', 'DEFAULT', 'CASCADE', 'CONSTRAINT', 'UNIQUE', 'CHECK',
  'WITH', 'RETURNING', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
  'USING', 'NATURAL', 'TRUNCATE', 'EXPLAIN', 'ANALYZE', 'VACUUM', 'BEGIN',
  'COMMIT', 'ROLLBACK', 'TRANSACTION', 'GRANT', 'REVOKE', 'IF', 'REPLACE'
)
const SQL_TYPES = set(
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'SERIAL', 'BIGSERIAL',
  'TEXT', 'VARCHAR', 'CHAR', 'BOOLEAN', 'BOOL', 'DATE', 'TIME', 'TIMESTAMP',
  'TIMESTAMPTZ', 'INTERVAL', 'DECIMAL', 'NUMERIC', 'REAL', 'DOUBLE', 'FLOAT',
  'JSON', 'JSONB', 'UUID', 'BLOB', 'BYTEA', 'ARRAY'
)
const SQL_BUILTINS = set(
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'NOW',
  'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'LOWER', 'UPPER', 'LENGTH', 'TRIM',
  'SUBSTRING', 'ROUND', 'ABS', 'CONCAT', 'STRING_AGG', 'ARRAY_AGG',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK'
)
const SQL_CONFIG = makeConfig({
  lineComments: ['--'],
  blockComments: [['/*', '*/']],
  strings: ["'", '"'],
  keywords: SQL_KEYWORDS,
  types: SQL_TYPES,
  literals: set('TRUE', 'FALSE', 'NULL'),
  builtins: SQL_BUILTINS,
  caseInsensitive: true
})

const CSS_CONFIG = makeConfig({
  blockComments: [['/*', '*/']],
  strings: ['"', "'"],
  wordPattern: RE_WORD_CSS,
  keywords: set(
    'important', 'inherit', 'initial', 'unset', 'revert', 'none', 'auto',
    'block', 'inline', 'flex', 'grid', 'absolute', 'relative', 'fixed',
    'sticky', 'transparent', 'currentColor'
  ),
  dashWord: true,
  keyColonLoose: true,
  hashColor: true,
  numberUnits: true,
  decorators: true
})

const YAML_CONFIG = makeConfig({
  lineComments: ['#'],
  strings: ["'", '"'],
  literals: set(
    'true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'Null',
    'NULL', 'TRUE', 'FALSE', 'Yes', 'No', 'On', 'Off', '~'
  ),
  keyColon: true,
  anchorChars: '&*',
  metaAtStart: true,
  tildeLiteral: true
})

/* ------------------------------------------------------------------ *
 * Custom line handlers
 * ------------------------------------------------------------------ */

/**
 * HTML/XML: comments, doctype, tag names, attributes and quoted values.
 * Text outside tags is left unstyled. Never loses a character.
 * @returns {Segment[]}
 */
function htmlLine(line, syn, state) {
  const out = []
  const n = line.length
  let i = 0
  while (i < n) {
    if (state.block) {
      const idx = line.indexOf(state.block, i)
      if (idx === -1) {
        pushSegment(out, line.slice(i), styleOf(syn, 'comment'))
        return out
      }
      pushSegment(out, line.slice(i, idx + state.block.length), styleOf(syn, 'comment'))
      i = idx + state.block.length
      state.block = null
      continue
    }
    if (line.startsWith('<!--', i)) {
      const idx = line.indexOf('-->', i + 4)
      if (idx === -1) {
        state.block = '-->'
        pushSegment(out, line.slice(i), styleOf(syn, 'comment'))
        return out
      }
      pushSegment(out, line.slice(i, idx + 3), styleOf(syn, 'comment'))
      i = idx + 3
      continue
    }
    if (line[i] === '<') {
      if (/^<!doctype/i.test(line.slice(i, i + 9)) || line.startsWith('<!', i) || line.startsWith('<?', i)) {
        const idx = line.indexOf('>', i)
        const end = idx === -1 ? n : idx + 1
        pushSegment(out, line.slice(i, end), styleOf(syn, 'meta'))
        i = end
        continue
      }
      const idx = line.indexOf('>', i)
      const end = idx === -1 ? n : idx + 1
      highlightTag(line.slice(i, end), out, syn)
      i = end
      continue
    }
    const next = line.indexOf('<', i)
    const end = next === -1 ? n : next
    pushSegment(out, line.slice(i, end))
    i = end
  }
  return out
}

/** Tokenize the inside of a single `<...>` tag. */
function highlightTag(text, out, syn) {
  const n = text.length
  let i = 0
  if (text.startsWith('</')) {
    pushSegment(out, '</', styleOf(syn, 'tag'))
    i = 2
  } else if (text.startsWith('<')) {
    pushSegment(out, '<', styleOf(syn, 'tag'))
    i = 1
  }
  let j = i
  while (j < n && /[A-Za-z0-9:_.-]/.test(text[j])) j += 1
  if (j > i) {
    pushSegment(out, text.slice(i, j), styleOf(syn, 'tag'))
    i = j
  }
  while (i < n) {
    const ch = text[i]
    if (ch === '>' || ch === '/') {
      pushSegment(out, ch, styleOf(syn, 'tag'))
      i += 1
      continue
    }
    if (ch === '=') {
      pushSegment(out, '=', styleOf(syn, 'operator'))
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      let end = i + 1
      while (end < n && text[end] !== ch) end += 1
      if (end < n) end += 1
      pushSegment(out, text.slice(i, end), styleOf(syn, 'string'))
      i = end
      continue
    }
    if (/\s/.test(ch)) {
      let end = i
      while (end < n && /\s/.test(text[end])) end += 1
      pushSegment(out, text.slice(i, end))
      i = end
      continue
    }
    let end = i
    while (end < n && /[A-Za-z0-9_:.@[\]-]/.test(text[end])) end += 1
    if (end === i) end = i + 1
    pushSegment(out, text.slice(i, end), styleOf(syn, 'attribute'))
    i = end
  }
}

/**
 * Markdown source highlighting: fences, headings, quotes, inline code, emphasis
 * and links. Purely cosmetic — the block renderer lives in `markdown.js`.
 * @returns {Segment[]}
 */
function markdownLine(line, syn) {
  const out = []
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
  if (fence) {
    pushSegment(out, line, styleOf(syn, 'meta'))
    return out
  }
  const heading = /^(#{1,6})(\s.*)?$/.exec(line)
  if (heading) {
    pushSegment(out, heading[1], styleOf(syn, 'keyword'))
    if (heading[2] !== undefined) pushSegment(out, heading[2], styleOf(syn, 'type'))
    return out
  }
  const n = line.length
  let i = 0
  while (i < n) {
    const ch = line[i]
    if (ch === '`') {
      const run = countRun(line, i, '`')
      const close = line.indexOf('`'.repeat(run), i + run)
      if (close === -1) {
        pushSegment(out, line.slice(i), styleOf(syn, 'string'))
        i = n
        continue
      }
      pushSegment(out, line.slice(i, i + run), styleOf(syn, 'punctuation'))
      pushSegment(out, line.slice(i + run, close), styleOf(syn, 'string'))
      pushSegment(out, line.slice(close, close + run), styleOf(syn, 'punctuation'))
      i = close + run
      continue
    }
    if (line.startsWith('**', i) || line.startsWith('__', i) || line.startsWith('~~', i)) {
      pushSegment(out, line.slice(i, i + 2), styleOf(syn, 'keyword'))
      i += 2
      continue
    }
    if (ch === '*' || ch === '_' || ch === '>') {
      pushSegment(out, ch, styleOf(syn, 'keyword'))
      i += 1
      continue
    }
    if (ch === '[') {
      const close = line.indexOf(']', i + 1)
      const open = close === -1 ? -1 : line.indexOf('(', close + 1)
      if (close !== -1 && open === close + 1) {
        const end = line.indexOf(')', open + 1)
        if (end !== -1) {
          pushSegment(out, line.slice(i, close + 1), styleOf(syn, 'function'))
          pushSegment(out, line.slice(close + 1, end + 1), styleOf(syn, 'string'))
          i = end + 1
          continue
        }
      }
    }
    let end = i
    while (end < n && !'`*_~[]>#-'.includes(line[end])) end += 1
    if (end === i) end = i + 1
    pushSegment(out, line.slice(i, end))
    i = end
  }
  return out
}

/**
 * Diff: whole-line colouring so additions and removals read at a glance.
 * @returns {Segment[]}
 */
function diffLine(line, syn) {
  const out = []
  if (RE_HUNK.test(line)) pushSegment(out, line, styleOf(syn, 'meta'))
  else if (line.startsWith('+++')) pushSegment(out, line, styleOf(syn, 'added'))
  else if (line.startsWith('---')) pushSegment(out, line, styleOf(syn, 'removed'))
  else if (line.startsWith('+')) pushSegment(out, line, styleOf(syn, 'added'))
  else if (line.startsWith('-')) pushSegment(out, line, styleOf(syn, 'removed'))
  else if (/^(?:diff |index |new file|deleted file|similarity |rename |old mode|new mode)/.test(line)) {
    pushSegment(out, line, styleOf(syn, 'meta'))
  } else pushSegment(out, line)
  return out
}

/* ------------------------------------------------------------------ *
 * Scanner
 * ------------------------------------------------------------------ */

const CONFIGS = {
  js: JS_CONFIG,
  ts: TS_CONFIG,
  json: JSON_CONFIG,
  bash: BASH_CONFIG,
  python: PYTHON_CONFIG,
  diff: makeConfig({ handler: diffLine }),
  css: CSS_CONFIG,
  html: makeConfig({ handler: htmlLine }),
  sql: SQL_CONFIG,
  go: GO_CONFIG,
  rust: RUST_CONFIG,
  yaml: YAML_CONFIG,
  markdown: makeConfig({ handler: markdownLine }),
  text: makeConfig({ plain: true })
}

/**
 * Read one token starting at `index`.
 * @returns {{ end: number, key?: string }}
 */
function readToken(line, index, cfg, syn, state) {
  const n = line.length

  // Resume a construct that ran off the end of the previous line.
  if (state.block !== undefined && state.block !== null) {
    const close = state.block
    const idx = line.indexOf(close, index)
    if (idx === -1) return { end: n, key: 'comment' }
    state.block = null
    return { end: idx + close.length, key: 'comment' }
  }
  if (state.triple !== undefined && state.triple !== null) {
    const close = state.triple
    const idx = line.indexOf(close, index)
    if (idx === -1) return { end: n, key: 'string' }
    state.triple = null
    return { end: idx + close.length, key: 'string' }
  }

  if (cfg.metaAtStart === true && index === 0) {
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) return { end: 3, key: 'meta' }
  }

  for (const marker of cfg.lineComments) {
    if (line.startsWith(marker, index)) return { end: n, key: 'comment' }
  }

  for (const [open, close] of cfg.blockComments) {
    if (line.startsWith(open, index)) {
      const idx = line.indexOf(close, index + open.length)
      if (idx === -1) {
        state.block = close
        return { end: n, key: 'comment' }
      }
      return { end: idx + close.length, key: 'comment' }
    }
  }

  for (const quote of cfg.tripleStrings) {
    if (line.startsWith(quote, index)) {
      const idx = line.indexOf(quote, index + quote.length)
      if (idx === -1) {
        state.triple = quote
        return { end: n, key: 'string' }
      }
      return { end: idx + quote.length, key: 'string' }
    }
  }

  const ch = line[index]

  if (cfg.dashFlags === true && ch === '-' && /[-A-Za-z]/.test(line[index + 1] ?? '')) {
    RE_DASH_FLAG.lastIndex = index
    const match = RE_DASH_FLAG.exec(line)
    if (match !== null) return { end: index + match[0].length, key: 'attribute' }
  }

  if (cfg.dollarVariables === true && ch === '$') {
    if (line[index + 1] === '{') {
      const idx = line.indexOf('}', index + 2)
      return { end: idx === -1 ? n : idx + 1, key: 'variable' }
    }
    const word = readWord(line, index + 1, cfg)
    if (word !== null) return { end: index + 1 + word.length, key: 'variable' }
    if ('0123456789?@*#$!'.includes(line[index + 1] ?? '')) {
      return { end: index + 2, key: 'variable' }
    }
    return { end: index + 1, key: 'operator' }
  }

  if (
    cfg.anchorChars !== undefined &&
    cfg.anchorChars.includes(ch) &&
    /[A-Za-z0-9_]/.test(line[index + 1] ?? '')
  ) {
    const word = readWord(line, index + 1, cfg)
    return { end: word === null ? index + 1 : index + 1 + word.length, key: 'variable' }
  }

  if (cfg.decorators === true && ch === '@') {
    const word = readWord(line, index + 1, cfg)
    if (word !== null) return { end: index + 1 + word.length, key: 'meta' }
    return { end: index + 1, key: 'punctuation' }
  }

  if (cfg.hashColor === true && ch === '#') {
    const match = RE_HEX_COLOR.exec(line.slice(index))
    if (match !== null) return { end: index + match[0].length, key: 'number' }
  }

  if (cfg.tildeLiteral === true && ch === '~') return { end: index + 1, key: 'keyword' }

  // Rust: a lifetime looks like a char literal but has no closing quote.
  if (cfg.lifetime === true && ch === "'") {
    const word = readWord(line, index + 1, cfg)
    if (word !== null && line[index + 1 + word.length] !== "'") {
      return { end: index + 1 + word.length, key: 'type' }
    }
  }

  for (const quote of cfg.templates) {
    if (ch === quote) {
      let end = index + 1
      while (end < n) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === quote) {
          end += 1
          break
        }
        end += 1
      }
      return { end: Math.min(end, n), key: 'string' }
    }
  }

  for (const quote of cfg.strings) {
    if (ch === quote) {
      let end = index + 1
      while (end < n) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === quote) {
          end += 1
          break
        }
        end += 1
      }
      const stop = Math.min(end, n)
      if (cfg.jsonKeys === true && /^\s*:/.test(line.slice(stop))) {
        return { end: stop, key: 'property' }
      }
      return { end: stop, key: 'string' }
    }
  }

  if (isDigit(ch) || (ch === '.' && isDigit(line[index + 1] ?? ''))) {
    const re = cfg.numberUnits === true ? RE_NUMBER_UNITS : RE_NUMBER
    re.lastIndex = index
    const match = re.exec(line)
    if (match !== null && match[0].length > 0) {
      return { end: index + match[0].length, key: 'number' }
    }
  }

  if (
    isWordStart(ch) ||
    (cfg.dashWord === true && ch === '-' && /[A-Za-z_]/.test(line[index + 1] ?? ''))
  ) {
    const word = readWord(line, index, cfg)
    if (word !== null && word.length > 0) {
      const end = index + word.length
      const after = line[end]
      const before = index > 0 ? line[index - 1] : ''
      const lookup = cfg.caseInsensitive === true ? word.toUpperCase() : word
      let key
      if (cfg.literals.has(lookup)) key = 'keyword'
      else if (cfg.keywords.has(lookup)) key = 'keyword'
      else if (cfg.types.has(lookup)) key = 'type'
      else if (cfg.builtins.has(lookup)) key = 'function'
      else if (cfg.selfWords.has(lookup)) key = 'variable'
      else if (cfg.globals.has(lookup)) key = 'variable'
      else if (after === '(') key = 'function'
      else if (cfg.macros === true && after === '!') key = 'function'
      else if (after === ':' && (cfg.keyColon === true ? isStrictKeyColon(line, end) : cfg.keyColonLoose === true)) {
        key = 'property'
      } else if (before === '.') key = 'property'
      return { end, key }
    }
  }

  RE_OPERATOR.lastIndex = index
  const operator = RE_OPERATOR.exec(line)
  if (operator !== null && operator[0].length > 0) {
    return { end: index + operator[0].length, key: 'operator' }
  }

  RE_PUNCT.lastIndex = index
  if (RE_PUNCT.test(line)) return { end: index + 1, key: 'punctuation' }

  return { end: index + 1 }
}

/**
 * Tokenize one already-sanitized line into contiguous segments.
 * @param {string} line
 * @param {string} lang
 * @param {Record<string, string> | undefined | null} syn
 * @param {{ block?: string | null, triple?: string | null }} state
 * @returns {Segment[]}
 */
function scan(line, lang, syn, state) {
  const cfg = CONFIGS[lang] ?? CONFIGS.text
  if (cfg.plain === true) return line.length === 0 ? [] : [{ text: line }]
  if (typeof cfg.handler === 'function') return cfg.handler(line, syn, state)

  /** @type {Segment[]} */
  const out = []
  const n = line.length
  let index = 0
  while (index < n) {
    const token = readToken(line, index, cfg, syn, state)
    let end = token !== null && token !== undefined && Number.isFinite(token.end) ? token.end : index + 1
    if (end <= index) end = index + 1
    if (end > n) end = n
    pushSegment(out, line.slice(index, end), styleOf(syn, token?.key))
    index = end
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Canonical identifiers this module can highlight, including `text`. */
export const SUPPORTED_LANGUAGES = Object.freeze([
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
])

/** Alias table; the first whitespace-delimited token of a hint is looked up. */
const ALIASES = new Map(
  Object.entries({
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
    python: 'python',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    xml: 'html',
    svg: 'html',
    rs: 'rust',
    rust: 'rust',
    golang: 'go',
    go: 'go',
    md: 'markdown',
    markdown: 'markdown',
    patch: 'diff',
    udiff: 'diff',
    diff: 'diff',
    jsonc: 'json',
    json: 'json',
    css: 'css',
    sql: 'sql',
    text: 'text',
    txt: 'text',
    plain: 'text'
  })
)

/**
 * Canonicalize a language hint. Unknown, empty and non-string hints become
 * `'text'`, never an error.
 * @param {unknown} hint
 * @returns {string}
 */
export function normalizeLanguage(hint) {
  if (typeof hint !== 'string') return 'text'
  const trimmed = hint.trim().toLowerCase()
  if (trimmed.length === 0) return 'text'
  const first = trimmed.split(/\s+/)[0]
  return ALIASES.get(first) ?? 'text'
}

/**
 * Highlight a single line. The result's concatenated text always equals
 * `sanitize(line)`; malformed input is tolerated by construction.
 * @param {string} line
 * @param {string} [lang]
 * @param {Record<string, string>} [syn]
 * @returns {Segment[]}
 */
export function highlightLine(line, lang, syn) {
  const text = sanitize(line)
  if (text.length === 0) return []
  const id = normalizeLanguage(lang)
  return scan(text, id, syn, { block: null, triple: null })
}

/**
 * Highlight a whole snippet. Multi-line block comments and Python triple-quoted
 * strings carry state from line to line; the returned segments may contain
 * `'\n'` and concatenate back to `sanitize(code)`.
 * @param {string} code
 * @param {string} [lang]
 * @param {Record<string, string>} [syn]
 * @returns {Segment[]}
 */
export function highlightCode(code, lang, syn) {
  const text = sanitize(code)
  if (text.length === 0) return []
  const id = normalizeLanguage(lang)
  if (id === 'text') return [{ text }]
  const state = { block: null, triple: null }
  /** @type {Segment[]} */
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) pushSegment(out, '\n')
    for (const segment of scan(lines[i], id, syn, state)) {
      pushSegment(out, segment.text, segment.sgr)
    }
  }
  return out
}
