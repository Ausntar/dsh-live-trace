#!/usr/bin/env node
/**
 * Offline demo: run the real dashboard against a scripted trace, with no
 * Harness and no model provider involved.
 *
 * This exists so the board can be seen (and its layout checked) in a second,
 * without installing the plugin anywhere. It drives the same `TraceHub` and
 * `createTraceServer` the Host plugin uses, so what appears on screen is the
 * production rendering path.
 *
 *   node scripts/demo.mjs [--duration <ms>] [--no-color]
 *
 * Without `--duration` the board stays live until you press q in it.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serversDir } from '../lib/paths.js'
import { writeServerRecord } from '../lib/registry.js'
import { TraceHub } from '../lib/tracker.js'
import { createTraceServer } from '../lib/transport.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const options = { duration: undefined, color: true }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--duration') options.duration = Number.parseInt(argv[index + 1], 10)
    else if (argv[index] === '--no-color') options.color = false
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const runtimeDir = join(tmpdir(), `dsh-live-trace-demo-${process.pid}`)
const socketPath = join(runtimeDir, 'sockets', `${process.pid}.sock`)
const sessionId = 'session-6e3caa1a-3c38-4222-8d66-0bb3b8c30c45'
const startedAt = Date.now()
const session = { id: sessionId, header: { createdAt: startedAt, cwd: process.cwd(), agentPreset: 'standard' }, seq: 0 }

const hub = new TraceHub({ now: () => Date.now(), streamIntervalMs: 500, backlogSize: 500 })
const server = createTraceServer({
  socketPath,
  runtimeDir,
  hub,
  serverInfo: () => ({ pid: process.pid, version: 'demo', profile: 'demo', cwd: process.cwd() }),
  heartbeatMs: 2000
})
await server.ready

mkdirSync(serversDir(runtimeDir), { recursive: true })
const publishRegistry = () => {
  writeServerRecord(serversDir(runtimeDir), {
    pid: process.pid,
    socket: socketPath,
    version: 'demo',
    profile: 'demo',
    cwd: process.cwd(),
    startedAt,
    heartbeat: Date.now(),
    activeSessionId: sessionId,
    sessions: [
      { id: sessionId, createdAt: startedAt, cwd: process.cwd(), title: 'live trace demo', turn: 3, step: 2 }
    ]
  })
}
publishRegistry()

const child = spawn(
  process.execPath,
  [
    join(HERE, '..', 'bin', 'dsh-live-trace.js'),
    '--runtime-dir',
    runtimeDir,
    '--session',
    sessionId,
    // Force the full-screen board even when the demo's own stdout is a pipe,
    // which is what a capture or a CI check needs.
    '--alt-screen',
    ...(options.color ? [] : ['--no-color'])
  ],
  { stdio: 'inherit' }
)

let finished = false
/** Tear down the viewer, the socket, and the temporary runtime directory. */
function finish() {
  if (finished) return
  finished = true
  child.kill('SIGTERM')
  server.close().finally(() => {
    rmSync(runtimeDir, { recursive: true, force: true })
    process.exit(0)
  })
}
// Registered before the script runs: the viewer may quit at any moment.
child.on('exit', finish)
process.on('SIGINT', finish)
process.on('SIGTERM', finish)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let seq = 0
const appendEvent = (type, data) => hub.onSessionEvent(session, { type, seq: seq++, time: Date.now(), data })

async function script() {
  hub.onSessionCreated(session, 'startup')
  appendEvent('permission/preset', { preset: 'workspace-write' })
  appendEvent('sandbox/mode', { mode: 'workspace-write' })
  appendEvent('approval/policy', { policy: 'ask' })
  hub.onAgentCreated({ options: { provider: 'deepseek-official', model: 'deepseek-flash' }, session }, 'startup')
  appendEvent('turn/start', { turn: 3 })
  await sleep(400)
  appendEvent('step/start', { turn: 3, step: 1 })
  appendEvent('session/title', { title: 'live trace demo', messageSeqs: [] })
  appendEvent('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: '把登录逻辑抽到 src/auth.ts，并补上测试' }],
    source: { kind: 'user' }
  })
  await sleep(300)

  hub.onAssistantStream({ session }, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 3, step: 1 })
  for (const text of ['先读一下现有的登录代码，', '确认调用点，', '再决定抽象边界…']) {
    hub.onAssistantStream(
      { session },
      { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } }
    )
    hub.flushStreams()
    await sleep(320)
  }
  appendEvent('assistant/message', {
    turn: 3,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: [
            '先确认 `login()` 的所有调用点，再决定抽象边界。',
            '',
            '1. 只有两处直接调用，都在 `src/routes/` 里。',
            '2. 会话创建逻辑已经在 `src/session.ts`，可以直接复用。',
            '3. 把校验逻辑留在原文件，导出 `login()` 即可。',
            '4. 测试需要覆盖：正常登录、错误密码、会话过期。',
            '5. lint 规则要求显式返回类型，所以要标注 `Promise<Session>`。'
          ].join('\n')
        },
        {
          type: 'text',
          text: [
            '## 计划',
            '',
            '把 `login()` 抽到 **src/auth.ts**，然后跑测试：',
            '',
            '- 读取 `src/login.ts`',
            '- 写入新模块',
            '- 运行 `npm test`',
            '',
            '```ts',
            'export async function login(user: string): Promise<Session> {',
            '  // 校验并创建会话',
            '  return createSession(user)',
            '}',
            '```'
          ].join('\n')
        }
      ],
      source: { kind: 'model' }
    },
    stream: [],
    usage: { inputTokens: 3200, outputTokens: 180, totalTokens: 3380 }
  })
  await sleep(200)

  const calls = [
    { id: 'c1', name: 'read_file', args: { path: 'src/login.ts' }, result: '返回 234 行', ms: 300 },
    { id: 'c2', name: 'write_file', args: { path: 'src/auth.ts' }, result: '写入 96 行', ms: 300 },
    { id: 'c3', name: 'bash', args: { command: 'npm test', description: 'Run the test suite' }, result: '测试通过 (12 passed)', ms: 900 },
    { id: 'c4', name: 'bash', args: { command: 'npm run lint', description: 'Lint the workspace' }, result: '2 problems (0 errors, 2 warnings)', ok: false, ms: 700 }
  ]
  for (const call of calls) {
    appendEvent('tool/call', { turn: 3, step: 1, callId: call.id, name: call.name, arguments: JSON.stringify(call.args) })
    await sleep(240)
    appendEvent('tool/result', {
      turn: 3,
      step: 1,
      message: {
        id: `r-${call.id}`,
        role: 'tool',
        toolCallId: call.id,
        isError: call.ok === false,
        content: [{ type: 'text', text: call.result }],
        source: { kind: 'tool', callId: call.id }
      },
      ...(call.ok === false ? { error: { name: 'LintError', code: 'LINT_WARNINGS', reason: '2 warnings' } } : {})
    })
    await sleep(call.ms)
  }

  // A file write whose content exists only in the call arguments, exactly like
  // a real `write` tool creating a new file.
  const writeArgs = JSON.stringify({
    file_path: 'src/auth.ts',
    content: [
      "import { createSession, type Session } from './session'",
      '',
      'export async function login(user: string): Promise<Session> {',
      '  return createSession(user)',
      '}',
      ''
    ].join('\n')
  })
  appendEvent('tool/call', { turn: 3, step: 1, callId: 'c5', name: 'write', arguments: writeArgs })
  await sleep(260)
  appendEvent('tool/result', {
    turn: 3,
    step: 1,
    message: {
      id: 'r-c5',
      role: 'tool',
      toolCallId: 'c5',
      content: [{ type: 'text', text: 'wrote 96 bytes to src/auth.ts' }],
      source: { kind: 'tool', callId: 'c5' }
    },
    meta: { operation: 'create', diffs: [] }
  })
  await sleep(400)

  appendEvent('approval/asked', { id: 'ap-1', toolName: 'bash', reason: 'runs outside the sandbox' })
  await sleep(1000)
  appendEvent('approval/decided', { id: 'ap-1', outcome: 'allowed-once' })
  await sleep(300)

  appendEvent('step/start', { turn: 3, step: 2 })
  appendEvent('assistant/message', {
    turn: 3,
    step: 2,
    message: {
      id: 'a2',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: [
            '### 完成',
            '',
            '登录逻辑已抽到 `src/auth.ts`：',
            '',
            '| 检查 | 结果 |',
            '| --- | --- |',
            '| 测试 | 12 passed |',
            '| lint | 2 warnings |',
            '',
            '```bash',
            '$ npm test',
            '✓ 12 passed',
            '```'
          ].join('\n')
        }
      ],
      source: { kind: 'model' }
    },
    stream: [],
    usage: { inputTokens: 4400, outputTokens: 260, totalTokens: 4660 }
  })
  appendEvent('request/context', { provider: 'deepseek-official', model: 'deepseek-flash', capacity: 1_000_000 })
  appendEvent('turn/end', { turn: 3, reason: { kind: 'completed' } })
  publishRegistry()
}

await script()

if (Number.isFinite(options.duration)) {
  setTimeout(finish, options.duration)
} else {
  process.stdout.write('\nDemo trace complete. The board stays live — press q in the dashboard to exit.\n')
}
