/** 等待切片（毫秒）：把长等待拆开，保证中止/暂停能及时生效。 */
const SLICE_MS = 25

/**
 * @description 真实时钟的等待实现：分片等待，保证可被中止/暂停及时打断
 * @param ms 等待的毫秒数
 * @param shouldContinue 返回 false 时提前结束等待
 * @returns 等待结束或被提前打断后 resolve
 */
export function realSleep(ms: number, shouldContinue: () => boolean = () => true): Promise<void> {
  if (ms <= 0) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let remaining = ms
    const step = (): void => {
      if (!shouldContinue() || remaining <= 0) {
        resolve()
        return
      }
      const slice = Math.min(SLICE_MS, remaining)
      remaining -= slice
      setTimeout(step, slice)
    }
    step()
  })
}

/**
 * @description 读取当前时间戳（毫秒）
 * @returns 当前时间
 */
export function realNow(): number {
  return Date.now()
}
