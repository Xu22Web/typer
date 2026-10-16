import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@main/ipc/channels'
import { toIpcError } from '@main/ipc/ipcError'
import { toPlainPayload } from '@main/ipc/plainPayload'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot } from '@main/typing/engine/states'
import type { WindowStatePayload } from '@main/ipc/contracts'
import type { UpdateProgress, UpdateState } from '@main/update/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.off(channel, wrapped)
  }
}

/**
 * 统一从这里发请求，做两件事：
 *
 * 1. 把参数净化成"结构化克隆能处理"的纯对象。渲染进程传进来的参数常常是 Vue 的
 *    响应式 Proxy，而 `ipcRenderer.invoke` 用结构化克隆序列化参数，**无法克隆 Proxy**，
 *    会抛 `An object could not be cloned` 让整个调用失败。
 * 2. 剥掉 Electron 给主进程错误加的包装（`Error invoking remote method 'x': Error: …`），
 *    让界面能直接展示主进程给出的中文原因。
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
  window: {
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => invoke(IPC.windowClose),
    isMaximized: () => invoke(IPC.windowIsMaximized),
    onState: (listener: (payload: WindowStatePayload) => void) =>
      subscribe(IPC.eventWindowState, listener)
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
