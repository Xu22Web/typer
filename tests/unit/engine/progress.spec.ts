import { describe, expect, it } from 'vitest'
import { computeProgress } from '@main/typing/engine/progress'

describe('computeProgress', () => {
  it('按比例计算百分比', () => {
    const snapshot = computeProgress({
      typed: 25,
      total: 100,
      elapsedMs: 1000,
      baseIntervalMs: 10,
      stage: 'typing'
    })
    expect(snapshot.percent).toBeCloseTo(0.25, 5)
    expect(snapshot.typed).toBe(25)
    expect(snapshot.total).toBe(100)
  })

  it('总数未知（total = 0）时进度视为 100%，不产生 NaN', () => {
    const snapshot = computeProgress({
      typed: 0,
      total: 0,
      elapsedMs: 0,
      baseIntervalMs: 60,
      stage: 'countdown'
    })
    expect(snapshot.percent).toBe(1)
    expect(Number.isNaN(snapshot.aps)).toBe(false)
    expect(Number.isNaN(snapshot.remainingMs)).toBe(false)
  })

  it('已用时间为 0 时速度按 0 处理（不产生 Infinity）', () => {
    const snapshot = computeProgress({
      typed: 5,
      total: 10,
      elapsedMs: 0,
      baseIntervalMs: 40,
      stage: 'typing'
    })
    expect(snapshot.aps).toBe(0)
    // 没有样本时用 baseIntervalMs 估算剩余
    expect(snapshot.remainingMs).toBe(200)
  })

  it('有样本时按实测平均耗时估算剩余时间', () => {
    const snapshot = computeProgress({
      typed: 50,
      total: 100,
      elapsedMs: 5000,
      baseIntervalMs: 10,
      stage: 'typing'
    })
    // 平均 100ms/动作 → 剩余 50 个动作 ≈ 5000ms
    expect(snapshot.remainingMs).toBeGreaterThan(4000)
    expect(snapshot.remainingMs).toBeLessThan(6000)
    expect(snapshot.aps).toBeCloseTo(10, 1)
  })

  it('typed 超过 total 或为负时被夹取', () => {
    const over = computeProgress({
      typed: 200,
      total: 100,
      elapsedMs: 1000,
      baseIntervalMs: 10,
      stage: 'typing'
    })
    expect(over.typed).toBe(100)
    expect(over.percent).toBe(1)

    const negative = computeProgress({
      typed: -5,
      total: 100,
      elapsedMs: -100,
      baseIntervalMs: 10,
      stage: 'typing'
    })
    expect(negative.typed).toBe(0)
    expect(negative.elapsedMs).toBe(0)
    expect(negative.remainingMs).toBeGreaterThan(0)
  })

  it('倒计时阶段回传剩余毫秒', () => {
    const snapshot = computeProgress({
      typed: 0,
      total: 10,
      elapsedMs: 1000,
      baseIntervalMs: 10,
      stage: 'countdown',
      countdownRemainingMs: 2500
    })
    expect(snapshot.stage).toBe('countdown')
    expect(snapshot.countdownRemainingMs).toBe(2500)
  })
})
