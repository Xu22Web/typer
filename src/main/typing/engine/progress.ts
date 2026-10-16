/** 帧模式（文件传输）的进度：多一个"片"维度，便于用户看到"第几片 / 共几片"。 */
export interface ProgressFrames {
  /** 本次运行已发送的片数 */
  done: number
  /** 本次运行计划发送的片数 */
  total: number
  /** 最近一片的片号（任务的 0 基序号） */
  lastIndex: number
  /** 发送失败的片数 */
  failed: number
}

export interface ProgressInput {
  typed: number
  total: number
  elapsedMs: number
  /** 用于在没有样本时估算剩余时间 */
  baseIntervalMs: number
  stage: 'countdown' | 'typing'
  countdownRemainingMs?: number
  /** 仅文件传输任务提供 */
  frames?: ProgressFrames
}

export interface ProgressSnapshot {
  typed: number
  total: number
  /** 0 ~ 1 */
  percent: number
  elapsedMs: number
  remainingMs: number
  /** 实际平均速度（动作/秒） */
  aps: number
  stage: 'countdown' | 'typing'
  countdownRemainingMs: number
  /** 仅文件传输任务提供 */
  frames?: ProgressFrames
}

/** 进度与 ETA 计算：把手上的计数变成 UI 需要的指标。 */
export function computeProgress(input: ProgressInput): ProgressSnapshot {
  const { typed, total, elapsedMs, baseIntervalMs, stage } = input
  const safeTotal = Math.max(0, total)
  const safeTyped = Math.max(0, Math.min(typed, safeTotal))
  const percent = safeTotal === 0 ? 1 : safeTyped / safeTotal
  const aps = elapsedMs > 0 ? safeTyped / (elapsedMs / 1000) : 0

  const measured = safeTyped > 0 && elapsedMs > 0 ? elapsedMs / safeTyped : 0
  // 没有可用样本（或样本为 0）时退回设置里的基础间隔，避免 ETA 变成 0 误导用户
  const perActionMs = measured > 0 ? measured : Math.max(1, baseIntervalMs)
  const remainingMs = Math.max(0, Math.round((safeTotal - safeTyped) * perActionMs))

  return {
    typed: safeTyped,
    total: safeTotal,
    percent,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    remainingMs,
    aps,
    stage,
    countdownRemainingMs: Math.max(0, Math.round(input.countdownRemainingMs ?? 0)),
    frames: input.frames
      ? {
          done: Math.max(0, input.frames.done),
          total: Math.max(0, input.frames.total),
          lastIndex: input.frames.lastIndex,
          failed: Math.max(0, input.frames.failed)
        }
      : undefined
  }
}
