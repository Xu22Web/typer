import type { SettingsStore } from '../settings/store'
import type { PersistResult } from '../settings/store'
import { toEngineSettings } from '../settings/schema'
import type { ImportCharset } from '../settings/types'
import type { TypingEngine } from '../typing/engine/TypingEngine'
import type { ProgressSnapshot } from '../typing/engine/progress'
import type { EngineSnapshot } from '../typing/engine/states'
import type { TransferSession } from '../transfer/session'
import type { UpdateCheckResult, UpdateProgress, UpdateState } from '../update/types'
import type { Logger } from '../util/logger'
import { IPC } from './channels'
import {
  IpcValidationError,
  parseExternalUrl,
  parseFloatDelta,
  parseImportRequest,
  parseSettingsPayload,
  parseStartRequest,
  parseTransferFramesRequest,
  parseTransferPrepareRequest,
  parseTransferResumeRequest,
  type AppInfo,
  type TransferToolScriptPayload
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
  /** 召回并聚焦主窗口（进度浮窗点击"回到主窗口"时用） */
  focusMain: () => void
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
  /** 文件传输会话；缺省时不注册传输频道。 */
  transfer?: TransferControls
  /** 进度浮窗；缺省时不注册浮窗频道。 */
  float?: FloatControls
  /** 在默认浏览器打开外链。 */
  openExternal?: (url: string) => Promise<void> | void
  logger?: Logger
}

/** 文件传输的 IPC 面（准备 / 续传比对 / 脚本导出）。 */
export interface TransferControls {
  /** 选择要传输的文件（与"导入文本"不同：不做扩展名过滤） */
  pickFile: () => Promise<string | null>
  prepare: (
    path: string,
    options: Parameters<TransferSession['prepare']>[1],
    config?: { reuse?: boolean }
  ) => Promise<unknown>
  cancelPrepare: () => void
  matchResume: (text: string) => unknown
  createRequest: TransferSession['createRequest']
  plan: TransferSession['plan']
  /** 把 tools/ 复制到用户选择的目录，返回目标目录 */
  exportTools: () => Promise<string | null>
  /** 打开脚本所在目录（找不到时返回 false） */
  revealTools: () => Promise<boolean> | boolean
  /** 读取接收端脚本（构建产物）的路径与全文，交给渲染进程展示 / 复制 */
  toolScript: () => Promise<TransferToolScriptPayload> | TransferToolScriptPayload
}

/** 更新服务的 IPC 面（只暴露界面需要的那几个动作）。 */
export interface UpdateControls {
  check: (options?: { force?: boolean }) => Promise<UpdateCheckResult>
  download: () => Promise<UpdateState>
  cancelDownload: () => void
  install: () => UpdateState
  state: () => UpdateState
}

/** 进度浮窗的 IPC 面（拖动 / 吸附 / 展开由渲染进程驱动）。 */
export interface FloatControls {
  expand: () => void
  collapse: () => void
  dragBy: (dx: number, dy: number) => void
  drop: () => void
  /** 无条件吸附到最近的边（卡片上的"贴边"按钮） */
  dock: () => void
  /** 渲染进程请求开始 / 结束"窗口接收鼠标"（贴边时默认穿透） */
  setInteractive: (interactive: boolean) => void
}

/**
 * @description 取出面向用户的错误文本：校验错误直接透传，其它错误取 message
 * @param error 任意抛出物
 * @returns 错误文本
 */
function toMessage(error: unknown): string {
  if (error instanceof IpcValidationError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @description 把"没能落盘"转成错误抛出；按隐私设置有意跳过不算失败，否则会出现"界面提示已保存、磁盘其实没变"的假成功
 * @param result 持久化结果
 */
function assertPersisted(result: PersistResult): void {
  if (result.ok) return
  throw new Error(`设置保存失败：${result.error ?? '未知原因'}`)
}

/**
 * @description 注册所有 IPC 处理器；与业务无关的胶水（谁持有窗口、怎么广播）由参数注入，所有异常都转成可读中文消息而不让主进程崩溃
 * @param options 依赖注入集合：ipcMain、设置、引擎与各可选 IPC 面
 * @returns 已注册的频道名列表
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
    transfer,
    openExternal,
    logger,
    float: floatControls
  } = options
  const registered: string[] = []

  /**
   * @description 注册单个频道，并把处理器抛出的异常统一转成可读消息后重新抛出
   * @param channel 频道名
   * @param handler 实际处理器
   */
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

  if (transfer) {
    register(IPC.transferPick, () => transfer.pickFile())

    register(IPC.transferPrepare, async (_event, payload) => {
      const request = parseTransferPrepareRequest(payload)
      const summary = await transfer.prepare(request.path, request.options, {
        reuse: request.reuse
      })
      logger?.info(`已准备文件传输：${String((summary as { name?: string }).name ?? '')}`)
      return summary
    })

    register(IPC.transferCancelPrepare, () => {
      transfer.cancelPrepare()
      return true
    })
    register(IPC.transferResumeState, (_event, payload) =>
      transfer.matchResume(parseTransferResumeRequest(payload))
    )

    register(IPC.transferPlan, (_event, payload) =>
      transfer.plan(parseTransferFramesRequest(payload))
    )

    register(IPC.transferExportTools, async () => {
      const destination = await transfer.exportTools()
      if (destination) logger?.info(`已导出脚本到 ${destination}`)
      return destination
    })

    register(IPC.transferRevealTools, () => transfer.revealTools())

    // 接收端脚本是构建产物：渲染进程拿到全文就能直接展示 / 复制，用户不必去安装目录翻文件
    register(IPC.transferToolScript, () => transfer.toolScript())

    register(IPC.transferStartFrames, async (_event, payload) => {
      const options = parseTransferFramesRequest(payload)
      if (engine.isRunning) {
        throw new IpcValidationError('已有输入任务正在进行，请先停止')
      }

      const { request, plan } = transfer.createRequest(options, {
        onFrame: (index, ok, error) => {
          if (!ok) {
            logger?.error(`第 ${index} 片发送失败：${error ?? '未知原因'}`)
            return
          }
          // 逐片都记日志会把日志页冲掉，这里只按固定间隔留痕（失败必记）
          if (index > 0 && index % 20 === 0) logger?.info(`已发送第 ${index} 片`)
        }
      })

      const engineSettings = toEngineSettings(settings.get())
      logger?.info(
        `开始文件传输：发送 ${plan.ranges}（本次 ${request.indexes.length} 片，共 ${request.total} 片，` +
          `节奏 ${engineSettings.transferPace ?? 'safe'}）`
      )

      const result = await engine.start(request, engineSettings)
      return {
        state: result.state,
        typed: result.typed,
        total: result.total,
        elapsedMs: result.elapsedMs,
        seed: result.seed,
        error: result.error ? result.error.message : undefined,
        plan
      }
    })
  }

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

    register(IPC.windowFocusMain, () => {
      windowControls.focusMain()
    })
  }

  if (floatControls) {
    register(IPC.floatExpand, () => {
      floatControls.expand()
    })

    register(IPC.floatCollapse, () => {
      floatControls.collapse()
    })

    register(IPC.floatDrag, (_event, payload) => {
      const delta = parseFloatDelta(payload)
      floatControls.dragBy(delta.dx, delta.dy)
    })

    register(IPC.floatDrop, () => {
      floatControls.drop()
    })

    register(IPC.floatDock, () => {
      floatControls.dock()
    })

    register(IPC.floatInteractive, (_event, payload) => {
      floatControls.setInteractive(payload === true)
    })
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

/**
 * @description 引擎事件 → 渲染进程事件桥
 * @param broadcast 主进程内的广播函数
 * @returns 引擎需要的三个事件回调
 */
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
 * @description 更新服务事件 → 渲染进程事件桥；下载进度单独一个频道，避免高频进度事件与状态快照混在一起
 * @param broadcast 主进程内的广播函数
 * @returns 更新服务需要的两个事件回调
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
