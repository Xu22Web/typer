import type { KeystrokeAction, Modifier } from '../planner/types'

/** 宿主可执行的原子动作（JSON Lines 协议的最小单元）。 */
export interface HostKeyItem {
  t: 'key'
  vk: number
  mods: Modifier[]
  delay: number
}

export interface HostUnicodeItem {
  t: 'unicode'
  cu: number
  delay: number
}

export interface HostWaitItem {
  t: 'wait'
  ms: number
}

export type HostItem = HostKeyItem | HostUnicodeItem | HostWaitItem

/** 带节奏信息的动作（引擎产出，驱动转成 HostItem）。 */
export interface ScheduledAction {
  action: KeystrokeAction
  delayMs: number
}

export interface HostErrorPayload {
  code: string
  message: string
  detail?: string
}

export interface HostResponse {
  id: number
  ok: boolean
  data?: unknown
  error?: HostErrorPayload
}

export interface HostForegroundData {
  hwnd: number
  pid: number
  title: string
}

export interface HostTypeData {
  /** 期望的底层输入事件数（1 个按键动作 = 2 个事件，含修饰键时更多） */
  requested: number
  /** 实际成功注入的事件数 */
  injected: number
  /** 本批包含的动作数 */
  items?: number
}

export interface HostPingData {
  os: string
  psVersion: string
  dryRun: boolean
}

export interface HostProbeData {
  stuckKeys: number[]
}

/** 宿主通信协议错误：`code` 决定面向用户的说明（见 ERROR_MESSAGES）。 */
export class ProtocolError extends Error {
  readonly code: string
  readonly detail?: string

  /**
   * @description 构造协议错误
   * @param code 错误码，用于映射中文说明
   * @param message 原始错误信息（技术细节）
   * @param detail 附加线索，通常是宿主返回的原因
   */
  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.detail = detail
  }
}

/** 宿主/协议错误码 → 面向用户的中文说明。 */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  E_PARSE: '输入宿主无法解析指令（协议不一致）',
  E_UNKNOWN_CMD: '输入宿主不认识该指令（协议版本不匹配）',
  E_INJECT_FAILED:
    '系统拒绝了按键注入：通常是目标窗口以管理员权限运行（UIPI 限制），或被杀毒软件拦截',
  E_NO_FOREGROUND: '无法获取前台窗口信息',
  E_TIMEOUT: '输入宿主响应超时',
  E_HOST_EXIT: '输入宿主进程意外退出',
  E_NOT_STARTED: '输入宿主尚未启动',
  E_UNSUPPORTED_PLATFORM: '当前系统不受支持：本程序仅支持 Windows',
  E_CLIPBOARD: '剪贴板操作失败'
}

/**
 * @description 把任意错误转成面向用户的一句话说明
 * @param error 捕获到的错误
 * @returns 用户可读的说明（优先映射错误码）
 */
export function describeError(error: unknown): string {
  if (error instanceof ProtocolError) {
    return ERROR_MESSAGES[error.code] ?? `${error.code}: ${error.message}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @description 把带节奏信息的动作序列转成宿主可执行的原子动作
 * @param scheduled 引擎产出的动作与延迟
 * @returns 协议层动作列表
 */
export function toHostItems(scheduled: ScheduledAction[]): HostItem[] {
  const items: HostItem[] = []
  for (const { action, delayMs } of scheduled) {
    const delay = Math.max(0, Math.round(delayMs))
    if (action.kind === 'key') {
      items.push({ t: 'key', vk: action.vk, mods: [...action.modifiers], delay })
    } else if (action.kind === 'unicode') {
      items.push({ t: 'unicode', cu: action.codeUnit, delay })
    } else {
      items.push({ t: 'wait', ms: Math.max(0, Math.round(action.ms)) })
    }
  }
  return items
}

/**
 * @description 计算一批动作会产生的底层输入事件数（用于校验注入结果）
 * @param items 协议层动作列表
 * @returns 期望的事件总数
 */
export function expectedEventCount(items: HostItem[]): number {
  let total = 0
  for (const item of items) {
    if (item.t === 'key') total += 2 + 2 * item.mods.length
    else if (item.t === 'unicode') total += 2
  }
  return total
}

/**
 * @description 把所有非 ASCII 字符转成 `\uXXXX` 转义，使发往宿主的每一行都是纯 ASCII；
 * 这样做的原因：Windows 控制台代码页（GBK/UTF-8）会让 UTF-8 中文在 PowerShell 的 stdin 上被误解码，
 * 纯 ASCII 传输可以从根本上规避该问题
 * @param text 原始文本
 * @returns 仅含 ASCII 的等价文本
 */
export function escapeNonAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

export interface HostRequestPayload {
  id: number
  cmd: string
  [key: string]: unknown
}

/**
 * @description 序列化为一行请求（纯 ASCII + 换行）
 * @param payload 请求 id、指令名与附加字段
 * @returns 可写入子进程 stdin 的一行
 */
export function encodeRequest(payload: HostRequestPayload): string {
  return `${escapeNonAscii(JSON.stringify(payload))}\n`
}

/**
 * @description 创建行解码器：处理 stdout 的分片（一个响应被拆开）与粘包（多个响应同批到达）
 * @returns 增量解码函数，入参是 stdout 分片，返回其中完整的行
 */
export function createLineDecoder(): (chunk: string | Buffer) => string[] {
  let buffer = ''
  return (chunk: string | Buffer): string[] => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const lines: string[] = []
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '').trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) lines.push(line)
      index = buffer.indexOf('\n')
    }
    // 防御：异常长的行说明协议已经错乱，丢弃以免无限增长
    if (buffer.length > 1_000_000) buffer = ''
    return lines
  }
}

/**
 * @description 解析并校验一行宿主响应
 * @param line 宿主 stdout 中的一行
 * @returns 结构化响应
 */
export function parseResponse(line: string): HostResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new ProtocolError(
      'E_PARSE',
      '宿主返回了无法解析的内容',
      error instanceof Error ? error.message : String(error)
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError('E_PARSE', '宿主返回的内容不是对象')
  }

  const candidate = parsed as Partial<HostResponse>
  if (typeof candidate.id !== 'number' || typeof candidate.ok !== 'boolean') {
    throw new ProtocolError('E_PARSE', '宿主返回的内容缺少 id / ok 字段')
  }
  if (!candidate.ok && (!candidate.error || typeof candidate.error.code !== 'string')) {
    throw new ProtocolError('E_PARSE', '宿主返回的失败响应缺少 error.code')
  }

  return candidate as HostResponse
}

/**
 * @description 校验 `type` 指令的注入结果：少于请求的事件数说明被系统拦截
 * @param data 宿主返回的原始数据
 * @param requestedEvents 本批动作期望的事件数
 * @returns 校验通过后的注入统计
 */
export function assertInjectionResult(data: unknown, requestedEvents: number): HostTypeData {
  if (typeof data !== 'object' || data === null) {
    throw new ProtocolError('E_PARSE', 'type 指令的返回内容格式错误')
  }
  const candidate = data as Partial<HostTypeData>
  if (typeof candidate.injected !== 'number' || typeof candidate.requested !== 'number') {
    throw new ProtocolError('E_PARSE', 'type 指令的返回内容缺少 injected / requested')
  }
  if (candidate.injected < candidate.requested) {
    throw new ProtocolError(
      'E_INJECT_FAILED',
      `系统只注入了 ${candidate.injected}/${candidate.requested} 个输入事件`,
      '常见原因：目标窗口以管理员权限运行（UIPI），或被安全软件拦截'
    )
  }
  if (requestedEvents > 0 && candidate.requested < requestedEvents) {
    throw new ProtocolError(
      'E_INJECT_FAILED',
      `宿主报告的事件数（${candidate.requested}）少于预期（${requestedEvents}）`
    )
  }
  return candidate as HostTypeData
}
