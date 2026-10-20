import { iterateActions } from '../planner/plan'
import { PROFILE_LIMITS, type InjectionProfile } from './profile'
import { createRng } from './rng'
import { TimingScheduler, type TimingSettings } from './timing'
import type { TypoCorrection, TypoStyle } from './typo'

/** 预览估算用的固定种子：同一段内容每次算出来都一样，挪动光标不会让数字跳动 */
export const PREVIEW_SEED = 1

export interface TypingEstimateOptions {
  /** 节奏设置（与运行时同一份） */
  timing: TimingSettings
  /** 键盘布局 */
  layout?: string
  /** 造错设置；null / 省略表示不打错（与运行时保持一致才有可比性） */
  typo?: { rate: number; style: TypoStyle; correction: TypoCorrection } | null
  /** 注入档位：决定每个动作的最小间隔 */
  profile?: InjectionProfile
  /** 抖动与造错的随机种子，默认 {@link PREVIEW_SEED} */
  seed?: number
}

export interface TypingEstimate {
  /** 会产生按键的动作数（与运行时进度条的总数同口径） */
  actions: number
  /** 预计耗时（毫秒）：逐个动作的节奏延迟之和 */
  ms: number
}

/**
 * @description 按"真实计划"估一次文本输入：与引擎走同一套 planner + 节奏调度器，
 * 把每个动作的延迟加起来。因此标点/空格/换行/空行停顿、抖动、成组停顿与错字纠正
 * 都算进去了，而不是只拿 `字符数 × 基础间隔` 糊一个数。
 *
 * 差异只来自随机：预览用固定种子，实际运行用的是当次种子（或随机种子），
 * 所以数字应当接近而不是逐毫秒相同。
 * @param text 待输入文本（原始文本，换行/Tab 等由 planner 归一化）
 * @param options 节奏、布局、造错与档位
 * @returns 动作数与预计耗时
 */
export function estimateTypingMs(text: string, options: TypingEstimateOptions): TypingEstimate {
  const seed = options.seed ?? PREVIEW_SEED
  const profile = options.profile ?? 'normal'
  // 与引擎一致：节奏抖动与造错各自使用同种子的独立随机源，互不干扰对方的序列
  const scheduler = new TimingScheduler(
    options.timing,
    createRng(seed),
    PROFILE_LIMITS[profile].minDelayMs
  )
  const typo = options.typo ? { ...options.typo, rng: createRng(seed) } : null

  let ms = 0
  let actions = 0
  for (const action of iterateActions(text, { layout: options.layout, typo })) {
    ms += scheduler.delayFor(action)
    if (action.kind !== 'delay') actions += 1
  }

  return { actions, ms: Math.round(ms) }
}
