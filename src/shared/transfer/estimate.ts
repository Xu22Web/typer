import type { TransferJobSummary } from './transfer'

/**
 * 预计耗时估算（纯函数，界面与测试共用）。
 * 帧一律**逐字符真实按键**下发，因此按"帧字符总数 × 帧内间隔 + 片间断顿"估算。
 */
export interface TransferEstimateConfig {
  /** 片间额外停顿 */
  interFrameDelayMs: number
  /** 帧内每个字符的注入耗时；默认取 {@link FRAME_KEYSTROKE_INTERVAL_MS} */
  keystrokeIntervalMs?: number
}

export interface TransferEstimate {
  ms: number
  /** 需要逐字符键入的字符数（帧字符 + 每帧行尾换行） */
  keystrokeChars: number
}

/**
 * 帧模式每个字符的注入耗时（毫秒/字符）。
 *
 * 实测（协议 v2 + 宿主批量注入，N=2000 字符）：
 *   · 重消费者（WinForms TextBox，每字符重排重绘）≈ 4.3 ~ 5.3 ms/字符
 *   · 轻消费者（只记录 WM_CHAR）≈ 1.9 ~ 2.5 ms/字符
 * 目标端是终端时落在这个区间内，这里取偏保守的一端——宁可略微高估，也不要把耗时说小；
 * 真正的速度仍然取决于目标程序消化输入的快慢（本常量只是一个量级估算的量尺）。
 *
 * 曾经用的是 1ms（等价于 1000 字符/秒），会把文件传输的预计耗时低估约 4~10 倍。
 */
export const FRAME_KEYSTROKE_INTERVAL_MS = 4

/**
 * @description 估算一次传输的耗时（逐字符按键）
 * @param summary 任务摘要
 * @param config 间隔配置
 * @returns 预计耗时
 */
export function estimateTransferMs(
  summary: TransferJobSummary,
  config: TransferEstimateConfig
): TransferEstimate {
  const interval = config.keystrokeIntervalMs ?? FRAME_KEYSTROKE_INTERVAL_MS
  // 帧数 = 数据片 + 开始帧 + 结束帧
  const frames = summary.total + 2
  if (frames <= 0 || summary.frameChars <= 0) {
    return { ms: 0, keystrokeChars: 0 }
  }

  // 每帧除帧内容外还要打一个行尾换行
  const keystrokeChars = summary.frameChars + frames
  // 片间断顿只发生在两片之间（首片之前与末片之后都不等），因此是 total-1 次
  const pauses = Math.max(0, summary.total - 1)
  const ms = keystrokeChars * interval + pauses * config.interFrameDelayMs

  return { ms: Math.round(ms), keystrokeChars }
}
