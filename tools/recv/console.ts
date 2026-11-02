/**
 * 控制台能力探测 + 输入法（IME）切换 / 还原。
 *
 * 接收端要在这个目标机的控制台窗口里"读键盘"：中文输入法开着时，打进来的帧会被吃成候选上屏，
 * 所以启动时做一次和主程序 `typing-host.ps1` 同样的处理（切英文布局 + 关输入法 + 英数模式），
 * **结束时再还原**，不把用户的输入法状态留在英文上。
 *
 * 顺带开启控制台的 VT 处理与 UTF-8 代码页：前者是两行原地重绘的前提（否则转义序列被原样打印），
 * 后者决定中文提示与方块字符能不能正常显示（这替代了旧版启动时那次 `chcp` 子进程）。
 *
 * 一切都是尽力而为：没有 PowerShell / 被策略禁止 / 非 Windows 时返回"没探测到"，
 * 调用方据此降级为 ASCII 单行输出，绝不影响收片本身。
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { consoleInitScript, consoleRestoreScript } from './imeScript'
import type { ScreenCaps } from './screen'

/** 目标窗口的键盘布局 / 输入法状态（与宿主脚本的判定口径一致） */
export interface ImeSnapshot {
  /** 布局句柄（恢复时用） */
  hkl: number
  /** 语言 ID（低 16 位；0x0409 = 英语(美国)） */
  layout: number
  english: boolean
  open: boolean
  native: boolean
}

/** 切换前保存下来的状态：脚本退出时按它还原 */
export interface ImeSaved {
  hwnd: number
  hkl: number
  open: boolean
  conv: number
  sent: number
}

/** 探测结果 */
export interface ConsoleSetup {
  caps: ScreenCaps
  /** 是否成功跑通控制台初始化（没跑通时中文/方块字符可能显示异常） */
  probed: boolean
  /** 失败原因（成功时为 null） */
  note: string | null
  /** 输入法探测结果（`--ime off` 或非 Windows 时为 null） */
  ime: {
    before: ImeSnapshot | null
    after: ImeSnapshot | null
    switched: boolean
    saved: ImeSaved | null
  } | null
}

/** 上一次真的切换过的状态：用于退出时还原（null = 没有需要还原的东西） */
let pendingRestore: ImeSaved | null = null
let restored = false

/** 助手返回的键值对（`k=v;k=v`；C# 里手拼 JSON 容易出转义问题，这里用最笨的格式） */
type Reply = Record<string, string>

/**
 * @description 把助手的 `k=v;k=v` 文本解析成字典
 * @param line 一行文本
 * @returns 字典；不像助手输出（没有 ok=）时返回 null
 */
function parseReply(line: string): Reply | null {
  const reply: Reply = {}
  for (const part of line.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    reply[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return 'ok' in reply ? reply : null
}

/**
 * @description 解析 `hkl,lang,en,open,nat` 这样的状态元组
 * @param text 元组文本
 * @returns 状态；缺字段时返回 null
 */
function parseState(text: string | undefined): ImeSnapshot | null {
  if (!text) return null
  const parts = text.split(',').map((item) => Number(item))
  if (parts.length < 5) return null
  const [hkl, layout, english, open, native] = parts
  return {
    hkl: hkl ?? 0,
    layout: layout ?? 0,
    english: english === 1,
    open: open === 1,
    native: native === 1
  }
}

/**
 * @description 解析 `hwnd,hkl,open,conv,sent` 这样的还原状态
 * @param text 元组文本
 * @returns 还原状态；缺字段时返回 null
 */
function parseSaved(text: string | undefined): ImeSaved | null {
  if (!text) return null
  const parts = text.split(',').map((item) => Number(item))
  if (parts.length < 5) return null
  const [hwnd, hkl, open, conv, sent] = parts
  if (!hwnd) return null
  return { hwnd, hkl: hkl ?? 0, open: open === 1, conv: conv ?? 0, sent: sent ?? 0 }
}

/**
 * @description 运行一段内联 PowerShell，并解析它最后一行 `k=v` 输出
 * @param script 脚本文本
 * @returns 解析结果；PowerShell 不可用或没吐出结果时返回 null
 */
function runPowerShell(script: string): Reply | null {
  // -EncodedCommand 收 UTF-16LE 的 base64：脚本里有 C# 与大量引号，拼命令行一定会被转义打死
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const candidates = [
    'powershell.exe',
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ]
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encoded
  ]
  for (const exe of candidates) {
    const result = spawnSync(exe, args, {
      encoding: 'utf8',
      timeout: 15_000,
      // 隐藏窗口：这一步绝不能给用户多弹一个黑框
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result.error) continue
    const text = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    if (text.length === 0) continue
    const lines = text.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index--) {
      const parsed = parseReply((lines[index] ?? '').trim())
      if (parsed) return parsed
    }
  }
  return null
}

/**
 * @description 探测终端能力（必要时切英文直输）
 * @param options `ensureIme`：是否连输入法一起处理
 * @returns 探测结果（`caps` 永远可用）
 */
export function prepareConsole(options: { ensureIme: boolean }): ConsoleSetup {
  const tty = process.stdout.isTTY === true
  const columns = Number(process.stdout.columns ?? 0) || 80
  const base: ScreenCaps = { tty, vt: false, columns, unicode: false, color: false }
  if (!tty) return { caps: base, probed: false, note: null, ime: null }

  if (process.platform !== 'win32') {
    // 非 Windows 的控制台本来就是 ANSI 终端，不需要任何辅助进程
    const vt = Boolean(process.env['TERM']) && process.env['TERM'] !== 'dumb'
    return {
      caps: { ...base, vt, unicode: vt, color: vt && colorWanted() },
      probed: vt,
      note: null,
      ime: null
    }
  }

  const reply = runPowerShell(consoleInitScript(options.ensureIme))
  if (!reply) {
    return {
      caps: base,
      probed: false,
      note: 'PowerShell 不可用（或执行被策略禁止）',
      ime: null
    }
  }

  const vt = reply['vt'] === '1'
  const codePage = Number(reply['cp'] ?? 0) || 0
  const saved = parseSaved(reply['s'])
  pendingRestore = saved
  restored = false

  return {
    caps: {
      ...base,
      vt,
      // 65001 才敢用方块字符与中文提示：代码页不对时汉字会变成乱码
      unicode: vt && codePage === 65001,
      color: vt && colorWanted()
    },
    probed: reply['console'] === '1' || reply['ok'] === '1',
    note: reply['err'] ? reply['err'] : null,
    ime: options.ensureIme
      ? {
          before: parseState(reply['b']),
          after: parseState(reply['a']),
          switched: reply['switched'] === '1',
          saved
        }
      : null
  }
}

/**
 * @description 还原启动时切走前的输入法状态；幂等，可在退出钩子里反复调用
 * @returns 是否真的还原了（没有需要还原的东西 / 窗口已关闭时为 false）
 */
export function restoreConsoleIme(): boolean {
  const saved = pendingRestore
  if (!saved || restored) return false
  restored = true
  const reply = runPowerShell(consoleRestoreScript(saved))
  return reply?.['restored'] === '1'
}

/** @description 是否还有未还原的输入法状态（退出前决定要不要再试一次） */
export function hasPendingImeRestore(): boolean {
  return pendingRestore !== null && !restored
}

/** @description 终端是否愿意上色（`NO_COLOR` 与能力探测都尊重） */
function colorWanted(): boolean {
  if (process.env['NO_COLOR']) return false
  return process.stdout.hasColors?.(16) === true
}

/**
 * @description 把输入法状态说成一句话（日志用）
 * @param state 状态
 * @returns 形如 `0804 / 输入法开启 / 本地语言模式`
 */
export function describeIme(state: ImeSnapshot | null): string {
  if (!state) return '未知'
  const layout = state.layout.toString(16).padStart(4, '0')
  const parts = [`布局 ${layout}`, state.english ? '英文' : '非英文']
  parts.push(state.open ? '输入法开启' : '输入法关闭')
  if (state.native) parts.push('本地语言模式')
  return parts.join(' / ')
}
