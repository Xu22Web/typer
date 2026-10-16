/**
 * 键盘动作模型。
 *
 * 真实按键（`key`）由目标窗口按自己的布局把 `vk` 翻译成字符，同一 vk 在不同布局下会得到不同字符；
 * Unicode 报文（`unicode`）直接投递 UTF-16 码元、绕过布局与输入法，是 CJK / emoji 等字符唯一可靠的通用方式。
 */
export type Modifier = 'shift' | 'ctrl' | 'alt' | 'win'

/** 真实虚拟键事件。 */
export interface KeyAction {
  kind: 'key'
  vk: number
  modifiers: Modifier[]
  /** 该动作期望产生的字符，用于进度、日志与断言。 */
  char: string
}

/** `KEYEVENTF_UNICODE` 报文，`codeUnit` 是 UTF-16 码元（BMP 外字符会拆成两个动作）。 */
export interface UnicodeAction {
  kind: 'unicode'
  codeUnit: number
  char: string
  /** 该动作是同一个码点的后续码元（代理对的低半区）：调度器不为它单独计时，进度统计里合并计数 */
  continues?: boolean
}

/** 显式停顿。当前 planner 不产出（节奏停顿由 scheduling/timing 统一计算），保留给后续语法扩展。 */
export interface DelayAction {
  kind: 'delay'
  ms: number
  reason: 'newline' | 'paragraph' | 'explicit'
}

export type KeystrokeAction = KeyAction | UnicodeAction | DelayAction

export interface PlanStats {
  /** 归一化后的码点总数 */
  chars: number
  /** 产生的按键/Unicode 动作数（不含 delay） */
  typed: number
  /** 其中 CJK 字符数 */
  cjk: number
  /** 因当前布局缺失而回退到 Unicode 的可打印 ASCII 字符数 */
  layoutFallbacks: number
  /** 因非 ASCII 而走 Unicode 的字符数 */
  unicodeChars: number
  /** 为提高真实感而插入的错字动作数 */
  typos: number
  /** 被跳过的不可输入字符 → 次数 */
  skipped: Record<string, number>
}

export interface TypingPlan {
  actions: KeystrokeAction[]
  stats: PlanStats
}
