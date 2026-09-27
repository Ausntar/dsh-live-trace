/**
 * Pure helpers for the two structured things a trace is most often read for:
 * the commands the model ran (with their output and exit status) and the files
 * it changed (with their diffs).
 *
 * Nothing here imports the Harness. The shell exit-status marker contract and
 * the file-diff metadata shape are *mirrored* rather than imported so the
 * observer keeps working across Harness versions and stays dependency-free; the
 * mirroring is deliberately tolerant, and an unrecognized shape degrades to
 * "no structured detail" instead of an error.
 *
 * @module dsh-live-trace/tools
 */

/** Tool names treated as shell commands. */
const SHELL_TOOLS = new Set([
  'bash',
  'sh',
  'zsh',
  'shell',
  'pwsh',
  'powershell',
  'cmd',
  'exec',
  'terminal',
  'bash_persistent',
  'pwsh_persistent'
])

/** Default cap on retained command output, in lines and characters. */
export const OUTPUT_LINE_LIMIT = 200
export const OUTPUT_CHAR_LIMIT = 20_000

/**
 * @param {unknown} name
 * @returns {boolean} whether a tool name denotes a shell command
 */
export function isShellTool(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  const normalized = name.toLowerCase()
  if (SHELL_TOOLS.has(normalized)) return true
  // Persistent or namespaced variants such as `local:bash`.
  const tail = normalized.split(/[:/.]/).pop() ?? normalized
  return SHELL_TOOLS.has(tail)
}

/**
 * Split a rendered shell result into its output body and exit status.
 *
 * Mirrors the marker contract the shell tools append: a trailing
 * `[exit code: N]` or `[killed by signal: X]` on its own final line. Absent
 * both markers means a clean exit 0.
 *
 * @param {string} text
 * @returns {{ body: string, exitCode?: number, signal?: string }}
 */
export function parseExitStatus(text) {
  if (typeof text !== 'string' || text.length === 0) return { body: '', exitCode: 0 }
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal !== null && signal[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit !== null && exit[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}

/**
 * Parse a tool call's raw argument JSON without ever throwing.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | undefined}
 */
export function parseArguments(raw) {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw)
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Structured shell facts for one call, when the tool is a shell tool.
 *
 * @param {string} name tool name
 * @param {unknown} rawArguments the raw arguments JSON string
 * @returns {{ command: string, description?: string, cwd?: string } | undefined}
 */
export function shellCallFrom(name, rawArguments) {
  if (!isShellTool(name)) return undefined
  const args = parseArguments(rawArguments)
  const command = typeof args?.command === 'string' ? args.command : undefined
  if (command === undefined || command.length === 0) return undefined
  /** @type {{ command: string, description?: string, cwd?: string }} */
  const shell = { command }
  if (typeof args?.description === 'string' && args.description.length > 0) shell.description = args.description
  if (typeof args?.cwd === 'string' && args.cwd.length > 0) shell.cwd = args.cwd
  return shell
}

/**
 * A file-edit tool's target path, when the call names one.
 * @param {unknown} rawArguments
 * @returns {string | undefined}
 */
export function filePathFrom(rawArguments) {
  const args = parseArguments(rawArguments)
  if (args === undefined) return undefined
  for (const key of ['file_path', 'path', 'filePath', 'filename']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * A `write`-style call's file path and content, when the arguments carry both.
 *
 * A brand-new file has no prior text, so the tool reports an empty hunk list
 * and the applied content exists only in the call arguments. Recovering it here
 * is what lets a create show up as a whole-file addition instead of nothing.
 *
 * @param {unknown} rawArguments
 * @param {string} [filePath]
 * @returns {{ filePath: string, content: string } | undefined}
 */
export function writeCallFrom(rawArguments, filePath) {
  const args = parseArguments(rawArguments)
  if (args === undefined) return undefined
  const content = args.content
  if (typeof content !== 'string') return undefined
  const path = filePath ?? (typeof args.file_path === 'string' ? args.file_path : undefined)
  if (path === undefined || path.length === 0) return undefined
  return { filePath: path, content }
}

/**
 * Narrow opaque `tool/result` metadata into file diffs.
 *
 * Mirrors the `{ diffs: [{ path, oldText, newText }], operation? }` payload a
 * file-writing tool attaches. Malformed metadata yields `undefined` so
 * presentation falls back instead of throwing during replay.
 *
 * @param {unknown} meta
 * @returns {{ path: string, oldText: string | null, newText: string }[] | undefined}
 */
export function narrowFileDiffs(meta) {
  if (meta === null || typeof meta !== 'object') return undefined
  const diffs = /** @type {Record<string, unknown>} */ (meta).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const out = []
  for (const candidate of diffs) {
    if (candidate === null || typeof candidate !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (candidate)
    if (typeof record.path !== 'string') continue
    if (typeof record.newText !== 'string') continue
    const oldText = record.oldText
    if (oldText !== null && typeof oldText !== 'string') continue
    out.push({ path: record.path, oldText: oldText ?? null, newText: record.newText })
  }
  return out.length > 0 ? out : undefined
}

/**
 * The operation a diff payload reports (`create` or `update`).
 * @param {unknown} meta
 * @returns {'create' | 'update' | undefined}
 */
export function diffOperationFrom(meta) {
  if (meta === null || typeof meta !== 'object') return undefined
  const operation = /** @type {Record<string, unknown>} */ (meta).operation
  return operation === 'create' || operation === 'update' ? operation : undefined
}

/**
 * Count the added and removed lines across diff hunks.
 *
 * A hunk is a replaced region: `oldText === null` is a pure insertion. The
 * counts are line-based so they match what a `git diff --numstat` reader
 * expects.
 *
 * @param {{ oldText: string | null, newText: string }[]} hunks
 * @returns {{ added: number, removed: number }}
 */
export function countDiffLines(hunks) {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    if (hunk.newText.length > 0) added += hunk.newText.split('\n').length
    if (typeof hunk.oldText === 'string' && hunk.oldText.length > 0) {
      removed += hunk.oldText.split('\n').length
    }
  }
  return { added, removed }
}

/**
 * Flatten diff hunks into unified-diff display lines.
 *
 * Each hunk becomes a `@@` header followed by its context/removed/added lines,
 * with a one-line gap marker between non-adjacent hunks so a reader can tell
 * that content was elided.
 *
 * @param {{ path: string, oldText: string | null, newText: string }[]} hunks
 * @returns {{ kind: 'hunk' | 'context' | 'add' | 'del' | 'gap' | 'meta', text: string }[]}
 */
export function diffLines(hunks) {
  const out = []
  hunks.forEach((hunk, index) => {
    if (index > 0) out.push({ kind: 'gap', text: '⋮' })
    out.push({ kind: 'hunk', text: `@@ ${hunk.path}${hunk.oldText === null ? ' (new file)' : ''}` })
    if (typeof hunk.oldText === 'string' && hunk.oldText.length > 0) {
      for (const line of hunk.oldText.split('\n')) out.push({ kind: 'del', text: line })
    }
    for (const line of hunk.newText.split('\n')) out.push({ kind: 'add', text: line })
  })
  return out
}

/**
 * Cap command output for display, reporting what was dropped.
 *
 * The tail is kept rather than the head: when a command fails, the interesting
 * part is almost always the end.
 *
 * @param {string} text
 * @param {{ maxLines?: number, maxChars?: number }} [options]
 * @returns {{ text: string, lines: number, truncated: boolean, omitted: number }}
 */
export function capOutput(text, options = {}) {
  const maxLines = options.maxLines ?? OUTPUT_LINE_LIMIT
  const maxChars = options.maxChars ?? OUTPUT_CHAR_LIMIT
  const source = typeof text === 'string' ? text : ''
  if (source.length === 0) return { text: '', lines: 0, truncated: false, omitted: 0 }
  let lines = source.split('\n')
  let truncated = false
  let omitted = 0
  if (lines.length > maxLines) {
    omitted = lines.length - maxLines
    lines = lines.slice(lines.length - maxLines)
    truncated = true
  }
  let body = lines.join('\n')
  if (body.length > maxChars) {
    const dropped = body.length - maxChars
    // Count the extra lines folded into the character cut so `omitted` stays honest.
    const extraLines = body.slice(0, dropped).split('\n').length - 1
    omitted += extraLines
    body = body.slice(dropped)
    lines = body.split('\n')
    truncated = true
  }
  return { text: body, lines: lines.length, truncated, omitted }
}
