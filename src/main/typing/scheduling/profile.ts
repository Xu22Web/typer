/**
 * 注入档位：把"能跑多快"从散落的常数收成一张表。
 *
 * - `normal`：与历史行为一致 —— 每动作至少 1ms、逐字下发、批次小（停止/暂停最灵敏）。
 * - `turbo`：允许 0 间隔与亚毫秒节奏，由引擎攒批、宿主压力阀按目标端消化能力自适应；
 *   上限只作为 UI 量程，真正的速度取决于目标窗口。
 */
export type InjectionProfile = 'normal' | 'turbo'

/** 文件传输的节奏档：稳健保留每字符 1ms 下限，极速把节奏交给压力阀。 */
export type TransferPace = 'safe' | 'fast'

export interface ProfileLimits {
  /** 字符/秒的可选区间（UI 量程，不是节流器） */
  cps: readonly [number, number]
  /** 每批下发的动作数上限 */
  chunkSize: readonly [number, number]
  /** 每个动作的最小间隔（毫秒）；0 表示不设下限 */
  minDelayMs: number
  /** 单次请求的计划时长上限（毫秒）；0 表示不按时间切批 */
  batchBudgetMs: number
}

export interface TransferPaceLimits {
  /** 帧内每个字符的最小间隔（毫秒） */
  minDelayMs: number
  /** 攒批窗口（毫秒）；0 表示"整帧攒成一批"，按动作数切分 */
  batchWindowMs: number
  /** 单批动作上限 */
  batchActions: number
  /**
   * 片间停顿：`null` 表示用「设置 → 文件传输」里的值；
   * 数字表示该档位下的固定值（极速档不需要留出落盘时间，固定 0）。
   */
  frameGapMs: number | null
}

export const PROFILE_LIMITS: Record<InjectionProfile, ProfileLimits> = {
  normal: { cps: [0.5, 200], chunkSize: [1, 64], minDelayMs: 1, batchBudgetMs: 0 },
  turbo: { cps: [0.5, 2000], chunkSize: [1, 512], minDelayMs: 0, batchBudgetMs: 250 }
}

export const TRANSFER_PACE_LIMITS: Record<TransferPace, TransferPaceLimits> = {
  // 帧内间隔固定 1ms/字符（两个档位一致）：实测真实终端在逐字符投递 + 1ms 间隔下
  // 27,657 个字符零丢失，速率约 446 字符/秒——已经接近目标端消化输入的上限；
  // 再快就只是在灌满输入队列，目标端跟不上时 Windows 会直接丢字符（数据帧丢一个就整片作废）。
  // batchActions 也刻意保持很小：请求内宿主连续投递，一次给太多同样会丢。
  safe: { minDelayMs: 1, batchWindowMs: 16, batchActions: 32, frameGapMs: null },
  fast: { minDelayMs: 1, batchWindowMs: 16, batchActions: 32, frameGapMs: 0 }
}

/** 档位取值（供设置层做白名单校验） */
export const INJECTION_PROFILES: readonly InjectionProfile[] = ['normal', 'turbo']
export const TRANSFER_PACES: readonly TransferPace[] = ['safe', 'fast']

/**
 * @description 文本路径的攒批窗口：间隔越短，攒批越划算；接近人速时不攒批以免打乱节奏
 * @param profile 注入档位
 * @param baseIntervalMs 当前设置下的基础间隔（毫秒）
 * @returns 攒批窗口（毫秒）；0 表示逐字下发
 */
export function textBatchWindowMs(profile: InjectionProfile, baseIntervalMs: number): number {
  if (profile === 'turbo') return Math.min(16, Math.max(4, baseIntervalMs * 8))
  return baseIntervalMs < 6 ? 8 : 0
}
