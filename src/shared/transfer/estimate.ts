import type { TransferJobSummary } from './transfer'

/**
 * 预计耗时估算（纯函数，界面与测试共用）。
 * 必须按实际注入方式计价：长帧走剪贴板粘贴（一次粘贴即一个动作），若按逐字符按键估算，几千字节的文件会被算成几小时，提示完全失真。
 */
export interface TransferEstimateConfig {
  insertMode: 'keystroke' | 'paste' | 'auto'
  /** auto 模式下超过多少字符改用粘贴 */
  autoPasteThreshold: number
  /** 片间额外停顿 */
  interFrameDelayMs: number
  /** 帧内每个动作的间隔；文件传输用确定性节奏，默认即引擎的最小动作间隔 */
  keystrokeIntervalMs?: number
  /** 一次粘贴的固定开销（写剪贴板 + Ctrl+V + 目标端消化） */
  pasteOverheadMs?: number
}

export interface TransferEstimate {
  ms: number
  /** 实际会用的注入方式（帧很长时几乎总是粘贴） */
  mode: 'keystroke' | 'paste' | 'mixed'
  pasteFrames: number
  keystrokeChars: number
}

/** 一次粘贴的固定开销：实测（写剪贴板 + Ctrl+V + 目标端回显）约 100~200ms。 */
export const PASTE_OVERHEAD_MS = 140

/**
 * 帧模式每个动作的间隔。文件传输**不受节奏与随机性设置影响**（见主进程的确定性节奏），
 * 帧内一律取引擎的最小动作间隔，因此这里也用同一取值，二者不会漂移。
 */
export const FRAME_KEYSTROKE_INTERVAL_MS = 1

/**
 * @description 按实际注入方式估算一次传输的耗时
 * @param summary 任务摘要
 * @param config 注入方式与间隔配置
 * @returns 预计耗时与本次实际会用的注入方式
 */
export function estimateTransferMs(
  summary: TransferJobSummary,
  config: TransferEstimateConfig
): TransferEstimate {
  const overhead = config.pasteOverheadMs ?? PASTE_OVERHEAD_MS
  const interval = config.keystrokeIntervalMs ?? FRAME_KEYSTROKE_INTERVAL_MS
  // 帧数 = 数据片 + 开始帧 + 结束帧
  const frames = summary.total + 2
  if (frames <= 0 || summary.frameChars <= 0) {
    return { ms: 0, mode: 'keystroke', pasteFrames: 0, keystrokeChars: 0 }
  }

  const averagePayload = Math.max(1, Math.round(summary.frameChars / frames) - 1)
  /**
   * @description 判断该长度的帧是否改用剪贴板粘贴
   * @param chars 帧的字符数
   * @returns 是否走粘贴
   */
  const usesPaste = (chars: number): boolean => {
    if (config.insertMode === 'paste') return true
    if (config.insertMode === 'keystroke') return false
    return chars >= Math.max(1, config.autoPasteThreshold)
  }

  const paste = usesPaste(averagePayload)
  const pasteFrames = paste ? frames : 0
  const keystrokeChars = paste ? 0 : summary.frameChars

  // 片间断顿只发生在两片之间（首片之前与末片之后都不等），因此是 total-1 次
  const pauses = Math.max(0, summary.total - 1)
  const ms = paste
    ? frames * overhead + pauses * config.interFrameDelayMs
    : (keystrokeChars + frames) * interval + pauses * config.interFrameDelayMs

  return {
    ms: Math.round(ms),
    mode: paste ? 'paste' : 'keystroke',
    pasteFrames,
    keystrokeChars
  }
}
