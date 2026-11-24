/**
 * 时长格式化（纯函数，主进程与渲染进程共用）：按「时/分/秒」展示，值为 0 的位不显示，
 * 例如 `32秒`、`1分35秒`、`1小时1分1秒`。
 */

const MINUTE_SECONDS = 60
const HOUR_SECONDS = 3600

/**
 * @description 把毫秒格式化成「时/分/秒」，省略值为 0 的位
 * @param ms 毫秒数
 * @returns 人类可读的时长文本（非法输入返回破折号）
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'

  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / HOUR_SECONDS)
  const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / MINUTE_SECONDS)
  const seconds = totalSeconds % MINUTE_SECONDS

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}小时`)
  if (minutes > 0) parts.push(`${minutes}分`)
  // 秒是最后一位：全为 0 时也要给出单位，避免出现空字符串
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`)
  return parts.join('')
}

/**
 * @description 亚秒级时长：不足 1 秒时直接给毫秒数，避免「0 秒」这种没有信息量的结果
 * @param ms 毫秒数
 * @returns 人类可读的时长文本（非法输入返回破折号）
 */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms)) return '—'

  const value = Math.max(0, Math.round(ms))
  return value < 1000 ? `${value}毫秒` : formatDuration(value)
}

/**
 * @description 卡片主数值用的紧凑时长：最多两级单位，保证窄卡片内单行可容纳
 * @param ms 毫秒数
 * @returns 形如 `880毫秒`、`39分49秒`、`3小时39分` 的文本（非法输入返回破折号）
 */
export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms)) return '—'

  const value = Math.max(0, Math.round(ms))
  if (value < 1000) return `${value}毫秒`

  const totalSeconds = Math.round(value / 1000)
  if (totalSeconds < MINUTE_SECONDS) return `${totalSeconds}秒`

  const hours = Math.floor(totalSeconds / HOUR_SECONDS)
  const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / MINUTE_SECONDS)
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`

  const seconds = totalSeconds % MINUTE_SECONDS
  return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`
}
