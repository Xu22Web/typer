import type { SettingsStore } from '../settings/store'
import type { PersistResult } from '../settings/store'
import { toEngineSettings } from '../settings/schema'
import type { ImportCharset } from '../settings/types'
import type { TypingEngine } from '../typing/engine/TypingEngine'
import type { ProgressSnapshot } from '../typing/engine/progress'
import type { EngineSnapshot } from '../typing/engine/states'
import type { UpdateCheckResult, UpdateProgress, UpdateState } from '../update/types'
import type { Logger } from '../util/logger'
import { IPC } from './channels'
import {
  IpcValidationError,
  parseExternalUrl,
  parseImportRequest,
  parseSettingsPayload,
  parseStartRequest,
  type AppInfo
} from './contracts'

/** `ipcMain` 的最小接口（便于测试注入）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler?(channel: string): void
}

export interface ImportResult {
  path: string
  fileName: string
  text: string
  charset: string
  bytes: number
}

/**
 * 自绘标题栏需要的窗口操作。
 *
 * 由主进程注入（谁持有 BrowserWindow 谁实现），这样 IPC 层不必依赖 Electron，
 * 单测里可以直接传假实现。
 */
export interface WindowControls {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => boolean
}

export interface RegisterIpcOptions {
  ipcMain: IpcMainLike
  settings: SettingsStore
  engine: TypingEngine
  getAppInfo: () => AppInfo
  pickFile: () => Promise<string | null>
  importFile: (path: string, charset?: ImportCharset) => Promise<ImportResult>
  /** 缺省时不注册窗口控制频道（例如无窗口的测试环境）。 */
  windowControls?: WindowControls
  /** 更新服务；缺省时不注册更新频道。 */
  updates?: UpdateControls
  /** 在默认浏览器打开外链。 */
  openExternal?: (url: string) => Promise<void> | void
  logger?: Logger
}

/** 更新服务的 IPC 面（只暴露界面需要的那几个动作）。 */
export interface UpdateControls {
  check: (options?: { force?: boolean }) => Promise<UpdateCheckResult>
  download: () => Promise<UpdateState>
  cancelDownload: () => void
  install: () => UpdateState
  state: () => UpdateState
}

function toMessage(error: unknown): string {
  if (error instanceof IpcValidationError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 把"没能落盘"转成错误抛出。
 *
 * 默认不落盘（隐私设置）不算失败，只有真正写盘失败才需要让界面看到，
 * 否则会出现"界面提示已保存、磁盘其实没变"的假成功。
 */
function assertPersisted(result: PersistResult): void {
  if (result.ok) return
  throw new Error(`设置保存失败：${result.error ?? '未知原因'}`)
}

/**
 * 注册所有 IPC 处理器。
 *
 * 约定：
 * - 与业务无关的胶水（谁持有窗口、怎么广播）通过参数注入，方便测试
 * - 所有异常都转成可读中文消息；校验失败与执行失败都不应让主进程崩溃
 */
export function registerIpcHandlers(options: RegisterIpcOptions): string[] {
  const {
    ipcMain,
    settings,
    engine,
    getAppInfo,
    importFile,
    pickFile,
    windowControls,
    updates,
    openExternal,
    logger
  } = options
  const registered: string[] = []

  const register = (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
  ): void => {
    ipcMain.removeHandler?.(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args)
      } catch (error) {
        const message = toMessage(error)
        logger?.warn(`IPC ${channel} 失败：${message}`)
        throw new Error(message)
      }
    })
    registered.push(channel)
  }

  register(IPC.appInfo, () => getAppInfo())

  register(IPC.settingsGet, () => settings.get())

  register(IPC.settingsSet, (_event, payload) => {
    const result = settings.update(parseSettingsPayload(payload))
    assertPersisted(result)
    return result.settings
  })

  register(IPC.settingsReset, () => {
    const result = settings.reset()
    assertPersisted(result)
    return result.settings
  })

  register(IPC.typingStart, async (_event, payload) => {
    const { text } = parseStartRequest(payload)
    if (engine.isRunning) {
      throw new IpcValidationError('已有输入任务正在进行，请先停止')
    }
    const result = await engine.start(text, toEngineSettings(settings.get()))
    return {
      state: result.state,
      typed: result.typed,
      total: result.total,
      elapsedMs: result.elapsedMs,
      seed: result.seed,
      error: result.error ? result.error.message : undefined
    }
  })

  register(IPC.typingPause, () => {
    engine.pause()
    return engine.snapshot
  })

  register(IPC.typingResume, () => {
    engine.resume()
    return engine.snapshot
  })

  register(IPC.typingStop, (_event, reason) => {
    engine.abort(typeof reason === 'string' && reason.length > 0 ? reason : '用户中止')
    return engine.snapshot
  })

  register(IPC.typingStatus, () => engine.snapshot)

  register(IPC.typingForeground, async () => {
    try {
      return await engine.foreground()
    } catch (error) {
      logger?.warn(`读取前台窗口失败：${toMessage(error)}`)
      return null
    }
  })

  register(IPC.filesPick, async () => pickFile())

  register(IPC.filesImport, async (_event, payload) => {
    const request = parseImportRequest(payload)
    const result = await importFile(request.path, request.charset)
    logger?.info(`已导入文件：${result.fileName}（${result.charset}，${result.bytes} 字节）`)
    return result
  })

  if (windowControls) {
    register(IPC.windowMinimize, () => {
      windowControls.minimize()
    })

    register(IPC.windowToggleMaximize, () => {
      windowControls.toggleMaximize()
      return windowControls.isMaximized()
    })

    register(IPC.windowClose, () => {
      windowControls.close()
    })

    register(IPC.windowIsMaximized, () => windowControls.isMaximized())
  }

  if (updates) {
    register(IPC.updateCheck, (_event, payload) => {
      const force = (payload as { force?: unknown } | undefined)?.force === true
      return updates.check({ force })
    })

    register(IPC.updateDownload, () => updates.download())

    register(IPC.updateCancel, () => {
      updates.cancelDownload()
      return updates.state()
    })

    register(IPC.updateInstall, () => updates.install())

    register(IPC.updateState, () => updates.state())
  }

  if (openExternal) {
    register(IPC.shellOpenExternal, async (_event, payload) => {
      const url = parseExternalUrl(payload)
      await openExternal(url)
      return url
    })
  }

  return registered
}

/** 引擎事件 → 渲染进程事件桥。 */
export function createEngineEventBridge(broadcast: (channel: string, payload: unknown) => void): {
  onState: (snapshot: EngineSnapshot) => void
  onProgress: (snapshot: ProgressSnapshot) => void
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void
} {
  return {
    onState: (snapshot) => broadcast(IPC.eventState, snapshot),
    onProgress: (snapshot) => broadcast(IPC.eventProgress, snapshot),
    onLog: (level, message) => broadcast(IPC.eventLog, { level, message })
  }
}

/**
 * 更新服务事件 → 渲染进程事件桥。
 *
 * 「下载进度」单独一个频道：它每秒可能触发多次，和状态快照混在一起会让状态更新
 * 变得难以推理（也更容易触发界面上的无谓重绘）。
 */
export function createUpdateEventBridge(broadcast: (channel: string, payload: unknown) => void): {
  onState: (state: UpdateState) => void
  onProgress: (progress: UpdateProgress) => void
} {
  return {
    onState: (state) => broadcast(IPC.eventUpdateState, state),
    onProgress: (progress) => broadcast(IPC.eventUpdateProgress, progress)
  }
}
