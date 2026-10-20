import type { KeystrokeAction } from '../planner/types'
import type { ScheduledAction } from '../drivers/protocol'
import { clamp, type Rng } from './rng'

export type SpeedMode = 'cps' | 'wpm' | 'interval' | 'max'
export type JitterDistribution = 'uniform' | 'gaussian'

/** 与节奏相关的设置子集（设置层会从这里派生完整的 Settings）。 */
export interface TimingSettings {
  speedMode: SpeedMode
  /** 字符/秒 */
  cps: number
  /** 词/分钟（按 1 词 = 5 字符折算） */
  wpm: number
  /** speedMode = interval 时的固定间隔 */
  baseIntervalMs: number
  /** 0 表示完全匀速 */
  jitterMs: number
  distribution: JitterDistribution
  /** 空格之后 */
  wordPauseMs: number
  /** 中英文标点之后 */
  punctuationPauseMs: number
  /** 换行之后 */
  newlinePauseMs: number
  /** 空行（连续两个换行）之后 */
  paragraphPauseMs: number
  /** 每输入 N 个字符插入一次较长停顿；0 表示关闭 */
  burstSize: number
  burstPauseMs: number
}

export const PUNCTUATION_CHARS = new Set([
  ',',
  '.',
  ';',
  ':',
  '!',
  '?',
  '，',
  '。',
  '；',
  '：',
  '！',
  '？',
  '、',
  '…',
  '—'
])

export const MIN_DELAY_MS = 1

/** 亚毫秒节奏的取整步长（毫秒）：极速档下基础间隔可能远小于 1ms */
export const SUB_MS_STEP = 0.25

/**
 * @description 把毫秒数按当前档位的步长取整并夹到下限
 * @param ms 原始毫秒数
 * @param floorMs 下限（0 表示允许 0 间隔）
 * @returns 取整后的毫秒数
 */
export function quantizeDelay(ms: number, floorMs: number): number {
  const step = floorMs >= MIN_DELAY_MS ? 1 : SUB_MS_STEP
  const rounded = Math.round(Math.max(ms, 0) / step) * step
  return Math.max(floorMs, Math.round(rounded * 100) / 100)
}

/**
 * 文件传输（帧模式）专用的确定性节奏。
 *
 * 帧模式把文件切成"每片一行"逐片送出，本质是**数据传输**而非演示打字，因此：
 * - 抖动、突发停顿、标点 / 词 / 换行 / 段落停顿只会拖慢传输，且一旦掺入随机数，
 *   "同样的输入得到同样的耗时"便不再成立，失败无法复现；
 * - 任何随机化都不会提升数据完整性，反而拉长输入窗口、增加丢字符的机会。
 *
 * 所以这里把所有影响节奏的项统一置 0，帧内节奏完全确定、可复现；每个动作的最小间隔
 * 由 `MIN_DELAY_MS` 兜底（`baseIntervalMs` 为 0 时仍至少等待 1ms，无法取 0）。
 * 片与片之间的停顿不属于帧内节奏，仍由 `EngineSettings.interFrameDelayMs` 单独控制。
 */
export const FRAME_MODE_TIMING: TimingSettings = {
  speedMode: 'interval',
  cps: 0,
  wpm: 0,
  baseIntervalMs: 0,
  jitterMs: 0,
  distribution: 'uniform',
  wordPauseMs: 0,
  punctuationPauseMs: 0,
  newlinePauseMs: 0,
  paragraphPauseMs: 0,
  burstSize: 0,
  burstPauseMs: 0
}

/**
 * @description 把速度设置换算成"每个字符的基础间隔"
 * @param settings 节奏设置
 * @returns 基础间隔毫秒数
 */
export function baseIntervalMsFor(settings: TimingSettings): number {
  switch (settings.speedMode) {
    case 'max':
      // 不限速：节奏完全交给目标端的消化能力（极速档专用）
      return 0
    case 'cps':
      return 1000 / Math.max(settings.cps, 0.01)
    case 'wpm':
      // 1 词 ≈ 5 字符
      return 60000 / (Math.max(settings.wpm, 1) * 5)
    case 'interval':
    default:
      return settings.baseIntervalMs
  }
}

/**
 * @description 把连续的小间隔攒成一批：每批只有第一个动作带延迟（等于该批间隔之和），
 * 其余动作延迟为 0。宿主是"见到延迟就先断批、再等待"，所以攒批后每批只产生一次
 * `SendInput`——总时长不变（延迟之和不变），但调用次数少一个数量级。
 *
 * 为什么需要：每次 `SendInput` 都要抢系统输入队列，次数太多会明显拖慢整台机器的输入处理
 * （实测逐字符断批时约 1.1ms CPU/字符，攒批后降到 0.18ms），还会让目标端被高频打断。
 *
 * 显式停顿（`delay` 动作）与不小于 `batchMs` 的间隔保持原位：它们是"节拍"而不是抖动。
 * `batchMs <= 0` 表示不设时间窗口：把连续动作整段攒成一批，只被显式停顿打断。
 *
 * `minGroup` 给每批一个动作数下限：目标端"每次被唤醒的处理开销"往往远大于每个字符的处理开销
 * （实测同一个目标：每 8 个字符一次 `SendInput` ≈ 76 字符/秒，每 128 个字符一次 ≈ 370 字符/秒），
 * 所以哪怕时间窗口已经到了，也要凑够这个数量再断批——总间隔不变，只是把字符分成更少的唤醒。
 * @param scheduled 动作与延迟
 * @param batchMs 攒批阈值（毫秒）；0 表示整段攒批
 * @param minGroup 每批至少多少个动作（默认 1）
 * @returns 攒批后的动作与延迟（延迟之和与原序列相同）
 */
export function coalesceDelays(
  scheduled: ScheduledAction[],
  batchMs: number,
  minGroup = 1
): ScheduledAction[] {
  const out: ScheduledAction[] = []
  let group: ScheduledAction[] = []
  let groupMs = 0

  /** @description 收掉当前批：把整批的间隔挂到第一个动作上 */
  const flushGroup = (): void => {
    if (group.length === 0) return
    const first = group[0] as ScheduledAction
    out.push({ action: first.action, delayMs: groupMs })
    for (let i = 1; i < group.length; i++) {
      const item = group[i] as ScheduledAction
      out.push({ action: item.action, delayMs: 0 })
    }
    group = []
    groupMs = 0
  }

  for (const item of scheduled) {
    if (item.action.kind === 'delay' || (batchMs > 0 && item.delayMs >= batchMs)) {
      flushGroup()
      out.push(item)
      continue
    }
    group.push(item)
    groupMs += item.delayMs
    if (batchMs > 0 && groupMs >= batchMs && group.length >= minGroup) flushGroup()
  }

  flushGroup()
  return out
}

/**
 * 节奏调度器：为每个动作计算"执行前应等待的毫秒数"。
 *
 * 显式停顿（`delay` 动作）直接返回其 ms；代理对的第二个 UTF-16 码元（`continues === true`）
 * 不额外计时，避免 emoji 被拉长一倍。
 */
export class TimingScheduler {
  private typed = 0
  private lastWasNewline = false

  /**
   * @description 用节奏设置与随机源创建调度器
   * @param settings 节奏设置
   * @param rng 抖动采样用的随机源
   * @param floorMs 每个动作的最小间隔（极速档传 0，允许 0 间隔与亚毫秒节奏）
   */
  constructor(
    private readonly settings: TimingSettings,
    private readonly rng: Rng,
    private readonly floorMs: number = MIN_DELAY_MS
  ) {}

  /** @description 清空计数，复用于下一次运行 */
  reset(): void {
    this.typed = 0
    this.lastWasNewline = false
  }

  /** @description 已计时的动作数 */
  get typedCount(): number {
    return this.typed
  }

  /**
   * @description 采样一次抖动值
   * @returns 抖动毫秒数，可为负
   */
  private sampleJitter(): number {
    const { jitterMs, distribution } = this.settings
    if (jitterMs <= 0) return 0
    if (distribution === 'gaussian') {
      // σ = jitter/3 → 约 99.7% 落在 ±jitter 内
      return this.rng.gaussian(0, jitterMs / 3, -jitterMs * 3, jitterMs * 3)
    }
    return (this.rng.next() * 2 - 1) * jitterMs
  }

  /**
   * @description 计算某动作执行前应等待的毫秒数（含标点/换行/成组停顿与抖动）
   * @param action 待执行的动作
   * @returns 延迟毫秒数，不小于 MIN_DELAY_MS
   */
  delayFor(action: KeystrokeAction): number {
    if (action.kind === 'delay') return Math.max(0, Math.round(action.ms))

    if (this.settings.speedMode === 'max') {
      this.typed += 1
      this.lastWasNewline = action.kind === 'key' && action.char === '\n'
      return 0
    }

    const char = action.char
    const isNewline = action.kind === 'key' && char === '\n'

    let delay = baseIntervalMsFor(this.settings) + this.sampleJitter()

    if (isNewline) {
      delay += this.settings.newlinePauseMs
      if (this.lastWasNewline) delay += this.settings.paragraphPauseMs
    } else if (char === ' ') {
      delay += this.settings.wordPauseMs
    } else if (PUNCTUATION_CHARS.has(char)) {
      delay += this.settings.punctuationPauseMs
    }

    this.typed += 1
    if (this.settings.burstSize > 0 && this.typed % this.settings.burstSize === 0) {
      delay += this.settings.burstPauseMs
    }

    this.lastWasNewline = isNewline

    return quantizeDelay(delay, this.floorMs)
  }

  /** @description 供 UI 展示：当前生效的基础间隔（已夹取到合法范围） */
  get baseIntervalMs(): number {
    return clamp(baseIntervalMsFor(this.settings), MIN_DELAY_MS, 60000)
  }
}
