import type { HostForegroundData, HostItem, HostProbeData, HostTypeData } from './protocol'

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
  send(items: HostItem[]): Promise<HostTypeData>
  /** 释放所有可能按下的修饰键（任何结束路径都必须调用，避免粘键） */
  releaseAll(): Promise<void>
  /** 读取当前前台窗口信息（焦点守护用） */
  foreground(): Promise<HostForegroundData>
  /** 探测是否仍有按键处于按下状态（abort 后自检） */
  probe(): Promise<HostProbeData>
  /** 通过剪贴板粘贴代替逐字符输入（长文本/游戏回退方案） */
  paste(text: string): Promise<void>
  /** 关闭宿主并释放资源 */
  dispose(): Promise<void>
}

export type { HostForegroundData, HostItem, HostProbeData, HostTypeData }
