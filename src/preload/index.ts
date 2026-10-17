import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@main/ipc/channels'
import { toIpcError } from '@main/ipc/ipcError'
import { toPlainPayload } from '@main/ipc/plainPayload'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot } from '@main/typing/engine/states'
import type { WindowStatePayload } from '@main/ipc/contracts'
import type { FloatStatePayload } from '@main/window/floatingWindow'
import type { UpdateProgress, UpdateState } from '@main/update/types'

/**
 * @description 订阅主进程事件
 * @param channel IPC 事件频道
 * @param listener 收到载荷时的回调
 * @returns 取消订阅的函数
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.off(channel, wrapped)
  }
}

/**
 * @description 统一从这里发请求：净化参数并剥掉 Electron 给主进程错误加的包装，让界面能直接展示主进程给出的中文原因。
 * 必须净化参数是因为渲染进程传进来的常常是 Vue 响应式 Proxy，而 `ipcRenderer.invoke` 用结构化克隆
 * 序列化参数、无法克隆 Proxy，会抛 `An object could not be cloned` 让整个调用失败
 * @param channel IPC 频道
 * @param args 传给主进程的参数
 * @returns 主进程返回的结果
 */
async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(
      channel,
      ...args.map((arg) => toPlainPayload(arg))
    )) as Promise<T>
  } catch (error) {
    throw toIpcError(error)
  }
}

const api = {
  getAppInfo: () => invoke(IPC.appInfo),
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch: unknown) => invoke(IPC.settingsSet, patch),
    reset: () => invoke(IPC.settingsReset)
  },
  typing: {
    start: (text: string) => invoke(IPC.typingStart, { text }),
    pause: () => invoke(IPC.typingPause),
    resume: () => invoke(IPC.typingResume),
    stop: (reason?: string) => invoke(IPC.typingStop, reason),
    status: () => invoke(IPC.typingStatus),
    foreground: () => invoke(IPC.typingForeground)
  },
  files: {
    pick: () => invoke(IPC.filesPick),
    import: (path: string, charset?: string) => invoke(IPC.filesImport, { path, charset })
  },
  transfer: {
    pick: () => invoke(IPC.transferPick),
    prepare: (path: string, options: unknown, config?: { reuse?: boolean }) =>
      invoke(IPC.transferPrepare, { path, options, reuse: config?.reuse === true }),
    cancelPrepare: () => invoke(IPC.transferCancelPrepare),
    resumeState: (text: string) => invoke(IPC.transferResumeState, { text }),
    plan: (options: unknown) => invoke(IPC.transferPlan, options),
    start: (options: unknown) => invoke(IPC.transferStartFrames, options),
    exportTools: () => invoke(IPC.transferExportTools),
    revealTools: () => invoke(IPC.transferRevealTools),
    toolScript: () => invoke(IPC.transferToolScript),
    onPrepareProgress: (listener: (payload: unknown) => void) =>
      subscribe(IPC.eventTransferPrepare, listener)
  },
  window: {
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => invoke(IPC.windowClose),
    isMaximized: () => invoke(IPC.windowIsMaximized),
    /** 召回并聚焦主窗口（进度浮窗点击时用） */
    focusMain: () => invoke(IPC.windowFocusMain),
    onState: (listener: (payload: WindowStatePayload) => void) =>
      subscribe(IPC.eventWindowState, listener)
  },
  float: {
    /** 展开成卡片（鼠标靠近细条时） */
    expand: () => invoke(IPC.floatExpand),
    /** 收回成贴边细条（鼠标离开后） */
    collapse: () => invoke(IPC.floatCollapse),
    /** 拖动位移（单位 DIP） */
    drag: (dx: number, dy: number) => invoke(IPC.floatDrag, { dx, dy }),
    /** 拖动落定：靠近边缘则吸附成细条，否则自由浮动 */
    drop: () => invoke(IPC.floatDrop),
    /** 立刻吸附到最近的边 */
    dock: () => invoke(IPC.floatDock),
    /** 贴边时把窗口切成"接收鼠标 / 点击穿透" */
    setInteractive: (interactive: boolean) => invoke(IPC.floatInteractive, interactive),
    onState: (listener: (payload: FloatStatePayload) => void) =>
      subscribe(IPC.eventFloatState, listener)
  },
  updates: {
    check: (force = false) => invoke(IPC.updateCheck, { force }),
    download: () => invoke(IPC.updateDownload),
    cancel: () => invoke(IPC.updateCancel),
    install: () => invoke(IPC.updateInstall),
    state: () => invoke(IPC.updateState),
    onState: (listener: (payload: UpdateState) => void) =>
      subscribe(IPC.eventUpdateState, listener),
    onProgress: (listener: (payload: UpdateProgress) => void) =>
      subscribe(IPC.eventUpdateProgress, listener)
  },
  openExternal: (url: string) => invoke(IPC.shellOpenExternal, url),
  onProgress: (listener: (payload: ProgressSnapshot) => void) =>
    subscribe(IPC.eventProgress, listener),
  onState: (listener: (payload: EngineSnapshot) => void) => subscribe(IPC.eventState, listener),
  onLog: (listener: (payload: { level: string; message: string }) => void) =>
    subscribe(IPC.eventLog, listener)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
