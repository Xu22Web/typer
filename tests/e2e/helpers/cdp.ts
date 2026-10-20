/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 端到端测试要驱动的是「真实 Electron 应用里的渲染进程」，而这里只需要一个能力：
 * 在页面里求值。Node 22+ 自带 `WebSocket`，因此不引入 Playwright——也就不需要下载浏览器或
 * Electron 驱动，`pnpm test:e2e` 在任何有 Electron 依赖的机器上都能直接跑。
 */

/** Node 内置 WebSocket 的最小结构：避免为一个测试文件把 DOM 类型塞进 tsconfig */
interface WebSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

/** 调试端口 `/json/list` 返回的目标描述（只保留用得到的字段） */
export interface CdpTarget {
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/** 一次 `Runtime.evaluate` 的返回结构（只声明用得到的部分） */
interface EvaluateResult {
  result?: { value?: unknown }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

interface CdpMessage {
  id?: number
  result?: EvaluateResult & Record<string, unknown>
  error?: { message?: string }
}

interface Waiter {
  method: string
  resolve: (value: CdpMessage['result']) => void
  reject: (error: Error) => void
}

/**
 * @description 等待若干毫秒
 * @param ms 毫秒数
 * @returns 计时结束的 Promise
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/**
 * @description 轮询直到探测函数返回真值（超时抛错并带上最后一次的返回值）
 * @param probe 探测函数，返回真值即结束
 * @param options 超时、轮询间隔与用于报错的说明
 * @returns 探测函数的最后一次返回值
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 150
  const deadline = Date.now() + timeoutMs
  let last: unknown

  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last as T
    await sleep(intervalMs)
  }

  throw new Error(
    `等待超时：${options.label ?? '条件未满足'}（${timeoutMs}ms，最后结果 ${JSON.stringify(last)}）`
  )
}

/** 一条 CDP 连接：只实现「发命令 → 等响应」这一种模式 */
export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, Waiter>()

  /**
   * @description 保存连接并接上消息/关闭事件
   * @param socket 已打开的 WebSocket
   */
  private constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener('message', (event) => {
      this.onMessage(event.data)
    })
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(`CDP 连接已关闭（等待中的 ${waiter.method} 失败）`))
      }
      this.pending.clear()
    })
  }

  /**
   * @description 连接到一个调试目标
   * @param url `webSocketDebuggerUrl`
   * @returns 可用的客户端
   */
  static async connect(url: string): Promise<CdpClient> {
    const Ctor = (globalThis as { WebSocket?: new (target: string) => WebSocketLike }).WebSocket
    if (!Ctor) throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）')

    const socket = new Ctor(url)
    await new Promise<void>((done, fail) => {
      socket.addEventListener('open', () => done())
      socket.addEventListener('error', () => fail(new Error(`CDP 连接失败：${url}`)))
    })
    return new CdpClient(socket)
  }

  /**
   * @description 处理一条来自调试端点的消息（非本客户端发的 id 直接忽略）
   * @param data WebSocket 消息体
   */
  private onMessage(data: unknown): void {
    let message: CdpMessage
    try {
      message = JSON.parse(String(data)) as CdpMessage
    } catch {
      return
    }

    if (typeof message.id !== 'number') return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)

    if (message.error) {
      waiter.reject(new Error(`${message.error.message ?? 'CDP 错误'}（${waiter.method}）`))
      return
    }
    waiter.resolve(message.result)
  }

  /**
   * @description 发一条 CDP 命令并等它的响应
   * @param method 命令名，如 `Runtime.evaluate`
   * @param params 命令参数
   * @returns 命令结果
   */
  send(method: string, params: Record<string, unknown> = {}): Promise<EvaluateResult | undefined> {
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => {
          resolve(value)
        },
        reject
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * @description 在页面里执行一段表达式并取回它的值（支持 await 与返回值序列化）
   * @param expression 页面上下文里的表达式
   * @returns 求值结果
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })

    if (result?.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知错误'
      throw new Error(`页面里执行失败：${detail}`)
    }
    return result?.result?.value as T
  }

  /** @description 关闭连接（失败不影响测试结论） */
  close(): void {
    try {
      this.socket.close()
    } catch {
      // 忽略：连接可能已经断开
    }
  }
}
