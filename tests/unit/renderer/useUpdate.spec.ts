import { describe, expect, it, vi } from 'vitest'
// 预热 Vue 的 ESM 图：useUpdate 依赖自动导入的 ref/computed。
// 若等到 it 里再 await import，冷启动成本会落在 5s 的用例超时里（全量并行时偶发超时）。
import 'vue'

/**
 * 更新中心渲染侧状态：保证事件只订阅一次、状态与进度能反映到界面、
 * "有新版本 / 下载中 / 可安装" 判断正确，且动作失败时留下原因。
 * composable 是模块级单例，因此每个用例用 resetModules 拿一份干净实例。
 */
interface UpdatesApiStub {
  check: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  state: ReturnType<typeof vi.fn>
  onState: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
  pushState: (value: unknown) => void
  pushProgress: (value: unknown) => void
}

const IDLE = {
  status: 'idle',
  progress: null,
  filePath: null,
  sha256: null,
  verifiedBy: null,
  error: null
}

/**
 * @description 安装一个 window.api.updates 桩，可推送给已注册的监听器
 * @param overrides 覆盖默认桩方法的实现
 * @returns 安装好的 updates API 桩
 */
function installApi(overrides: Record<string, unknown> = {}): UpdatesApiStub {
  const stateListeners: Array<(value: unknown) => void> = []
  const progressListeners: Array<(value: unknown) => void> = []

  const api: UpdatesApiStub = {
    check: vi.fn(async () => ({
      status: 'available',
      current: '0.1.0',
      latest: { version: '0.2.0' },
      checkedAt: 1
    })),
    download: vi.fn(async () => ({ ...IDLE, status: 'ready', verifiedBy: 'manifest' })),
    cancel: vi.fn(async () => ({ ...IDLE, status: 'failed', error: '已取消下载' })),
    install: vi.fn(async () => ({ ...IDLE, status: 'idle' })),
    state: vi.fn(async () => ({ ...IDLE })),
    onState: vi.fn((listener: (value: unknown) => void) => {
      stateListeners.push(listener)
      return () => {}
    }),
    onProgress: vi.fn((listener: (value: unknown) => void) => {
      progressListeners.push(listener)
      return () => {}
    }),
    pushState: (value) => stateListeners.forEach((listener) => listener(value)),
    pushProgress: (value) => progressListeners.forEach((listener) => listener(value)),
    ...overrides
  }

  ;(globalThis as unknown as { window: unknown }).window = { api: { updates: api } }
  return api
}

/**
 * @description 用一份干净的模块实例加载 useUpdate，避免模块级单例跨用例串状态
 * @returns 新安装的 API 桩与该模块导出的 useUpdate
 */
async function loadUseUpdate(): Promise<{
  api: UpdatesApiStub
  useUpdate: typeof import('../../../src/renderer/src/composables/useUpdate').useUpdate
}> {
  // 先装好 window.api 再加载模块：模块体若将来改成顶层访问 window.api，这里不会炸
  const api = installApi()
  vi.resetModules()
  const mod = await import('../../../src/renderer/src/composables/useUpdate')
  return { api, useUpdate: mod.useUpdate }
}

// 在收集阶段先求值一次并装好 window.api 桩：全量并行运行时这几个包的首次 transform
// 可能超过默认 5s，落到 it 里就会随机超时。resetModules 之后再次 import 只是重新求值（transform 已缓存）。
installApi()
await import('../../../src/renderer/src/composables/useUpdate')

describe('useUpdate', () => {
  it('初始化时读取状态并触发一次检查，同时只订阅一遍', async () => {
    const { api, useUpdate } = await loadUseUpdate()
    const update = useUpdate()

    await update.init()
    useUpdate()

    expect(api.state).toHaveBeenCalledTimes(1)
    expect(api.check).toHaveBeenCalledWith(false)
    expect(api.onState).toHaveBeenCalledTimes(1)
    expect(api.onProgress).toHaveBeenCalledTimes(1)
  })

  it('检查结果为 available 时置位"有新版本"，供侧边导航提示使用', async () => {
    const { useUpdate } = await loadUseUpdate()
    const update = useUpdate()

    await update.init()
    expect(update.available.value).toBe(true)
    expect(update.latestVersion.value).toBe('0.2.0')
    expect(update.currentVersion.value).toBe('0.1.0')
  })

  it('主进程推送的状态与进度会反映到界面判断上', async () => {
    const { api, useUpdate } = await loadUseUpdate()
    const update = useUpdate()
    await update.init()

    api.pushState({ ...IDLE, status: 'downloading' })
    expect(update.downloading.value).toBe(true)
    expect(update.busy.value).toBe(true)

    api.pushProgress({ received: 512, total: 1024, percent: 0.5, bytesPerSecond: 100 })
    expect(update.progress.value?.percent).toBe(0.5)

    api.pushState({
      ...IDLE,
      status: 'ready',
      verifiedBy: 'api-digest',
      sha256: 'a'.repeat(64),
      filePath: 'C:\\temp\\setup.exe'
    })
    expect(update.installed.value).toBe(true)
    expect(update.downloading.value).toBe(false)
    expect(update.verifiedLabel.value).toContain('GitHub 摘要')
  })

  it('ready 状态会清掉进度，避免界面停在旧百分比', async () => {
    const { api, useUpdate } = await loadUseUpdate()
    const update = useUpdate()
    await update.init()

    api.pushProgress({ received: 10, total: 100, percent: 0.1, bytesPerSecond: 1 })
    api.pushState({ ...IDLE, status: 'verifying' })
    expect(update.downloading.value).toBe(true)

    api.pushState({ ...IDLE, status: 'idle' })
    expect(update.progress.value).toBeNull()
  })

  it('下载失败时保留可读原因', async () => {
    const { api, useUpdate } = await loadUseUpdate()
    api.download.mockResolvedValueOnce({ ...IDLE, status: 'failed', error: '完整性校验失败' })

    const update = useUpdate()
    await update.init()
    await update.download()

    expect(update.state.value.status).toBe('failed')
    expect(update.error.value).toBe('完整性校验失败')
  })

  it('检查接口抛错时记录错误，不抛出到调用方', async () => {
    const { api, useUpdate } = await loadUseUpdate()
    api.check.mockRejectedValue(new Error('GitHub 接口访问频率超限，请稍后再试'))

    const update = useUpdate()
    const result = await update.runCheck(true)

    expect(result).toBeNull()
    expect(update.error.value).toContain('频率超限')
    expect(update.checking.value).toBe(false)
  })

  it('取消与安装都会把主进程返回的状态同步回来', async () => {
    const { api, useUpdate } = await loadUseUpdate()
    const update = useUpdate()
    await update.init()

    await update.cancel()
    expect(api.cancel).toHaveBeenCalledTimes(1)
    expect(update.state.value.status).toBe('failed')

    await update.install()
    expect(api.install).toHaveBeenCalledTimes(1)
    expect(update.state.value.status).toBe('idle')
  })
})
