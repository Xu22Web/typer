import { describe, expect, it } from 'vitest'
import {
  createEngineEventBridge,
  registerIpcHandlers,
  type ImportResult
} from '@main/ipc/registerIpc'
import { IPC } from '@main/ipc/channels'
import { SettingsStore } from '@main/settings/store'
import { MockKeyboardDriver } from '@main/typing/drivers/MockKeyboardDriver'
import { TypingEngine } from '@main/typing/engine/TypingEngine'
import type { UpdateCheckResult, UpdateState } from '@main/update/types'
import { createFakeIpcMain, createMemoryFs } from '../../helpers/fakes'
import { createVirtualClock } from '../../helpers/virtualClock'

/** @description 假窗口控制，记录调用顺序以断言 IPC → 窗口操作的映射 */
interface FakeWindowControls {
  calls: string[]
  maximize: boolean
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => boolean
}

/**
 * @description 创建假窗口控制
 * @param maximized 初始最大化状态
 * @returns 记录调用的假窗口控制
 */
function createFakeWindowControls(maximized = false): FakeWindowControls {
  const controls: FakeWindowControls = {
    calls: [],
    maximize: maximized,
    minimize: () => controls.calls.push('minimize'),
    toggleMaximize: () => {
      controls.maximize = !controls.maximize
      controls.calls.push('toggleMaximize')
    },
    close: () => controls.calls.push('close'),
    isMaximized: () => controls.maximize
  }
  return controls
}

/** @description 假更新服务，用来断言 IPC → 更新动作的映射 */
interface FakeUpdates {
  check: (options?: { force?: boolean }) => Promise<UpdateCheckResult>
  download: () => Promise<UpdateState>
  cancelDownload: () => void
  install: () => UpdateState
  state: () => UpdateState
}

const IDLE_UPDATE_STATE: UpdateState = {
  status: 'idle',
  progress: null,
  filePath: null,
  sha256: null,
  verifiedBy: null,
  error: null
}

/**
 * @description 创建假更新服务，各动作返回固定状态
 * @returns 假更新服务
 */
function createFakeUpdates(): FakeUpdates {
  return {
    check: async () => ({
      status: 'up-to-date',
      current: '0.1.0',
      latest: null,
      checkedAt: Date.now()
    }),
    download: async () => ({ ...IDLE_UPDATE_STATE }),
    cancelDownload: () => {},
    install: () => ({ ...IDLE_UPDATE_STATE }),
    state: () => ({ ...IDLE_UPDATE_STATE })
  }
}

/**
 * @description 组装 IPC 夹具：假 ipcMain、引擎、设置存储与可选的窗口/更新服务
 * @param overrides 是否启用窗口控制与更新服务，以及导入失败、打开外链等注入点
 * @returns 测试用的 IPC 夹具
 */
function createHarness(
  overrides: {
    importFileError?: Error
    withWindowControls?: boolean
    withUpdates?: boolean
    openExternal?: (url: string) => void
  } = {}
): {
  ipcMain: ReturnType<typeof createFakeIpcMain>
  engine: TypingEngine
  driver: MockKeyboardDriver
  store: SettingsStore
  memoryFs: ReturnType<typeof createMemoryFs>
  broadcast: Array<{ channel: string; payload: unknown }>
  importCalls: Array<{ path: string; charset?: string }>
  windowControls: FakeWindowControls | null
  updates: FakeUpdates | null
} {
  const ipcMain = createFakeIpcMain()
  const clock = createVirtualClock()
  const driver = new MockKeyboardDriver()
  const memoryFs = createMemoryFs()
  const broadcast: Array<{ channel: string; payload: unknown }> = []
  const importCalls: Array<{ path: string; charset?: string }> = []

  const engine = new TypingEngine({
    driver,
    sleep: clock.sleep,
    now: clock.now,
    onState: (snapshot) => broadcast.push({ channel: IPC.eventState, payload: snapshot }),
    onProgress: (snapshot) => broadcast.push({ channel: IPC.eventProgress, payload: snapshot }),
    onLog: (level, message) =>
      broadcast.push({ channel: IPC.eventLog, payload: { level, message } })
  })

  const store = new SettingsStore({ filePath: 'C:\\userData\\settings.json', fs: memoryFs })
  store.load()

  const windowControls = overrides.withWindowControls ? createFakeWindowControls() : null
  const updates = overrides.withUpdates ? createFakeUpdates() : null

  registerIpcHandlers({
    ipcMain,
    settings: store,
    engine,
    getAppInfo: () => ({ name: 'typer', version: '0.1.0', platform: 'win32', supported: true }),
    pickFile: async () => 'C:\\temp\\input.txt',
    importFile: async (path, charset): Promise<ImportResult> => {
      importCalls.push({ path, charset })
      if (overrides.importFileError) throw overrides.importFileError
      return { path, fileName: 'input.txt', text: '文件内容', charset: 'utf8', bytes: 12 }
    },
    ...(windowControls ? { windowControls } : {}),
    ...(updates ? { updates } : {}),
    ...(overrides.openExternal ? { openExternal: overrides.openExternal } : {}),
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      child: () => ({})
    } as never
  })

  return {
    ipcMain,
    engine,
    driver,
    store,
    memoryFs,
    broadcast,
    importCalls,
    windowControls,
    updates
  }
}

describe('registerIpcHandlers 注册', () => {
  it('注册全部约定频道，且不重复注册', () => {
    const h = createHarness({ withWindowControls: true })
    const expected = [
      IPC.appInfo,
      IPC.settingsGet,
      IPC.settingsSet,
      IPC.settingsReset,
      IPC.typingStart,
      IPC.typingPause,
      IPC.typingResume,
      IPC.typingStop,
      IPC.typingStatus,
      IPC.typingForeground,
      IPC.filesPick,
      IPC.filesImport,
      IPC.windowMinimize,
      IPC.windowToggleMaximize,
      IPC.windowClose,
      IPC.windowIsMaximized
    ]
    for (const channel of expected) {
      expect(h.ipcMain.channels).toContain(channel)
    }
    expect(new Set(h.ipcMain.channels).size).toBe(h.ipcMain.channels.length)
  })

  it('没有窗口控制实现时不注册窗口频道（无窗口环境）', () => {
    const h = createHarness()
    expect(h.ipcMain.channels).not.toContain(IPC.windowMinimize)
    expect(h.ipcMain.channels).not.toContain(IPC.windowClose)
  })
})

describe('IPC 窗口控制（自绘标题栏）', () => {
  it('最小化/关闭转发到窗口操作', async () => {
    const h = createHarness({ withWindowControls: true })
    await h.ipcMain.invoke(IPC.windowMinimize)
    await h.ipcMain.invoke(IPC.windowClose)
    expect(h.windowControls?.calls).toEqual(['minimize', 'close'])
  })

  it('切换最大化返回切换后的真实状态', async () => {
    const h = createHarness({ withWindowControls: true })

    expect(await h.ipcMain.invoke<boolean>(IPC.windowIsMaximized)).toBe(false)
    expect(await h.ipcMain.invoke<boolean>(IPC.windowToggleMaximize)).toBe(true)
    expect(await h.ipcMain.invoke<boolean>(IPC.windowIsMaximized)).toBe(true)
    expect(await h.ipcMain.invoke<boolean>(IPC.windowToggleMaximize)).toBe(false)
    expect(await h.ipcMain.invoke<boolean>(IPC.windowIsMaximized)).toBe(false)
  })

  it('窗口操作抛错时转成可读消息而不是让主进程崩掉', async () => {
    const h = createHarness({ withWindowControls: true })
    if (h.windowControls) {
      h.windowControls.minimize = () => {
        throw new Error('窗口已销毁')
      }
    }
    await expect(h.ipcMain.invoke(IPC.windowMinimize)).rejects.toThrow('窗口已销毁')
  })
})

describe('IPC 更新', () => {
  it('检查更新把 force 参数透传下去', async () => {
    const h = createHarness({ withUpdates: true })
    const calls: Array<{ force?: boolean } | undefined> = []
    h.updates!.check = async (options) => {
      calls.push(options)
      return {
        status: 'available',
        current: '0.1.0',
        latest: null,
        checkedAt: 1
      }
    }

    const plain = await h.ipcMain.invoke<{ status: string }>(IPC.updateCheck)
    expect(plain.status).toBe('available')
    expect(calls).toEqual([{ force: false }])

    await h.ipcMain.invoke(IPC.updateCheck, { force: true })
    expect(calls.at(-1)).toEqual({ force: true })
  })

  it('force 只在严格等于 true 时生效（避免任意真值绕过节流）', async () => {
    const h = createHarness({ withUpdates: true })
    const calls: Array<{ force?: boolean } | undefined> = []
    h.updates!.check = async (options) => {
      calls.push(options)
      return { status: 'up-to-date', current: '0.1.0', latest: null, checkedAt: 1 }
    }

    await h.ipcMain.invoke(IPC.updateCheck, { force: 'yes' })
    expect(calls.at(-1)).toEqual({ force: false })
  })

  it('下载 / 取消 / 安装转发到更新服务，并返回状态快照', async () => {
    const h = createHarness({ withUpdates: true })
    const order: string[] = []
    h.updates!.download = async () => {
      order.push('download')
      return { ...IDLE_UPDATE_STATE, status: 'ready' }
    }
    h.updates!.cancelDownload = () => order.push('cancel')
    h.updates!.state = () => ({ ...IDLE_UPDATE_STATE, status: 'idle' })
    h.updates!.install = () => {
      order.push('install')
      return { ...IDLE_UPDATE_STATE, status: 'idle' }
    }

    expect(await h.ipcMain.invoke<{ status: string }>(IPC.updateDownload)).toMatchObject({
      status: 'ready'
    })
    await h.ipcMain.invoke(IPC.updateCancel)
    await h.ipcMain.invoke(IPC.updateInstall)
    expect(await h.ipcMain.invoke<{ status: string }>(IPC.updateState)).toMatchObject({
      status: 'idle'
    })
    expect(order).toEqual(['download', 'cancel', 'install'])
  })

  it('没有更新服务时不注册更新频道', () => {
    const h = createHarness()
    expect(h.ipcMain.channels).not.toContain(IPC.updateCheck)
    expect(h.ipcMain.channels).not.toContain(IPC.updateDownload)
  })
})

describe('IPC 打开外链', () => {
  it('只放行 http/https，并做规范化', async () => {
    const opened: string[] = []
    const h = createHarness({ openExternal: (url) => opened.push(url) })

    await h.ipcMain.invoke(IPC.shellOpenExternal, 'https://github.com/Xu22Web/typer/releases')
    expect(opened).toEqual(['https://github.com/Xu22Web/typer/releases'])
  })

  it('拒绝 file: 等危险协议（防止被当成本地程序启动器）', async () => {
    const opened: string[] = []
    const h = createHarness({ openExternal: (url) => opened.push(url) })

    await expect(
      h.ipcMain.invoke(IPC.shellOpenExternal, 'file:///C:/Windows/System32/calc.exe')
    ).rejects.toThrow(/不支持的协议/)
    await expect(h.ipcMain.invoke(IPC.shellOpenExternal, 'ms-settings:')).rejects.toThrow(
      /不支持的协议/
    )
    expect(opened).toHaveLength(0)
  })

  it('空地址或非法地址被拒绝', async () => {
    const h = createHarness({ openExternal: () => {} })
    await expect(h.ipcMain.invoke(IPC.shellOpenExternal, '')).rejects.toThrow(/缺少地址/)
    await expect(h.ipcMain.invoke(IPC.shellOpenExternal, 'not-a-url')).rejects.toThrow(
      /地址格式不正确/
    )
    await expect(h.ipcMain.invoke(IPC.shellOpenExternal, 42)).rejects.toThrow(/缺少地址/)
  })
})

describe('IPC 设置相关', () => {
  it('读取/更新/重置设置', async () => {
    const h = createHarness()
    const initial = await h.ipcMain.invoke<{ startDelayMs: number }>(IPC.settingsGet)
    expect(initial.startDelayMs).toBe(3000)

    const updated = await h.ipcMain.invoke<{ startDelayMs: number }>(IPC.settingsSet, {
      startDelayMs: 1000
    })
    expect(updated.startDelayMs).toBe(1000)
    expect(h.store.get().startDelayMs).toBe(1000)

    const reset = await h.ipcMain.invoke<{ startDelayMs: number }>(IPC.settingsReset)
    expect(reset.startDelayMs).toBe(3000)
  })

  it('设置载荷类型错误时给出中文错误', async () => {
    const h = createHarness()
    await expect(h.ipcMain.invoke(IPC.settingsSet, '不是对象')).rejects.toThrow(/设置格式错误/)
    await expect(h.ipcMain.invoke(IPC.settingsSet, [1, 2, 3])).rejects.toThrow(/设置格式错误/)
  })

  it('磁盘写入失败时 settings:set / settings:reset 必须拒绝，而不是假装成功', async () => {
    const h = createHarness()
    h.store.load()
    // 让设置文件的写入失败（模拟磁盘满 / 无权限 / 路径被占用）
    h.memoryFs.failWrites = true

    await expect(h.ipcMain.invoke(IPC.settingsSet, { startDelayMs: 500 })).rejects.toThrow(
      /设置保存失败/
    )
    await expect(h.ipcMain.invoke(IPC.settingsReset)).rejects.toThrow(/设置保存失败/)

    // 恢复可写后又能正常保存
    h.memoryFs.failWrites = false
    const saved = await h.ipcMain.invoke<{ startDelayMs: number }>(IPC.settingsSet, {
      startDelayMs: 600
    })
    expect(saved.startDelayMs).toBe(600)
  })
})

describe('IPC 输入相关', () => {
  it('start 会驱动引擎完成输入', async () => {
    const h = createHarness()
    // 关掉错字模拟：默认 typo.rate = 0.02 且 seed = 0（每次随机），
    // 会往动作流里插入"错字 + 退格"，让动作数断言偶发失败
    h.store.update({ typo: { rate: 0 }, seed: 1 })

    const summary = await h.ipcMain.invoke<{ state: string; typed: number; total: number }>(
      IPC.typingStart,
      { text: 'abc' }
    )
    expect(summary.state).toBe('completed')
    expect(summary.typed).toBe(3)
    expect(summary.total).toBe(3)
    expect(h.driver.items).toHaveLength(3)
  })

  it('start 缺少文本或类型错误时被拒绝', async () => {
    const h = createHarness()
    await expect(h.ipcMain.invoke(IPC.typingStart, {})).rejects.toThrow(/缺少文本内容/)
    await expect(h.ipcMain.invoke(IPC.typingStart, { text: 123 })).rejects.toThrow(/缺少文本内容/)
    await expect(h.ipcMain.invoke(IPC.typingStart, null)).rejects.toThrow(/请求参数格式错误/)
    await expect(
      h.ipcMain.invoke(IPC.typingStart, { text: 'a'.repeat(2_000_001) })
    ).rejects.toThrow(/文本过长/)
  })

  it('进行中再次 start 被拒绝（不会出现两条输入流）', async () => {
    const h = createHarness()
    const pending = h.ipcMain.invoke(IPC.typingStart, { text: 'a'.repeat(50) })
    await expect(h.ipcMain.invoke(IPC.typingStart, { text: 'b' })).rejects.toThrow(/正在进行/)
    h.engine.abort('测试结束')
    await pending
  })

  it('pause/resume/stop 返回引擎快照', async () => {
    const h = createHarness()
    const pending = h.ipcMain.invoke(IPC.typingStart, { text: 'a'.repeat(30) })
    const paused = await h.ipcMain.invoke<{ state: string }>(IPC.typingPause)
    expect(['countdown', 'running', 'paused', 'completed']).toContain(paused.state)

    const resumed = await h.ipcMain.invoke<{ state: string }>(IPC.typingResume)
    expect(['countdown', 'running', 'completed']).toContain(resumed.state)

    const stopped = await h.ipcMain.invoke<{ state: string }>(IPC.typingStop, '测试中止')
    expect(['countdown', 'aborted', 'completed']).toContain(stopped.state)
    await pending
  })

  it('status 返回待机状态', async () => {
    const h = createHarness()
    const snapshot = await h.ipcMain.invoke<{ state: string }>(IPC.typingStatus)
    expect(snapshot.state).toBe('idle')
  })

  it('foreground 在宿主报错时返回 null 而不是抛错', async () => {
    const h = createHarness()
    h.driver.foreground = async () => {
      throw new Error('宿主挂了')
    }
    expect(await h.ipcMain.invoke(IPC.typingForeground)).toBeNull()
  })
})

describe('IPC 文件导入', () => {
  it('pick 返回路径，import 返回内容与编码', async () => {
    const h = createHarness()
    expect(await h.ipcMain.invoke(IPC.filesPick)).toBe('C:\\temp\\input.txt')

    const result = await h.ipcMain.invoke<ImportResult>(IPC.filesImport, {
      path: 'C:\\temp\\a.txt'
    })
    expect(result.text).toBe('文件内容')
    expect(h.importCalls).toEqual([{ path: 'C:\\temp\\a.txt', charset: undefined }])
  })

  it('透传编码参数', async () => {
    const h = createHarness()
    await h.ipcMain.invoke(IPC.filesImport, { path: 'C:\\temp\\a.txt', charset: 'gbk' })
    expect(h.importCalls[0]?.charset).toBe('gbk')
  })

  it('缺少路径或编码非法时被拒绝', async () => {
    const h = createHarness()
    await expect(h.ipcMain.invoke(IPC.filesImport, {})).rejects.toThrow(/缺少文件路径/)
    await expect(h.ipcMain.invoke(IPC.filesImport, { path: 'a', charset: 'big5' })).rejects.toThrow(
      /不支持的编码/
    )
  })

  it('读取失败时把原因透传给界面', async () => {
    const h = createHarness({ importFileError: new Error('文件过大') })
    await expect(h.ipcMain.invoke(IPC.filesImport, { path: 'a.txt' })).rejects.toThrow('文件过大')
  })
})

describe('IPC app:info', () => {
  it('返回应用与平台信息', async () => {
    const h = createHarness()
    expect(await h.ipcMain.invoke(IPC.appInfo)).toEqual({
      name: 'typer',
      version: '0.1.0',
      platform: 'win32',
      supported: true
    })
  })
})

describe('createEngineEventBridge', () => {
  it('把引擎事件映射到 IPC 事件频道', () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const bridge = createEngineEventBridge((channel, payload) => sent.push({ channel, payload }))

    bridge.onState({ state: 'running', typed: 1, total: 3, countdownRemainingMs: 0 })
    bridge.onProgress({
      typed: 1,
      total: 3,
      percent: 1 / 3,
      elapsedMs: 10,
      remainingMs: 20,
      aps: 100,
      stage: 'typing',
      countdownRemainingMs: 0
    })
    bridge.onLog('warn', '注意')

    expect(sent.map((entry) => entry.channel)).toEqual([
      IPC.eventState,
      IPC.eventProgress,
      IPC.eventLog
    ])
    expect(sent[2]?.payload).toEqual({ level: 'warn', message: '注意' })
  })
})
