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
 * 所有与进程相关的能力都通过 `spawn` 注入，因此测试可以完整覆盖
 * 握手 / 超时 / 崩溃重启 / 关闭等生命周期，而无需真的起进程。
 */
export class ProcessLinesClient {
  private child: ChildProcessLike | null = null
  private readonly decoder = createLineDecoder()
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private hasStartedOnce = false
  private restartAttempts = 0
  private starting: Promise<void> | null = null
  private disposed = false
  private stderrTail = ''

  constructor(private readonly options: ProcessLinesClientOptions) {}

  get running(): boolean {
    return this.child !== null
  }

  get restarts(): number {
    return this.restartAttempts
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  async start(): Promise<void> {
    await this.ensureRunning()
  }

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

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // 尽力发出一条 shutdown，不等响应（进程可能马上就没了）
    try {
      this.child?.stdin?.write(encodeRequest({ id: this.nextId++, cmd: 'shutdown' }), 'utf8')
    } catch {
      // 忽略：关闭流程不应因为写入失败而中断
    }

    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new ProtocolError('E_HOST_EXIT', '输入宿主已关闭'))
      this.pending.delete(id)
    }

    try {
      this.child?.stdin?.end()
    } catch {
      // 忽略
    }

    const child = this.child
    this.child = null
    try {
      child?.kill()
    } catch {
      // 忽略
    }
  }

  /** 捕获最近一段 stderr，用于错误诊断。 */
  get lastStderr(): string {
    return this.stderrTail
  }

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
