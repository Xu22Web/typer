/**
 * 可复现的伪随机数源：所有随机性都必须能用固定种子在测试里复现，
 * 因此这里不用 `Math.random()`。
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

/**
 * @description 把数值夹取到 [min, max] 区间（NaN 视为 min）
 * @param value 原始值
 * @param min 下界
 * @param max 上界
 * @returns 夹取后的值
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * @description mulberry32：32 位种子、分布均匀、实现极简，适合本场景
 * @param seed 32 位种子
 * @returns 每次调用产出 [0, 1) 随机数的函数
 */
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

/**
 * @description 生成一个随机种子
 * @returns 非零的 32 位随机种子
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0 || 1
}

/**
 * @description 创建随机源；种子为 0 或省略时改用随机种子（"每次运行都不同"）
 * @param seed 设置里的种子
 * @returns 随机源
 */
export function createRng(seed?: number): Rng {
  const normalizedSeed = seed !== undefined && seed > 0 ? seed >>> 0 : randomSeed()
  const source = mulberry32(normalizedSeed)
  let spare: number | null = null

  /**
   * @description 转发底层 mulberry32 的输出，其余方法共用同一条序列
   * @returns [0, 1) 区间内的随机数
   */
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

/**
 * @description 把（可能为 0 的）设置种子归一成实际使用的种子，便于日志展示与复现某次节奏
 * @param seed 设置里的种子
 * @returns 实际使用的 32 位种子
 */
export function resolveSeed(seed?: number): number {
  return seed !== undefined && seed > 0 ? seed >>> 0 : randomSeed()
}
