import { EventEmitter } from 'node:events'
import type {
  ChildProcessLike,
  ReadableStreamLike,
  SpawnFn,
  SpawnOptionsLike,
  WritableStreamLike
} from '@main/typing/drivers/powershellDriver'

/** @description 把子进程拆成可控的假对象，让驱动的生命周期可完整断言 */
export class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  readonly writes: string[] = []
  readonly writtenLines: string[] = []
  killed = false
  pid = 4242
  stdinEnded = false

  private buffer = ''
  private readonly stdoutEmitter = new EventEmitter()
  private readonly stderrEmitter = new EventEmitter()

  stdin: WritableStreamLike = {
    write: (chunk: string) => {
      this.writes.push(chunk)
      this.buffer += chunk
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        this.writtenLines.push(this.buffer.slice(0, index))
        this.buffer = this.buffer.slice(index + 1)
        index = this.buffer.indexOf('\n')
      }
      return true
    },
    end: () => {
      this.stdinEnded = true
    },
    on: () => this.stdin
  }

  stdout: ReadableStreamLike = {
    on: (event, listener) => this.stdoutEmitter.on(event, listener)
  }

  stderr: ReadableStreamLike = {
    on: (event, listener) => this.stderrEmitter.on(event, listener)
  }

  constructor() {
    super()
  }

  /**
   * @description 模拟宿主输出一段内容，可故意切成多段以覆盖分片重组
   * @param chunk 写入 stdout 的文本
   */
  emitStdout(chunk: string): void {
    this.stdoutEmitter.emit('data', chunk)
  }

  /**
   * @description 模拟宿主输出一段 stderr 文本
   * @param chunk 写入 stderr 的文本
   */
  emitStderr(chunk: string): void {
    this.stderrEmitter.emit('data', chunk)
  }

  /**
   * @description 模拟终止子进程，仅记录调用状态
   * @returns 固定为 true，与真实 ChildProcess.kill 的返回类型保持一致
   */
  kill(): boolean {
    this.killed = true
    return true
  }

  /**
   * @description 模拟子进程退出，触发 exit 事件
   * @param code 退出码
   * @param signal 退出信号
   */
  exit(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal)
  }

  /**
   * @description 解析驱动写到 stdin 的每一行请求，便于断言协议
   * @returns 收到的请求对象列表
   */
  parsedRequests(): Array<Record<string, unknown>> {
    return this.writtenLines.map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  /**
   * @description 取最近一条请求的 id
   * @returns 最后一条请求的 id，无请求时为 0
   */
  lastRequestId(): number {
    const requests = this.parsedRequests()
    const last = requests[requests.length - 1]
    return Number(last?.id ?? 0)
  }

  /**
   * @description 按请求 id 回一个成功响应
   * @param id 对应的请求 id
   * @param data 响应负载，缺省时不带 data 字段
   */
  respondOk(id: number, data?: unknown): void {
    this.emitStdout(
      `${JSON.stringify(data === undefined ? { id, ok: true } : { id, ok: true, data })}\n`
    )
  }

  /**
   * @description 按请求 id 回一个失败响应
   * @param id 对应的请求 id
   * @param code 错误码
   * @param message 错误描述
   */
  respondError(id: number, code: string, message = 'mock error'): void {
    this.emitStdout(`${JSON.stringify({ id, ok: false, error: { code, message } })}\n`)
  }
}

export interface FakeSpawn {
  fn: SpawnFn
  children: FakeChildProcess[]
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptionsLike }>
  failNext?: Error
}

/** @description 自动应答器返回的结果，`delayMs` 用于模拟宿主响应慢 */
export interface AutoRespondOutcome {
  data?: unknown
  error?: { code: string; message: string }
  delayMs?: number
}

export interface FakeSpawnOptions {
  /** @description 让假宿主自动响应请求，测试无需手工应答 */
  autoRespond?: (
    request: Record<string, unknown>,
    child: FakeChildProcess
  ) => AutoRespondOutcome | undefined
}

/**
 * @description 接管 stdin.write，在请求写入后自动产生响应
 * @param child 被接管的假子进程
 * @param responder 根据请求生成响应的应答器
 */
function attachAutoRespond(
  child: FakeChildProcess,
  responder: NonNullable<FakeSpawnOptions['autoRespond']>
): void {
  const originalWrite = child.stdin.write.bind(child.stdin)
  child.stdin.write = (chunk: string, encoding?: BufferEncoding) => {
    const result = originalWrite(chunk, encoding)
    const requests = child.parsedRequests()
    const request = requests[requests.length - 1]
    if (!request) return result

    const respond = (): void => {
      const outcome = responder(request, child)
      if (!outcome) return
      const id = Number(request.id)
      if (outcome.error) child.respondError(id, outcome.error.code, outcome.error.message)
      else child.respondOk(id, outcome.data)
    }

    const outcome = responder(request, child)
    if (outcome && outcome.delayMs && outcome.delayMs > 0) {
      const delayedOutcome = outcome
      setTimeout(() => {
        const id = Number(request.id)
        if (delayedOutcome.error) {
          child.respondError(id, delayedOutcome.error.code, delayedOutcome.error.message)
        } else {
          child.respondOk(id, delayedOutcome.data)
        }
      }, delayedOutcome.delayMs)
      return result
    }

    queueMicrotask(respond)
    return result
  }
}

/**
 * @description 创建可注入的 spawn，每次调用都生成一个新的 FakeChildProcess
 * @param options 配置项，可开启自动应答
 * @returns 假的 spawn 实现及其调用记录
 */
export function createFakeSpawn(options: FakeSpawnOptions = {}): FakeSpawn {
  const children: FakeChildProcess[] = []
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptionsLike }> = []

  const fake: FakeSpawn = {
    children,
    calls,
    fn: (command, args, spawnOptions) => {
      if (fake.failNext) {
        const error = fake.failNext
        fake.failNext = undefined
        throw error
      }
      calls.push({ command, args, options: spawnOptions })
      const child = new FakeChildProcess()
      children.push(child)
      if (options.autoRespond) attachAutoRespond(child, options.autoRespond)
      return child
    }
  }

  return fake
}

/** @description 假 ipcMain，记录注册的频道与处理器，便于直接调用 */
export interface FakeIpcMain {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  readonly channels: string[]
}

/**
 * @description 创建假 ipcMain，重复注册同一频道会立即报错
 * @returns 可注册、移除并直接 invoke 的假 ipcMain
 */
export function createFakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`频道重复注册：${channel}`)
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`频道未注册：${channel}`)
      return (await handler({}, ...args)) as T
    },
    get channels() {
      return [...handlers.keys()]
    }
  }
}

/** @description 内存文件系统，用于覆盖设置存储的原子写与损坏回退等路径 */
export interface MemoryFs {
  files: Map<string, string>
  dirs: Set<string>
  failWrites: boolean
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  renameSync(oldPath: string, newPath: string): void
  mkdirSync(path: string, options: { recursive: true }): string | undefined
}

/**
 * @description 创建内存文件系统，可通过 failWrites 模拟只读磁盘
 * @param initial 初始文件内容
 * @returns 与 fs 同步 API 子集一致的假实现
 */
export function createMemoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map(Object.entries(initial))
  const fs: MemoryFs = {
    files,
    dirs: new Set<string>(),
    failWrites: false,
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    writeFileSync: (path, data) => {
      if (fs.failWrites) throw new Error('EACCES: 只读文件系统')
      files.set(path, data)
    },
    renameSync: (oldPath, newPath) => {
      const value = files.get(oldPath)
      if (value === undefined) throw new Error(`ENOENT: ${oldPath}`)
      files.delete(oldPath)
      files.set(newPath, value)
    },
    mkdirSync: (path) => {
      fs.dirs.add(path)
      return path
    }
  }
  return fs
}

/**
 * @description 创建假剪贴板，记录每次写入以便断言
 * @param initial 初始剪贴板内容
 * @returns 带读写方法与写入历史的假剪贴板
 */
export function createFakeClipboard(initial = ''): {
  readText(): string
  writeText(text: string): void
  readonly history: string[]
  value: string
} {
  const state = {
    value: initial,
    history: [] as string[],
    readText: () => state.value,
    writeText: (text: string) => {
      state.value = text
      state.history.push(text)
    }
  }
  return state
}
