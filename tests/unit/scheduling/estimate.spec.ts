import { describe, expect, it } from 'vitest'
import { estimateTypingMs } from '@main/typing/scheduling/estimate'
import type { TimingSettings } from '@main/typing/scheduling/timing'

/**
 * @description 构造一份带默认值的节奏设置
 * @param overrides 需要覆盖的字段
 * @returns 完整的 TimingSettings
 */
function timing(overrides: Partial<TimingSettings> = {}): TimingSettings {
  return {
    speedMode: 'interval',
    cps: 10,
    wpm: 120,
    baseIntervalMs: 100,
    jitterMs: 0,
    distribution: 'uniform',
    wordPauseMs: 0,
    punctuationPauseMs: 0,
    newlinePauseMs: 0,
    paragraphPauseMs: 0,
    burstSize: 0,
    burstPauseMs: 0,
    ...overrides
  }
}

describe('estimateTypingMs', () => {
  it('匀速时等于 动作数 × 间隔', () => {
    const estimate = estimateTypingMs('abc', { timing: timing() })
    expect(estimate.actions).toBe(3)
    expect(estimate.ms).toBe(300)
  })

  it('空格、标点、换行、空行的停顿都算进去', () => {
    // a(100) + 空格(100+50) + b(100) + .(100+200)
    expect(
      estimateTypingMs('a b.', {
        timing: timing({ wordPauseMs: 50, punctuationPauseMs: 200 })
      }).ms
    ).toBe(650)

    // 换行 400；连续两个换行时第二个额外加空行停顿 1000
    expect(estimateTypingMs('a\nb', { timing: timing({ newlinePauseMs: 400 }) }).ms).toBe(
      100 + 500 + 100
    )
    expect(
      estimateTypingMs('a\n\nb', {
        timing: timing({ newlinePauseMs: 400, paragraphPauseMs: 1000 })
      }).ms
    ).toBe(100 + 500 + 1500 + 100)
  })

  it('成组停顿计入', () => {
    const estimate = estimateTypingMs('aaaa', {
      timing: timing({ burstSize: 2, burstPauseMs: 500 })
    })
    expect(estimate.ms).toBe(100 + 600 + 100 + 600)
  })

  it('错字会额外产生动作，与运行时口径一致', () => {
    const clean = estimateTypingMs('hello', {
      timing: timing(),
      typo: { rate: 0, style: 'adjacent', correction: 'auto' }
    })
    const typo = estimateTypingMs('hello', {
      timing: timing(),
      typo: { rate: 1, style: 'adjacent', correction: 'auto' }
    })
    expect(clean.actions).toBe(5)
    expect(typo.actions).toBeGreaterThan(clean.actions)
    expect(typo.ms).toBeGreaterThan(clean.ms)
  })

  it('同一段内容重复估算结果不变（预览不会因为重算而跳动）', () => {
    const config = { timing: timing({ jitterMs: 20 }) }
    expect(estimateTypingMs('hello world', config)).toEqual(estimateTypingMs('hello world', config))
  })

  it('不限速模式估 0；极速档允许 0 间隔，标准档每个动作至少 1ms', () => {
    // 不限速只属于极速档（设置层会把标准档的 max 回退成 cps）
    expect(
      estimateTypingMs('abc', { timing: timing({ speedMode: 'max' }), profile: 'turbo' }).ms
    ).toBe(0)
    // 但用户显式设定的每字符下限依然生效：云桌面里不把远端输入队列打满
    expect(
      estimateTypingMs('abc', {
        timing: timing({ speedMode: 'max' }),
        profile: 'turbo',
        minDelayMs: 5
      }).ms
    ).toBe(15)
    expect(
      estimateTypingMs('abc', { timing: timing({ baseIntervalMs: 0 }), profile: 'turbo' }).ms
    ).toBe(0)
    expect(
      estimateTypingMs('abc', { timing: timing({ baseIntervalMs: 0 }), profile: 'normal' }).ms
    ).toBe(3)
  })

  it('没有可输入的字符时为 0', () => {
    const estimate = estimateTypingMs('中文', { timing: timing() })
    expect(estimate.actions).toBe(0)
    expect(estimate.ms).toBe(0)
  })

  it('用户设定的最小间隔会抬高每个动作的耗时', () => {
    const fast = timing({ baseIntervalMs: 1 })
    expect(estimateTypingMs('abc', { timing: fast }).ms).toBe(3)
    expect(estimateTypingMs('abc', { timing: fast, minDelayMs: 8 }).ms).toBe(24)
  })

  it('换行键与行首归位都会计入预估（否则预览会比实际短一截）', () => {
    const config = { timing: timing() }
    // a + 换行 + b
    expect(estimateTypingMs('a\nb', config).actions).toBe(3)
    // home-select：每次换行多两个归位动作
    expect(estimateTypingMs('a\nb', { ...config, lineStart: 'home-select' }).actions).toBe(5)
    expect(estimateTypingMs('a\nb', { ...config, lineStart: 'home' }).actions).toBe(4)
  })
})
