import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

/**
 * preload 是渲染进程 → 主进程的必经之路：这里验证交给 `ipcRenderer.invoke` 的参数
 * 一定是"结构化克隆能处理"的纯数据，而不是 Vue 的响应式 Proxy。
 */
const shared = vi.hoisted(() => {
  // 必须在 preload 模块体执行之前设置（静态 import 会先执行），
  // 否则 preload 会走"非隔离"分支并访问不存在的 window
  ;(process as unknown as { contextIsolated: boolean }).contextIsolated = true

  return { invoke: vi.fn(), exposed: {} as Record<string, unknown> }
})

const invoke = shared.invoke
const exposed = shared.exposed

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...args: unknown[]) => shared.invoke(...args),
    on: vi.fn(),
    off: vi.fn()
  },
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      shared.exposed[key] = value
    }
  }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: { marker: 'electron-api' } }))

// 静态导入：vi.mock 会被提升到所有 import 之前，因此 preload 拿到的是被 mock 的 electron。
// 用静态导入（而不是测试内 await import）可以避免"冷启动的模块解析时间"落在某个用例的超时里。
import '../../../src/preload/index'

interface ExposedApi {
  settings: { set: (patch: unknown) => Promise<unknown> }
  typing: { start: (text: string) => Promise<unknown> }
  files: { import: (path: string, charset?: string) => Promise<unknown> }
  window: {
    minimize: () => Promise<unknown>
    toggleMaximize: () => Promise<unknown>
    close: () => Promise<unknown>
    isMaximized: () => Promise<unknown>
    onState: (listener: (payload: { maximized: boolean }) => void) => () => void
  }
  updates: {
    check: (force?: boolean) => Promise<unknown>
    download: () => Promise<unknown>
    cancel: () => Promise<unknown>
    install: () => Promise<unknown>
    state: () => Promise<unknown>
  }
  openExternal: (url: string) => Promise<unknown>
}

function getApi(): ExposedApi {
  return exposed.api as ExposedApi
}

/** 取第 index 次 invoke 调用的频道与载荷。 */
function callAt(index = 0): { channel: string; payload: unknown } {
  const [channel, payload] = invoke.mock.calls[index] as [string, unknown]
  return { channel, payload }
}

describe('preload 的 IPC 参数净化', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ ok: true })
  })

  it('暴露了 electron 与 api 两个全局对象', () => {
    expect(getApi()).toBeDefined()
    expect(Object.keys(exposed).sort()).toEqual(['api', 'electron'])
  })

  it('settings.set 收到 Vue 响应式对象时，实际传给 invoke 的是纯数据', async () => {
    const api = getApi()
    const patch = reactive({ startDelayMs: 1500, timing: { cps: 12 } })

    // 不净化时结构化克隆会失败（Proxy 不可克隆）
    expect(() => structuredClone(patch)).toThrow()

    await api.settings.set(patch)

    expect(invoke).toHaveBeenCalledTimes(1)
    const { channel, payload } = callAt()
    expect(channel).toBe('settings:set')
    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload).toEqual({ startDelayMs: 1500, timing: { cps: 12 } })
  })

  it('typing.start 把文本包成纯对象', async () => {
    const api = getApi()
    await api.typing.start('中文内容')

    const { channel, payload } = callAt()
    expect(channel).toBe('typing:start')
    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload).toEqual({ text: '中文内容' })
  })

  it('files.import 的编码参数可省略', async () => {
    const api = getApi()
    await api.files.import('C:\\a.txt')

    const { channel, payload } = callAt()
    expect(channel).toBe('files:import')
    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload).toEqual({ path: 'C:\\a.txt' })
  })

  it('带编码参数时原样透传', async () => {
    const api = getApi()
    await api.files.import('C:\\a.txt', 'gbk')

    expect(callAt().payload).toEqual({ path: 'C:\\a.txt', charset: 'gbk' })
  })

  it('主进程报错时会剥掉 Electron 的包装，只留下可读原因', async () => {
    const api = getApi()
    invoke.mockRejectedValueOnce(
      new Error("Error invoking remote method 'settings:set': Error: 设置保存失败：磁盘已满")
    )

    await expect(api.settings.set({ startDelayMs: 1 })).rejects.toThrow('设置保存失败：磁盘已满')
  })

  it('窗口控制走各自的频道，且切换最大化返回主进程结果', async () => {
    const api = getApi()
    invoke.mockResolvedValue(true)

    await api.window.minimize()
    expect(callAt(0).channel).toBe('window:minimize')

    expect(await api.window.toggleMaximize()).toBe(true)
    expect(callAt(1).channel).toBe('window:toggle-maximize')

    await api.window.close()
    expect(callAt(2).channel).toBe('window:close')

    await api.window.isMaximized()
    expect(callAt(3).channel).toBe('window:is-maximized')
  })

  it('更新接口走各自的频道，force 默认带上 false', async () => {
    const api = getApi()
    invoke.mockResolvedValue({ status: 'up-to-date' })

    await api.updates.check()
    expect(callAt(0).channel).toBe('update:check')
    expect(callAt(0).payload).toEqual({ force: false })

    await api.updates.check(true)
    expect(callAt(1).payload).toEqual({ force: true })

    await api.updates.download()
    expect(callAt(2).channel).toBe('update:download')

    await api.updates.cancel()
    expect(callAt(3).channel).toBe('update:cancel')

    await api.updates.install()
    expect(callAt(4).channel).toBe('update:install')

    await api.updates.state()
    expect(callAt(5).channel).toBe('update:get-state')
  })

  it('openExternal 直接传 URL 字符串', async () => {
    const api = getApi()
    invoke.mockResolvedValue('https://github.com/Xu22Web/typer')
    await api.openExternal('https://github.com/Xu22Web/typer')

    expect(callAt().channel).toBe('shell:open-external')
    expect(callAt().payload).toBe('https://github.com/Xu22Web/typer')
  })
})
