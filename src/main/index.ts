import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  shell
} from 'electron'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
import type { ImportCharset } from './settings/types'
import { copyToolsTo, TransferSession } from './transfer/session'
import { resolveToolsDir } from './transfer/toolsLocator'
import { createDriver, type KeyboardDriver } from './typing/drivers'
import { resolveHostScriptPath } from './typing/drivers/hostLocator'
import { TypingEngine } from './typing/engine/TypingEngine'
import { disposeHotkeys, registerHotkeys } from './typing/hotkeys'
import { createUpdateService, type UpdateService } from './update/updateService'
import { realNow, realSleep } from './util/clock'
import { createLogger } from './util/logger'
import { settingsFilePath, updateDownloadDir } from './util/paths'
import { decodeText } from './util/textFile'

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

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

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

  // 最大化状态变化时推给渲染进程，让标题栏按钮切换"最大化/还原"图标
  const pushWindowState = (): void => {
    broadcast(IPC.eventWindowState, { maximized: window.isMaximized() })
  }
  window.on('maximize', pushWindowState)
  window.on('unmaximize', pushWindowState)

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
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
 * 宿主不可用时的占位驱动：让界面能正常加载，并在用户点击"开始"时
 * 给出明确原因（而不是白屏或静默失败）。
 */
function createUnavailableDriver(message: string): KeyboardDriver {
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
    paste: fail,
    dispose: async () => {}
  }
}

/** 选择要传输的文件：不做扩展名过滤（任意文件都要能传）。 */
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

/** tools/ 在开发模式下位于仓库根目录，打包后位于 resources/ 下。 */
function toolsLocatorContext(): { isPackaged: boolean; appPath: string; resourcesPath: string } {
  return {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  }
}

/** 把接收/分片脚本复制到用户选择的目录（目标机没有 npm，需要的正是这些可直接运行的文件）。 */
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

async function revealTools(): Promise<boolean> {
  const dir = resolveToolsDir(toolsLocatorContext())
  const error = await shell.openPath(dir)
  return error.length === 0
}

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

function buildDriver(store: SettingsStore): KeyboardDriver {
  if (process.platform !== 'win32') {
    return createUnavailableDriver(
      `当前系统（${process.platform}）暂不支持键盘注入：本程序目前仅支持 Windows`
    )
  }

  try {
    return createDriver({
      platform: process.platform,
      clipboard,
      locator: {
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath
      },
      restoreClipboard: store.get().clipboard.restore,
      onLog: (level, message) => logger[level](message)
    })
  } catch (error) {
    return createUnavailableDriver(error instanceof Error ? error.message : String(error))
  }
}

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

  driver = buildDriver(store)

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
    onState: bridge.onState,
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
      isMaximized: () => mainWindow?.isMaximized() ?? false
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
      revealTools: () => revealTools()
    },
    openExternal: async (url) => {
      await shell.openExternal(url)
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

// 本程序只支持 Windows，不需要 macOS 的"关闭窗口但保留进程"语义
app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  disposeHotkeys({ register: () => false, unregisterAll: () => globalShortcut.unregisterAll() })
  void engine?.dispose().catch(() => {})
  void transfer?.dispose().catch(() => {})
})
