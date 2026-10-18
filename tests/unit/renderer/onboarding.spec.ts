import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {} from 'pinia-plugin-persistedstate'
import { useOnboardingStore } from '@renderer/store/onboarding'

describe('新手引导状态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('首次未完成；标记后不再自动播放', () => {
    const store = useOnboardingStore()
    expect(store.tourDone).toBe(false)
    store.markTourDone()
    expect(store.tourDone).toBe(true)
  })

  it('重播信号每次递增，不写入完成标记', () => {
    const store = useOnboardingStore()
    expect(store.tourSignal).toBe(0)
    store.restartTour()
    store.restartTour()
    expect(store.tourSignal).toBe(2)
    expect(store.tourDone).toBe(false)
  })
})
