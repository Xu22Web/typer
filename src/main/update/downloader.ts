/**
 * 流式下载器：用 pipeline 边读边写盘（自带背压与错误清理），中间插一个计数器汇报进度。
 * 安装包接近 100MB，全量读进内存既浪费又无法汇报进度，因此不采用 arrayBuffer 式的写法。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { FetchLike } from './githubClient'
import type { UpdateProgress } from './types'

export interface DownloadOptions {
  url: string
  destPath: string
  fetch: FetchLike
  userAgent: string
  /** 进度回调（约每 400ms 或每块数据触发一次） */
  onProgress?: (progress: UpdateProgress) => void
  signal?: AbortSignal
}

export interface DownloadResult {
  filePath: string
  bytes: number
}

/** 用户主动取消下载（与"网络失败"区分开，界面提示不同）。 */
export class DownloadCancelledError extends Error {
  /** @description 建立"用户主动取消下载"错误 */
  constructor() {
    super('已取消下载')
    this.name = 'DownloadCancelledError'
  }
}

/**
 * @description 流式下载到本地文件；失败时清掉半成品，避免把残缺文件当成安装包
 * @param options 地址、目标路径、fetch 实现、UA、进度回调与取消信号
 * @returns 落地路径与实际字节数
 */
export async function downloadToFile(options: DownloadOptions): Promise<DownloadResult> {
  const { url, destPath, fetch, userAgent, signal } = options

  await mkdir(dirname(destPath), { recursive: true })

  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/octet-stream', 'user-agent': userAgent },
      redirect: 'follow',
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    if (isAbortError(error)) throw new DownloadCancelledError()
    throw new Error(`下载连接失败：${describeError(error)}`)
  }

  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
  if (!response.body) throw new Error('下载失败：响应没有内容')

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  const total = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : 0

  let received = 0
  let lastTick = Date.now()
  let lastBytes = 0
  let bytesPerSecond = 0

  /** @description 汇报一次进度；速度按不满 400ms 也不重复采样的节奏估算 */
  const report = (): void => {
    const now = Date.now()
    const elapsed = now - lastTick
    if (elapsed >= 400 || received === total) {
      bytesPerSecond = elapsed > 0 ? Math.round(((received - lastBytes) * 1000) / elapsed) : 0
      lastTick = now
      lastBytes = received
    }
    options.onProgress?.({
      received,
      total,
      percent: total > 0 ? Math.min(1, received / total) : 0,
      bytesPerSecond
    })
  }

  const counter = new Transform({
    /**
     * @description 累计已接收字节数并汇报进度
     * @param chunk 数据块
     * @param _encoding 流编码（不使用）
     * @param callback 继续管道的回调
     */
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      report()
      callback(null, chunk)
    }
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(destPath),
      ...(signal ? [{ signal }] : [])
    )
  } catch (error) {
    await rm(destPath, { force: true })
    if (isAbortError(error)) throw new DownloadCancelledError()
    throw new Error(`下载中断：${describeError(error)}`)
  }

  if (received === 0) {
    await rm(destPath, { force: true })
    throw new Error('下载失败：收到 0 字节内容')
  }

  // 服务端给了长度就核一下，提前发现被截断的下载（真正的完整性由 SHA-256 负责）
  if (total > 0 && received !== total) {
    await rm(destPath, { force: true })
    throw new Error(`下载不完整：期望 ${total} 字节，实际 ${received} 字节`)
  }

  // 收尾时补一次 100% 的进度，避免界面停在 99%
  if (total > 0) {
    options.onProgress?.({ received, total, percent: 1, bytesPerSecond })
  }

  return { filePath: destPath, bytes: received }
}

/**
 * @description 判断错误是否来自主动取消或超时
 * @param error 任意抛出物
 * @returns 是否为中止类错误
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * @description 取出可展示的错误文本
 * @param error 任意抛出物
 * @returns 错误文本
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
