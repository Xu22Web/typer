/**
 * @description 预置的"文件选择结果"队列：让自动化测试能确定性地回答原生文件对话框。
 *
 * 原生对话框由操作系统绘制，`SendKeys`、UI Automation 之类的手段都要依赖前台焦点与会话状态，
 * 在远程桌面、锁屏、多显示器等场景下并不可靠，也无法断言"用户到底选了什么"。
 * 因此在主进程这一层留一个显式开关：只有设置了环境变量 `TYPER_PICK_PATHS` 时才接管，
 * 其余情况（含所有正式打包版本）一律继续弹真实对话框，行为完全不变。
 */

/** 环境变量名：以分号分隔的路径列表，按顺序被依次消费。 */
export const PICK_QUEUE_ENV = 'TYPER_PICK_PATHS'

/** 表示"用户点了取消"的占位符（Windows 路径不可能等于单个减号）。 */
const CANCEL_TOKEN = '-'

/** 一次选择的预置结果：字符串为选中的路径，null 表示用户取消。 */
export type PickAnswer = string | null

/**
 * @description 把环境变量内容拆成按顺序消费的队列
 * @param source 环境变量原始值
 * @returns 非空条目列表（保持原顺序）
 */
export function parsePickQueue(source: string | undefined): string[] {
  if (!source) return []
  return source
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * @description 建立一个预置选择队列
 * @param source 环境变量原始值（默认读取 `TYPER_PICK_PATHS`）
 * @param enabled 是否启用；打包版本应传 false，避免被外部环境改写行为
 * @returns 队列对象，`next()` 返回 undefined 表示"没有预置，去弹真实对话框"
 */
export function createPickQueue(
  source: string | undefined = process.env[PICK_QUEUE_ENV],
  enabled = true
): { next: () => PickAnswer | undefined } {
  const pending = enabled ? parsePickQueue(source) : []
  return {
    next: () => {
      const head = pending.shift()
      if (head === undefined) return undefined
      return head === CANCEL_TOKEN ? null : head
    }
  }
}
