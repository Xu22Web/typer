import type {
  HostForegroundData,
  HostImeData,
  HostItem,
  HostProbeData,
  HostTypeData
} from './protocol'

/** 下发动作的可选行为。 */
export interface SendOptions {
  /**
   * 每个动作单独一次 `SendInput`（不让宿主攒批）。
   *
   * 数据帧早期为了"绝不丢字符"用过它；现在数据帧改用「省略 keyup + 攒批」，
   * 靠每片 CRC32 与整文件 SHA-256 保证正确性（丢字符会被立刻抓到并只重传该片）。
   */
  perItem?: boolean
  /**
   * 修饰键按下后、主键之前的等待毫秒数（默认 15）。
   *
   * 远程桌面会把同一次 SendInput 里的修饰键与主键合批，实测修饰键会被直接丢弃；
   * 拆成独立调用并在按下后等一小段才能生效。
   */
  modLeadMs?: number
  /** 修饰键抬起之前的等待毫秒数（默认 10） */
  modTailMs?: number
}

/**
 * 键盘注入驱动接口。
 *
 * 引擎只依赖这个接口，因此测试可以注入 `MockKeyboardDriver` 脱离真实键鼠与界面。
 */
export interface KeyboardDriver {
  readonly kind: string
  /** 启动宿主/建立连接（幂等，可重复调用） */
  start(): Promise<void>
  /** 下发一批动作；宿主按每个动作的 `delay` 依次注入 */
  send(items: HostItem[], options?: SendOptions): Promise<HostTypeData>
  /**
   * 立刻中止正在执行的那一批（不等响应）。
   * 不实现这个方法的驱动会退化为"等当前批次自然结束"，因此引擎的中止延迟仍受批次大小限制。
   */
  cancel?(): void
  /** 释放所有可能按下的修饰键（任何结束路径都必须调用，避免粘键） */
  releaseAll(): Promise<void>
  /** 读取当前前台窗口信息（焦点守护用） */
  foreground(): Promise<HostForegroundData>
  /**
   * 读取/切换目标窗口的键盘布局与输入法状态（可选能力）。
   *
   * 注入的是真实按键，按键先经过目标窗口线程的输入法：开着中文输入法时字母键会被吃成候选上屏。
   * 不实现这个方法的驱动表示“这条链路没有输入法概念”（例如测试用 Mock）。
   */
  ime?(options?: { ensureEnglish?: boolean }): Promise<HostImeData>
  /** 探测是否仍有按键处于按下状态（abort 后自检） */
  probe(): Promise<HostProbeData>
  /** 关闭宿主并释放资源 */
  dispose(): Promise<void>
}

export type { HostForegroundData, HostImeData, HostItem, HostProbeData, HostTypeData }
