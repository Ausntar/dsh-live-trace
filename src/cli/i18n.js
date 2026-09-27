/**
 * Dashboard localization.
 *
 * The board is read by people whose Harness UI may be Chinese or English, so
 * every user-facing string goes through a key. The language is picked from the
 * environment by default and can be pinned on the command line or cycled at
 * runtime with `l`; the choice only affects the chrome, never the trace itself
 * (event text is whatever the model and the Harness wrote).
 *
 * @module dsh-live-trace/i18n
 */

/** Languages this build ships. */
export const LANGUAGES = ['en', 'zh']

/** Environment variables consulted for the initial language, in order. */
const LOCALE_ENV = ['DSH_LIVE_TRACE_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']

const DICTIONARIES = {
  en: {
    'header.session': 'Session:',
    'header.status': 'Status:',
    'header.noSession': 'no session bound',
    'header.disconnected': 'disconnected',

    'status.idle': 'idle',
    'status.running': 'running',
    'status.tool': 'tool running',
    'status.approval': 'waiting for approval',
    'status.error': 'error',

    'trace.connecting': 'Connecting to the Harness observer…',
    'trace.noSession': 'Connected. No session yet — send a message in the dsh web UI to start one.',
    'trace.waiting': 'Connected. Waiting for session activity…',
    'trace.thinking': 'thinking',
    'trace.writing': 'writing',
    'trace.moreLines': '… {n} more lines',
    'trace.expand': 'e to expand',
    'trace.collapse': 'e to collapse',
    'trace.gotoCommands': '(v commands)',
    'trace.gotoEdits': '(v edits)',
    'trace.hunks': '± {n} hunks',
    'trace.hunk': '± {n} hunk',
    'trace.running': 'running',

    'panel.sessions': 'SESSIONS',
    'panel.edits': 'FILE CHANGES',
    'panel.commands': 'COMMANDS',
    'panel.none': 'none',
    'panel.known': '{n} known · {m} active',

    'sessions.empty': 'No sessions yet.',
    'sessions.emptyHint': 'Send a message in the dsh web UI to start one; it appears here immediately.',
    'sessions.subagent': 'subagent L{n}',

    'edits.empty': 'No file changes recorded for this session yet.',
    'edits.emptyHint': 'Edits appear here as soon as a write or edit tool reports its applied diff.',
    'edits.noChanges': 'no changes yet',
    'edits.fileCount': '{n} file',
    'edits.filePlural': '{n} files',
    'edits.moreFiles': '… {n} more files',
    'edits.moreFile': '… {n} more file',
    'edits.badge.new': 'new',
    'edits.badge.mod': 'mod',
    'edits.badge.del': 'del',
    'edits.newFile': '(new file)',

    'commands.empty': 'No shell commands run in this session yet.',
    'commands.emptyHint': 'Every command the model runs appears here with its output and exit status.',
    'commands.running': 'running…',
    'commands.exit': 'exit {n}',
    'commands.signal': 'signal {x}',
    'commands.noOutput': '(no output)',
    'commands.summaryRun': '{n} run',
    'commands.summaryFailed': '{n} failed',
    'commands.summaryRunning': '{n} running',

    'footer.paused': 'paused',
    'footer.tokens': 'Tokens',
    'footer.older': '↑ older',
    'footer.above': '↑{n}',
    'footer.below': '↓{n}',
    'footer.sessions': '{n} sessions',
    'footer.files': '{n} files',

    'keys.trace': '1-4 views  e:think  m:md  ?:help',
    'keys.sessions': '↑↓ select  enter open  esc back  ?:help',
    'keys.edits': '↑↓ file  1:trace  ?:help',
    'keys.commands': '1:trace  d:edits  ?:help',

    'view.trace': 'trace',
    'view.sessions': 'sessions',
    'view.edits': 'edits',
    'view.commands': 'commands',

    'work.title': 'working',
    'work.state.sleep': 'dozing',
    'work.state.thinking': 'thinking it over',
    'work.state.typing': 'typing',
    'work.state.writing': 'writing a file',
    'work.state.waiting': 'waiting on a command',
    'work.state.reading': 'reading',
    'work.state.searching': 'looking it up',
    'work.state.calling': 'on the phone',
    'work.bubbleCalling': 'Subagent #{n} on the line',
    'work.bubbleQueue': 'Subagent #{n} of {total} ({q} queued)',
    'work.bubbleReply': 'Subagent #{n} calling back',
    'work.noReply': '(it came back with no text)',
    'work.state.ringing': 'answering the phone',
    'work.sceneRoom': 'a desk by a window (b)',
    'work.sceneNature': 'outdoors (b)',
    'work.soundOn': 'rain sound on {level}% (n, -/+)',
    'work.soundOff': 'rain sound off {level}% (n)',
    'work.soundFixed': 'rain sound on · {player} cannot change a file level (n)',
    'work.weather.clear': 'clear',
    'work.weather.cloudy': 'cloudy',
    'work.weather.rain': 'rain',
    'work.weather.storm': 'storm',
    'work.weather.fog': 'fog',
    'work.weather.snow': 'snow',
    'work.waitingForSubagents': 'napping — waiting for {n} subagent(s) to call back',
    'work.bubbleCallingNoInput': 'Subagent #{n} — no instructions yet',
    'work.noInput': '(no instructions)',
    'work.helpTitle': 'Keys',
    'work.help.pin': 'pin an animation (1-8), 0 for automatic',
    'work.help.language': 'switch language',
    'work.help.quit': 'quit',
    'work.pinned': 'pinned',
    'work.automatic': 'automatic',
    'work.helpKey': 'close this help',
    'work.noSession': 'no session bound yet',
    'work.state': 'state',
    'work.tooSmall': 'the terminal is too small for the desk scene',
    'working.pick': 'Which session?',
    'working.pickKeys': '↑↓ choose   enter bind   esc cancel',

    'age.now': 'now',

    'help.title': 'Key bindings',
    'help.views': 'Views',
    'help.trace': 'Trace',
    'help.lists': 'Lists (sessions, edits, commands)',
    'help.general': '',
    'help.tracePanel': 'trace — the chronological event log',
    'help.sessionsPanel': 'sessions — pick between concurrent dsh sessions',
    'help.editsPanel': 'edits — file changes with a unified diff',
    'help.commandsPanel': 'commands — every command and its output',
    'help.cycle': 'cycle panels',
    'help.scrollLine': 'scroll one line',
    'help.page': 'scroll one page',
    'help.jump': 'jump to the oldest / newest',
    'help.thinking': 'expand or collapse every thinking block',
    'help.markdown': 'toggle Markdown rendering (raw text)',
    'help.pause': 'pause or resume following new entries',
    'help.replay': 'ask the plugin to replay this session',
    'help.language': 'switch language (English / 中文)',
    'help.mouse': 'scroll three lines per notch',
    'help.click': 'select the row under the pointer',
    'help.select': 'move the selection',
    'help.bind': 'bind the selected session',
    'help.leave': 'leave the session picker',
    'help.helpKey': 'close this help',
    'help.quit': 'quit',
    'help.readonly': 'The dashboard is read-only: it never sends anything to the agent.',
    'help.width': 'Content width here: {n} columns.',

    'cli.detached': 'dsh-live-trace: detached from {id}',
    'cli.noObserver': 'dsh-live-trace: no running Harness observer found.',
    'cli.lookedIn': 'Looked in: {path}',
    'cli.installHint': 'The dashboard reads events published by the dsh-live-trace Host plugin.',
    'cli.installHint2': 'Install and enable it in the profile your Harness runs, then restart (or',
    'cli.installHint3': 'let hot reload pick it up) and run this command again:',
    'cli.useList': 'Use `dsh-live-trace --list` to see what was discovered, or `--socket <path>`',
    'cli.attachDirect': 'to attach to a known socket directly. Add `--wait` to poll instead of exiting.',
    'cli.runtimeDir': 'runtime dir: {path}',
    'cli.serversDir': 'servers dir: {path}',
    'cli.noObservers': 'No running Harness observers.',
    'cli.noneYet': '  sessions: none yet',
    'cli.sessionsHeader': '  sessions:',
    'cli.unknownOption': 'unknown option: {arg}',
    'cli.unexpectedArg': 'unexpected argument: {arg}',
    'cli.missingValue': 'missing value for {arg}'
  },

  zh: {
    'header.session': '会话：',
    'header.status': '状态：',
    'header.noSession': '未绑定会话',
    'header.disconnected': '已断开',

    'status.idle': '空闲',
    'status.running': '运行中',
    'status.tool': '执行工具',
    'status.approval': '等待审批',
    'status.error': '出错',

    'trace.connecting': '正在连接 Harness 观察器…',
    'trace.noSession': '已连接，暂无会话 — 在 dsh web 界面发一条消息即可开始。',
    'trace.waiting': '已连接，等待会话活动…',
    'trace.thinking': '思考',
    'trace.writing': '输出',
    'trace.moreLines': '… 还有 {n} 行',
    'trace.expand': 'e 展开',
    'trace.collapse': 'e 收起',
    'trace.gotoCommands': '（v 查看命令）',
    'trace.gotoEdits': '（v 查看改动）',
    'trace.hunks': '± {n} 处改动',
    'trace.hunk': '± {n} 处改动',
    'trace.running': '执行中',

    'panel.sessions': '会话',
    'panel.edits': '文件改动',
    'panel.commands': '命令',
    'panel.none': '无',
    'panel.known': '{n} 个 · {m} 个活动中',

    'sessions.empty': '暂无会话。',
    'sessions.emptyHint': '在 dsh web 界面发一条消息即可开始，会话会立刻出现在这里。',
    'sessions.subagent': '子代理 L{n}',

    'edits.empty': '本会话暂无文件改动记录。',
    'edits.emptyHint': '写入或编辑工具上报已应用的差异后，改动会立刻出现在这里。',
    'edits.noChanges': '暂无改动',
    'edits.fileCount': '{n} 个文件',
    'edits.filePlural': '{n} 个文件',
    'edits.moreFiles': '… 还有 {n} 个文件',
    'edits.moreFile': '… 还有 {n} 个文件',
    'edits.badge.new': '新增',
    'edits.badge.mod': '修改',
    'edits.badge.del': '删除',
    'edits.newFile': '（新文件）',

    'commands.empty': '本会话尚未执行任何 shell 命令。',
    'commands.emptyHint': '模型执行的每条命令都会连同输出与退出状态显示在这里。',
    'commands.running': '执行中…',
    'commands.exit': '退出 {n}',
    'commands.signal': '信号 {x}',
    'commands.noOutput': '（无输出）',
    'commands.summaryRun': '{n} 条',
    'commands.summaryFailed': '{n} 条失败',
    'commands.summaryRunning': '{n} 条执行中',

    'footer.paused': '已暂停',
    'footer.tokens': 'Token',
    'footer.older': '↑ 更早',
    'footer.above': '↑{n}',
    'footer.below': '↓{n}',
    'footer.sessions': '{n} 个会话',
    'footer.files': '{n} 个文件',

    'keys.trace': '1-4 视图  e:思考  m:原文  ?:帮助',
    'keys.sessions': '↑↓ 选择  enter 打开  esc 返回  ?:帮助',
    'keys.edits': '↑↓ 文件  1:轨迹  ?:帮助',
    'keys.commands': '1:轨迹  d:改动  ?:帮助',

    'view.trace': '轨迹',
    'view.sessions': '会话',
    'view.edits': '改动',
    'view.commands': '命令',

    'work.title': '工作台',
    'work.state.sleep': '打盹中',
    'work.state.thinking': '思考中',
    'work.state.typing': '敲键盘',
    'work.state.writing': '写文件中',
    'work.state.waiting': '等待命令',
    'work.state.reading': '阅读文件',
    'work.state.searching': '翻阅资料',
    'work.state.calling': '打电话',
    'work.bubbleCalling': '接 {n} 号子代理',
    'work.bubbleQueue': '接 {n} 号子代理（共 {total} 个，排队 {q} 个）',
    'work.bubbleReply': '{n} 号子代理回电',
    'work.noReply': '（它没有带回正文）',
    'work.state.ringing': '接电话',
    'work.sceneRoom': '室内·窗边（b）',
    'work.sceneNature': '全自然环境（b）',
    'work.soundOn': '雨声 开 {level}%（n, -/+）',
    'work.soundOff': '雨声 关 {level}%（n）',
    'work.soundFixed': '雨声 开 · {player} 无法调节文件音量（n）',
    'work.weather.clear': '晴',
    'work.weather.cloudy': '多云',
    'work.weather.rain': '雨',
    'work.weather.storm': '暴风雨',
    'work.weather.fog': '雾',
    'work.weather.snow': '雪',
    'work.waitingForSubagents': '打盹中 — 等 {n} 个子代理回电',
    'work.bubbleCallingNoInput': '接 {n} 号子代理，（暂无指令）',
    'work.noInput': '（对子代理的输入）',
    'work.helpTitle': '按键',
    'work.help.pin': '固定动画状态（1-8），0 恢复自动',
    'work.help.language': '切换语言',
    'work.help.quit': '退出',
    'work.pinned': '已固定',
    'work.automatic': '自动',
    'work.helpKey': '关闭本帮助',
    'work.noSession': '尚未绑定会话',
    'work.state': '状态',
    'work.tooSmall': '终端太小，放不下这张桌子',
    'working.pick': '选择会话',
    'working.pickKeys': '↑↓ 选择   enter 绑定   esc 取消',

    'age.now': '刚刚',

    'help.title': '按键说明',
    'help.views': '面板',
    'help.trace': '轨迹',
    'help.lists': '列表（会话 / 改动 / 命令）',
    'help.general': '',
    'help.tracePanel': '轨迹 — 按时间顺序的事件日志',
    'help.sessionsPanel': '会话 — 在并发的 dsh 会话之间切换',
    'help.editsPanel': '改动 — 文件改动与 unified diff',
    'help.commandsPanel': '命令 — 每条命令及其输出',
    'help.cycle': '循环切换面板',
    'help.scrollLine': '滚动一行',
    'help.page': '翻页',
    'help.jump': '跳到最早 / 最新',
    'help.thinking': '展开或收起所有思考块',
    'help.markdown': '切换 Markdown 渲染（显示原文）',
    'help.pause': '暂停 / 恢复跟随新事件',
    'help.replay': '请求插件重放本会话',
    'help.language': '切换语言（中文 / English）',
    'help.mouse': '滚轮：每格滚动三行',
    'help.click': '点击选中指针所在行',
    'help.select': '移动选中项',
    'help.bind': '绑定所选会话',
    'help.leave': '离开会话选择页',
    'help.helpKey': '关闭本帮助',
    'help.quit': '退出',
    'help.readonly': '看板是只读的：它不会向 agent 发送任何内容。',
    'help.width': '当前内容宽度：{n} 列。',

    'cli.detached': 'dsh-live-trace：已断开与 {id} 的连接',
    'cli.noObserver': 'dsh-live-trace：未找到正在运行的 Harness 观察器。',
    'cli.lookedIn': '查找位置：{path}',
    'cli.installHint': '看板读取由 dsh-live-trace Host 插件发布的事件。',
    'cli.installHint2': '请在你的 Harness 所用 profile 中安装并启用它，然后重启（或',
    'cli.installHint3': '让热重载自动加载），再重新运行本命令：',
    'cli.useList': '用 `dsh-live-trace --list` 查看发现了什么，或用 `--socket <path>`',
    'cli.attachDirect': '直接连接已知 socket。加 `--wait` 可轮询等待而不是直接退出。',
    'cli.runtimeDir': '运行时目录：{path}',
    'cli.serversDir': '注册表目录：{path}',
    'cli.noObservers': '没有正在运行的 Harness 观察器。',
    'cli.noneYet': '  会话：暂无',
    'cli.sessionsHeader': '  会话：',
    'cli.unknownOption': '未知选项：{arg}',
    'cli.unexpectedArg': '多余的参数：{arg}',
    'cli.missingValue': '{arg} 缺少取值'
  }
}

/**
 * Pick the language from a locale string such as `zh_CN.UTF-8`.
 * @param {unknown} locale
 * @returns {'en' | 'zh' | null}
 */
function languageFromLocale(locale) {
  if (typeof locale !== 'string') return null
  const normalized = locale.trim().toLowerCase()
  if (normalized.length === 0) return null
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('en')) return 'en'
  return null
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {'en' | 'zh'} the best guess, defaulting to English
 */
export function detectLanguage(env = process.env) {
  for (const name of LOCALE_ENV) {
    const found = languageFromLocale(env?.[name])
    if (found !== null) return found
  }
  return 'en'
}

/**
 * Resolve the effective language.
 * @param {unknown} option `auto`, a language code, or undefined
 * @param {Record<string, string | undefined>} [env]
 * @returns {'en' | 'zh'}
 */
export function resolveLanguage(option, env = process.env) {
  if (typeof option === 'string') {
    const normalized = option.trim().toLowerCase()
    if (normalized === 'auto' || normalized.length === 0) return detectLanguage(env)
    const direct = LANGUAGES.find((language) => language === normalized)
    if (direct !== undefined) return direct
    const byLocale = languageFromLocale(normalized)
    if (byLocale !== null) return byLocale
  }
  return detectLanguage(env)
}

/** The next language in the cycle, for a runtime switch. */
export function nextLanguage(language) {
  const index = LANGUAGES.indexOf(language)
  return LANGUAGES[(index + 1) % LANGUAGES.length]
}

/** Substitution values may be strings or numbers. @typedef {Record<string, string | number>} Params */

/**
 * Build a translator.
 *
 * A missing key falls back to English and then to the key itself, so a gap in a
 * translation degrades to readable text instead of an empty line.
 *
 * @param {'en' | 'zh'} language
 * @returns {{ language: string, t: (key: string, params?: Params) => string }}
 */
export function createTranslator(language) {
  const active = LANGUAGES.includes(language) ? language : 'en'
  const dictionary = DICTIONARIES[active]
  const t = (key, params) => {
    const template = dictionary[key] ?? DICTIONARIES.en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    )
  }
  return { language: active, t }
}

/** English translator used when no language was injected (tests, plain mode). */
export const DEFAULT_TRANSLATOR = createTranslator('en').t

/**
 * Status vocabulary in the active language.
 * @param {(key: string) => string} t
 * @param {string} status
 * @returns {string}
 */
export function statusText(t, status) {
  switch (status) {
    case 'running':
      return t('status.running')
    case 'tool':
      return t('status.tool')
    case 'waiting-approval':
      return t('status.approval')
    case 'error':
      return t('status.error')
    default:
      return t('status.idle')
  }
}

/** Every key this build defines, for tests that guard against gaps. */
export function dictionaryKeys(language = 'en') {
  return Object.keys(DICTIONARIES[language] ?? {})
}

/** The raw dictionary, for tests. */
export function dictionary(language) {
  return DICTIONARIES[language]
}
