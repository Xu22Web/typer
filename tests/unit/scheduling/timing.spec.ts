import { describe, expect, it } from 'vitest'
import { createRng } from '@main/typing/scheduling/rng'
import {
  baseIntervalMsFor,
  coalesceDelays,
  estimateTotalMs,
  MIN_DELAY_MS,
  TimingScheduler,
  type TimingSettings
} from '@main/typing/scheduling/timing'
import type { ScheduledAction } from '@main/typing/drivers/protocol'
import type { KeyAction } from '@main/typing/planner/types'
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

  it('max（不限速）模式的基础间隔为 0', () => {
    expect(baseIntervalMsFor(settings({ speedMode: 'max', baseIntervalMs: 33 }))).toBe(0)
    expect(estimateTotalMs(10, settings({ speedMode: 'max' }))).toBe(0)
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

  it('极速档（地板 0）允许 0 间隔与亚毫秒节奏', () => {
    const scheduler = new TimingScheduler(
      settings({ speedMode: 'cps', cps: 4000, jitterMs: 0 }),
      createRng(3),
      0
    )
    // 4000 字符/秒 = 0.25ms/动作，正好是可取整的最小步长
    expect(scheduler.delayFor(key('a'))).toBe(0.25)
    expect(
      new TimingScheduler(settings({ speedMode: 'max' }), createRng(3), 0).delayFor(key('a'))
    ).toBe(0)
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

describe('coalesceDelays', () => {
  /** @description 造一串"每字符固定间隔"的动作 */
  const uniform = (count: number, delayMs: number, char = 'a'): ScheduledAction[] =>
    Array.from({ length: count }, () => ({ action: key(char), delayMs }))

  it('攒够阈值才断批：每批只有第一个动作带延迟', () => {
    const batched = coalesceDelays(uniform(40, 1), 16)
    const delays = batched.map((item) => item.delayMs)
    // 40 个字符 → 16 + 16 + 8 三批
    expect(delays.slice(0, 3)).toEqual([16, 0, 0])
    expect(delays[16]).toBe(16)
    expect(delays[32]).toBe(8)
    expect(delays.filter((ms) => ms > 0)).toHaveLength(3)
  })

  it('延迟之和不变（总时长与攒批前一致）', () => {
    const scheduled = uniform(100, 3)
    const sumOf = (items: ScheduledAction[]): number =>
      items.reduce((sum, item) => sum + item.delayMs, 0)
    expect(sumOf(coalesceDelays(scheduled, 16))).toBe(sumOf(scheduled))
  })

  it('动作顺序与数量不变', () => {
    const scheduled: ScheduledAction[] = [
      { action: key('a'), delayMs: 1 },
      { action: key('中'), delayMs: 1 },
      { action: key('b'), delayMs: 1 }
    ]
    const batched = coalesceDelays(scheduled, 16)
    expect(batched).toHaveLength(3)
    expect(batched.map((item) => item.action)).toEqual(scheduled.map((item) => item.action))
  })

  it('显式停顿与不小于阈值的间隔保持原位（节拍不能被攒掉）', () => {
    const pause: ScheduledAction = {
      action: { kind: 'delay', ms: 300, reason: 'explicit' },
      delayMs: 300
    }
    const scheduled: ScheduledAction[] = [
      { action: key('a'), delayMs: 1 },
      pause,
      { action: key('b'), delayMs: 50 },
      { action: key('c'), delayMs: 1 }
    ]
    const batched = coalesceDelays(scheduled, 16)

    const pauseIndex = batched.findIndex((item) => item.action.kind === 'delay')
    expect(batched[pauseIndex]).toEqual(pause)
    // 停顿之前的动作不会被搬到停顿之后：顺序仍是 a → pause → b → c
    expect(
      batched.map((item) => (item.action.kind === 'key' ? item.action.char : '|')).join('')
    ).toBe('a|bc')
    // 50ms 的间隔 >= 阈值，自己单独成批
    const big = batched.find(
      (item) => item.action.kind === 'key' && item.action.char === 'b'
    ) as ScheduledAction
    expect(big.delayMs).toBe(50)
  })

  it('空序列与单动作不会出问题', () => {
    expect(coalesceDelays([], 16)).toEqual([])
    expect(coalesceDelays([{ action: key('a'), delayMs: 7 }], 16)).toEqual([
      { action: key('a'), delayMs: 7 }
    ])
  })

  it('minGroup 保证每次下发至少凑够若干动作（时间窗口到了也继续攒）', () => {
    const batched = coalesceDelays(uniform(70, 1), 4, 32)
    const breaks = batched.filter((item) => item.delayMs > 0).map((item) => item.delayMs)
    // 70 个动作 → 32 + 32 + 6 三批
    expect(breaks).toEqual([32, 32, 6])
    expect(batched.reduce((sum, item) => sum + item.delayMs, 0)).toBe(70)
  })

  it('阈值为 0 表示整段攒批：只被显式停顿打断', () => {
    const pause: ScheduledAction = {
      action: { kind: 'delay', ms: 100, reason: 'explicit' },
      delayMs: 100
    }
    const scheduled: ScheduledAction[] = [
      { action: key('a'), delayMs: 0 },
      { action: key('b'), delayMs: 0 },
      pause,
      { action: key('c'), delayMs: 0 }
    ]
    const batched = coalesceDelays(scheduled, 0)
    // a、b 合成一批（延迟都是 0，仍是 0），停顿原样保留，后面的字符单独一批
    expect(batched).toEqual([
      { action: key('a'), delayMs: 0 },
      { action: key('b'), delayMs: 0 },
      pause,
      { action: key('c'), delayMs: 0 }
    ])
  })
})
