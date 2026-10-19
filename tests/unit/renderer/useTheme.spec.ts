import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {} from 'pinia-plugin-persistedstate'
import { useThemeStore } from '@renderer/store/theme'
import { useTheme } from '@renderer/composables/useTheme'

/** 根元素上出现过的 class（dark / light），用于断言主题已应用 */
const rootClasses = new Set<string>()

/** matchMedia 当前返回的系统亮暗偏好 */
let mediaDark = false

/**
 * @description 打桩浏览器环境（node 测试环境没有 document / matchMedia）
 */
function stubBrowser(): void {
  const listeners: Array<(event: { matches: boolean }) => void> = []
  ;(globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      classList: {
        toggle: (name: string, on: boolean): void => {
          if (on) rootClasses.add(name)
          else rootClasses.delete(name)
        }
      }
    },
    // 不支持 View Transition：setDark 走直接提交路径
    startViewTransition: undefined
  }
  ;(globalThis as unknown as { matchMedia: unknown }).matchMedia = vi.fn(() => ({
    get matches(): boolean {
      return mediaDark
    },
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void): void => {
      listeners.push(listener)
    }
  }))
}

describe('useTheme · 跟随系统与手动切换', () => {
  beforeEach(() => {
    stubBrowser()
    setActivePinia(createPinia())
    rootClasses.clear()
    mediaDark = false
  })

  it('手动切换主题会停止跟随系统并立即应用', async () => {
    const store = useThemeStore()
    store.dark = true
    store.followSystem = true

    const { isDark, followSystem, setDark } = useTheme()
    await setDark(false)

    expect(isDark.value).toBe(false)
    expect(followSystem.value).toBe(false)
    expect(store.followSystem).toBe(false)
    expect(rootClasses.has('dark')).toBe(false)
    expect(rootClasses.has('light')).toBe(true)
  })

  it('toggle 反转当前主题，同样停止跟随系统', async () => {
    const store = useThemeStore()
    store.dark = false
    store.followSystem = true

    const { isDark, toggle } = useTheme()
    await toggle({} as MouseEvent)

    expect(isDark.value).toBe(true)
    expect(store.followSystem).toBe(false)
  })

  it('打开跟随系统立即同步到系统当前偏好', () => {
    const store = useThemeStore()
    store.dark = true
    store.followSystem = false
    mediaDark = false

    const { isDark, setFollowSystem } = useTheme()
    setFollowSystem(true)

    expect(isDark.value).toBe(false)
    expect(store.followSystem).toBe(true)
    expect(rootClasses.has('light')).toBe(true)
  })

  it('关闭跟随系统只改开关，不动当前主题', async () => {
    const store = useThemeStore()
    const { setDark, setFollowSystem } = useTheme()

    // 先真的把深色应用上去，否则“关闭跟随”根本无从验证
    await setDark(true)
    store.followSystem = true
    setFollowSystem(false)

    expect(store.followSystem).toBe(false)
    expect(store.dark).toBe(true)
    expect(rootClasses.has('dark')).toBe(true)
    expect(rootClasses.has('light')).toBe(false)
  })
})
