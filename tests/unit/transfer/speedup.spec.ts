import { describe, expect, it } from 'vitest'
import {
  PACE_LABELS,
  finishClock,
  suggestSpeedUp,
  withChunk,
  type PaceProfile
} from '@shared/transfer/speedup'
import { symbolsForBytes, type TransferJobSummary } from '@shared/transfer/transfer'

/**
 * 造一份可控的任务摘要：载荷字符数与帧头开销都按真实公式给，
 * 这样"换片大小 / 换节奏档"的耗时差异才与实际一致。
 * @param overrides 覆盖字段
 * @returns 摘要
 */
function makeSummary(overrides: Partial<TransferJobSummary> = {}): TransferJobSummary {
  const wireBytes = overrides.wireBytes ?? 100_000
  const chunkBytes = overrides.chunkBytes ?? 16_384
  const alphabet = overrides.alphabet ?? 'ascii32'
  const total = overrides.total ?? Math.ceil(wireBytes / chunkBytes)
  const payload = symbolsForBytes(wireBytes, alphabet)
  const headPerFrame = 60
  return {
    path: 'C:/tmp/x.bin',
    name: 'x.bin',
    size: wireBytes,
    job: 'a1b2c3d4',
    alphabet,
    compression: 'none',
    quality: 9,
    mode: 'term',
    chunkBytes,
    maxFrameChars: 65_536,
    total,
    sha256: 'a'.repeat(64),
    wireBytes,
    tailBytes: wireBytes - (total - 1) * chunkBytes,
    peakFrameChars: headPerFrame + symbolsForBytes(chunkBytes, alphabet),
    frameChars: payload + headPerFrame * total + 600,
    typedActions: 0,
    preview: [],
    looksUtf8: false,
    compressionNote: '',
    kind: 'bin',
    kindLabel: '二进制',
    prepareMs: 1,
    ...overrides
  }
}

/** 与界面同口径的档位表现（这里写死，便于断言具体数字） */
function profile(pace: 'safe' | 'fast' | 'turbo'): PaceProfile {
  return { charsPerSecond: pace === 'turbo' ? 700 : 446, gapMs: pace === 'turbo' ? 0 : 120 }
}

describe('withChunk', () => {
  it('载荷字符数不变，变的是帧数与帧头开销', () => {
    const base = makeSummary()
    const larger = withChunk(base, 65_536, 262_144)
    const payload = symbolsForBytes(base.wireBytes, base.alphabet)

    expect(larger.total).toBe(2)
    expect(larger.chunkBytes).toBe(65_536)
    // 帧数从 7 片降到 2 片：帧头总开销也降下来，所以总字符数更少
    expect(larger.frameChars).toBeLessThan(base.frameChars)
    expect(larger.frameChars).toBeGreaterThan(payload)
    expect(larger.tailBytes).toBe(base.wireBytes - 65_536)
  })

  it('片大小没变时原样返回（不产生新的摘要对象）', () => {
    const base = makeSummary()
    expect(withChunk(base, base.chunkBytes, base.maxFrameChars)).toBe(base)
  })

  it('空文件不会出现负数尾巴', () => {
    const empty = makeSummary({ wireBytes: 0, total: 0, tailBytes: 0 })
    const chunked = withChunk(empty, 65_536, 262_144)
    expect(chunked.total).toBe(0)
    expect(chunked.tailBytes).toBe(0)
  })
})

describe('suggestSpeedUp', () => {
  it('节奏档太保守时建议换档，并给出能省多少', () => {
    const suggestion = suggestSpeedUp(makeSummary(), {
      current: { paceMode: 'safe', chunkBytes: 16_384, maxFrameChars: 65_536 },
      profileFor: profile
    })

    expect(suggestion).not.toBeNull()
    expect(suggestion?.next.paceMode).toBe('turbo')
    expect(suggestion?.kinds).toContain('pace')
    expect(suggestion?.title).toContain(PACE_LABELS.turbo)
    expect(suggestion?.savedMs).toBeGreaterThan(0)
    expect(suggestion?.savedRatio).toBeGreaterThan(0.2)
    expect(suggestion?.nextMs).toBeLessThan(suggestion?.currentMs ?? 0)
  })

  it('片数很多时也会建议换大片（帧头与片间停顿都少）', () => {
    // 40 MB / 16 KB = 2560 片，帧头开销约 15 万字符；换成 64 KB 只剩 640 片
    const big = makeSummary({ wireBytes: 40 * 1024 * 1024 })
    const suggestion = suggestSpeedUp(big, {
      current: { paceMode: 'turbo', chunkBytes: 16_384, maxFrameChars: 65_536 },
      profileFor: profile
    })

    expect(suggestion).not.toBeNull()
    expect(suggestion?.next.chunkBytes).toBe(65_536)
    expect(suggestion?.kinds).toContain('chunk')
  })

  it('片数不多时换大片收益太小，不打扰（省不到 20 秒不提）', () => {
    // 4 MB / 16 KB = 256 片，帧头只有约 1.5 万字符，省不到阈值
    const small = makeSummary({ wireBytes: 4 * 1024 * 1024 })
    const suggestion = suggestSpeedUp(small, {
      current: { paceMode: 'turbo', chunkBytes: 16_384, maxFrameChars: 65_536 },
      profileFor: profile
    })
    expect(suggestion).toBeNull()
  })

  it('已经是最优组合时不给建议（界面显示“已是推荐配置”）', () => {
    const big = makeSummary({ wireBytes: 4 * 1024 * 1024 })
    const suggestion = suggestSpeedUp(big, {
      current: { paceMode: 'turbo', chunkBytes: 65_536, maxFrameChars: 262_144 },
      profileFor: profile
    })
    expect(suggestion).toBeNull()
  })

  it('收益太小时也不打扰（阈值可调）', () => {
    const suggestion = suggestSpeedUp(makeSummary(), {
      current: { paceMode: 'safe', chunkBytes: 16_384, maxFrameChars: 65_536 },
      profileFor: profile,
      // 「省够时间」与「快够比例」必须同时提高到不可能达到，才能干净地验证"收益小就不提"
      minSavedMs: 10 * 60 * 1000,
      minSavedRatio: 0.9
    })
    expect(suggestion).toBeNull()
  })

  it('没有任务时返回 null', () => {
    expect(
      suggestSpeedUp(null, {
        current: { paceMode: 'safe', chunkBytes: 16_384, maxFrameChars: 65_536 },
        profileFor: profile
      })
    ).toBeNull()
  })
})

describe('finishClock', () => {
  const noon = new Date(2026, 10, 2, 12, 0, 0).getTime()

  it('按"现在 + 耗时"给出几点几分', () => {
    expect(finishClock(0, noon)).toBe('12:00')
    expect(finishClock(25 * 60_000, noon)).toBe('12:25')
    expect(finishClock(65 * 60_000, noon)).toBe('13:05')
  })

  it('超过一天就不再说"几点"（换天说时刻会误导）', () => {
    expect(finishClock(25 * 3600 * 1000, noon)).toBeNull()
    expect(finishClock(-1, noon)).toBeNull()
  })
})
