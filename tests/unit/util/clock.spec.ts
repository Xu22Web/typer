import { describe, expect, it } from 'vitest'
import { realNow, realSleep } from '@main/util/clock'

describe('realSleep', () => {
  it('等待指定时间后返回', async () => {
    const started = Date.now()
    await realSleep(60)
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })

  it('shouldContinue 返回 false 时立刻结束等待', async () => {
    const started = Date.now()
    await realSleep(5000, () => false)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('等待过程中被中止会提前返回（响应紧急停止）', async () => {
    let continueFlag = true
    const started = Date.now()
    const pending = realSleep(5000, () => continueFlag)
    setTimeout(() => {
      continueFlag = false
    }, 60)
    await pending
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('ms <= 0 时立即返回', async () => {
    const started = Date.now()
    await realSleep(0)
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('realNow 返回当前时间戳', () => {
    expect(Math.abs(realNow() - Date.now())).toBeLessThan(50)
  })
})
