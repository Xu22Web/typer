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
