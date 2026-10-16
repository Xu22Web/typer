/**
 * 设置的纯类型定义。
 *
 * 单独成文件的原因：preload 的类型声明（`src/preload/index.d.ts`）需要引用 `Settings`，
 * 而渲染进程的 tsconfig 不应该去解析主进程的实现代码。这里只放类型，
 * 且所有依赖都是纯类型模块（不含 electron / node 运行时依赖）。
 */
import type { InsertMode } from '../typing/engine/TypingEngine'
import type { FocusGuardMode } from '../typing/focus/focusGuard'
import type { LayoutId } from '../typing/planner/keymap'
import type { TimingSettings } from '../typing/scheduling/timing'
import type { TypoCorrection, TypoStyle } from '../typing/scheduling/typo'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'
export type ImportCharset = 'auto' | 'utf8' | 'utf16le' | 'gbk'

export interface Settings {
  /** 点击开始后等待多久才开始输入 */
  startDelayMs: number
  insertMode: InsertMode
  /** auto 模式下超过多少字符改用剪贴板粘贴 */
  autoPasteThreshold: number
  /** 每批下发给宿主的动作数（决定"紧急停止"的最大延迟） */
  chunkSize: number
  /** 0 表示每次运行随机；>0 可复现节奏 */
  seed: number
  timing: TimingSettings
  typo: {
    rate: number
    style: TypoStyle
    correction: TypoCorrection
  }
  keyboard: {
    layout: LayoutId
    /** 全部走 Unicode 注入（与布局无关，最稳） */
    forceUnicodeForAll: boolean
  }
  focusGuard: FocusGuardMode
  hotkeys: {
    stop: string
    togglePause: string
  }
  privacy: {
    /** 输入内容不落盘（默认） */
    persistContent: boolean
    persistSettings: boolean
  }
  clipboard: {
    restore: boolean
    importCharset: ImportCharset
  }
  update: {
    /** 启动后自动检查 GitHub 是否有新版本 */
    checkOnStartup: boolean
  }
  /** 完成后自检是否有按键粘住 */
  verifyStuckKeys: boolean
  logLevel: LogLevel
}
