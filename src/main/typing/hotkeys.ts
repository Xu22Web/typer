export interface HotkeyRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregisterAll(): void
}

export interface HotkeyConfig {
  stop: string
  togglePause: string
}

export interface HotkeyHandlers {
  stop: () => void
  togglePause: () => void
}

export interface HotkeyReport {
  registered: string[]
  failed: Array<{ accelerator: string; reason: string }>
}

/**
 * @description 注册全局热键：输入过程中焦点在别的窗口上，界面按钮点不到，
 * 必须有一个系统级入口来紧急停止
 * @param registrar 注册器（Electron globalShortcut 的最小接口）
 * @param config 停止与暂停/继续的快捷键
 * @param handlers 对应的处理函数
 * @returns 成功与失败的清单；失败（被别的程序占用）不中断应用，交给 UI 提示
 */
export function registerHotkeys(
  registrar: HotkeyRegistrar,
  config: HotkeyConfig,
  handlers: HotkeyHandlers
): HotkeyReport {
  const report: HotkeyReport = { registered: [], failed: [] }
  const seen = new Set<string>()

  /**
   * @description 注册单个热键并把结果记入清单（空值、重复、被占用都算失败）
   * @param accelerator 加速键文本
   * @param callback 触发时的处理函数
   * @param label 未配置时用于提示的配置项名
   */
  const tryRegister = (accelerator: string, callback: () => void, label: string): void => {
    const trimmed = accelerator.trim()
    if (trimmed.length === 0) {
      report.failed.push({ accelerator: label, reason: '未配置快捷键' })
      return
    }
    if (seen.has(trimmed)) {
      report.failed.push({ accelerator: trimmed, reason: '与其他热键重复' })
      return
    }
    seen.add(trimmed)

    let ok = false
    try {
      ok = registrar.register(trimmed, callback)
    } catch {
      ok = false
    }

    if (ok) report.registered.push(trimmed)
    else report.failed.push({ accelerator: trimmed, reason: '已被其它程序占用或格式不合法' })
  }

  tryRegister(config.stop, handlers.stop, 'stop')
  tryRegister(config.togglePause, handlers.togglePause, 'togglePause')

  return report
}

/**
 * @description 注销全部热键；退出流程中即使失败也不抛出
 * @param registrar 注册器
 */
export function disposeHotkeys(registrar: HotkeyRegistrar): void {
  try {
    registrar.unregisterAll()
  } catch {
    // 退出流程中忽略
  }
}
