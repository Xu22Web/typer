/** 真实时钟的等待实现：分片等待，保证可被中止/暂停及时打断。 */
const SLICE_MS = 25

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

export function realNow(): number {
  return Date.now()
}
