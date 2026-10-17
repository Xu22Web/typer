import type { HostForegroundData, HostItem, HostProbeData, HostTypeData } from './protocol'

/** 下发动作的可选行为。 */
export interface SendOptions {
  /**
   * 每个动作单独一次 `SendInput`（不让宿主攒批）。
   *
   * 数据帧必须开启：实测（真实终端接收端）一次 `SendInput` 投递多个字符时，
   * 目标端输入缓冲紧张会**静默丢字符**——丢一个字符整片 CRC 就过不去。
   * 逐动作投递则零丢失，速率同样可观（约 460 字符/秒）。
   */
  perItem?: boolean
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
  /** 探测是否仍有按键处于按下状态（abort 后自检） */
  probe(): Promise<HostProbeData>
  /** 关闭宿主并释放资源 */
  dispose(): Promise<void>
}

export type { HostForegroundData, HostItem, HostProbeData, HostTypeData }
