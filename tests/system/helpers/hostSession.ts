import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { encodeRequest, type HostResponse } from '@main/typing/drivers/protocol'
import { HOST_SCRIPT, POWERSHELL } from './system'

interface Pending {
  resolve: (response: HostResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 直接驱动输入宿主（不经 Electron）的最小客户端：以 `-DryRun` 启动宿主，
 * 验证 "Add-Type 编译 → 协议 → 事件计数" 这条系统链路，而不产生真实按键。
 */
export class HostSession {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  readonly stderr: string[] = []

  /**
   * @description 接管已启动的宿主进程，并把 stdout 接成按行响应
   * @param child 宿主进程
   */
  private constructor(child: ChildProcess) {
    this.child = child

    const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    reader.on('line', (line) => this.handleLine(line))

    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString('utf8'))
    })
  }

  /**
   * @description 启动 PowerShell 宿主并等到它应答 ping（首启含 Add-Type 编译）
   * @param options dryRun 时不产生真实按键
   * @returns 已就绪的宿主会话
   */
  static async start(options: { dryRun?: boolean } = {}): Promise<HostSession> {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      HOST_SCRIPT
    ]
    if (options.dryRun) args.push('-DryRun')

    const child = spawn(POWERSHELL, args, { windowsHide: true })
    const session = new HostSession(child)
    await session.request('ping', {}, 60_000) // 首次启动需要 Add-Type 编译 C#
    return session
  }

  /**
   * @description 发送一条协议请求并等待同 id 的响应
   * @param cmd 命令名
   * @param payload 命令参数
   * @param timeoutMs 超时毫秒数
   * @returns 响应中的 data
   */
  request<T = unknown>(
    cmd: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 20_000
  ): Promise<T> {
    const id = this.nextId++
    const line = encodeRequest({ id, cmd, ...payload })

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`等待宿主响应 ${cmd} 超时（${timeoutMs}ms）`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (response) => {
          if (!response.ok) {
            reject(new Error(`${response.error?.code}: ${response.error?.message}`))
            return
          }
          resolve(response.data as T)
        },
        reject,
        timer
      })

      this.child.stdin?.write(line, 'utf8')
    })
  }

  /**
   * @description 请求宿主 shutdown 并结束进程，同时清掉所有待响应请求
   */
  dispose(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
    }
    this.pending.clear()
    try {
      this.child.stdin?.write(encodeRequest({ id: this.nextId++, cmd: 'shutdown' }), 'utf8')
      this.child.stdin?.end()
    } catch {
      // 忽略
    }
    try {
      this.child.kill()
    } catch {
      // 忽略
    }
  }

  /**
   * @description 解析宿主 stdout 的一行并兑现对应的待响应请求
   * @param line 一行输出
   */
  private handleLine(line: string): void {
    if (!line.trim()) return
    let response: HostResponse
    try {
      response = JSON.parse(line) as HostResponse
    } catch {
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }
}
