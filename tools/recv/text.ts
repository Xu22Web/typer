/**
 * 终端文本：可见宽度、按宽度裁剪、分段着色、进度条。
 *
 * 纯函数、零 I/O。这里是"进度行永远不会超出终端宽度"的唯一保证点——旧版按**字符数**补空格、
 * 忽略中文占两格，行一超宽终端就自动折行，于是"有时原地刷新、有时一行行往上滚"同时出现。
 */

/** 文本片段的可选样式（着色只在终端支持时生效，日志里永远不留转义序列） */
export type Style = 'plain' | 'dim' | 'bold' | 'ok' | 'warn' | 'err' | 'accent'

/** 一行文本由若干片段拼成：**先排版、后着色**，裁剪因此永远只作用在可见字符上 */
export interface Segment {
  text: string
  style?: Style
}

/** 样式 → ANSI 序列（`plain` 为空：不上色的输出与纯文本完全一致） */
const STYLE_CODES: Record<Style, string> = {
  plain: '',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  err: '\u001b[31m',
  accent: '\u001b[36m'
}

const RESET = '\u001b[0m'

/**
 * 东亚"宽字符"区段：这些码位的字形占两格。
 *
 * 只收真正会让行变宽的主流区段（CJK、全角符号、常见 emoji），不做完整 Unicode 宽度表：
 * 这里的目标是"宁可多算一格，也不要少算"，算多了只是浪费一点宽度，算少了会导致折行。
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2010, 0x2027],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd]
]

/** 组合符号（0 宽）：不算进宽度，否则会凭空多出空格 */
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f]
]

/**
 * @description 单个码位占几格
 * @param code 码位
 * @returns 0 / 1 / 2
 */
function charWidth(code: number): number {
  for (const [from, to] of ZERO_WIDTH_RANGES) if (code >= from && code <= to) return 0
  for (const [from, to] of WIDE_RANGES) if (code >= from && code <= to) return 2
  return 1
}

/**
 * @description 字符串在终端里占多少格（中文 / 全角符号 / emoji 算 2）
 * @param text 文本
 * @returns 格数
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0)
  return width
}

/** @description 一行片段的可见宽度 */
export function segmentsWidth(segments: readonly Segment[]): number {
  let width = 0
  for (const segment of segments) width += displayWidth(segment.text)
  return width
}

/**
 * @description 把文本裁到指定宽度以内（超宽时末尾补省略号，省略号按 2 格预留）
 * @param text 文本
 * @param maxWidth 允许的最大格数
 * @param ellipsis 省略号（ASCII 模式传 `~`）
 * @returns 裁剪后的文本；`maxWidth` 太小放不下省略号时返回空串
 */
export function clipText(text: string, maxWidth: number, ellipsis = '\u2026'): string {
  if (maxWidth <= 0) return ''
  if (displayWidth(text) <= maxWidth) return text
  // 省略号按 2 格预留：`…` 属 East Asian Ambiguous，中文控制台里可能占两格，
  // 少算一格的后果是行超宽 → 折行 → 原地重绘错乱，比多留一格严重得多
  const room = maxWidth - 2
  if (room <= 0) return ''
  let width = 0
  let out = ''
  for (const char of text) {
    const next = width + charWidth(char.codePointAt(0) ?? 0)
    if (next > room) break
    out += char
    width = next
  }
  return `${out}${ellipsis}`
}

/**
 * @description 把一行片段裁到指定宽度以内（丢掉放不下的片段，必要时裁剪最后一个）
 * @param segments 片段
 * @param maxWidth 允许的最大格数
 * @param ellipsis 省略号
 * @returns 新片段数组
 */
export function clipSegments(
  segments: readonly Segment[],
  maxWidth: number,
  ellipsis = '\u2026'
): Segment[] {
  const out: Segment[] = []
  let used = 0
  for (const segment of segments) {
    const width = displayWidth(segment.text)
    if (used + width <= maxWidth) {
      out.push(segment)
      used += width
      continue
    }
    const clipped = clipText(segment.text, maxWidth - used, ellipsis)
    if (clipped.length > 0) out.push({ text: clipped, style: segment.style })
    break
  }
  return out
}

/**
 * @description 给一段文本上色（一次性输出的整行信息用；不上色时原样返回）
 * @param text 文本
 * @param style 样式
 * @param color 是否上色
 * @returns 可直接写出的字符串
 */
export function paint(text: string, style: Style, color: boolean): string {
  return paintSegments([{ text, style }], color)
}

/**
 * @description 给一行片段上色
 * @param segments 片段
 * @param color 是否上色（非终端 / `NO_COLOR` / 不支持颜色时传 false）
 * @returns 可直接写出的字符串（上色时每个片段各自包裹转义序列）
 */
export function paintSegments(segments: readonly Segment[], color: boolean): string {
  if (!color) return segments.map((segment) => segment.text).join('')
  return segments
    .map((segment) => {
      const code = STYLE_CODES[segment.style ?? 'plain']
      return code.length === 0 ? segment.text : `${code}${segment.text}${RESET}`
    })
    .join('')
}

/** @description 拼一行纯文本（不上色）：日志、测试与自检用 */
export function plainText(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).join('')
}

/**
 * @description 进度条
 * @param ratio 0~1
 * @param width 宽度（格数）
 * @param unicode 是否可用方块字符（否则退回 ASCII）
 * @returns 形如 `████░░░░` / `####----`
 */
export function renderBar(ratio: number, width: number, unicode: boolean): string {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  const cells = Math.max(1, Math.floor(width))
  const filled = Math.round(clamped * cells)
  const full = unicode ? '\u2588' : '#'
  const empty = unicode ? '\u2591' : '-'
  return full.repeat(filled) + empty.repeat(cells - filled)
}

/** 转圈动画帧（`unicode` 为 false 时用 `|/-\`，任何控制台都能显示） */
const SPINNER_UNICODE = [
  '\u280b',
  '\u2819',
  '\u2839',
  '\u2838',
  '\u283c',
  '\u2834',
  '\u2826',
  '\u2827'
]
const SPINNER_ASCII = ['|', '/', '-', '\\']

/**
 * @description 取一帧动画
 * @param index 帧序号（自增即可，函数自己取模）
 * @param unicode 是否可用盲文点阵
 * @returns 一个字符
 */
export function spinnerFrame(index: number, unicode: boolean): string {
  const frames = unicode ? SPINNER_UNICODE : SPINNER_ASCII
  const safe = frames.length === 0 ? 1 : frames.length
  const at = ((index % safe) + safe) % safe
  return frames[at] as string
}
