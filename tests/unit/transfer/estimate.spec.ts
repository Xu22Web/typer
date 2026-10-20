import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHARS_PER_SECOND,
  PACE_CHARS_PER_SECOND,
  estimateTransferMs,
  meetsBudget
} from '@shared/transfer/estimate'
import type { TransferJobSummary } from '@shared/transfer/transfer'

/**
 * @description 造一个只关心 total / frameChars / mode 的任务摘要
 * @param total 片数
 * @param frameChars 帧字符总数（不含行尾）
 * @param mode 目标端模式
 * @returns 摘要
 */
function summary(
  total: number,
  frameChars: number,
  mode: TransferJobSummary['mode'] = 'term'
): TransferJobSummary {
  return {
    path: 'C:\\demo.bin',
    name: 'demo.bin',
    size: frameChars,
    job: 'a1b2c3d4',
    alphabet: 'ascii32',
    compression: 'none',
    quality: 0,
    mode,
    chunkBytes: 16384,
    maxFrameChars: 65536,
    total,
    sha256: '0'.repeat(64),
    wireBytes: frameChars,
    tailBytes: 16,
    peakFrameChars: 8700,
    frameChars,
    typedActions: frameChars,
    preview: [],
    looksUtf8: false,
    compressionNote: '',
    kind: 'binary',
    kindLabel: '二进制',
    prepareMs: 0
  }
}

describe('estimateTransferMs', () => {
  it('字符数 = 帧字符 + 每帧一个行尾（数据片 + 开始 + 结束）', () => {
    const result = estimateTransferMs(summary(3, 300), {
      interFrameDelayMs: 0,
      charsPerSecond: 1000
    })
    expect(result.keystrokeChars).toBe(305)
    expect(result.ms).toBe(305)
  })

  it('开始帧 / 结束帧连发多遍时按实际发送量算', () => {
    const once = estimateTransferMs(summary(3, 300), {
      interFrameDelayMs: 0,
      charsPerSecond: 1000
    })
    const thrice = estimateTransferMs(summary(3, 300), {
      interFrameDelayMs: 0,
      charsPerSecond: 1000,
      headCopies: 3
    })
    // 数据片 3 + 开始/结束各 3 遍 = 9 帧，每帧 1 个行尾
    expect(thrice.keystrokeChars).toBe(309)
    expect(thrice.ms).toBeGreaterThan(once.ms)
  })

  it('单行模式没有行尾：只算帧字符', () => {
    const result = estimateTransferMs(summary(3, 300, 'line'), {
      interFrameDelayMs: 0,
      charsPerSecond: 1000
    })
    expect(result.keystrokeChars).toBe(300)
  })

  it('片间断顿只发生在片与片之间（total-1 次）', () => {
    const base = { charsPerSecond: 1000 }
    const noPause = estimateTransferMs(summary(4, 400), { interFrameDelayMs: 0, ...base })
    const withPause = estimateTransferMs(summary(4, 400), { interFrameDelayMs: 100, ...base })
    expect(withPause.ms - noPause.ms).toBe(3 * 100)
  })

  it('空任务返回 0', () => {
    expect(estimateTransferMs(summary(0, 0), { interFrameDelayMs: 400 })).toEqual({
      ms: 0,
      keystrokeChars: 0,
      charsPerSecond: DEFAULT_CHARS_PER_SECOND
    })
  })

  it('耗时与每秒字符数成反比（用于对比不同目标端）', () => {
    const slow = estimateTransferMs(summary(2, 2000), { interFrameDelayMs: 0, charsPerSecond: 400 })
    const fast = estimateTransferMs(summary(2, 2000), {
      interFrameDelayMs: 0,
      charsPerSecond: 2000
    })
    expect(slow.ms / fast.ms).toBeCloseTo(5, 5)
  })

  it('默认速度取稳健档的实测值，而不是乐观的 1000 字符/秒', () => {
    expect(DEFAULT_CHARS_PER_SECOND).toBe(PACE_CHARS_PER_SECOND.safe)
    expect(DEFAULT_CHARS_PER_SECOND).toBeLessThanOrEqual(500)
  })
})

describe('meetsBudget', () => {
  it('把"能不能进 1 小时 / 2 小时"算成布尔与倍数', () => {
    expect(meetsBudget(30 * 60 * 1000, 60)).toEqual({ ok: true, ratio: 0.5 })
    expect(meetsBudget(150 * 60 * 1000, 60).ok).toBe(false)
    expect(meetsBudget(150 * 60 * 1000, 60).ratio).toBeCloseTo(2.5, 5)
  })
})
