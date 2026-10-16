export type EngineState =
  'idle' | 'countdown' | 'running' | 'paused' | 'completed' | 'aborted' | 'failed'

export interface EngineSnapshot {
  state: EngineState
  typed: number
  total: number
  /** 倒计时剩余毫秒（仅 countdown 阶段有意义） */
  countdownRemainingMs: number
  /** 中止/失败原因 */
  message?: string
}

/**
 * @description 判断是否处于"进行中"状态（可被中止/暂停）
 * @param state 引擎状态
 * @returns 是否仍在倒计时、输入或暂停中
 */
export function isBusy(state: EngineState): boolean {
  return state === 'countdown' || state === 'running' || state === 'paused'
}

/**
 * @description 判断是否已到达终态（不会再有新的进度）
 * @param state 引擎状态
 * @returns 是否已完成 / 已中止 / 已失败
 */
export function isTerminal(state: EngineState): boolean {
  return state === 'completed' || state === 'aborted' || state === 'failed'
}

/** 引擎状态 → 界面展示文案。 */
export const STATE_LABELS: Readonly<Record<EngineState, string>> = {
  idle: '待机',
  countdown: '倒计时中',
  running: '输入中',
  paused: '已暂停',
  completed: '已完成',
  aborted: '已中止',
  failed: '出错'
}
