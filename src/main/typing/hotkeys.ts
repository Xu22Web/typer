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
 * 注册全局热键。
 *
 * 之所以需要全局热键：输入过程中焦点在**别的窗口**上，
 * 本程序的界面按钮点不到，必须有一个系统级入口来紧急停止。
 *
 * 注册失败（被别的程序占用）不应中断应用，只记录下来交给 UI 提示。
 */
export function registerHotkeys(
  registrar: HotkeyRegistrar,
  config: HotkeyConfig,
  handlers: HotkeyHandlers
): HotkeyReport {
  const report: HotkeyReport = { registered: [], failed: [] }
  const seen = new Set<string>()

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

export function disposeHotkeys(registrar: HotkeyRegistrar): void {
  try {
    registrar.unregisterAll()
  } catch {
    // 退出流程中忽略
  }
}
