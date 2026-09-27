/**
 * The dashboard's visual vocabulary: one color and one treatment per event tag.
 *
 * Colors are 256-color SGR parameters rather than truecolor so the board looks
 * right in the widest range of terminals, and every value collapses to an empty
 * style when color is disabled (`NO_COLOR`, `--no-color`, or a non-TTY).
 *
 * @module dsh-live-trace/theme
 */

/**
 * @typedef {object} Theme
 * @property {boolean} color
 * @property {Record<string, string>} tag        style per {@link import('../../lib/normalize.js').TAG}
 * @property {Record<string, string>} level      style per entry level
 * @property {Record<string, string>} ui         chrome styles
 * @property {Record<string, string>} md         markdown palette for markdown.js
 * @property {Record<string, string>} syn        syntax palette for highlight.js
 * @property {Record<string, string>} scene      palette for the desk scene
 */

/**
 * Build a theme.
 * @param {{ color?: boolean }} [options]
 * @returns {Theme}
 */
export function createTheme(options = {}) {
  const color = options.color !== false
  const sgr = (code) => (color ? code : '')

  const tag = {
    session: sgr('1;38;5;141'),
    turn: sgr('1;38;5;39'),
    step: sgr('38;5;44'),
    user: sgr('1;38;5;255'),
    assistant: sgr('38;5;42'),
    tool: sgr('1;38;5;220'),
    result: sgr('38;5;40'),
    error: sgr('1;38;5;203'),
    approval: sgr('1;38;5;214'),
    meta: sgr('38;5;245')
  }

  const level = {
    info: sgr('38;5;252'),
    success: sgr('38;5;42'),
    warn: sgr('38;5;214'),
    error: sgr('1;38;5;203'),
    muted: sgr('38;5;243')
  }

  const ui = {
    border: sgr('38;5;238'),
    title: sgr('1;38;5;45'),
    label: sgr('38;5;246'),
    value: sgr('1;38;5;253'),
    dim: sgr('38;5;240'),
    headerBg: sgr('48;5;235'),
    footerBg: sgr('48;5;235'),
    statusRunning: sgr('1;38;5;42'),
    statusTool: sgr('1;38;5;220'),
    statusIdle: sgr('38;5;245'),
    statusApproval: sgr('1;38;5;214'),
    statusError: sgr('1;38;5;203'),
    stream: sgr('3;38;5;246'),
    scrollHint: sgr('38;5;245'),
    hint: sgr('38;5;240'),
    ok: sgr('38;5;42'),
    fail: sgr('38;5;203'),
    // View chrome
    cursor: sgr('1;38;5;45'),
    cursorBg: sgr('48;5;237'),
    selected: sgr('1;38;5;255'),
    panelTitle: sgr('1;38;5;45'),
    added: sgr('38;5;42'),
    removed: sgr('38;5;203'),
    addedBg: sgr('48;5;22'),
    removedBg: sgr('48;5;52'),
    hunkHeader: sgr('38;5;141'),
    gutter: sgr('38;5;240'),
    command: sgr('38;5;252'),
    output: sgr('38;5;246'),
    exitOk: sgr('38;5;42'),
    exitFail: sgr('1;38;5;203')
  }

  // Markdown and syntax palettes are handed to `markdown.js` / `highlight.js`,
  // which never hard-code a colour of their own.
  const md = {
    heading: sgr('1;38;5;45'),
    heading2: sgr('1;38;5;44'),
    bold: sgr('1'),
    italic: sgr('3'),
    strike: sgr('9'),
    link: sgr('4;38;5;39'),
    inlineCode: sgr('38;5;180'),
    bullet: sgr('38;5;39'),
    quote: sgr('38;5;245'),
    rule: sgr('38;5;238'),
    code: sgr('38;5;252'),
    fenceBorder: sgr('38;5;238'),
    fenceLang: sgr('38;5;245'),
    more: sgr('38;5;245')
  }

  const syn = {
    keyword: sgr('38;5;170'),
    string: sgr('38;5;114'),
    number: sgr('38;5;180'),
    comment: sgr('3;38;5;243'),
    function: sgr('38;5;39'),
    type: sgr('38;5;80'),
    operator: sgr('38;5;210'),
    punctuation: sgr('38;5;245'),
    variable: sgr('38;5;252'),
    property: sgr('38;5;117'),
    tag: sgr('38;5;170'),
    attribute: sgr('38;5;180'),
    added: sgr('38;5;42'),
    removed: sgr('38;5;203'),
    meta: sgr('38;5;141')
  }

  // The desk scene owns its own palette: wood, plastic, paper and a bright red
  // telephone against the same blues as the mascot.
  const scene = {
    body: sgr('38;5;69'),
    // A shade off the body: enough to read the limb as a limb, not enough to
    // look like a different animal.
    flipper: sgr('38;5;75'),
    outline: sgr('38;5;25'),
    belly: sgr('38;5;231'),
    spout: sgr('38;5;245'),
    accent: sgr('38;5;222'),
    desk: sgr('38;5;137'),
    deskDark: sgr('38;5;94'),
    keyboard: sgr('38;5;238'),
    key: sgr('38;5;246'),
    phone: sgr('38;5;160'),
    phoneDark: sgr('38;5;88'),
    page: sgr('38;5;255'),
    pageShade: sgr('38;5;250'),
    pageDark: sgr('38;5;243'),
    windowEdge: sgr('38;5;110'),
    // The sky colour is rewritten every frame from the in-game clock; this is
    // only the fallback for a caller that does not provide one.
    sky: sgr('38;5;24'),
    // All four are rewritten every frame from the in-game clock and weather.
    skyLow: sgr('38;5;31'),
    landscape: sgr('38;5;236'),
    glow: sgr('38;5;230'),
    starDim: sgr('38;5;245'),
    windowFrame: sgr('38;5;180'),
    wall: sgr('38;5;145'),
    wallShade: sgr('38;5;102'),
    skirting: sgr('38;5;60'),
    floor: sgr('38;5;236'),
    // The z's sit on the wall, so they cannot be another mid grey.
    sleepZ: sgr('38;5;255'),
    tree: sgr('38;5;22'),
    ground: sgr('38;5;58'),
    cloud: sgr('38;5;252'),
    sun: sgr('38;5;220'),
    moon: sgr('38;5;253'),
    star: sgr('38;5;255'),
    rain: sgr('38;5;111'),
    snow: sgr('38;5;255'),
    fog: sgr('38;5;246'),
    windowFill: sgr('38;5;234'),
    bookGreen: sgr('38;5;65'),
    bookYellow: sgr('38;5;179'),
    bookCyan: sgr('38;5;73'),
    bubble: sgr('38;5;250'),
    bubbleFill: sgr('38;5;236'),
    text: sgr('38;5;253')
  }

  return { color, tag, level, ui, md, syn, scene }
}

/**
 * Wide-character-safe status glyph.
 * @param {'idle' | 'running' | 'tool' | 'waiting-approval' | 'error'} status
 * @param {number} frame rotating frame index
 * @returns {string}
 */
export function statusGlyph(status, frame) {
  switch (status) {
    case 'running':
      return ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame % 10]
    case 'tool':
      return ['◐', '◓', '◑', '◒'][frame % 4]
    case 'waiting-approval':
      return '▲'
    case 'error':
      return '✖'
    default:
      return '●'
  }
}

/**
 * Style for a status value.
 * @param {Theme} theme
 * @param {string} status
 * @returns {string}
 */
export function statusStyle(theme, status) {
  switch (status) {
    case 'running':
      return theme.ui.statusRunning
    case 'tool':
      return theme.ui.statusTool
    case 'waiting-approval':
      return theme.ui.statusApproval
    case 'error':
      return theme.ui.statusError
    default:
      return theme.ui.statusIdle
  }
}
