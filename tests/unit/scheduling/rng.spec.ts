import { describe, expect, it } from 'vitest'
import { clamp, createRng, mulberry32, randomSeed, resolveSeed } from '@main/typing/scheduling/rng'

describe('mulberry32', () => {
  it('同一路径产生同一序列', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('不同种子产生不同序列', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    expect(a()).not.toBe(b())
  })

  it('输出落在 [0, 1)', () => {
    const next = mulberry32(99)
    for (let i = 0; i < 500; i++) {
      const value = next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('createRng', () => {
  it('相同种子完全可复现', () => {
    const a = createRng(2024)
    const b = createRng(2024)
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()])
    expect(a.int(0, 100)).toBe(b.int(0, 100))
  })

  it('int 是闭区间且不越界', () => {
    const rng = createRng(5)
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const value = rng.int(3, 7)
      seen.add(value)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThanOrEqual(7)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('int 的边界情况（min == max、min > max）', () => {
    const rng = createRng(6)
    expect(rng.int(5, 5)).toBe(5)
    expect(rng.int(9, 2)).toBeGreaterThanOrEqual(2)
    expect(rng.int(9, 2)).toBeLessThanOrEqual(9)
  })

  it('bool 的概率边界确定', () => {
    const rng = createRng(7)
    expect(rng.bool(0)).toBe(false)
    expect(rng.bool(1)).toBe(true)
    const hits = Array.from({ length: 2000 }, () => rng.bool(0.3)).filter(Boolean).length
    expect(hits).toBeGreaterThan(450)
    expect(hits).toBeLessThan(750)
  })

  it('pick 覆盖所有元素，空数组抛错', () => {
    const rng = createRng(11)
    const items = ['a', 'b', 'c'] as const
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(rng.pick(items))
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
    expect(() => rng.pick([])).toThrow()
  })

  it('gaussian 的均值/标准差接近设定值，且被夹取在范围内', () => {
    const rng = createRng(1234)
    const samples = Array.from({ length: 20000 }, () => rng.gaussian(0, 10, -30, 30))
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length
    expect(Math.abs(mean)).toBeLessThan(0.5)
    expect(Math.sqrt(variance)).toBeGreaterThan(8.5)
    expect(Math.sqrt(variance)).toBeLessThan(11.5)
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-30)
    expect(Math.max(...samples)).toBeLessThanOrEqual(30)
  })

  it('stdDev = 0 时直接返回夹取后的均值', () => {
    const rng = createRng(5)
    expect(rng.gaussian(100, 0, 0, 50)).toBe(50)
    expect(rng.gaussian(-5, 0, 0, 50)).toBe(0)
  })

  it('seed = 0 表示每次随机（不同实例结果不同）', () => {
    const a = createRng(0)
    const b = createRng(0)
    const valuesA = [a.next(), a.next(), a.next(), a.next()]
    const valuesB = [b.next(), b.next(), b.next(), b.next()]
    expect(valuesA).not.toEqual(valuesB)
  })

  it('resolveSeed 只在 seed > 0 时固定', () => {
    expect(resolveSeed(77)).toBe(77)
    expect(resolveSeed(undefined)).toBeGreaterThan(0)
    expect(randomSeed()).toBeGreaterThan(0)
  })
})

describe('clamp', () => {
  it('夹取到范围内，NaN 视为下限', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
    expect(clamp(Number.NaN, 3, 10)).toBe(3)
  })
})
