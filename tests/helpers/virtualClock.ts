/** @description 虚拟时钟，让引擎的倒计时与节奏在测试中瞬间推进且完全可预测 */
export interface VirtualClock {
  now(): number
  /** @description 记录每次 sleep 的毫秒数，用于断言节奏 */
  readonly sleeps: number[]
  sleep(ms: number, shouldContinue?: () => boolean): Promise<void>
  /** @description 直接推进时间，不经过 sleep 调用 */
  advance(ms: number): void
}

export interface VirtualClockOptions {
  start?: number
  /** @description 每次 sleep 解析前调用，便于测试在中途 abort 或 pause */
  beforeResolve?: (ms: number) => void
  /** @description true 时不自动推进时间，需测试手动 advance */
  manual?: boolean
}

/**
 * @description 创建虚拟时钟，sleep 会记录时长并可跳过真实等待
 * @param options 起始时间、解析前钩子与手动推进开关
 * @returns 可注入引擎的虚拟时钟
 */
export function createVirtualClock(options: VirtualClockOptions = {}): VirtualClock {
  let current = options.start ?? 0
  const sleeps: number[] = []

  return {
    now: () => current,
    sleeps,
    async sleep(ms, shouldContinue = () => true) {
      sleeps.push(ms)
      if (!shouldContinue()) return
      options.beforeResolve?.(ms)
      if (!options.manual) current += Math.max(0, ms)
      // 让出一个微任务，模拟真实的异步等待顺序
      await Promise.resolve()
    },
    advance(ms) {
      current += ms
    }
  }
}

/**
 * @description 创建真实定时器版 sleep，用于不需要时间确定性的场景
 * @returns 上限 1ms 的 sleep 函数，避免测试真正久等
 */
export function createRealSleeper(): (ms: number, shouldContinue?: () => boolean) => Promise<void> {
  return async (ms, shouldContinue = () => true) => {
    if (!shouldContinue()) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1)))
  }
}
