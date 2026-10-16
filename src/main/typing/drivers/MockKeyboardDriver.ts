import type { KeyboardDriver } from './KeyboardDriver'
import type { HostForegroundData, HostItem, HostProbeData, HostTypeData } from './protocol'

export interface MockDriverOptions {
  /** 反查前台窗口时返回的固定值。 */
  foreground?: HostForegroundData
  /** 为 true 时所有方法都抛错（模拟注入被系统拒绝）。 */
  failing?: boolean
  /** 记录的前台窗口序列，按调用顺序返回。 */
  foregroundQueue?: HostForegroundData[]
  /** 每批动作后的回调（用于在测试里推进时间/状态）。 */
  onSend?: (items: HostItem[], index: number) => void
}

/**
 * 测试用驱动：记录全部下发内容，不做任何真实注入。
 *
 * 断言重点：动作顺序、每个动作的延迟、releaseAll 调用次数与 paste 文本内容。
 */
export class MockKeyboardDriver implements KeyboardDriver {
  readonly kind = 'mock'

  /** 每次 start 调用的时间戳 */
  readonly started: number[] = []
  /** 每批下发的动作（逐项浅拷贝，断言时不受后续改动影响） */
  readonly batches: HostItem[][] = []
  /** 每次 paste 收到的文本 */
  readonly pasted: string[] = []
  releaseAllCalls = 0
  disposed = false
  private readonly options: MockDriverOptions

  /**
   * @description 用给定的测试行为创建 Mock 驱动
   * @param options 失败开关、固定前台窗口与各回调
   */
  constructor(options: MockDriverOptions = {}) {
    this.options = options
  }

  /** @description 拍平后的动作序列（忽略分批），便于断言顺序 */
  get items(): HostItem[] {
    return this.batches.flat()
  }

  /** @description 记录一次启动；failing 时抛出与真实驱动同形的错误 */
  async start(): Promise<void> {
    if (this.options.failing) throw new Error('mock driver: start failed')
    this.started.push(Date.now())
  }

  /**
   * @description 记录一批动作，并报告"全部注入成功"
   * @param items 待下发的动作
   * @returns 请求数与注入数相等的统计
   */
  async send(items: HostItem[]): Promise<HostTypeData> {
    if (this.options.failing) throw new Error('mock driver: send failed')
    const index = this.batches.length
    this.batches.push(items.map((item) => ({ ...item })))
    this.options.onSend?.(items, index)
    return { requested: items.length, injected: items.length }
  }

  /** @description 记录一次修饰键释放调用 */
  async releaseAll(): Promise<void> {
    this.releaseAllCalls += 1
  }

  /**
   * @description 返回前台窗口：优先消费 foregroundQueue，其次固定值，最后兜底假窗口
   * @returns 前台窗口信息
   */
  async foreground(): Promise<HostForegroundData> {
    const queued = this.options.foregroundQueue?.shift()
    return queued ?? this.options.foreground ?? { hwnd: 1, pid: 100, title: 'mock-window' }
  }

  /**
   * @description 始终报告没有按键粘住
   * @returns 空的 stuckKeys
   */
  async probe(): Promise<HostProbeData> {
    return { stuckKeys: [] }
  }

  /**
   * @description 记录一次粘贴文本
   * @param text 粘贴内容
   */
  async paste(text: string): Promise<void> {
    if (this.options.failing) throw new Error('mock driver: paste failed')
    this.pasted.push(text)
  }

  /** @description 标记为已释放 */
  async dispose(): Promise<void> {
    this.disposed = true
  }
}
