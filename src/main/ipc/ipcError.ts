/**
 * IPC 错误信息清理：剥掉 Electron 在渲染进程侧给主进程错误套上的包装
 * （`Error invoking remote method 'settings:set': Error: 设置保存失败：EPERM …`），只留对用户有意义的原文。
 */

/**
 * @description 剥掉 Electron 的错误包装，得到可直接展示给用户的消息
 * @param error 任意抛出物
 * @returns 清理后的消息（为空时返回"未知错误"）
 */
export function cleanIpcErrorMessage(error: unknown): string {
  return cleanMessage(error instanceof Error ? error.message : String(error))
}

/**
 * @description 清理纯字符串形式的错误消息，便于单独测试
 * @param raw 原始错误文本
 * @returns 清理后的消息（为空时返回"未知错误"）
 */
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

/**
 * @description 统一把任意抛出物转成带清理后消息的 Error
 * @param error 任意抛出物
 * @returns 新的 Error 实例
 */
export function toIpcError(error: unknown): Error {
  return new Error(cleanIpcErrorMessage(error))
}
