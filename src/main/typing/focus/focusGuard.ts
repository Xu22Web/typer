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

/**
 * @description 判定两个前台窗口快照是否"同一个窗口"（hwnd 一致，或 pid + 标题一致）
 * @param a 目标窗口快照
 * @param b 当前窗口快照
 * @returns 是否为同一个窗口
 */
export function sameWindow(a: FocusSnapshot, b: FocusSnapshot): boolean {
  if (a.hwnd === b.hwnd) return true
  return a.pid === b.pid && a.title === b.title
}

/**
 * @description 纯函数版的焦点判定：off 不检查，warn 窗口变了只提示仍继续输入，
 * strict 窗口变了直接阻止（交由引擎暂停/中止）
 * @param mode 守卫模式
 * @param expected 倒计时开始前记录的目标窗口；null 表示未记录
 * @param current 当前前台窗口
 * @returns 是否阻止、窗口是否变化与需要提示的警告
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

/** 焦点守护：把"前台窗口是否仍是目标窗口"的查询与判定包在一起。 */
export class FocusGuard {
  /**
   * @description 用守卫模式与"查询前台窗口"的最小依赖创建守护
   * @param mode 守卫模式
   * @param driver 只取 foreground 的驱动切片
   */
  constructor(
    private readonly mode: FocusGuardMode,
    private readonly driver: Pick<KeyboardDriver, 'foreground'>
  ) {}

  /**
   * @description 倒计时开始前记录目标窗口；off 模式不做任何查询
   * @returns 目标窗口快照，未记录或查询失败时为 null
   */
  async capture(): Promise<FocusSnapshot | null> {
    if (this.mode === 'off') return null
    try {
      return await this.driver.foreground()
    } catch {
      // 拿不到前台窗口时保持宽松：不因为查询失败而拒绝输入
      return null
    }
  }

  /**
   * @description 再次查询前台窗口并给出判定
   * @param expected 目标窗口快照；null 表示不做检查
   * @returns 是否阻止、窗口是否变化与需要提示的警告
   */
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
