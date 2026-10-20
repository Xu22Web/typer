/**
 * 全角 / 中文标点 → ASCII 近似字符的映射（纯函数，无 IO）。
 *
 * 为什么需要它：远程桌面（RDP / Citrix / 云桌面）只转发真实键盘事件，`KEYEVENTF_UNICODE`
 * 报文到不了远端，没有物理键位的字符只能换成"有键位的近似字符"再输入。
 * 这里只处理标点与全角形式：汉字、emoji 没有近似写法，硬换会篡改内容，
 * 仍然保持"开始前列为不可输入"的行为。
 *
 * 主进程与渲染进程共用（预览、开始前确认、日志），因此不依赖任何运行时环境。
 */

/**
 * 语义明确、能一对一换成 ASCII 的标点。
 *
 * 全角的 `，！？；：（）－～＃％` 等**不在这里**：它们属于全角 ASCII 区间，
 * 由 {@link toAsciiPunctuation} 按码点偏移统一折叠，避免漏项。
 * `《》` 也刻意不收录：`<` / `>` 在多数目标程序里有语义（HTML、重定向），换过去反而是错的。
 */
const ASCII_PUNCTUATION: Readonly<Record<string, string>> = {
  '\u3000': ' ', // U+3000 全角空格
  '\u3001': ',', // 、 顿号
  '\u3002': '.', // 。 句号
  '\u300c': '"', // 「
  '\u300d': '"', // 」
  '\u300e': "'", // 『
  '\u300f': "'", // 』
  '\u3010': '[', // 【
  '\u3011': ']', // 】
  '\u3014': '(', // 〔
  '\u3015': ')', // 〕
  '\u3016': '[', // 〖
  '\u3017': ']', // 〗
  '\u2018': "'", // ‘
  '\u2019': "'", // ’
  '\u201c': '"', // “
  '\u201d': '"', // ”
  '\u2013': '-', // – 短连接号
  '\u2014': '-', // — 破折号（`——` 会得到 `--`）
  '\u2026': '...', // … 省略号
  '\u00a0': ' ' // 不换行空格
}

/** 全角 ASCII 区间的起点：`！`（U+FF01） */
const FULLWIDTH_START = 0xff01
/** 全角 ASCII 区间的终点：`～`（U+FF5E） */
const FULLWIDTH_END = 0xff5e
/** 全角与半角的码点差：`！`(U+FF01) - `!`(0x21) = 0xFEE0 */
const FULLWIDTH_OFFSET = 0xfee0

/** 某一类标点被替换的情况 */
export interface PunctuationChange {
  /** 原字符 */
  from: string
  /** 替换成的 ASCII 近似字符（可能是多个字符，例如 `…` → `...`） */
  to: string
  /** 出现次数 */
  count: number
}

/** 一次映射的结果 */
export interface PunctuationResult {
  /** 替换后的文本；没有命中时与原文相同 */
  text: string
  /** 被替换的字符统计（按首次出现顺序） */
  changes: PunctuationChange[]
  /** 被替换的字符总数 */
  replaced: number
}

/**
 * @description 查询单个字符的 ASCII 近似替换
 * @param char 单个码点
 * @returns 近似字符；undefined 表示没有可用的近似写法（汉字、emoji、`《》` 等）
 */
export function toAsciiPunctuation(char: string): string | undefined {
  const mapped = ASCII_PUNCTUATION[char]
  if (mapped !== undefined) return mapped

  const cp = char.codePointAt(0)
  if (cp === undefined) return undefined
  if (cp >= FULLWIDTH_START && cp <= FULLWIDTH_END) {
    return String.fromCodePoint(cp - FULLWIDTH_OFFSET)
  }
  return undefined
}

/**
 * @description 把全角 / 中文标点替换成 ASCII 近似字符（其余字符原样保留）
 * @param input 原始文本
 * @returns 替换后的文本、替换清单与替换总数
 */
export function mapPunctuation(input: string): PunctuationResult {
  const out: string[] = []
  const counts = new Map<string, PunctuationChange>()
  let replaced = 0

  for (const char of input) {
    const to = toAsciiPunctuation(char)
    if (to === undefined) {
      out.push(char)
      continue
    }
    replaced += 1
    const existing = counts.get(char)
    if (existing) existing.count += 1
    else counts.set(char, { from: char, to, count: 1 })
    out.push(to)
  }

  return { text: out.join(''), changes: [...counts.values()], replaced }
}

/**
 * @description 生成替换清单的可读文案：`、 → ,（×2），。 → .（×1）`
 * @param changes 替换清单
 * @param limit 最多展示几种（超出部分只报总数）
 * @returns 单行文案；清单为空时返回空串
 */
export function describePunctuation(changes: readonly PunctuationChange[], limit = 8): string {
  if (changes.length === 0) return ''
  const visible = changes
    .slice(0, Math.max(0, limit))
    .map((change) => `${change.from} → ${change.to}（×${change.count}）`)
    .join('，')
  return changes.length > limit ? `${visible} …（共 ${changes.length} 种）` : visible
}
