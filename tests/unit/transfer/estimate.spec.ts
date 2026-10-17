import { describe, expect, it } from 'vitest'
import { estimateTransferMs, FRAME_KEYSTROKE_INTERVAL_MS } from '@shared/transfer/estimate'
import type { TransferJobSummary } from '@shared/transfer/transfer'

/** @description 造一个只关心 total / frameChars 的任务摘要 */
function summary(total: number, frameChars: number): TransferJobSummary {
  return {
    path: 'C:\\demo.bin',
    name: 'demo.bin',
    size: frameChars,
    job: 'job00001',
    encoding: 'hex',
    chunkBytes: 1024,
    maxFrameChars: 4096,
    total,
    sha256: '0'.repeat(64),
    wireBytes: frameChars,
    tailBytes: 16,
    peakFrameChars: 2100,
    frameChars,
    typedActions: frameChars,
    preview: [],
    looksUtf8: false
  }
}

describe('estimateTransferMs', () => {
  it('帧数 = 数据片 + 开始帧 + 结束帧，字符数含每帧的行尾换行', () => {
    const result = estimateTransferMs(summary(3, 300), { interFrameDelayMs: 0 })
    // 3 片 + 开始 + 结束 = 5 帧；300 字符 + 5 个换行 = 305
    expect(result.keystrokeChars).toBe(305)
    expect(result.ms).toBe(305 * FRAME_KEYSTROKE_INTERVAL_MS)
  })

  it('片间断顿只发生在片与片之间（total-1 次）', () => {
    const noPause = estimateTransferMs(summary(4, 400), { interFrameDelayMs: 0 })
    const withPause = estimateTransferMs(summary(4, 400), { interFrameDelayMs: 100 })
    expect(withPause.ms - noPause.ms).toBe(3 * 100)
  })

  it('空任务返回 0', () => {
    expect(estimateTransferMs(summary(0, 0), { interFrameDelayMs: 400 })).toEqual({
      ms: 0,
      keystrokeChars: 0
    })
  })

  it('可以按调用方给的每字符耗时估算（用于对比不同注入方式）', () => {
    const fast = estimateTransferMs(summary(2, 200), {
      interFrameDelayMs: 0,
      keystrokeIntervalMs: 1
    })
    const slow = estimateTransferMs(summary(2, 200), {
      interFrameDelayMs: 0,
      keystrokeIntervalMs: 5
    })
    expect(slow.ms).toBe(fast.ms * 5)
  })

  it('每字符耗时取实测区间（1.9~5.3ms/字符）内的保守值，避免低估耗时', () => {
    // 曾用 1ms（=1000 字符/秒），比实测乐观 4~10 倍；这里锁住"不能退回乐观值"
    expect(FRAME_KEYSTROKE_INTERVAL_MS).toBeGreaterThanOrEqual(2)
    expect(FRAME_KEYSTROKE_INTERVAL_MS).toBeLessThanOrEqual(6)

    // 1MiB 的 hex 文件 ≈ 2M 帧字符：预计耗时应是分钟级（而不是乐观的几十秒）
    const big = estimateTransferMs(summary(2048, 2_100_000), { interFrameDelayMs: 400 })
    const minutes = big.ms / 60_000
    expect(minutes).toBeGreaterThan(60)
  })
})
