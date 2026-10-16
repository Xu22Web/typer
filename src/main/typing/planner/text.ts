/**
 * 文本归一化与字符分类工具（纯函数，无副作用）：把来源各异的文本整理成可按键输入的码点序列。
 */

/** 归一化过程中被跳过的字符 → 次数。 */
export type SkipReport = Record<string, number>

export interface NormalizeResult {
  text: string
  skipped: SkipReport
}

/** 解释型不可见字符：无法输入、且对结果没有意义，直接跳过。 */
const INVISIBLE = new Set<number>([
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x2060, // WORD JOINER
  0xfeff, // ZERO WIDTH NO-BREAK SPACE（BOM）
  0x00ad // SOFT HYPHEN
])

/** 各种换行写法，统一成 `\n`。 */
const LINE_BREAKS = new Set<number>([
  0x000d, // \r
  0x000a, // \n
  0x0085, // NEL
  0x2028, // LINE SEPARATOR
  0x2029 // PARAGRAPH SEPARATOR
])

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x2eff], // CJK 部首补充
  [0x3000, 0x303f], // CJK 符号与标点（、。「」等全角标点）
  [0x3040, 0x30ff], // 日文假名
  [0x3100, 0x312f], // 注音符号
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xac00, 0xd7af], // 谚文
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xffef], // 全角 / 半角形式
  [0x20000, 0x2fa1f], // CJK 扩展 B 及以后
  [0x1f200, 0x1f2ff] // 带圈 CJK
]

/**
 * @description 判断单个码点是否属于 CJK / 全角标点等需要 Unicode 注入的范围
 * @param codePoint 单个码点
 * @returns 是否属于 CJK 相关区间
 */
export function isCjk(codePoint: string): boolean {
  const cp = codePoint.codePointAt(0)
  if (cp === undefined) return false
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

/**
 * @description 判断是否是可直接按键输入的可打印 ASCII（0x20–0x7e，且是单个码元）
 * @param codePoint 单个码点
 * @returns 是否为可打印 ASCII
 */
export function isPrintableAscii(codePoint: string): boolean {
  if (codePoint.length !== 1) return false
  const cp = codePoint.charCodeAt(0)
  return cp >= 0x20 && cp <= 0x7e
}

/**
 * @description 把字符串按码点拆分（代理对保持为单个元素）
 * @param text 原始文本
 * @returns 码点数组
 */
export function toCodePoints(text: string): string[] {
  return Array.from(text)
}

/**
 * @description 把一个码点拆成 UTF-16 码元；Windows `SendInput` 的 `KEYEVENTF_UNICODE`
 * 每次只能投递一个码元，所以 U+10000 以上的字符（emoji 等）必须拆成两个动作
 * @param codePoint 单个码点
 * @returns 该码点对应的码元序列
 */
export function toUtf16Units(codePoint: string): number[] {
  const units: number[] = []
  for (let i = 0; i < codePoint.length; i++) {
    units.push(codePoint.charCodeAt(i))
  }
  return units
}

/**
 * @description 归一化待输入文本：去掉开头 BOM、统一换行为 `\n`、跳过控制字符与零宽字符、
 * 保留 Tab（会映射为真实 Tab 键）；连续换行必须保留（空行会影响段落停顿与实际输出内容），
 * 只有 `\r\n` 这种"一个换行由两个字符表示"的情况才会被合并成一个 `\n`
 * @param input 原始文本
 * @returns 归一化后的文本与被跳过字符的计数
 */
export function normalizeText(input: string): NormalizeResult {
  const skipped: SkipReport = {}
  const skip = (char: string): void => {
    skipped[char] = (skipped[char] ?? 0) + 1
  }

  const out: string[] = []
  // 累计的换行事件数：CRLF 只算一次
  let pendingBreaks = 0
  let justSawCr = false

  const flushBreaks = (): void => {
    while (pendingBreaks > 0) {
      out.push('\n')
      pendingBreaks -= 1
    }
  }

  for (const char of toCodePoints(input)) {
    const cp = char.codePointAt(0) as number

    if (cp === 0x000d) {
      pendingBreaks += 1
      justSawCr = true
      continue
    }

    if (LINE_BREAKS.has(cp)) {
      // \n 紧跟在 \r 之后时，已经被 CR 计入一次换行
      if (!(cp === 0x000a && justSawCr)) pendingBreaks += 1
      justSawCr = false
      continue
    }

    justSawCr = false

    if (cp === 0x0009) {
      // Tab 保留（映射为真实 Tab 键），但要把前面挂起的换行先落地
      flushBreaks()
      out.push('\t')
      continue
    }

    if (cp < 0x20 || cp === 0x7f || INVISIBLE.has(cp)) {
      skip(char)
      continue
    }

    flushBreaks()
    out.push(char)
  }

  flushBreaks()

  return { text: out.join(''), skipped }
}

/**
 * @description 便于日志/UI 展示的跳过字符描述
 * @param skipped 被跳过字符的计数
 * @returns 形如 `ESC×2、ZWSP×1` 的一句话
 */
export function describeSkipped(skipped: SkipReport): string {
  return Object.entries(skipped)
    .map(([char, count]) => `${controlName(char)}×${count}`)
    .join('、')
}

/**
 * @description 把控制字符映射成可读名字（未知控制字符回退成 U+XXXX）
 * @param char 单个码点
 * @returns 该字符的展示名
 */
function controlName(char: string): string {
  const cp = char.codePointAt(0) as number
  const names: Record<number, string> = {
    0x0000: 'NUL',
    0x0007: 'BEL',
    0x0008: 'BS',
    0x000b: 'VT',
    0x000c: 'FF',
    0x001b: 'ESC',
    0x007f: 'DEL',
    0x200b: 'ZWSP',
    0x200c: 'ZWNJ',
    0x2060: 'WJ',
    0xfeff: 'BOM',
    0x00ad: 'SHY'
  }
  if (names[cp]) return names[cp]
  if (cp < 0x20 || cp === 0x7f) return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
  return char
}
