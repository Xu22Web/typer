/**
 * 设置的纯类型定义：只放类型，且依赖均为纯类型模块（不含 electron / node 运行时依赖），
 * 供 preload 的类型声明引用而不必解析主进程实现。
 */
import type { FocusGuardMode } from '../typing/focus/focusGuard'
import type { LayoutId } from '../typing/planner/keymap'
import type { LineStartMode, NewlineKey } from '../typing/planner/types'
import type { TransferPace } from '../typing/scheduling/profile'
import type { TimingSettings } from '../typing/scheduling/timing'
import type { TypoCorrection, TypoStyle } from '../typing/scheduling/typo'
import type { DockEdge } from '../window/floatDock'
import type {
  TransferAlphabet,
  TransferCompression,
  TransferTargetMode
} from '@shared/transfer/transfer'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'
export type ImportCharset = 'auto' | 'utf8' | 'utf16le' | 'gbk'
/** 输入结束后的浮窗行为 */
export type FinishBehavior = 'manual' | 'auto'
export type { LineStartMode, NewlineKey } from '../typing/planner/types'
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
    /**
     * 每个字符的最小间隔下限（毫秒），0 表示不额外抬升。
     *
     * 生效值 = max(档位自带下限, 该值)：云桌面/远程桌面的远端输入队列紧张时，
     * 抬到几毫秒能让队列退到不饱和，避免静默丢字符。
     */
    minDelayMs: number
  }
  /**
   * 修饰键时序（远程桌面适配）。
   *
   * 远程桌面客户端会把同一次 `SendInput` 里的修饰键与主键合批丢弃（`Shift+1` 到远端只剩 `1`），
   * 所以宿主把修饰键拆成独立调用并留间隔；链路延迟大的云桌面需要把间隔调大。
   */
  modifier: {
    /** 按下修饰键后、打主键前的等待（毫秒） */
    leadMs: number
    /** 抬起修饰键之前的等待（毫秒） */
    tailMs: number
  }
  /** 文本输入的换行与行首处理（只作用于文本输入，文件传输恒用 Enter） */
  text: {
    /** 换行用哪个键：Enter / Shift+Enter / Ctrl+Enter */
    newlineKey: NewlineKey
    /** 换行后是否把光标归到行首：off（不处理）/ home（只归位）/ home-select（归位并清掉自动缩进） */
    lineStart: LineStartMode
  }
  typo: {
    rate: number
    style: TypoStyle
    correction: TypoCorrection
  }
  keyboard: {
    layout: LayoutId
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
    /** 载荷符号表：ascii32（5 比特、零 Shift，云桌面推荐）/ ascii64（6 比特）/ hex（4 比特，诊断） */
    alphabet: TransferAlphabet
    /** 压缩方式：auto（按样本决定）/ br（Brotli）/ none */
    compression: TransferCompression
    /** Brotli 质量（1~11）：9 是速度与压缩率的平衡点 */
    quality: number
    /** 目标端：终端 / 编辑器 / 单行输入框（决定换行方式） */
    mode: TransferTargetMode
    /** 节奏档：safe 逐字 1ms；fast 逐字无停顿；turbo 攒批 + 零延迟 + 压力阀自适应 */
    paceMode: TransferPace
    /** 每片线上字节数 */
    chunkBytes: number
    /** 单帧字符上限 */
    maxFrameChars: number
    /** 片与片之间的额外停顿 */
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
    /** 输入结束后的处理：manual 留在浮窗等用户点「返回主窗口」；auto 自动收起浮窗并召回主窗口 */
    finishBehavior: FinishBehavior
  }
  /** 完成后自检是否有按键粘住 */
  verifyStuckKeys: boolean
  logLevel: LogLevel
}
