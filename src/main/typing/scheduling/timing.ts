import type { KeystrokeAction } from '../planner/types'
import { clamp, type Rng } from './rng'

export type SpeedMode = 'cps' | 'wpm' | 'interval'
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
 * @description 按当前设置与字符总数估算总耗时（用于 UI 预估，实际以真实输入为准）
 * @param charCount 动作总数
 * @param settings 节奏设置
 * @returns 预计总耗时毫秒数
 */
export function estimateTotalMs(charCount: number, settings: TimingSettings): number {
  const base = baseIntervalMsFor(settings)
  const extra =
    settings.jitterMs > 0 ? (settings.distribution === 'gaussian' ? 0 : settings.jitterMs / 2) : 0
  const burst =
    settings.burstSize > 0 ? Math.floor(charCount / settings.burstSize) * settings.burstPauseMs : 0
  return Math.max(charCount, 1) * (base + extra) + burst
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
   */
  constructor(
    private readonly settings: TimingSettings,
    private readonly rng: Rng
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

    if (action.kind === 'unicode' && action.continues) {
      return MIN_DELAY_MS
    }

    let delay = baseIntervalMsFor(this.settings) + this.sampleJitter()

    const char = action.char
    const isNewline = action.kind === 'key' && char === '\n'

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

    return Math.max(MIN_DELAY_MS, Math.round(delay))
  }

  /** @description 供 UI 展示：当前生效的基础间隔（已夹取到合法范围） */
  get baseIntervalMs(): number {
    return clamp(baseIntervalMsFor(this.settings), MIN_DELAY_MS, 60000)
  }
}
