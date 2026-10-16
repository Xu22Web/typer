import type { TransferJobSummary } from './transfer'

/**
 * 预计耗时估算（纯函数，界面与测试共用）。
 *
 * 关键点：**必须按实际注入方式来算**。文件传输的每一帧通常很长，会走剪贴板粘贴
 * （一次粘贴 = 一个动作），如果按"逐字符按键"去估，几千字节的文件会被算成几个小时，
 * 提示完全失真。所以这里按帧判断走粘贴还是按键，再分别计价。
 */
export interface TransferEstimateConfig {
  insertMode: 'keystroke' | 'paste' | 'auto'
  /** auto 模式下超过多少字符改用粘贴 */
  autoPasteThreshold: number
  /** 片间额外停顿 */
  interFrameDelayMs: number
  /** 每个字符的基础间隔（由节奏设置换算） */
  baseIntervalMs: number
  /** 每帧行尾换行带来的额外停顿（按键模式下才有） */
  newlinePauseMs: number
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

export function estimateTransferMs(
  summary: TransferJobSummary,
  config: TransferEstimateConfig
): TransferEstimate {
  const overhead = config.pasteOverheadMs ?? PASTE_OVERHEAD_MS
  // 帧数 = 数据片 + 开始帧 + 结束帧
  const frames = summary.total + 2
  if (frames <= 0 || summary.frameChars <= 0) {
    return { ms: 0, mode: 'keystroke', pasteFrames: 0, keystrokeChars: 0 }
  }

  const averagePayload = Math.max(1, Math.round(summary.frameChars / frames) - 1)
  const usesPaste = (chars: number): boolean => {
    if (config.insertMode === 'paste') return true
    if (config.insertMode === 'keystroke') return false
    return chars >= Math.max(1, config.autoPasteThreshold)
  }

  const paste = usesPaste(averagePayload)
  const pasteFrames = paste ? frames : 0
  const keystrokeChars = paste ? 0 : summary.frameChars

  const ms = paste
    ? frames * (overhead + config.interFrameDelayMs)
    : keystrokeChars * config.baseIntervalMs + frames * config.newlinePauseMs

  return {
    ms: Math.round(ms),
    mode: paste ? 'paste' : 'keystroke',
    pasteFrames,
    keystrokeChars
  }
}
