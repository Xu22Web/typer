import type { TransferJobSummary } from './transfer'

/**
 * 预计耗时估算（纯函数，界面与测试共用）。
 *
 * 帧一律逐字符真实按键下发，因此耗时由「字符数 ÷ 每秒字符数」决定。
 * 每秒字符数在不同目标端差异极大（终端、记事本、云桌面客户端都不一样），
 * 所以这里接受一个可覆盖的 `charsPerSecond`：界面用最近一次实测值，没有实测时才用档位默认值。
 */
export interface TransferEstimateConfig {
  /** 片间额外停顿 */
  interFrameDelayMs: number
  /** 每秒字符数；省略则取 {@link DEFAULT_CHARS_PER_SECOND} */
  charsPerSecond?: number
}

export interface TransferEstimate {
  ms: number
  /** 需要逐字符键入的字符数（帧字符 + 每帧行尾换行） */
  keystrokeChars: number
  charsPerSecond: number
}

/**
 * 各档位的默认字符速度（字符/秒）。
 *
 * 来自实测：逐字符投递 + 1ms 间隔时，终端接收端约 446 字符/秒（27,657 字符零丢失）。
 * 攒批、关回显、压力阀自适应后能明显更高，但没有实测前不要拿它当承诺——
 * 界面上的「预计」在拿到实测值后会立刻被替换。
 */
export const PACE_CHARS_PER_SECOND = {
  safe: 446,
  fast: 446,
  // 实测（真实 cmd 接收端、逐动作投递 + 零间隔）：约 660–700 字符/秒。
  // 再往上取决于目标端消化能力，压力阀会自适应，所以这里只作为 UI 预估。
  turbo: 700
} as const

/** 没有实测值时的保守默认（对应用户最常用的稳健档）。 */
export const DEFAULT_CHARS_PER_SECOND = PACE_CHARS_PER_SECOND.safe

/**
 * @description 估算一次传输的耗时
 * @param summary 任务摘要
 * @param config 片间停顿与每秒字符数
 * @returns 预计耗时
 */
export function estimateTransferMs(
  summary: TransferJobSummary,
  config: TransferEstimateConfig
): TransferEstimate {
  const charsPerSecond = Math.max(1, config.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND)
  // 帧数 = 数据片 + 开始帧 + 结束帧（`line` 模式没有行尾换行，按 0 计）
  const lineBreaks = summary.mode === 'line' ? 0 : 1
  const frames = summary.total + 2
  if (summary.frameChars <= 0) {
    return { ms: 0, keystrokeChars: 0, charsPerSecond }
  }

  const keystrokeChars = summary.frameChars + frames * lineBreaks
  // 片间断顿只发生在两片之间（首片之前与末片之后都不等），因此是 total-1 次
  const pauses = Math.max(0, summary.total - 1)
  const ms = (keystrokeChars / charsPerSecond) * 1000 + pauses * config.interFrameDelayMs

  return { ms: Math.round(ms), keystrokeChars, charsPerSecond }
}

/**
 * @description 判断预计耗时是否落在给定预算内
 * @param ms 预计毫秒数
 * @param budgetMinutes 预算（分钟）
 * @returns 是否可行与超出比例
 */
export function meetsBudget(ms: number, budgetMinutes: number): { ok: boolean; ratio: number } {
  const budgetMs = budgetMinutes * 60 * 1000
  if (budgetMs <= 0) return { ok: true, ratio: 0 }
  return { ok: ms <= budgetMs, ratio: ms / budgetMs }
}
