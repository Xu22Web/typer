/** 虚拟时钟：让引擎的倒计时/节奏在测试中瞬间推进且完全可预测。 */
export interface VirtualClock {
  now(): number
  /** 记录每次 sleep 的毫秒数（用于断言节奏） */
  readonly sleeps: number[]
  sleep(ms: number, shouldContinue?: () => boolean): Promise<void>
  /** 直接推进时间（不经过 sleep 调用） */
  advance(ms: number): void
}

export interface VirtualClockOptions {
  start?: number
  /** 每次 sleep 解析前调用，便于测试在中途 abort/pause */
  beforeResolve?: (ms: number) => void
  /** true 时不自动推进时间（需要测试手动 advance） */
  manual?: boolean
}

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

/** 真实定时器版 sleep（不需要时间确定性时使用）。 */
export function createRealSleeper(): (ms: number, shouldContinue?: () => boolean) => Promise<void> {
  return async (ms, shouldContinue = () => true) => {
    if (!shouldContinue()) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1)))
  }
}
