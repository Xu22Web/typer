/**
 * 面向人读的格式化：大小、速率、时长、百分比。
 *
 * 纯函数：所有排版细节（保留几位小数、什么时候换成 KB）都收在这里，
 * 进度排版与最终摘要用同一套口径，不会出现"进度说 12 KB、摘要说 12.0 KB"。
 */

/**
 * @description 字节数 → 人读大小
 * @param bytes 字节数
 * @returns 形如 `0 B` / `191 B` / `12.3 KB` / `3.4 MB`
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // 一位小数只在 <10 时有意义；再大就别浪费那一格宽度了
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * @description 字节/秒 → 人读速率
 * @param bytesPerSecond 每秒字节数
 * @returns 形如 `14.2 KB/s`
 */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--'
  return `${formatSize(bytesPerSecond)}/s`
}

/**
 * @description 毫秒 → 计时器样式（进度行里用，力求短）
 * @param ms 毫秒
 * @returns 形如 `00:42` / `12:05` / `1:02:33`
 */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const pad = (value: number): string => String(value).padStart(2, '0')
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
  return `${pad(minutes)}:${pad(seconds % 60)}`
}

/**
 * @description 毫秒 → 口语时长（最终摘要里用）
 * @param ms 毫秒
 * @returns 形如 `8 秒` / `3 分 20 秒` / `1 时 5 分`
 */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`
}

/**
 * @description 0~1 → 百分比
 * @param ratio 比例
 * @param digits 小数位（0 用于"当前片"这类窄字段）
 * @returns 形如 `62.5%`
 */
export function formatPercent(ratio: number, digits = 1): string {
  const value = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  return `${(value * 100).toFixed(digits)}%`
}
