import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import { IPC } from './ipc/channels'
import {
  createEngineEventBridge,
  createUpdateEventBridge,
  registerIpcHandlers,
  type ImportResult
} from './ipc/registerIpc'
import { SettingsStore } from './settings/store'
import type { ImportCharset, Settings } from './settings/types'
import { copyToolsTo, TransferSession } from './transfer/session'
import { readToolScript } from './transfer/toolScript'
import { resolveToolsDir } from './transfer/toolsLocator'
import { createDriver, type KeyboardDriver } from './typing/drivers'
import { resolveHostScriptPath } from './typing/drivers/hostLocator'
import { TypingEngine } from './typing/engine/TypingEngine'
import { isBusy, isTerminal, type EngineState } from './typing/engine/states'
import { disposeHotkeys, registerHotkeys } from './typing/hotkeys'
import { createUpdateService, type UpdateService } from './update/updateService'
import { realNow, realSleep } from './util/clock'
import { createLogger } from './util/logger'
import { settingsFilePath, updateDownloadDir } from './util/paths'
import { decodeText } from './util/textFile'
import { createFloatingWindow, type FloatingWindowController } from './window/floatingWindow'
import type { FloatPlacement } from './window/floatDock'

/** 导入文件的体积上限；更大的内容请自行裁剪后再粘贴。 */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** 更新来源（GitHub Releases），与 package.json 的 repository 保持一致。 */
const UPDATE_REPOSITORY = { owner: 'Xu22Web', repo: 'typer' } as const

const logger = createLogger({ level: 'info', scope: 'Typer' })

let engine: TypingEngine | null = null
let driver: KeyboardDriver | null = null
let mainWindow: BrowserWindow | null = null
let updates: UpdateService | null = null
let transfer: TransferSession | null = null
let floating: FloatingWindowController | null = null

/**
 * @description 把一条消息广播给所有未销毁的窗口
 * @param channel 频道名
 * @param payload 载荷
 */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

/**
 * @description 进度浮窗页面地址：开发模式指向 dev server 的 float.html，打包后指向产物里的 float.html
 * @returns 可直接交给 BrowserWindow.loadURL 的地址
 */
function floatingPageUrl(): string {
  const devServer = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devServer) return `${devServer.replace(/\/+$/, '')}/float.html`
  return pathToFileURL(join(__dirname, '../renderer/float.html')).href
}

/**
 * @description 运行期同步进度浮窗：进行中最小化主窗口并显示浮窗；结束后按设置决定是自动召回主窗口，
 * 还是把浮窗钉在完成态、等用户点「返回主窗口」
 * @param state 引擎状态
 * @param settings 当前设置（决定结束后的行为）
 */
function syncFloatingWindow(state: EngineState, settings: Settings): void {
  if (isBusy(state)) {
    const window = mainWindow
    if (window && !window.isDestroyed() && !window.isMinimized()) window.minimize()
    floating?.show()
    return
  }

  if (!isTerminal(state)) return

  // manual（默认）：不抢焦点、不弹回主界面，把结果留在浮窗上等用户自己返回
  if (settings.floating.finishBehavior === 'manual') {
    floating?.pin()
    return
  }

  floating?.hide()
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** @description 设置里的浮窗摆放 → 控制器使用的摆放 */
function toFloatPlacement(floating: Settings['floating']): FloatPlacement {
  if (floating.mode === 'floating') {
    return { mode: 'floating', x: floating.x, y: floating.y }
  }
  return { mode: 'docked', edge: floating.edge, offset: floating.offset }
}

/** @description 控制器使用的摆放 → 设置里的浮窗摆放（只写摆放字段，其它项交给深合并保留） */
function fromFloatPlacement(placement: FloatPlacement): Partial<Settings['floating']> {
  if (placement.mode === 'floating') {
    return { mode: 'floating', edge: 'right', offset: 0, x: placement.x, y: placement.y }
  }
  return { mode: 'docked', edge: placement.edge, offset: placement.offset, x: 0, y: 0 }
}

/** @description 创建主窗口：无边框自绘标题栏，并把最大化状态变化推给渲染进程 */
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 880,
    minHeight: 620,
    show: false,
    // 自绘标题栏：去掉系统边框，把标题栏与窗口按钮交给渲染进程
    // （原生边框在深浅主题下都无法与自绘界面融为一体）
    frame: false,
    backgroundColor: '#1b1b1f',
    autoHideMenuBar: true,
    title: app.getName(),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow = window

  window.on('page-title-updated', (event) => {
    // 标题固定为应用名，避免渲染进程的路由/文档标题影响任务栏
    event.preventDefault()
    window.setTitle(app.getName())
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  /** @description 把窗口最大化状态推给渲染进程，让标题栏按钮切换"最大化/还原"图标 */
  const pushWindowState = (): void => {
    broadcast(IPC.eventWindowState, { maximized: window.isMaximized() })
  }
  window.on('maximize', pushWindowState)
  window.on('unmaximize', pushWindowState)

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    // 主窗口关闭后浮窗没有要"召回"的目标，一并销毁
    floating?.dispose()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * @description 宿主不可用时的占位驱动：让界面能正常加载，并在用户点击"开始"时给出明确原因（而不是白屏或静默失败）
 * @param message 失败原因（会原样抛给界面）
 * @returns 只会抛错的驱动
 */
function createUnavailableDriver(message: string): KeyboardDriver {
  /**
   * @description 统一的失败实现：抛出宿主不可用的原因
   * @returns 永不返回（总是抛出）
   */
  const fail = async (): Promise<never> => {
    throw new Error(message)
  }

  return {
    kind: 'unavailable',
    start: fail,
    send: fail,
    releaseAll: async () => {},
    foreground: async () => ({ hwnd: 0, pid: 0, title: '' }),
    probe: async () => ({ stuckKeys: [] }),
    dispose: async () => {}
  }
}

/**
 * @description 选择要传输的文件：不做扩展名过滤（任意文件都要能传）
 * @returns 文件路径；用户取消时返回 null
 */
async function pickTransferFile(): Promise<string | null> {
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    title: '选择要输入的文件',
    properties: ['openFile' as const],
    filters: [{ name: '所有文件', extensions: ['*'] }]
  }
  const result = focused
    ? await dialog.showOpenDialog(focused, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/**
 * @description 采集定位 tools/ 目录所需的运行形态信息（开发模式下位于仓库根目录，打包后位于 resources/ 下）
 * @returns 运行形态与两个根路径
 */
function toolsLocatorContext(): { isPackaged: boolean; appPath: string; resourcesPath: string } {
  return {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  }
}

/**
 * @description 把接收端脚本（构建产物）复制到用户选择的目录（目标机没有 npm，需要的正是这些可直接运行的文件）
 * @returns 导出后的目标目录；用户取消时返回 null
 */
async function exportTools(): Promise<string | null> {
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    title: '选择脚本导出目录',
    properties: ['openDirectory' as const, 'createDirectory' as const]
  }
  const result = focused
    ? await dialog.showOpenDialog(focused, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const destination = join(result.filePaths[0] as string, 'typer-tools')
  copyToolsTo(resolveToolsDir(toolsLocatorContext()), destination)
  return destination
}

/**
 * @description 在系统文件管理器中打开脚本所在目录
 * @returns 是否成功打开（找不到目录时返回 false）
 */
async function revealTools(): Promise<boolean> {
  const dir = resolveToolsDir(toolsLocatorContext())
  const error = await shell.openPath(dir)
  return error.length === 0
}

/**
 * @description 读取并解码文本文件，同时施加体积上限
 * @param filePath 文件路径
 * @param charset 指定编码或 auto 探测
 * @returns 导入结果（路径、文件名、文本、实际编码、字节数）
 */
async function importTextFile(
  filePath: string,
  charset: ImportCharset = 'auto'
): Promise<ImportResult> {
  const buffer = await readFile(filePath)
  if (buffer.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(
      `文件过大（${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB），上限 ${
        MAX_IMPORT_BYTES / 1024 / 1024
      }MB`
    )
  }

  const decoded = decodeText(buffer, charset)
  return {
    path: filePath,
    fileName: basename(filePath),
    text: decoded.text,
    charset: decoded.charset,
    bytes: buffer.byteLength
  }
}

/**
 * @description 按当前平台与设置构建键盘驱动；非 Windows 或构建失败时退化为占位驱动
 * @returns 键盘驱动
 */
function buildDriver(): KeyboardDriver {
  if (process.platform !== 'win32') {
    return createUnavailableDriver(
      `当前系统（${process.platform}）暂不支持键盘注入：本程序目前仅支持 Windows`
    )
  }

  try {
    return createDriver({
      platform: process.platform,
      locator: {
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath
      },
      // 端到端调试用：宿主只走协议、不真的注入按键（tests/e2e 会设 TYPER_DRY_RUN=1），
      // 否则自动化跑起来会把字打到当时前台的那个窗口上
      dryRun: process.env['TYPER_DRY_RUN'] === '1',
      onLog: (level, message) => logger[level](message)
    })
  } catch (error) {
    return createUnavailableDriver(error instanceof Error ? error.message : String(error))
  }
}

/**
 * @description 应用启动流程：加载设置、建立驱动与引擎、注册 IPC 与热键、开窗并按需检查更新
 * @returns 启动流程走完后 resolve（启动期异常由调用方兜底）
 */
async function bootstrap(): Promise<void> {
  await app.whenReady()

  // 无边框窗口没有系统菜单栏的位置，应用菜单只会被 Alt 意外唤出并挤坏布局；
  // 复制/粘贴等编辑快捷键在 Windows 上由 Chromium 原生处理，不依赖菜单。
  Menu.setApplicationMenu(null)

  // 开发环境下 F12 开关 DevTools；生产环境忽略 Ctrl+R 之类快捷键
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const store = new SettingsStore({
    filePath: settingsFilePath(),
    logger: (level, message) => logger[level](message)
  })
  store.load()

  // 启动时就报出宿主缺失的问题，而不是等用户点击"开始"
  try {
    resolveHostScriptPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    })
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error))
  }

  driver = buildDriver()

  // 进度浮窗：跟随引擎状态显示/收起；摆放（贴边细条或自由浮动）跨重启记住
  floating = createFloatingWindow({
    preloadPath: join(__dirname, '../preload/index.js'),
    pageUrl: floatingPageUrl(),
    initialPlacement: toFloatPlacement(store.get().floating),
    onPlacementChange: (placement) => {
      const result = store.update({ floating: fromFloatPlacement(placement) })
      if (!result.ok) logger.warn(`浮窗位置保存失败：${result.error ?? '未知原因'}`)
    },
    onState: (payload) => broadcast(IPC.eventFloatState, payload),
    onLog: (level, message) => logger[level](`进度浮窗：${message}`)
  })

  const bridge = createEngineEventBridge(broadcast)
  // 文件传输会话：准备进度要实时推给界面（大文件哈希可能持续数秒）
  const transferSession = new TransferSession({
    onPrepareProgress: (progress) => broadcast(IPC.eventTransferPrepare, progress),
    onLog: (level, message) => logger[level](message)
  })
  transfer = transferSession
  const instance = new TypingEngine({
    driver,
    sleep: realSleep,
    now: realNow,
    onState: (snapshot) => {
      bridge.onState(snapshot)
      syncFloatingWindow(snapshot.state, store.get())
    },
    onProgress: bridge.onProgress,
    onLog: (level, message) => {
      logger[level](message)
      bridge.onLog(level, message)
    }
  })
  engine = instance

  const updateBridge = createUpdateEventBridge(broadcast)
  updates = createUpdateService({
    currentVersion: app.getVersion(),
    owner: UPDATE_REPOSITORY.owner,
    repo: UPDATE_REPOSITORY.repo,
    // 用 Electron 的 net.fetch：走系统代理与证书链，企业网络里比 Node fetch 更可靠
    fetch: (url, init) => net.fetch(url, init),
    downloadDir: updateDownloadDir(),
    isPackaged: app.isPackaged,
    userAgent: `Typer/${app.getVersion()} (Windows)`,
    onState: updateBridge.onState,
    onProgress: updateBridge.onProgress,
    launchInstaller: (filePath) => {
      // 用 detached 启动：安装向导要活到本进程退出之后
      const child = spawn(filePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
    },
    quitApp: () => app.quit()
  })

  registerIpcHandlers({
    ipcMain,
    settings: store,
    engine: instance,
    getAppInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      supported: process.platform === 'win32'
    }),
    importFile: importTextFile,
    pickFile: async () => {
      const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = {
        title: '选择要导入的文本文件',
        properties: ['openFile' as const],
        filters: [
          { name: '文本文件', extensions: ['txt', 'md', 'csv', 'log', 'json', 'srt', 'tsv'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      }
      const result = focused
        ? await dialog.showOpenDialog(focused, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0] ?? null
    },
    // 自绘标题栏：窗口实例由 createWindow 建立，这里只做延迟取用（含 activate 重建窗口的场景）
    windowControls: {
      minimize: () => mainWindow?.minimize(),
      toggleMaximize: () => {
        const window = mainWindow
        if (!window) return
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
      },
      close: () => mainWindow?.close(),
      isMaximized: () => mainWindow?.isMaximized() ?? false,
      focusMain: () => {
        const window = mainWindow
        // 先收起浮窗：从浮窗点「返回主窗口」时，浮窗再留在桌面上就多余了
        floating?.hide()
        if (!window || window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
    },
    updates: updates ?? undefined,
    transfer: {
      pickFile: () => pickTransferFile(),
      prepare: (path, options) => transferSession.prepare(path, options),
      cancelPrepare: () => transferSession.cancelPrepare(),
      matchResume: (text) => transferSession.matchResume(text),
      createRequest: (options, hooks) => transferSession.createRequest(options, hooks),
      plan: (options) => transferSession.plan(options),
      exportTools: () => exportTools(),
      revealTools: () => revealTools(),
      toolScript: () => readToolScript(toolsLocatorContext())
    },
    openExternal: async (url) => {
      await shell.openExternal(url)
    },
    float: {
      expand: () => floating?.expand(),
      collapse: () => floating?.collapse(),
      dragBy: (dx, dy) => floating?.dragBy(dx, dy),
      drop: () => floating?.drop(),
      dock: () => floating?.dock(),
      setInteractive: (interactive) => floating?.setInteractive(interactive)
    },
    logger
  })

  const hotkeyReport = registerHotkeys(
    {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregisterAll: () => globalShortcut.unregisterAll()
    },
    store.get().hotkeys,
    {
      stop: () => instance.abort('全局热键中止'),
      togglePause: () => {
        if (instance.state === 'paused') instance.resume()
        else instance.pause()
      }
    }
  )
  if (hotkeyReport.registered.length > 0) {
    logger.info(`全局热键已注册：${hotkeyReport.registered.join('、')}`)
  }
  if (hotkeyReport.failed.length > 0) {
    logger.warn(
      `部分全局热键注册失败：${hotkeyReport.failed
        .map((item) => `${item.accelerator}（${item.reason}）`)
        .join('、')}`
    )
  }
  broadcast(IPC.eventLog, {
    level: hotkeyReport.failed.length > 0 ? 'warn' : 'info',
    message:
      hotkeyReport.failed.length > 0
        ? `全局热键注册失败：${hotkeyReport.failed.map((item) => item.accelerator).join('、')}`
        : `全局热键已就绪：${hotkeyReport.registered.join('、')}`
  })

  // 预热输入宿主：Add-Type 首次编译需要 1~2 秒，提前做掉
  void driver.start().catch((error) => {
    logger.warn(`输入宿主预热失败：${error instanceof Error ? error.message : String(error)}`)
  })

  createWindow()

  // 启动后异步检查更新：失败只记日志，绝不打扰用户（离线是常态，不是错误）
  if (store.get().update.checkOnStartup) {
    setTimeout(() => {
      void updates
        ?.check()
        .then((result) => {
          if (result.status === 'available') {
            logger.info(`发现新版本 ${result.latest?.version ?? ''}`)
          }
        })
        .catch(() => {})
    }, 2500)
  }
}

void bootstrap().catch((error) => {
  logger.error(
    `启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  )
})

/** @description 窗口全部关闭即退出：本程序只支持 Windows，不需要 macOS 的"关闭窗口但保留进程"语义 */
app.on('window-all-closed', () => {
  app.quit()
})

/** @description 退出前释放全局热键、引擎、传输会话与浮窗 */
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  // 退出清理必须先让引擎把修饰键抬起来（宿主还活着才能收指令），
  // 所以拦住这个事件，等异步清理完再真正退出。
  event.preventDefault()
  disposeHotkeys({ register: () => false, unregisterAll: () => globalShortcut.unregisterAll() })
  floating?.dispose()
  void (async () => {
    await engine?.dispose().catch(() => {})
    await transfer?.dispose().catch(() => {})
    app.quit()
  })()
})
