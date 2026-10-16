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
 * 断言重点：动作顺序、每个动作的延迟、releaseAll 是否被调用、paste 文本内容。
 */
export class MockKeyboardDriver implements KeyboardDriver {
  readonly kind = 'mock'

  readonly started: number[] = []
  readonly batches: HostItem[][] = []
  readonly pasted: string[] = []
  releaseAllCalls = 0
  disposed = false
  private readonly options: MockDriverOptions

  constructor(options: MockDriverOptions = {}) {
    this.options = options
  }

  /** 拍平后的动作序列（忽略分批），便于断言顺序。 */
  get items(): HostItem[] {
    return this.batches.flat()
  }

  async start(): Promise<void> {
    if (this.options.failing) throw new Error('mock driver: start failed')
    this.started.push(Date.now())
  }

  async send(items: HostItem[]): Promise<HostTypeData> {
    if (this.options.failing) throw new Error('mock driver: send failed')
    const index = this.batches.length
    this.batches.push(items.map((item) => ({ ...item })))
    this.options.onSend?.(items, index)
    return { requested: items.length, injected: items.length }
  }

  async releaseAll(): Promise<void> {
    this.releaseAllCalls += 1
  }

  async foreground(): Promise<HostForegroundData> {
    const queued = this.options.foregroundQueue?.shift()
    return queued ?? this.options.foreground ?? { hwnd: 1, pid: 100, title: 'mock-window' }
  }

  async probe(): Promise<HostProbeData> {
    return { stuckKeys: [] }
  }

  async paste(text: string): Promise<void> {
    if (this.options.failing) throw new Error('mock driver: paste failed')
    this.pasted.push(text)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}
