import type { KeyboardDriver, SendOptions } from './KeyboardDriver'
import { ProcessLinesClient, type SpawnFn } from './powershellDriver'
import {
  assertInjectionResult,
  encodeHostItems,
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
  /** 默认 `powershell.exe`（Windows PowerShell 5.1，Windows 全版本自带） */
  powershellPath?: string
  /** 只解析动作、不真正注入（用于系统自检/测试） */
  dryRun?: boolean
  /**
   * 把"本来会发出"的按键事件追加到这个文件（每行 `vk,up`）。
   *
   * 端到端测试用它拿到"目标窗口本该收到的按键流"，再重放出文本交给接收端校验；
   * 它只记录、不影响注入行为（可与 dryRun 组合使用）。
   */
  recordPath?: string
  requestTimeoutMs?: number
  maxRestarts?: number
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * 每个注入事件（按下/抬起/修饰键）额外给多少毫秒预算。
 *
 * 目标端消化一个事件实测约 2.5ms（WinForms 控件 4~12ms/字符，一个字符 ≈ 2 个事件），
 * 这里给 4 倍余量。为什么要给：宿主会按目标端的实际消化能力补等（valve），
 * 这部分补等不在计划 delay 里，只按 delay 算超时会让"慢目标 + 大帧"被误判失败。
 */
const PER_EVENT_BUDGET_MS = 10

/**
 * Windows 键盘注入驱动：通过 `SendInput` 宿主完成真实注入。
 *
 * 所有动作都走宿主的真实按键注入路径；宿主内部按动作自带的 `delay` 精确等待，
 * 因此 Node 侧不需要高频 IPC；崩溃后自动重启，防粘键由引擎负责。
 */
export class WindowsSendInputDriver implements KeyboardDriver {
  readonly kind = 'windows-sendinput'

  private readonly client: ProcessLinesClient
  private readonly options: WindowsSendInputDriverOptions
  /** 是否已完成与宿主的握手 */
  private ready = false

  /**
   * @description 装配 PowerShell 宿主命令行并创建进程客户端
   * @param options 驱动选项（spawn、宿主脚本与超时/重启配置）
   */
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
    if (options.recordPath) args.push('-Record', options.recordPath)

    this.client = new ProcessLinesClient({
      command: options.powershellPath ?? 'powershell.exe',
      args,
      spawn: options.spawn,
      requestTimeoutMs: options.requestTimeoutMs,
      maxRestarts: options.maxRestarts,
      onLog: options.onLog
    })
  }

  /** @description 宿主进程 pid（尚未启动时为 undefined） */
  get pid(): number | undefined {
    return this.client.pid
  }

  /** @description 宿主进程被自动重启的次数 */
  get restarts(): number {
    return this.client.restarts
  }

  /** @description 启动宿主并完成 ping 握手（幂等） */
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

  /**
   * @description 下发一批动作，并按"基础超时 + 动作自身等待 + 目标端消化时间"计算超时上限
   * @param items 待注入的原子动作
   * @returns 宿主报告的注入统计
   */
  async send(items: HostItem[], options: SendOptions = {}): Promise<HostTypeData> {
    if (items.length === 0) return { requested: 0, injected: 0 }

    const batch = encodeHostItems(items, options)
    // 超时要覆盖"计划等待 + 目标端消化每个事件的时间"：delay 只是计划间隔，
    // 真正决定耗时的是目标程序消化输入的快慢（外加宿主为缓解队列压力补的等待）。
    // 只按 delay 算时，上千字符的一批会在固定上限处被误判超时，整批半途而废。
    const totalDelay = batch.delays.reduce((sum, ms) => sum + Math.max(0, ms), 0)
    const events = expectedEventCount(items)
    const base = this.options.requestTimeoutMs ?? 15_000

    const data = await this.client.request<unknown>(
      'type',
      batch,
      base + totalDelay + events * PER_EVENT_BUDGET_MS + 5_000
    )
    return assertInjectionResult(data, events)
  }

  /** @description 释放所有修饰键并等待宿主确认 */
  async releaseAll(): Promise<void> {
    await this.client.request('releaseAll')
  }

  /**
   * @description 立刻中止宿主正在执行的那一批（不等响应）。
   * 宿主在后台线程读到 cancel 后会置位中止标志，逐动作检查并丢弃未提交的事件，
   * 因此"停止"的生效时间从"等整批打完"缩短到一个动作以内。
   */
  cancel(): void {
    this.client.send('cancel')
  }

  /**
   * @description 读取当前前台窗口
   * @returns 前台窗口的 hwnd / pid / 标题
   */
  async foreground(): Promise<HostForegroundData> {
    return this.client.request<HostForegroundData>('foreground')
  }

  /**
   * @description 探测是否仍有按键处于按下状态
   * @returns 仍处于按下状态的虚拟键码
   */
  async probe(): Promise<HostProbeData> {
    return this.client.request<HostProbeData>('probe')
  }

  /** @description 关闭宿主进程并释放资源 */
  async dispose(): Promise<void> {
    this.ready = false
    await this.client.dispose()
  }
}

/**
 * @description 判断当前平台是否支持键盘注入
 * @param platform Node 的平台标识
 * @returns 是否受支持
 */
export function isSupportedPlatform(platform: NodeJS.Platform | string): boolean {
  return platform === 'win32'
}

/**
 * @description 构造"平台不受支持"的协议错误
 * @param platform 实际平台标识
 * @returns 带用户可读说明的协议错误
 */
export function unsupportedPlatformError(platform: string): ProtocolError {
  return new ProtocolError(
    'E_UNSUPPORTED_PLATFORM',
    `当前系统（${platform}）暂不支持键盘注入：本程序目前仅支持 Windows`
  )
}
