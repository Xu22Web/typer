import { describe, expect, it, vi } from 'vitest'

/**
 * 自绘标题栏的窗口状态。
 *
 * 窗口是无边框的，最大化状态可能被窗口管理器改掉（双击标题栏、Win+↑、拖到屏幕边缘），
 * 因此按钮图标必须跟随主进程推送，而不是自己记一个布尔值。
 *
 * composable 是模块级单例（只订阅一次），所以每个用例都用 resetModules 拿一份干净的实例。
 */
interface WindowApiStub {
  minimize: ReturnType<typeof vi.fn>
  toggleMaximize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  onState: ReturnType<typeof vi.fn>
  emit: (maximized: boolean) => void
}

async function loadUseWindowState(): Promise<{
  api: WindowApiStub
  useWindowState: typeof import('../../../src/renderer/src/composables/useWindowState').useWindowState
}> {
  let listener: ((payload: { maximized: boolean }) => void) | null = null

  const api: WindowApiStub = {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onState: vi.fn((next: (payload: { maximized: boolean }) => void) => {
      listener = next
      return () => {
        listener = null
      }
    }),
    emit: (maximized: boolean) => listener?.({ maximized })
  }

  ;(globalThis as unknown as { window: unknown }).window = { api: { window: api } }

  vi.resetModules()
  const mod = await import('../../../src/renderer/src/composables/useWindowState')
  return { api, useWindowState: mod.useWindowState }
}

describe('useWindowState', () => {
  it('把点击转成对应的窗口 IPC 调用', async () => {
    const { api, useWindowState } = await loadUseWindowState()
    const state = useWindowState()

    await state.minimize()
    await state.close()

    expect(api.minimize).toHaveBeenCalledTimes(1)
    expect(api.close).toHaveBeenCalledTimes(1)
  })

  it('切换最大化时采用主进程返回的真实状态', async () => {
    const { api, useWindowState } = await loadUseWindowState()
    api.toggleMaximize.mockResolvedValueOnce(true)
    api.toggleMaximize.mockResolvedValueOnce(false)

    const state = useWindowState()

    await state.toggleMaximize()
    expect(state.maximized.value).toBe(true)
    expect(state.maximizedLabel.value).toBe('还原')

    await state.toggleMaximize()
    expect(state.maximized.value).toBe(false)
    expect(state.maximizedLabel.value).toBe('最大化')
  })

  it('订阅主进程推送，窗口被外部最大化时图标能跟上', async () => {
    const { api, useWindowState } = await loadUseWindowState()
    const state = useWindowState()

    expect(api.onState).toHaveBeenCalledTimes(1)

    api.emit(true)
    expect(state.maximized.value).toBe(true)

    api.emit(false)
    expect(state.maximized.value).toBe(false)
  })

  it('只订阅一次，并且用主进程状态对齐初始值', async () => {
    const { api, useWindowState } = await loadUseWindowState()
    api.isMaximized.mockResolvedValue(true)

    const state = useWindowState()
    useWindowState()

    await vi.waitFor(() => {
      expect(state.maximized.value).toBe(true)
    })
    expect(api.onState).toHaveBeenCalledTimes(1)
  })
})
