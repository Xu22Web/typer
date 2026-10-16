/**
 * 可复现的伪随机数源。
 *
 * 之所以不用 `Math.random()`：所有"随机性"都必须能在测试里用固定种子复现，
 * 否则节奏/错字模型无法断言。
 */

export interface Rng {
  /** [0, 1) */
  next(): number
  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number
  /** 以 probability 的概率返回 true */
  bool(probability: number): boolean
  pick<T>(items: readonly T[]): T
  /** 正态分布采样，并夹取到 [min, max] */
  gaussian(mean: number, stdDev: number, min: number, max: number): number
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** mulberry32：32 位种子、分布均匀、实现极简，适合本场景。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成一个随机种子（`seed = 0` 表示"每次运行都不同"）。 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0 || 1
}

export function createRng(seed?: number): Rng {
  const normalizedSeed = seed !== undefined && seed > 0 ? seed >>> 0 : randomSeed()
  const source = mulberry32(normalizedSeed)
  let spare: number | null = null

  const next = (): number => source()

  return {
    next,
    int(min, max) {
      const lo = Math.ceil(Math.min(min, max))
      const hi = Math.floor(Math.max(min, max))
      if (hi <= lo) return lo
      return lo + Math.floor(next() * (hi - lo + 1))
    },
    bool(probability) {
      if (probability <= 0) return false
      if (probability >= 1) return true
      return next() < probability
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick 收到空数组')
      return items[Math.floor(next() * items.length)] as T
    },
    gaussian(mean, stdDev, min, max) {
      if (stdDev <= 0) return clamp(mean, min, max)
      let value: number
      if (spare !== null) {
        value = spare
        spare = null
      } else {
        // Box-Muller
        let u = 0
        let v = 0
        while (u === 0) u = next()
        while (v === 0) v = next()
        const magnitude = Math.sqrt(-2 * Math.log(u))
        value = magnitude * Math.cos(2 * Math.PI * v)
        spare = magnitude * Math.sin(2 * Math.PI * v)
      }
      return clamp(mean + value * stdDev, min, max)
    }
  }
}

/** 当前种子的来源（用于日志展示，方便复现某次输入节奏）。 */
export function resolveSeed(seed?: number): number {
  return seed !== undefined && seed > 0 ? seed >>> 0 : randomSeed()
}
