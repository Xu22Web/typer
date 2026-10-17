/**
 * 设置的纯类型定义：只放类型，且依赖均为纯类型模块（不含 electron / node 运行时依赖），
 * 供 preload 的类型声明引用而不必解析主进程实现。
 */
import type { FocusGuardMode } from '../typing/focus/focusGuard'
import type { LayoutId } from '../typing/planner/keymap'
import type { TransferPace } from '../typing/scheduling/profile'
import type { TimingSettings } from '../typing/scheduling/timing'
import type { TypoCorrection, TypoStyle } from '../typing/scheduling/typo'
import type { DockEdge } from '../window/floatDock'
import type { TransferEncoding } from '@shared/transfer/transfer'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'
export type ImportCharset = 'auto' | 'utf8' | 'utf16le' | 'gbk'
export type { InjectionProfile } from '../typing/scheduling/profile'

export interface Settings {
  /** 点击开始后等待多久才开始输入 */
  startDelayMs: number /** 每批下发给宿主的动作数（决定"紧急停止"的最大延迟） */
  chunkSize: number
  /** 0 表示每次运行随机；>0 可复现节奏 */
  seed: number
  timing: TimingSettings
  /** 注入档位：标准（逐字、最灵敏）或极速（攒批、零下限，速度由目标端决定） */
  injection: {
    profile: 'normal' | 'turbo'
  }
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
  files: {
    /** 导入文本文件时使用的编码（auto 表示自动识别） */
    importCharset: ImportCharset
  }
  /** 文件传输（把文件逐片"打"到目标窗口） */
  transfer: {
    /** 载荷编码：hex / b64 / txt（默认 hex：最抗终端与输入法干扰） */
    encoding: TransferEncoding
    /** 节奏档：safe 保留每字符 1ms 下限；fast 零延迟，靠压力阀按目标端自适应 */
    paceMode: TransferPace
    /** 每片原始字节数 */
    chunkBytes: number
    /** 单帧字符上限（终端/剪贴板对单行长度都有限制） */
    maxFrameChars: number
    /** 片与片之间的额外停顿：给接收端落盘/回显留时间 */
    interFrameDelayMs: number
  }
  update: {
    /** 启动后自动检查 GitHub 是否有新版本 */
    checkOnStartup: boolean
  }
  /** 进度浮窗：记住上次贴到哪条边 / 自由浮动停在哪里 */
  floating: {
    /** docked = 贴边细条；floating = 自由浮动卡片 */
    mode: 'docked' | 'floating'
    edge: DockEdge
    /** 沿边的位置（左右边是细条的上边 y，上下边是细条的左边 x）；越界时按所在屏幕夹取 */
    offset: number
    /** 自由浮动时卡片的左上角坐标 */
    x: number
    y: number
  }
  /** 完成后自检是否有按键粘住 */
  verifyStuckKeys: boolean
  logLevel: LogLevel
}
