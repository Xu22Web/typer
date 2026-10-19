/**
 * 注入档位：把"能跑多快"从散落的常数收成一张表。
 *
 * - `normal`：与历史行为一致 —— 每动作至少 1ms、逐字下发、批次小（停止/暂停最灵敏）。
 * - `turbo`：允许 0 间隔与亚毫秒节奏，由引擎攒批、宿主压力阀按目标端消化能力自适应；
 *   上限只作为 UI 量程，真正的速度取决于目标窗口。
 */
export type InjectionProfile = 'normal' | 'turbo'

/** 文件传输的节奏档：三档都逐动作投递（数据丢一个字符整片就废），差别只在间隔与攒批窗口。 */
export type TransferPace = 'safe' | 'fast' | 'turbo'

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
  /**
   * 是否每个动作单独一次 `SendInput`。
   *
   * 数据帧必须逐动作投递：实测真实 cmd 接收端下，攒批直投会静默丢字符（一次 16 KiB 片丢几十到几百个），
   * 逐动作投递在同样条件下零丢失。丢字符不会写坏数据（每片 CRC32 + 整文件 SHA-256 会立刻暴露），
   * 但会让整片重传，反而更慢。
   */
  perItem: boolean
}

export const PROFILE_LIMITS: Record<InjectionProfile, ProfileLimits> = {
  normal: { cps: [0.5, 200], chunkSize: [1, 64], minDelayMs: 1, batchBudgetMs: 0 },
  turbo: { cps: [0.5, 2000], chunkSize: [1, 512], minDelayMs: 0, batchBudgetMs: 250 }
}

export const TRANSFER_PACE_LIMITS: Record<TransferPace, TransferPaceLimits> = {
  // 帧内间隔 1ms/字符：实测真实终端在逐字符投递 + 1ms 间隔下零丢失。
  safe: { minDelayMs: 1, batchWindowMs: 16, batchActions: 64, frameGapMs: null, perItem: true },
  fast: { minDelayMs: 1, batchWindowMs: 16, batchActions: 128, frameGapMs: 0, perItem: true },
  // 极速档：逐动作投递（数据帧必须如此，攒批直投实测会静默丢字符），但取消 1ms 间隔，
  // 由宿主压力阀按目标端消化能力自适应。速度上限由目标端决定，不由我们决定。
  turbo: { minDelayMs: 0, batchWindowMs: 0, batchActions: 256, frameGapMs: 0, perItem: true }
}

/** 档位取值（供设置层做白名单校验） */
export const INJECTION_PROFILES: readonly InjectionProfile[] = ['normal', 'turbo']
export const TRANSFER_PACES: readonly TransferPace[] = ['safe', 'fast', 'turbo']

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
