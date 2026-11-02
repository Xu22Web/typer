import type { TransferPace } from '@main/typing/scheduling/profile'

import { estimateTransferMs } from './estimate'
import {
  CHUNK_PRESETS,
  FRAME_HEAD_REDUNDANCY,
  symbolsForBytes,
  type TransferJobSummary
} from './transfer'

/**
 * 「还能省多少」：在现有参数附近找一组更省时的设置，并给出可直接采用的目标参数。
 *
 * 为什么不是原来的「1 小时 / 2 小时预算」：预算只回答"能不能达标"，做不到时也没有下一步；
 * 而耗时几乎只由两件事决定——**字符数**（片大小 → 帧头开销与片间停顿）与**每秒字符数**（节奏档）
 * ——这两项都能立刻算出"换掉能省多少"，于是提示可以直接变成动作。
 *
 * 纯函数：不读设置、不读时钟，速率与停顿由调用方按当前设置换算后传进来（见 `profileFor`），
 * 因此单测可以脱离 Electron 运行。
 */

/** 各档位的字符速率与片间停顿（调用方按设置换算，含"实测速率"覆盖） */
export interface PaceProfile {
  /** 每秒可下发的字符数 */
  charsPerSecond: number
  /** 片与片之间的额外停顿（毫秒） */
  gapMs: number
}

export interface SpeedUpOptions {
  /** 当前生效的参数 */
  current: { paceMode: TransferPace; chunkBytes: number; maxFrameChars: number }
  /** 取某档位的速率与停顿 */
  profileFor: (pace: TransferPace) => PaceProfile
  /** 低于这个绝对节省就不提（默认 20 秒：省不到 20 秒不值得让用户改设置） */
  minSavedMs?: number
  /** 低于这个比例也不提（默认 8%） */
  minSavedRatio?: number
}

/** 一条提速建议 */
export interface SpeedUpSuggestion {
  /** 一句话标题，例如 `节奏换成「极速」` */
  title: string
  /** 建议改哪几项 */
  kinds: Array<'chunk' | 'pace'>
  /** 预计能省下的毫秒数 */
  savedMs: number
  /** 相对当前的比例（0~1） */
  savedRatio: number
  /** 采用后的参数（直接写回设置） */
  next: { paceMode: TransferPace; chunkBytes: number; maxFrameChars: number }
  /** 采用后的预计耗时（毫秒） */
  nextMs: number
  /** 当前的预计耗时（毫秒） */
  currentMs: number
}

/** 档位顺序：从最稳到最快，标题里按这个顺序拼 */
const PACES: readonly TransferPace[] = ['safe', 'fast', 'turbo']

/** 档位的中文名（与设置页一致） */
export const PACE_LABELS: Readonly<Record<TransferPace, string>> = {
  safe: '稳健',
  fast: '快速',
  turbo: '极速'
}

/**
 * @description 按"如果换成这个片大小"重算摘要里与帧相关的字段。
 *
 * 只做估算：载荷总字符数不变（同一个文件、同一个符号表），变的是帧头与片间停顿的次数。
 * 帧头长度取自 `peakFrameChars`（最长帧 = 帧头 + 一个满片载荷），因此比"按总字符数平摊"准确得多。
 * @param summary 当前摘要
 * @param chunkBytes 候选片大小（线上字节）
 * @param maxFrameChars 配套的单帧字符上限
 * @returns 换片大小后的摘要（其余字段原样保留）
 */
export function withChunk(
  summary: TransferJobSummary,
  chunkBytes: number,
  maxFrameChars: number
): TransferJobSummary {
  if (chunkBytes === summary.chunkBytes && maxFrameChars === summary.maxFrameChars) return summary

  const payload = symbolsForBytes(summary.wireBytes, summary.alphabet)
  // 帧头 = 最长帧 - 当前片大小对应的载荷（必须用**当前**片大小：peakFrameChars 描述的是现状）
  const currentFullChunk = Math.min(summary.chunkBytes, Math.max(1, summary.wireBytes))
  const headPerFrame = Math.max(
    0,
    summary.peakFrameChars - symbolsForBytes(currentFullChunk, summary.alphabet)
  )
  const fixed = Math.max(0, summary.frameChars - payload - headPerFrame * summary.total)
  const total = summary.wireBytes === 0 ? 0 : Math.ceil(summary.wireBytes / chunkBytes)
  const tailBytes = total === 0 ? 0 : summary.wireBytes - (total - 1) * chunkBytes
  const nextFullChunk = Math.min(chunkBytes, Math.max(1, summary.wireBytes))

  return {
    ...summary,
    chunkBytes,
    maxFrameChars,
    total,
    tailBytes,
    frameChars: Math.round(payload + headPerFrame * total + fixed),
    peakFrameChars: Math.round(headPerFrame + symbolsForBytes(nextFullChunk, summary.alphabet))
  }
}

/**
 * @description 估算"某档节奏 + 某片大小"下的耗时
 * @param summary 当前摘要
 * @param pace 候选节奏档
 * @param chunkBytes 候选片大小
 * @param maxFrameChars 配套的单帧字符上限
 * @param profileFor 档位 → 速率与停顿
 * @returns 预计毫秒数
 */
function estimateWith(
  summary: TransferJobSummary,
  pace: TransferPace,
  chunkBytes: number,
  maxFrameChars: number,
  profileFor: SpeedUpOptions['profileFor']
): number {
  const profile = profileFor(pace)
  return estimateTransferMs(withChunk(summary, chunkBytes, maxFrameChars), {
    interFrameDelayMs: profile.gapMs,
    headCopies: FRAME_HEAD_REDUNDANCY,
    charsPerSecond: profile.charsPerSecond
  }).ms
}

/**
 * @description 计算提速建议；没有明显收益时返回 null（界面据此显示"已是推荐配置"）
 * @param summary 当前任务摘要；还没有任务时为 null
 * @param options 当前参数与各档位表现
 * @returns 提速建议或 null
 */
export function suggestSpeedUp(
  summary: TransferJobSummary | null,
  options: SpeedUpOptions
): SpeedUpSuggestion | null {
  if (!summary || summary.frameChars <= 0) return null
  const { current, profileFor } = options
  const minSavedMs = options.minSavedMs ?? 20_000
  const minSavedRatio = options.minSavedRatio ?? 0.08

  const currentMs = estimateWith(
    summary,
    current.paceMode,
    current.chunkBytes,
    current.maxFrameChars,
    profileFor
  )

  // 候选集：每档节奏 × 每个片大小预设（+ 当前值）。组合数很小，直接枚举比写启发式更可靠
  const chunks = new Map<number, number>()
  for (const preset of CHUNK_PRESETS) chunks.set(preset.chunkBytes, preset.maxFrameChars)
  chunks.set(current.chunkBytes, current.maxFrameChars)

  let bestMs = currentMs
  let bestPace = current.paceMode
  let bestChunk = current.chunkBytes
  let bestMaxFrameChars = current.maxFrameChars
  for (const pace of PACES) {
    for (const [chunkBytes, maxFrameChars] of chunks) {
      const ms = estimateWith(summary, pace, chunkBytes, maxFrameChars, profileFor)
      // 只接受"更省时"的组合；相等时不建议，避免无意义地让用户改设置
      if (ms < bestMs) {
        bestMs = ms
        bestPace = pace
        bestChunk = chunkBytes
        bestMaxFrameChars = maxFrameChars
      }
    }
  }

  const savedMs = currentMs - bestMs
  // 「省够时间」或「快够比例」任一成立就值得提：大文件上换片只快 0.2%，但那是好几分钟
  const worthIt = savedMs >= minSavedMs || (currentMs > 0 && savedMs / currentMs >= minSavedRatio)
  if (!worthIt) return null

  const paceChanged = bestPace !== current.paceMode
  const chunkChanged = bestChunk !== current.chunkBytes
  if (!paceChanged && !chunkChanged) return null

  const chunkLabel =
    CHUNK_PRESETS.find((preset) => preset.chunkBytes === bestChunk)?.label ?? '自定义'
  const parts: string[] = []
  if (chunkChanged) parts.push(`片大小换成「${chunkLabel}」`)
  if (paceChanged) parts.push(`节奏换成「${PACE_LABELS[bestPace]}」`)

  const kinds: Array<'chunk' | 'pace'> = []
  if (chunkChanged) kinds.push('chunk')
  if (paceChanged) kinds.push('pace')

  return {
    title: parts.join(' + '),
    kinds,
    savedMs,
    savedRatio: currentMs > 0 ? savedMs / currentMs : 0,
    next: { paceMode: bestPace, chunkBytes: bestChunk, maxFrameChars: bestMaxFrameChars },
    nextMs: bestMs,
    currentMs
  }
}

/**
 * @description 把毫秒说成"预计几点几分"（本地时间，取最近的整分）
 * @param ms 距现在的毫秒数
 * @param now 当前时刻（毫秒时间戳，便于测试）
 * @returns 形如 `14:05`；超过一天时返回 null（这时说"几点"没有意义）
 */
export function finishClock(ms: number, now: number): string | null {
  if (!Number.isFinite(ms) || ms < 0 || ms > 24 * 3600 * 1000) return null
  const at = new Date(now + ms)
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}
