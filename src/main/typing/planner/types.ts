/**
 * 键盘动作模型。
 *
 * 只有真实按键：远程桌面（RDP / Citrix / KVM）只转发键盘事件，`KEYEVENTF_UNICODE` 报文到不了远端，
 * 因此没有物理键位的字符（中文、emoji 等）直接列为不可输入。
 */
export type Modifier = 'shift' | 'ctrl' | 'alt' | 'win'

/**
 * 换行按键。
 *
 * 云桌面里常见两类目标：终端/编辑器要的是 Enter，聊天框与 Web 表单里 Enter 却会直接提交，
 * 所以需要把"换行"换成 Shift+Enter 或 Ctrl+Enter。
 */
export type NewlineKey = 'enter' | 'shift-enter' | 'ctrl-enter'

/**
 * 换行后的行首处理。
 *
 * 编辑器（VS Code 等）会在 Enter 后自动插入上一行的缩进，再叠加源文本自带的缩进，
 * 结果整行右移。这里用"回到列 0"的按键序列把行首拉回去：
 * - `off`：不处理（终端里没有自动缩进，也就不需要额外按键）
 * - `home`：只发 Home，把光标移回列 0
 * - `home-select`：Home 后再 Shift+End，选中该行残留的自动缩进/自动补全内容，后续输入直接覆盖
 */
export type LineStartMode = 'off' | 'home' | 'home-select'

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
