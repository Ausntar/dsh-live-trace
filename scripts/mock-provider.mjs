#!/usr/bin/env node
/**
 * A minimal Anthropic-Messages-compatible SSE provider.
 *
 * DEVELOPMENT TOOL — not part of the plugin's runtime. It exists so the whole
 * pipeline (real agent loop -> real session events -> observer plugin ->
 * `dsh-live-trace`) can be exercised offline, without a provider account:
 *
 *   node scripts/mock-provider.mjs &                      # listens on 127.0.0.1:8799
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:8799 \
 *   DEEPSEEK_API_KEY=sk-mock \
 *   dsh --profile <profile> "<task>"
 *
 * Turn 1 streams thinking + text and asks for one `bash` call; turn 2 streams a
 * final answer. Env: MOCK_LLM_PORT, MOCK_LLM_CHUNK_DELAY_MS.
 */


import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8799)
const CHUNK_DELAY_MS = Number(process.env.MOCK_LLM_CHUNK_DELAY_MS ?? 90)

function send(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function sse(res, events) {
  let chain = Promise.resolve()
  for (const event of events) {
    chain = chain.then(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            send(res, event)
            resolve()
          }, CHUNK_DELAY_MS)
        })
    )
  }
  return chain
}

function firstToolTurn() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 4200, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '用户想看这个插件的实现，' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '所以我先列一下目录，再看入口文件。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我先看看项目结构，' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '然后读一下插件的入口。' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'bash',
        input: {
          command: 'ls -1 dsh-live-trace && echo "--- entry ---" && head -4 dsh-live-trace/index.js',
          description: 'Inspect the plugin package layout'
        }
      }
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 186 } },
    { type: 'message_stop' }
  ]
}

/** Second turn: run something that produces rich, multi-line output. */
function commandTurn() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 4600, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '接着跑一遍测试，确认当前状态。' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_02',
        name: 'bash',
        input: {
          command: 'cd dsh-live-trace && node --test test/width.test.js test/tools.test.js 2>&1 | tail -12',
          description: 'Run the measurement and tool-helper tests'
        }
      }
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 96 } },
    { type: 'message_stop' }
  ]
}

/** Third turn: write a file, so the edits panel has a real diff to show. */
function writeTurn() {
  const scratch = process.env.MOCK_LLM_SCRATCH ?? './demo-scratch.md'
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5200, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '把结论写成一个文件，顺便演示 diff 面板。' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_03',
        name: 'write',
        input: {
          file_path: scratch,
          content: '# dsh-live-trace\n\n一个只读的实时看板。\n\n- Host 插件订阅 session/event\n- 归一化后经 unix socket 推送\n- 独立终端渲染\n'
        }
      }
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 128 } },
    { type: 'message_stop' }
  ]
}

/** Final turn: a markdown answer with prose, a list, and a highlighted fence. */
function finalTurn() {
  const answer = [
    '## 结论',
    '',
    '这是一个 **只读** 的实时看板插件：Host 侧订阅 `session/event`，把归一化后的事件通过本地 socket 推给独立终端里的 `dsh-live-trace`。',
    '',
    '- 不改动 Harness 核心，不干预 Agent 运行',
    '- 卸载时 socket、监听器、定时器全部回收',
    '- 终端里用 `Markdown` 渲染模型输出，并给代码着色',
    '',
    '```ts',
    'export function apply(ctx, config) {',
    '  return ctx.effect(() => {',
    '    const dispose = ctx.on("session/event", (session, event) => {',
    '      hub.onSessionEvent(session, event)',
    '    })',
    '    return () => dispose()',
    '  })',
    '}',
    '```',
    '',
    '| 面板 | 快捷键 | 内容 |',
    '| --- | --- | --- |',
    '| trace | 1 | 事件轨迹 |',
    '| sessions | 2 | 会话切换 |',
    '| edits | 3 | 文件改动 |',
    '| commands | 4 | 命令与输出 |'
  ].join('\n')

  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 6100, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '整理结论，用列表和表格说明面板。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
  ]
  for (const chunk of answer.match(/[\s\S]{1,24}/g) ?? []) {
    events.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: chunk } })
  }
  events.push(
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 320 } },
    { type: 'message_stop' }
  )
  return events
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.writeHead(404).end('not found')
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', async () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* fall through to the tool turn */
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    // Each turn is chosen by how many tool results the conversation already
    // carries, which walks the agent loop through bash -> bash -> write -> answer.
    const toolResults = (JSON.stringify(messages).match(/"type":"tool_result"/g) ?? []).length
    const script = toolResults === 0 ? firstToolTurn() : toolResults === 1 ? commandTurn() : toolResults === 2 ? writeTurn() : finalTurn()
    process.stderr.write(`mock-llm: request model=${parsed.model} toolResults=${toolResults}\n`)

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    await sse(res, script)
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`mock-llm: listening on http://127.0.0.1:${PORT}\n`)
})
