import type { KeyboardDriver, SendOptions } from './KeyboardDriver'
import type { HostForegroundData, HostItem, HostProbeData, HostTypeData } from './protocol'

export interface MockDriverOptions {
  /** 反查前台窗口时返回的固定值。 */
  foreground?: HostForegroundData
  /** 为 true 时所有方法都抛错（模拟注入被系统拒绝）。 */
  failing?: boolean
  /** 记录的前台窗口序列，按调用顺序返回。 */
  foregroundQueue?: HostForegroundData[]
  /** 为 true 时把前台窗口放进每批注入的结果里（模拟宿主"搭车"返回，省掉单独查询）。 */
  piggybackForeground?: boolean
  /** probe 报告的"仍处于按下状态"的虚拟键；默认空（没有粘键）。 */
  stuckKeys?: number[]
  /** 每批动作后的回调（用于在测试里推进时间/状态）。 */
  onSend?: (items: HostItem[], index: number) => void
}

/**
 * 测试用驱动：记录全部下发内容，不做任何真实注入。
 *
 * 断言重点：动作顺序、每个动作的延迟与 releaseAll 调用次数。
 */
export class MockKeyboardDriver implements KeyboardDriver {
  readonly kind = 'mock'

  /** 每次 start 调用的时间戳 */
  readonly started: number[] = []
  /** 每批下发的动作（逐项浅拷贝，断言时不受后续改动影响） */
  readonly batches: HostItem[][] = []
  /** 每次下发时携带的选项（断言"数据帧逐动作投递"用） */
  readonly sendOptions: SendOptions[] = []
  releaseAllCalls = 0
  cancelCalls = 0
  /** foreground() 被调用的次数：用于断言"焦点查询已搭车、没有额外往返" */
  foregroundCalls = 0
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
  async send(items: HostItem[], options: SendOptions = {}): Promise<HostTypeData> {
    if (this.options.failing) throw new Error('mock driver: send failed')
    const index = this.batches.length
    this.batches.push(items.map((item) => ({ ...item })))
    this.sendOptions.push({ ...options })
    this.options.onSend?.(items, index)
    // 模拟宿主"搭车"返回：这是批次响应里自带的信息，不算一次单独的往返查询
    const foreground = this.options.piggybackForeground
      ? (this.options.foreground ?? { hwnd: 1, pid: 100, title: 'mock-window' })
      : undefined
    return {
      requested: items.length,
      injected: items.length,
      ...(foreground ? { foreground } : {})
    }
  }

  /** @description 记录一次修饰键释放调用 */
  async releaseAll(): Promise<void> {
    this.releaseAllCalls += 1
  }

  /** @description 记录一次紧急中止请求 */
  cancel(): void {
    this.cancelCalls += 1
  }

  /**
   * @description 返回前台窗口：优先消费 foregroundQueue，其次固定值，最后兜底假窗口
   * @returns 前台窗口信息
   */
  async foreground(): Promise<HostForegroundData> {
    this.foregroundCalls += 1
    const queued = this.options.foregroundQueue?.shift()
    return queued ?? this.options.foreground ?? { hwnd: 1, pid: 100, title: 'mock-window' }
  }

  /**
   * @description 报告粘键情况；用 `stuckKeys` 模拟“完成后仍有键按住”的异常场景
   * @returns 当前被设为按下的虚拟键
   */
  async probe(): Promise<HostProbeData> {
    return { stuckKeys: [...(this.options.stuckKeys ?? [])] }
  }

  /** @description 标记为已释放 */
  async dispose(): Promise<void> {
    this.disposed = true
  }
}
