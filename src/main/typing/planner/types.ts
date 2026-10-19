/**
 * 键盘动作模型。
 *
 * 只有真实按键：远程桌面（RDP / Citrix / KVM）只转发键盘事件，`KEYEVENTF_UNICODE` 报文到不了远端，
 * 因此没有物理键位的字符（中文、emoji 等）直接列为不可输入。
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

/** 显式停顿。当前 planner 不产出（节奏停顿由 scheduling/timing 统一计算），保留给后续语法扩展。 */
export interface DelayAction {
  kind: 'delay'
  ms: number
  reason: 'newline' | 'paragraph' | 'explicit'
}

export type KeystrokeAction = KeyAction | DelayAction

export interface PlanStats {
  /** 归一化后的码点总数 */
  chars: number
  /** 产生的按键动作数（不含 delay） */
  typed: number
  /** 其中 CJK 字符数（用于提示） */
  cjk: number
  /** 没有物理键位、无法输入的可打印字符 → 次数 */
  unsupported: Record<string, number>
  /** 为提高真实感而插入的错字动作数 */
  typos: number
  /** 被跳过的不可输入字符 → 次数 */
  skipped: Record<string, number>
}

export interface TypingPlan {
  actions: KeystrokeAction[]
  stats: PlanStats
}
