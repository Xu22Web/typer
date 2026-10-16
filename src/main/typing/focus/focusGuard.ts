import type { KeyboardDriver } from '../drivers/KeyboardDriver'
import type { HostForegroundData } from '../drivers/protocol'

export type FocusGuardMode = 'off' | 'warn' | 'strict'

export type FocusSnapshot = HostForegroundData

export interface FocusVerdict {
  /** 是否应当阻止继续输入 */
  blocked: boolean
  /** 需要提示给用户的警告（warn 模式） */
  warning?: string
  changed: boolean
}

/** 判定两个前台窗口快照是否"同一个窗口"（hwnd 一致，或 pid + 标题一致）。 */
export function sameWindow(a: FocusSnapshot, b: FocusSnapshot): boolean {
  if (a.hwnd === b.hwnd) return true
  return a.pid === b.pid && a.title === b.title
}

/**
 * 纯函数版的焦点判定，便于测试三种模式的差异：
 * - off：不检查
 * - warn：窗口变了只提示，仍然继续输入
 * - strict：窗口变了直接阻止（交由引擎暂停/中止）
 */
export function evaluateFocus(
  mode: FocusGuardMode,
  expected: FocusSnapshot | null,
  current: FocusSnapshot
): FocusVerdict {
  if (mode === 'off' || expected === null) {
    return { blocked: false, changed: false }
  }

  if (sameWindow(expected, current)) {
    return { blocked: false, changed: false }
  }

  const message =
    `前台窗口已变化：期望「${expected.title}」，当前「${current.title}」。` +
    '请把焦点切回目标窗口。'

  return { blocked: mode === 'strict', changed: true, warning: message }
}

export class FocusGuard {
  constructor(
    private readonly mode: FocusGuardMode,
    private readonly driver: Pick<KeyboardDriver, 'foreground'>
  ) {}

  /** 倒计时开始前记录目标窗口。off 模式返回 null（不做任何查询）。 */
  async capture(): Promise<FocusSnapshot | null> {
    if (this.mode === 'off') return null
    try {
      return await this.driver.foreground()
    } catch {
      // 拿不到前台窗口时保持宽松：不因为查询失败而拒绝输入
      return null
    }
  }

  async verify(expected: FocusSnapshot | null): Promise<FocusVerdict> {
    if (this.mode === 'off' || expected === null) {
      return { blocked: false, changed: false }
    }
    let current: FocusSnapshot
    try {
      current = await this.driver.foreground()
    } catch {
      return { blocked: false, changed: false }
    }
    return evaluateFocus(this.mode, expected, current)
  }
}
