import type { SendOptions } from './KeyboardDriver'
import type { KeystrokeAction, Modifier } from '../planner/types'

/** 宿主可执行的原子动作（JSON Lines 协议的最小单元）。 */
export interface HostKeyItem {
  t: 'key'
  vk: number
  mods: Modifier[]
  delay: number
}

export interface HostWaitItem {
  t: 'wait'
  ms: number
}

export type HostItem = HostKeyItem | HostWaitItem

/** 修饰键 → 位掩码（与宿主里 C# 的 MOD_* 常量一一对应）。每个键位最多带一个修饰键。 */
export const MODIFIER_BITS: Readonly<Record<Modifier, number>> = {
  ctrl: 1,
  shift: 2,
  alt: 4,
  win: 8
}

/** 动作操作码（与宿主里 C# 的 OP_* 常量一一对应）。 */
export const HOST_OP = { key: 0, wait: 1 } as const

/**
 * `type` 指令的扁平载荷：ops / vals / mods / delays 四个等长数组。
 *
 * 为什么不是"每个动作一个 JSON 对象"：宿主逐个读 PowerShell 对象的属性很贵
 * （实测每个动作约 2.4ms，把管线吞吐压到几百/秒）；换成扁平数组后宿主只需把
 * `"111"` 转成 int[]，chord 组装全部在 C# 里完成。
 */
export type EncodedHostBatch = {
  ops: number[]
  /** key: vk；wait: 0 */
  vals: number[]
  /** key: 修饰键位掩码；其它动作恒为 0 */
  mods: number[]
  /** 执行该动作之前要等待的毫秒数（wait 动作的时长也放在这里） */
  delays: number[]
  /** 每个动作单独一次 SendInput（数据帧用；省略表示允许宿主攒批） */
  perItem?: boolean
  /**
   * 修饰键按下后、主键之前的等待毫秒数。
   *
   * 远程桌面会把同一次 SendInput 里的修饰键与主键合批，实测修饰键会被丢弃；
   * 拆成独立调用并在按下后等这一小段才能生效（实测 10ms 即够，默认 15ms 留余量）。
   */
  modLeadMs?: number
  /** 修饰键抬起之前的等待毫秒数（默认 10ms） */
  modTailMs?: number
}

/**
 * @description 把协议层动作编码成宿主可直接消费的扁平数组
 * @param items 协议层动作列表
 * @returns 四个等长数组构成的批量载荷
 */
export function encodeHostItems(items: HostItem[], options: SendOptions = {}): EncodedHostBatch {
  const ops: number[] = []
  const vals: number[] = []
  const mods: number[] = []
  const delays: number[] = []

  for (const item of items) {
    if (item.t === 'key') {
      ops.push(HOST_OP.key)
      vals.push(item.vk)
      mods.push(item.mods.reduce((bits, mod) => bits | MODIFIER_BITS[mod], 0))
      delays.push(item.delay)
    } else {
      // 等待动作的时长也放进 delays：宿主用同一条"断批 + 等待"路径处理，无需单独分支
      ops.push(HOST_OP.wait)
      vals.push(0)
      mods.push(0)
      delays.push(item.ms)
    }
  }

  const encoded: EncodedHostBatch =
    options.perItem === true
      ? { ops, vals, mods, delays, perItem: true }
      : { ops, vals, mods, delays }
  if (options.modLeadMs !== undefined) encoded.modLeadMs = options.modLeadMs
  if (options.modTailMs !== undefined) encoded.modTailMs = options.modTailMs
  return encoded
}

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
  /** SendInput 被输入队列拖住的总时长（毫秒）：目标端消化不过来时会变大 */
  blockedMs?: number
  /** 单次 SendInput 被拖住的最长时长（毫秒） */
  maxBlockedMs?: number
  /** 宿主为"让队列排空"额外等待的总时长（毫秒），即自适应降速量 */
  valveMs?: number
  /** 被拖住的 SendInput 次数 */
  blockedCalls?: number
  /** 这一批被"紧急中止"打断：剩余动作被丢弃，因此 injected 会少于 requested */
  cancelled?: boolean
  /** 本批结束时宿主看到的前台窗口：焦点守护据此判定，省掉单独一次往返 */
  foreground?: HostForegroundData
}

export interface HostPingData {
  os: string
  psVersion: string
  dryRun: boolean
}

export interface HostProbeData {
  stuckKeys: number[]
}

/**
 * 目标窗口所在线程的键盘布局与输入法状态。
 *
 * 为什么要在输入前看这个：注入的是**真实按键**，按键先经过前台窗口线程的键盘布局与输入法。
 * 目标程序开着中文输入法时，字母键会被吃成候选上屏，注入的字符要么丢失、要么变成别的字。
 */
export interface HostImeSnapshot {
  /** 该线程键盘布局的语言 ID（低 16 位；0x0409 = 英语(美国)） */
  layoutId: number
  /** 布局标识（形如 00000409），取不到时为空串 */
  layoutName: string
  /** 是否为英语系布局（主语言 ID = 0x09） */
  english: boolean
  /** 是否为中日韩布局（这类布局基本都挂着 IME，注入前要切走） */
  cjk: boolean
  /** 输入法是否处于开启状态 */
  imeOpen: boolean
  /** 输入法是否处于“本地语言”模式（中文/日文等，会把按键变成上屏） */
  nativeMode: boolean
}

/** `ime` 指令的结果：切换前后的状态与是否已处于可直接注入的英文直输状态。 */
export interface HostImeData {
  before: HostImeSnapshot
  after: HostImeSnapshot
  /** 本轮是否真的执行了切换（切布局 / 关输入法 / 改英数模式） */
  switched: boolean
  /** 切换后是否已处于英文直输状态（布局英文 + 输入法未开 + 非本地语言模式） */
  ok: boolean
  /** 失败原因或补充说明 */
  note?: string
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
  E_IME_FAILED: '无法切换输入法/键盘布局（可以手动切到英文后再开始）',
  E_HOST_EXIT: '输入宿主进程意外退出',
  E_NOT_STARTED: '输入宿主尚未启动',
  E_UNSUPPORTED_PLATFORM: '当前系统不受支持：本程序仅支持 Windows'
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
    // 保留 0.25ms 精度：极速档的间隔可能是亚毫秒，取整到毫秒会把节奏放慢一倍
    const delay = Math.max(0, Math.round(delayMs * 4) / 4)
    if (action.kind === 'key') {
      items.push({ t: 'key', vk: action.vk, mods: [...action.modifiers], delay })
    } else {
      items.push({ t: 'wait', ms: Math.max(0, Math.round(action.ms)) })
    }
  }
  return items
}

/**
 * @description 计算一批动作会产生的底层输入事件数（用于校验注入结果）
 *
 * 只算主键的 down/up：修饰键事件由宿主按“状态过渡”自行决定（连续同修饰键的字符会保持按住），
 * 因此这只是一个下限，宿主报告的 `requested` 不会小于它。
 * @param items 协议层动作列表
 * @returns 期望的最少事件总数
 */
export function expectedEventCount(items: HostItem[]): number {
  let total = 0
  for (const item of items) {
    if (item.t === 'key') total += 2
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
  // 被中止打断的批次本来就会少注入，不能当成"注入不足"报错
  if (candidate.cancelled === true) return candidate as HostTypeData
  if (candidate.injected < candidate.requested) {
    throw new ProtocolError(
      'E_INJECT_FAILED',
      `系统只注入了 ${candidate.injected}/${candidate.requested} 个输入事件` +
        `（本批 ${candidate.items ?? '?'} 个动作，期望 ${requestedEvents} 个事件，` +
        `阻塞 ${candidate.blockedMs ?? 0}ms / 压力阀 ${candidate.valveMs ?? 0}ms）`,
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
