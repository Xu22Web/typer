import type { ElectronAPI } from '@electron-toolkit/preload'
import type { AppInfo, ImportResult, WindowStatePayload } from '@main/ipc/contracts'
import type { UpdateCheckResult, UpdateProgress, UpdateState } from '@main/update/types'
import type { Settings } from '@main/settings/types'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot } from '@main/typing/engine/states'
import type { HostForegroundData } from '@main/typing/drivers/protocol'
import type {
  ResumeMatch,
  TransferJobSummary,
  TransferPrepareOptions,
  TransferPrepareProgress
} from '@shared/transfer/transfer'

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

/** 发送计划：这次发哪些片、是否携带开始/结束帧。 */
export interface FramePlan {
  indexes: number[]
  ranges: string
  sendBegin: boolean
  sendEnd: boolean
}

export interface FramePlanRequest {
  only?: string
  from?: number
  /** 接收端还缺哪些片（来自续传状态）；省略或 null 表示全新传输 */
  resumeMissing?: number[] | null
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
  /** 文件传输：把文件切成"每片一行"的帧，用键盘/剪贴板送到目标窗口。 */
  transfer: {
    /** 选择文件（返回路径或 null） */
    pick: () => Promise<string | null>
    /** 读取文件 + 哈希 + 分片，返回任务摘要（可取消）；`reuse` 表示同一文件只改了片大小/编码 */
    prepare: (
      path: string,
      options: TransferPrepareOptions,
      config?: { reuse?: boolean }
    ) => Promise<TransferJobSummary>
    /** 中止正在进行的准备（哈希阶段） */
    cancelPrepare: () => Promise<boolean>
    /** 解析接收端带回来的续传状态（resume.json 内容或续传令牌） */
    resumeState: (text: string) => Promise<ResumeMatch>
    /** 预览"这次会发哪些片 / 是否带开始与结束帧"（不产生任何输入） */
    plan: (options: FramePlanRequest) => Promise<FramePlan>
    /** 开始输入：`only`/`from` 决定这次发哪些片 */
    start: (options: FramePlanRequest) => Promise<RunSummary & { plan?: FramePlan }>
    /** 把接收/分片脚本复制到用户选择的目录（返回目标目录或 null） */
    exportTools: () => Promise<string | null>
    /** 在资源管理器里定位脚本目录 */
    revealTools: () => Promise<boolean>
    onPrepareProgress: (listener: (payload: TransferPrepareProgress) => void) => () => void
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
