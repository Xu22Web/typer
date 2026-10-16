/**
 * IPC 错误信息清理。
 *
 * Electron 在渲染进程侧会给主进程抛出的错误套一层包装，例如：
 *   `Error invoking remote method 'settings:set': Error: 设置保存失败：EPERM …`
 * 这层包装对用户毫无意义，直接展示会让提示变得难读，所以在这里剥掉。
 */
export function cleanIpcErrorMessage(error: unknown): string {
  return cleanMessage(error instanceof Error ? error.message : String(error))
}

/** 纯字符串版本，便于单测。 */
export function cleanMessage(raw: string): string {
  let message = raw.trim()

  // 可能被套多层（invoke 包装 + Error: 前缀），循环剥到干净为止
  for (let round = 0; round < 4; round++) {
    const before = message
    message = message
      .replace(/^Error invoking remote method '[^']*':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim()
    if (message === before) break
  }

  return message.length > 0 ? message : '未知错误'
}

/** 统一把任意抛出物转成带清理后消息的 Error。 */
export function toIpcError(error: unknown): Error {
  return new Error(cleanIpcErrorMessage(error))
}
