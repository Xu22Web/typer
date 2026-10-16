import { pasteWithClipboard, type ClipboardLike } from './clipboard'
import type { KeyboardDriver } from './KeyboardDriver'
import { ProcessLinesClient, type SpawnFn } from './powershellDriver'
import {
  assertInjectionResult,
  expectedEventCount,
  ProtocolError,
  type HostForegroundData,
  type HostItem,
  type HostPingData,
  type HostProbeData,
  type HostTypeData
} from './protocol'

export interface WindowsSendInputDriverOptions {
  spawn: SpawnFn
  /** typing-host.ps1 的绝对路径 */
  hostScriptPath: string
  clipboard: ClipboardLike
  /** 默认 `powershell.exe`（Windows PowerShell 5.1，Windows 全版本自带） */
  powershellPath?: string
  /** 只解析动作、不真正注入（用于系统自检/测试） */
  dryRun?: boolean
  requestTimeoutMs?: number
  maxRestarts?: number
  /** 粘贴模式结束后是否恢复用户剪贴板 */
  restoreClipboard?: boolean
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

const PASTE_VK = 0x56 // V

/**
 * Windows 键盘注入驱动：通过 `SendInput` 宿主完成真实注入。
 *
 * - 真实按键（`key`）与 Unicode 报文（`unicode`）分别对应宿主的两条注入路径
 * - 宿主内部按每个动作的 `delay` 精确等待，因此 Node 侧不需要高频 IPC
 * - 崩溃自动重启；任何结束路径都调用 `releaseAll` 防粘键（由引擎负责）
 */
export class WindowsSendInputDriver implements KeyboardDriver {
  readonly kind = 'windows-sendinput'

  private readonly client: ProcessLinesClient
  private readonly options: WindowsSendInputDriverOptions
  private ready = false

  constructor(options: WindowsSendInputDriverOptions) {
    this.options = options

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      options.hostScriptPath
    ]
    if (options.dryRun) args.push('-DryRun')

    this.client = new ProcessLinesClient({
      command: options.powershellPath ?? 'powershell.exe',
      args,
      spawn: options.spawn,
      requestTimeoutMs: options.requestTimeoutMs,
      maxRestarts: options.maxRestarts,
      onLog: options.onLog
    })
  }

  get pid(): number | undefined {
    return this.client.pid
  }

  get restarts(): number {
    return this.client.restarts
  }

  /** 启动宿主并完成握手（幂等）。 */
  async start(): Promise<void> {
    if (this.ready && this.client.running) return
    await this.client.start()
    const ping = await this.client.request<HostPingData>('ping')
    this.options.onLog?.(
      'info',
      `输入宿主握手成功（${ping.os}，PowerShell ${ping.psVersion}${ping.dryRun ? '，dry-run' : ''}）`
    )
    this.ready = true
  }

  async send(items: HostItem[]): Promise<HostTypeData> {
    if (items.length === 0) return { requested: 0, injected: 0 }

    // 超时必须把动作自身的等待时间算进去，否则长批次会被误判为超时
    const totalDelay = items.reduce((sum, item) => {
      if (item.t === 'wait') return sum + item.ms
      return sum + item.delay
    }, 0)
    const base = this.options.requestTimeoutMs ?? 15_000

    const data = await this.client.request<unknown>('type', { items }, base + totalDelay + 5_000)
    return assertInjectionResult(data, expectedEventCount(items))
  }

  async releaseAll(): Promise<void> {
    await this.client.request('releaseAll')
  }

  async foreground(): Promise<HostForegroundData> {
    return this.client.request<HostForegroundData>('foreground')
  }

  async probe(): Promise<HostProbeData> {
    return this.client.request<HostProbeData>('probe')
  }

  async paste(text: string): Promise<void> {
    if (text.length === 0) return
    await pasteWithClipboard({
      clipboard: this.options.clipboard,
      text,
      restoreClipboard: this.options.restoreClipboard ?? true,
      sendPaste: async () => {
        await this.send([{ t: 'key', vk: PASTE_VK, mods: ['ctrl'], delay: 0 }])
      }
    })
  }

  async dispose(): Promise<void> {
    this.ready = false
    await this.client.dispose()
  }
}

export function isSupportedPlatform(platform: NodeJS.Platform | string): boolean {
  return platform === 'win32'
}

export function unsupportedPlatformError(platform: string): ProtocolError {
  return new ProtocolError(
    'E_UNSUPPORTED_PLATFORM',
    `当前系统（${platform}）暂不支持键盘注入：本程序目前仅支持 Windows`
  )
}
