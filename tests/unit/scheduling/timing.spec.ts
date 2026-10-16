import { describe, expect, it } from 'vitest'
import { createRng } from '@main/typing/scheduling/rng'
import {
  baseIntervalMsFor,
  estimateTotalMs,
  MIN_DELAY_MS,
  TimingScheduler,
  type TimingSettings
} from '@main/typing/scheduling/timing'
import type { KeyAction, KeystrokeAction } from '@main/typing/planner/types'
import { TIMING_PRESETS } from '@main/typing/scheduling/presets'

/**
 * @description 构造一份带默认值的节奏设置
 * @param overrides 需要覆盖的字段
 * @returns 完整的 TimingSettings
 */
function settings(overrides: Partial<TimingSettings> = {}): TimingSettings {
  return {
    speedMode: 'cps',
    cps: 10,
    wpm: 120,
    baseIntervalMs: 80,
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

/**
 * @description 造一个真实按键动作，vk 取字符大写形式的码点
 * @param char 字符
 * @returns 真实按键动作
 */
const key = (char: string): KeyAction => ({
  kind: 'key',
  vk: char.toUpperCase().charCodeAt(0),
  modifiers: [],
  char
})

/**
 * @description 造一个 Unicode 报文动作，可标记为代理对的后续码元
 * @param char 字符
 * @param continues 是否为代理对的第二个码元
 * @returns Unicode 动作
 */
const unicode = (char: string, continues = false): KeystrokeAction => {
  const action: KeystrokeAction = { kind: 'unicode', codeUnit: 0x4e2d, char }
  if (continues) return { ...action, continues: true }
  return action
}

describe('baseIntervalMsFor', () => {
  it('cps 模式：1000 / cps', () => {
    expect(baseIntervalMsFor(settings({ speedMode: 'cps', cps: 10 }))).toBe(100)
    expect(baseIntervalMsFor(settings({ speedMode: 'cps', cps: 4 }))).toBe(250)
  })

  it('wpm 模式：按 1 词 = 5 字符折算', () => {
    expect(baseIntervalMsFor(settings({ speedMode: 'wpm', wpm: 120 }))).toBe(100)
    expect(baseIntervalMsFor(settings({ speedMode: 'wpm', wpm: 60 }))).toBe(200)
  })

  it('interval 模式直接使用固定间隔', () => {
    expect(baseIntervalMsFor(settings({ speedMode: 'interval', baseIntervalMs: 33 }))).toBe(33)
  })

  it('非法输入不会产生 0/负数/NaN', () => {
    expect(baseIntervalMsFor(settings({ speedMode: 'cps', cps: 0 }))).toBeGreaterThan(0)
    expect(Number.isFinite(baseIntervalMsFor(settings({ speedMode: 'wpm', wpm: 0 })))).toBe(true)
  })
})

describe('TimingScheduler', () => {
  it('无抖动、无停顿设置时，每个动作的延迟恒定', () => {
    const scheduler = new TimingScheduler(settings({ cps: 20 }), createRng(1))
    const delays = ['a', 'b', 'c'].map((char) => scheduler.delayFor(key(char)))
    expect(delays).toEqual([50, 50, 50])
  })

  it('延迟永远 ≥ MIN_DELAY_MS', () => {
    const scheduler = new TimingScheduler(
      settings({ speedMode: 'interval', baseIntervalMs: 0.01, jitterMs: 0 }),
      createRng(2)
    )
    expect(scheduler.delayFor(key('a'))).toBeGreaterThanOrEqual(MIN_DELAY_MS)
  })

  it('均匀抖动落在 ±jitter 范围内且不是常量', () => {
    const scheduler = new TimingScheduler(
      settings({ cps: 10, jitterMs: 30, distribution: 'uniform' }),
      createRng(3)
    )
    const delays = Array.from({ length: 50 }, () => scheduler.delayFor(key('a')))
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(100 - 30 - 1)
      expect(delay).toBeLessThanOrEqual(100 + 30 + 1)
    }
    expect(new Set(delays).size).toBeGreaterThan(1)
  })

  it('正态抖动被夹取在 ±3σ 内，且整体围绕基准值', () => {
    const scheduler = new TimingScheduler(
      settings({ cps: 10, jitterMs: 30, distribution: 'gaussian' }),
      createRng(4)
    )
    const delays = Array.from({ length: 300 }, () => scheduler.delayFor(key('a')))
    const mean = delays.reduce((sum, value) => sum + value, 0) / delays.length
    expect(mean).toBeGreaterThan(90)
    expect(mean).toBeLessThan(110)
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(100 - 90 - 1)
    expect(Math.max(...delays)).toBeLessThanOrEqual(100 + 90 + 1)
  })

  it('相同种子得到完全相同的节奏（可复现）', () => {
    /**
     * @description 用同一种子跑一段节奏并返回延迟序列
     * @returns 20 个动作的延迟
     */
    const run = (): number[] => {
      const scheduler = new TimingScheduler(
        settings({ jitterMs: 20, distribution: 'gaussian', burstSize: 3, burstPauseMs: 100 }),
        createRng(77)
      )
      return Array.from({ length: 20 }, () => scheduler.delayFor(key('a')))
    }
    expect(run()).toEqual(run())
  })

  it('标点/空格/换行/空行分别触发对应停顿', () => {
    const scheduler = new TimingScheduler(
      settings({
        cps: 100,
        punctuationPauseMs: 200,
        wordPauseMs: 50,
        newlinePauseMs: 300,
        paragraphPauseMs: 700
      }),
      createRng(5)
    )

    expect(scheduler.delayFor(key('a'))).toBe(10)
    expect(scheduler.delayFor(key('，'))).toBe(210)
    expect(scheduler.delayFor(key(' '))).toBe(60)

    const firstNewline = scheduler.delayFor({ kind: 'key', vk: 0x0d, modifiers: [], char: '\n' })
    expect(firstNewline).toBe(310)
    // 连续第二个换行 = 空行，额外加段落停顿
    const secondNewline = scheduler.delayFor({ kind: 'key', vk: 0x0d, modifiers: [], char: '\n' })
    expect(secondNewline).toBe(310 + 700)
    // 空行之后回到普通字符
    expect(scheduler.delayFor(key('b'))).toBe(10)
  })

  it('英文标点同样触发停顿', () => {
    const scheduler = new TimingScheduler(
      settings({ cps: 100, punctuationPauseMs: 150 }),
      createRng(6)
    )
    for (const char of [',', '.', ';', ':', '!', '?']) {
      expect(scheduler.delayFor(key(char))).toBe(160)
    }
  })

  it('burst：每 N 个动作插入一次较长停顿', () => {
    const scheduler = new TimingScheduler(
      settings({ cps: 100, burstSize: 3, burstPauseMs: 500 }),
      createRng(7)
    )
    const delays = Array.from({ length: 6 }, () => scheduler.delayFor(key('a')))
    expect(delays).toEqual([10, 10, 510, 10, 10, 510])
  })

  it('代理对的第二个码元不额外计时，且不参与 burst 计数', () => {
    const scheduler = new TimingScheduler(
      settings({ cps: 100, burstSize: 2, burstPauseMs: 500 }),
      createRng(8)
    )
    expect(scheduler.delayFor(unicode('😀'))).toBe(10)
    expect(scheduler.delayFor(unicode('😀', true))).toBe(MIN_DELAY_MS)
    expect(scheduler.typedCount).toBe(1)
  })

  it('显式 delay 动作直接返回其毫秒数', () => {
    const scheduler = new TimingScheduler(settings(), createRng(9))
    expect(scheduler.delayFor({ kind: 'delay', ms: 1234, reason: 'explicit' })).toBe(1234)
    expect(scheduler.typedCount).toBe(0)
  })

  it('reset 后计数与换行状态复位', () => {
    const scheduler = new TimingScheduler(
      settings({ cps: 100, newlinePauseMs: 300 }),
      createRng(10)
    )
    scheduler.delayFor({ kind: 'key', vk: 0x0d, modifiers: [], char: '\n' })
    scheduler.reset()
    expect(scheduler.typedCount).toBe(0)
    // reset 之后第一个换行不应被当作空行
    expect(scheduler.delayFor({ kind: 'key', vk: 0x0d, modifiers: [], char: '\n' })).toBe(310)
  })
})

describe('estimateTotalMs', () => {
  it('随字符数线性增长，并为 0 字符兜底', () => {
    const config = settings({ cps: 10, jitterMs: 0 })
    expect(estimateTotalMs(10, config)).toBe(1000)
    expect(estimateTotalMs(0, config)).toBeGreaterThan(0)
    expect(estimateTotalMs(20, config)).toBeGreaterThan(estimateTotalMs(10, config))
  })

  it('burst 停顿计入估算', () => {
    const withBurst = estimateTotalMs(10, settings({ cps: 10, burstSize: 5, burstPauseMs: 100 }))
    const withoutBurst = estimateTotalMs(10, settings({ cps: 10 }))
    expect(withBurst).toBeGreaterThan(withoutBurst)
  })
})

describe('节奏预设', () => {
  it('每个预设都能被归一化且参数合法', () => {
    expect(TIMING_PRESETS.length).toBeGreaterThan(0)
    for (const preset of TIMING_PRESETS) {
      const merged = settings(preset.patch)
      expect(baseIntervalMsFor(merged)).toBeGreaterThan(0)
      expect(merged.jitterMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('匀速预设真的没有抖动与停顿', () => {
    const uniform = TIMING_PRESETS.find((preset) => preset.id === 'uniform')
    expect(uniform?.patch.jitterMs).toBe(0)
    expect(uniform?.patch.punctuationPauseMs).toBe(0)
  })
})
