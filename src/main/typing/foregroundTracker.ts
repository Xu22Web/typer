import type { HostForegroundData } from './drivers/protocol'

/**
 * 目标窗口解析：把「当前前台窗口」换成「用户真正想输入的那个窗口」。
 *
 * 为什么需要它：读前台窗口的两个入口（启动时初始化、点「重新检测」）都发生在 Typer 自己的窗口上，
 * 直接取 `GetForegroundWindow` 拿到的永远是 Typer 自己——点按钮这个动作本身就会把本程序激活。
 * 这里记住「最近一次不是本程序的前台窗口」，命中自身时回退到它。
 */
export interface ForegroundTracker {
  /** 采样一次：只在当前前台不是本程序时更新缓存（窗口失焦时调用） */
  capture: () => Promise<void>
  /** 解析目标窗口：前台是别家就直接用并记下；是自己或读不到就返回缓存的别家窗口 */
  resolve: () => Promise<HostForegroundData | null>
}

/** @description 是否算「别人的窗口」：有 pid、不是本进程、有标题 */
function isForeign(info: HostForegroundData | null, selfPid: number): info is HostForegroundData {
  return info !== null && info.pid > 0 && info.pid !== selfPid && info.title.trim().length > 0
}

/**
 * @description 创建目标窗口解析器
 * @param deps 读取前台窗口的依赖与"本进程 pid"
 * @returns 采样与解析两个入口
 */
export function createForegroundTracker(deps: {
  read: () => Promise<HostForegroundData | null>
  selfPid: () => number
}): ForegroundTracker {
  /** 最近一次不是本程序的前台窗口；null 表示还没有采样到 */
  let lastForeign: HostForegroundData | null = null

  return {
    async capture() {
      try {
        const info = await deps.read()
        if (isForeign(info, deps.selfPid())) lastForeign = info
      } catch {
        // 读不到就保留上一次的结果，不为一次查询失败丢掉已知目标
      }
    },

    async resolve() {
      try {
        const info = await deps.read()
        if (isForeign(info, deps.selfPid())) {
          lastForeign = info
          return info
        }
        return lastForeign
      } catch {
        // 查询失败同样退回缓存：界面宁可显示上次的目标窗口，也不要显示"未检测"
        return lastForeign
      }
    }
  }
}
