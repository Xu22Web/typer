import type { ImportCharset } from '../settings/types'

/** IPC 入参校验失败。消息会直接展示给用户，所以用中文写清楚。 */
export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

/** 单次输入文本的长度上限（约 200 万字符），防止超大文本把内存打满。 */
export const MAX_TEXT_LENGTH = 2_000_000

export interface StartRequest {
  text: string
}

export function parseStartRequest(payload: unknown): StartRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new IpcValidationError('开始输入失败：请求参数格式错误')
  }
  const text = (payload as { text?: unknown }).text
  if (typeof text !== 'string') {
    throw new IpcValidationError('开始输入失败：缺少文本内容')
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new IpcValidationError(
      `文本过长（${text.length} 字符），单次最多 ${MAX_TEXT_LENGTH} 字符`
    )
  }
  return { text }
}

export function parseSettingsPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new IpcValidationError('设置格式错误：应为对象')
  }
  return payload as Record<string, unknown>
}

export interface ImportRequest {
  path: string
  charset?: ImportCharset
}

export function parseImportRequest(payload: unknown): ImportRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new IpcValidationError('导入失败：请求参数格式错误')
  }
  const candidate = payload as { path?: unknown; charset?: unknown }
  if (typeof candidate.path !== 'string' || candidate.path.trim().length === 0) {
    throw new IpcValidationError('导入失败：缺少文件路径')
  }
  const charset = candidate.charset
  if (charset !== undefined && !['auto', 'utf8', 'utf16le', 'gbk'].includes(String(charset))) {
    throw new IpcValidationError(`导入失败：不支持的编码 ${String(charset)}`)
  }
  return { path: candidate.path, charset: charset as ImportCharset | undefined }
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  /** 当前系统是否支持键盘注入 */
  supported: boolean
}

/** 窗口最大化状态：主进程在 maximize / unmaximize 时推给渲染进程。 */
export interface WindowStatePayload {
  maximized: boolean
}

/**
 * 用默认浏览器打开链接。
 *
 * 只放行 http/https：渲染进程的任何输入都不应该能触发 `file:`、`ms-settings:` 之类
 * 协议处理器，否则一个被注入的链接就能变成"本地程序启动器"。
 */
export function parseExternalUrl(payload: unknown): string {
  if (typeof payload !== 'string' || payload.trim().length === 0) {
    throw new IpcValidationError('打开链接失败：缺少地址')
  }

  let url: URL
  try {
    url = new URL(payload)
  } catch {
    throw new IpcValidationError('打开链接失败：地址格式不正确')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new IpcValidationError(`打开链接失败：不支持的协议 ${url.protocol}`)
  }

  return url.toString()
}
