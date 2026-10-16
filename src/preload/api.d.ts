import type { ElectronAPI } from '@electron-toolkit/preload'
import type { AppInfo, ImportResult, WindowStatePayload } from '@main/ipc/contracts'
import type { UpdateCheckResult, UpdateProgress, UpdateState } from '@main/update/types'
import type { Settings } from '@main/settings/types'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot } from '@main/typing/engine/states'
import type { HostForegroundData } from '@main/typing/drivers/protocol'

/**
 * preload 暴露给渲染进程的 API 契约，以及 `window` 上的全局声明。
 *
 * 注意：这些声明**不能**放在 `src/preload/index.d.ts` 里。当同一个模块路径同时存在
 * `index.ts` 与 `index.d.ts` 时，TypeScript 只会把 `index.ts` 纳入程序、忽略 `index.d.ts`，
 * 于是 `declare global` 失效 —— 任何同时包含两者的 tsconfig（例如 tsconfig.test.json，
 * 它要编译渲染进程的 composables）都会报 `Property 'api' does not exist on type 'Window'`。
 * 因此单独放到没有 `.ts` 同名文件的 `api.d.ts`。
 */

export interface RunSummary {
  state: 'completed' | 'aborted' | 'failed'
  typed: number
  total: number
  elapsedMs: number
  seed: number
  error?: string
}

export interface TyperApi {
  getAppInfo: () => Promise<AppInfo>
  settings: {
    get: () => Promise<Settings>
    set: (patch: unknown) => Promise<Settings>
    reset: () => Promise<Settings>
  }
  typing: {
    start: (text: string) => Promise<RunSummary>
    pause: () => Promise<EngineSnapshot>
    resume: () => Promise<EngineSnapshot>
    stop: (reason?: string) => Promise<EngineSnapshot>
    status: () => Promise<EngineSnapshot>
    foreground: () => Promise<HostForegroundData | null>
  }
  files: {
    pick: () => Promise<string | null>
    import: (path: string, charset?: string) => Promise<ImportResult>
  }
  /** 自绘标题栏的窗口控制。 */
  window: {
    minimize: () => Promise<void>
    /** 切换最大化，返回切换后的状态 */
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onState: (listener: (payload: WindowStatePayload) => void) => () => void
  }
  /** 更新检查、下载、校验与安装。 */
  updates: {
    /** force=true 时绕过主进程的检查节流 */
    check: (force?: boolean) => Promise<UpdateCheckResult>
    download: () => Promise<UpdateState>
    cancel: () => Promise<UpdateState>
    install: () => Promise<UpdateState>
    state: () => Promise<UpdateState>
    onState: (listener: (payload: UpdateState) => void) => () => void
    onProgress: (listener: (payload: UpdateProgress) => void) => () => void
  }
  /** 用系统默认浏览器打开 http/https 链接。 */
  openExternal: (url: string) => Promise<string>
  onProgress: (listener: (payload: ProgressSnapshot) => void) => () => void
  onState: (listener: (payload: EngineSnapshot) => void) => () => void
  onLog: (listener: (payload: { level: string; message: string }) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: TyperApi
  }
}
