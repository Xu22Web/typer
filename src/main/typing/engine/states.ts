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

export function isBusy(state: EngineState): boolean {
  return state === 'countdown' || state === 'running' || state === 'paused'
}

export function isTerminal(state: EngineState): boolean {
  return state === 'completed' || state === 'aborted' || state === 'failed'
}

export const STATE_LABELS: Readonly<Record<EngineState, string>> = {
  idle: '待机',
  countdown: '倒计时中',
  running: '输入中',
  paused: '已暂停',
  completed: '已完成',
  aborted: '已中止',
  failed: '出错'
}
