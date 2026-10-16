import {
  createLineDecoder,
  parseResponse,
  ProtocolError,
  encodeRequest,
  type HostResponse
} from './protocol'

export interface WritableStreamLike {
  write(chunk: string, encoding?: BufferEncoding): boolean
  end(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface ReadableStreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export interface ChildProcessLike {
  pid?: number
  stdin: WritableStreamLike | null
  stdout: ReadableStreamLike | null
  stderr: ReadableStreamLike | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: string): boolean
}

export interface SpawnOptionsLike {
  cwd?: string
  env?: NodeJS.ProcessEnv
  windowsHide?: boolean
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike
) => ChildProcessLike

export interface ProcessLinesClientOptions {
  command: string
  args: readonly string[]
  spawn: SpawnFn
  /** 单次请求的基础超时（动作自身耗时另计） */
  requestTimeoutMs?: number
  /** 进程意外退出后的自动重启次数上限 */
  maxRestarts?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

interface PendingRequest {
  resolve: (response: HostResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESTARTS = 2

/**
 * JSON Lines 子进程客户端：启动宿主、按请求-响应模型通信、超时处理、崩溃自动重启。
 *
 * 所有与进程相关的能力都通过 `spawn` 注入，因此测试可以覆盖握手 / 超时 / 崩溃重启 / 关闭
 * 等生命周期，而无需真的起进程。
 */
export class ProcessLinesClient {
  private child: ChildProcessLike | null = null
  /** stdout 行解码器：负责分片与粘包 */
  private readonly decoder = createLineDecoder()
  /** 已发出但尚未收到响应的请求，按请求 id 索引 */
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  /** 是否启动过，用于区分首次启动与崩溃后的重启 */
  private hasStartedOnce = false
  private restartAttempts = 0
  /** 进行中的启动过程，避免并发重复启动 */
  private starting: Promise<void> | null = null
  private disposed = false
  /** 最近 stderr 的尾部，用于错误诊断 */
  private stderrTail = ''

  /**
   * @description 保存注入的进程与协议选项
   * @param options 命令、spawn 与超时/重启配置
   */
  constructor(private readonly options: ProcessLinesClientOptions) {}

  /** @description 当前是否有存活的宿主进程 */
  get running(): boolean {
    return this.child !== null
  }

  /** @description 宿主异常退出后已自动重启的次数 */
  get restarts(): number {
    return this.restartAttempts
  }

  /** @description 宿主进程 pid（未运行时为 undefined） */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** @description 启动宿主（幂等，已在运行时直接返回） */
  async start(): Promise<void> {
    await this.ensureRunning()
  }

  /**
   * @description 发送一条请求并等待响应；超时或写入失败都会 reject
   * @param cmd 指令名
   * @param payload 指令附带的字段
   * @param timeoutMs 本次超时毫秒数，省略则用客户端默认值
   * @returns 宿主响应中的 data
   */
  async request<T = unknown>(
    cmd: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<T> {
    await this.ensureRunning()
    const child = this.child
    if (!child || !child.stdin) {
      throw new ProtocolError('E_NOT_STARTED', '输入宿主尚未就绪')
    }

    const id = this.nextId++
    const line = encodeRequest({ id, cmd, ...payload })

    const response = await new Promise<HostResponse>((resolve, reject) => {
      const effectiveTimeout =
        timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(
                new ProtocolError('E_TIMEOUT', `等待宿主响应 ${cmd} 超时（${effectiveTimeout}ms）`)
              )
            }, effectiveTimeout)
          : undefined

      this.pending.set(id, { resolve, reject, timer })

      try {
        child.stdin?.write(line, 'utf8')
      } catch (error) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(
          new ProtocolError(
            'E_HOST_EXIT',
            '向输入宿主写入指令失败',
            error instanceof Error ? error.message : String(error)
          )
        )
      }
    })

    if (!response.ok) {
      const payloadError = response.error ?? { code: 'E_PARSE', message: '未知错误' }
      throw new ProtocolError(payloadError.code, payloadError.message, payloadError.detail)
    }

    return response.data as T
  }

  /** @description 关闭子进程并让所有未完成的请求立即失败 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // 尽力发出一条 shutdown，不等响应（进程可能马上就没了）
    try {
      this.child?.stdin?.write(encodeRequest({ id: this.nextId++, cmd: 'shutdown' }), 'utf8')
    } catch {
      // 忽略：关闭流程不应因写入失败而中断
    }

    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new ProtocolError('E_HOST_EXIT', '输入宿主已关闭'))
      this.pending.delete(id)
    }

    try {
      this.child?.stdin?.end()
    } catch {
      // 忽略：管道可能已经断开
    }

    const child = this.child
    this.child = null
    try {
      child?.kill()
    } catch {
      // 忽略：进程可能已经自己退出了
    }
  }

  /** @description 最近一段 stderr，用于错误诊断 */
  get lastStderr(): string {
    return this.stderrTail
  }

  /** @description 确保存在可用的子进程；并发调用共享同一次启动过程 */
  private async ensureRunning(): Promise<void> {
    if (this.child) return
    if (this.starting) return this.starting

    this.starting = this.launch()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  /** @description 真正拉起子进程并接好 stdout / stderr / exit 事件 */
  private async launch(): Promise<void> {
    if (this.disposed) {
      throw new ProtocolError('E_HOST_EXIT', '输入宿主已关闭')
    }

    if (this.hasStartedOnce) {
      this.restartAttempts += 1
      const max = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS
      if (this.restartAttempts > max) {
        throw new ProtocolError(
          'E_HOST_EXIT',
          `输入宿主多次异常退出（已重启 ${this.restartAttempts - 1} 次）`,
          this.stderrTail.trim() || undefined
        )
      }
      this.options.onLog?.(
        'warn',
        `输入宿主已退出，正在重启（第 ${this.restartAttempts}/${max} 次）`
      )
    }

    this.stderrTail = ''

    const child = this.options.spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      windowsHide: true
    })

    this.hasStartedOnce = true
    this.child = child

    child.stdout?.on('data', (chunk) => {
      for (const line of this.decoder(chunk)) {
        this.handleLine(line)
      }
    })

    child.stderr?.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4000)
    })

    child.stdin?.on('error', (error) => {
      this.options.onLog?.('warn', `输入宿主 stdin 错误：${error.message}`)
    })

    child.on('error', (error) => {
      this.options.onLog?.('error', `输入宿主启动失败：${error.message}`)
    })

    child.on('exit', (code, signal) => {
      this.handleExit(code, signal)
    })

    this.options.onLog?.('info', `输入宿主已启动（pid=${child.pid ?? 'unknown'}）`)
  }

  /**
   * @description 把一行宿主输出派发给对应的待响应请求
   * @param line 子进程 stdout 中的一整行
   */
  private handleLine(line: string): void {
    let response: HostResponse
    try {
      response = parseResponse(line)
    } catch {
      this.options.onLog?.('warn', `忽略无法解析的宿主输出：${line.slice(0, 200)}`)
      this.stderrTail = `${this.stderrTail}\n[unparsed] ${line}`.slice(-4000)
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) {
      this.options.onLog?.('warn', `收到未知 id=${response.id} 的宿主响应`)
      return
    }
    this.pending.delete(response.id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(response)
  }

  /**
   * @description 处理宿主进程退出：清空进程引用并让所有未完成的请求失败
   * @param code 退出码（被信号终止时为 null）
   * @param signal 终止信号（正常退出时为 null）
   */
  private handleExit(code: number | null, signal: string | null): void {
    const wasRunning = this.child !== null
    this.child = null
    if (!wasRunning) return

    const reason = `code=${code ?? 'null'} signal=${signal ?? 'null'}`
    if (!this.disposed) {
      this.options.onLog?.('error', `输入宿主已退出（${reason}）`)
    }

    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(
        new ProtocolError(
          'E_HOST_EXIT',
          `输入宿主在响应前退出（${reason}）`,
          this.stderrTail.trim() || undefined
        )
      )
      this.pending.delete(id)
    }
  }
}
