import { EventEmitter } from 'node:events'
import type {
  ChildProcessLike,
  ReadableStreamLike,
  SpawnFn,
  SpawnOptionsLike,
  WritableStreamLike
} from '@main/typing/drivers/powershellDriver'

/** 把子进程拆成"可控的假对象"，从而完整测试驱动的生命周期。 */
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

  /** 模拟宿主输出一段内容（可故意切成多段以测试分片重组）。 */
  emitStdout(chunk: string): void {
    this.stdoutEmitter.emit('data', chunk)
  }

  emitStderr(chunk: string): void {
    this.stderrEmitter.emit('data', chunk)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal)
  }

  /** 解析收到的请求（返回 JSON 对象），便于断言协议。 */
  parsedRequests(): Array<Record<string, unknown>> {
    return this.writtenLines.map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  lastRequestId(): number {
    const requests = this.parsedRequests()
    const last = requests[requests.length - 1]
    return Number(last?.id ?? 0)
  }

  /** 按请求 id 回一个成功响应。 */
  respondOk(id: number, data?: unknown): void {
    this.emitStdout(
      `${JSON.stringify(data === undefined ? { id, ok: true } : { id, ok: true, data })}\n`
    )
  }

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

/** 自动应答器返回的结果：`delayMs` 可模拟宿主响应慢。 */
export interface AutoRespondOutcome {
  data?: unknown
  error?: { code: string; message: string }
  delayMs?: number
}

export interface FakeSpawnOptions {
  /** 让假宿主自动响应请求，测试无需手工应答。 */
  autoRespond?: (
    request: Record<string, unknown>,
    child: FakeChildProcess
  ) => AutoRespondOutcome | undefined
}

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

/** 可注入的 spawn：每次调用生成一个新的 FakeChildProcess。 */
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

/** 假 ipcMain：记录注册的频道与处理器，便于直接调用。 */
export interface FakeIpcMain {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  readonly channels: string[]
}

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

/** 内存文件系统：覆盖设置存储的原子写/损坏回退等路径。 */
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

/** 假剪贴板。 */
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
