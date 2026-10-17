import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import {
  COMPRESSION_LEVEL,
  FrameError,
  buildBeginFrame,
  buildDataFrame,
  buildEndFrame,
  chunkCount,
  chunkSlice,
  crc32Hex,
  encodeBytes,
  escapeText,
  estimateDataFrameChars,
  parseFrame,
  payloadEncoding,
  planTextChunks,
  randomJobId,
  sha16Hex,
  toWireBytes,
  verifyDataFrame
} from '@main/util/frame'

import { isValidUtf8 } from '@main/util/textFile'
import {
  HEX_PREVIEW_ROWS,
  TRANSFER_LIMITS,
  TXT_MAX_BYTES,
  type HexPreviewRow,
  type TransferJobSummary,
  type TransferPrepareOptions,
  type TransferPrepareProgress
} from '@shared/transfer/transfer'

/** 准备阶段失败：消息直接展示给用户，因此用中文把"为什么不行 + 怎么办"讲清楚。 */
export class TransferError extends Error {
  readonly code: string

  /**
   * @description 建立准备阶段错误
   * @param code 机器可读的错误码
   * @param message 面向用户的错误说明
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'TransferError'
    this.code = code
  }
}

export interface PrepareDeps {
  onProgress?: (progress: TransferPrepareProgress) => void
  /** 返回 true 时尽快中止（读文件与哈希阶段都会检查） */
  shouldCancel?: () => boolean
}

/**
 * 一个已准备好的传输任务。
 *
 * 关键设计：**帧是按需渲染的**。hex/b64 每帧只从磁盘读一个片（内存恒定）；
 * txt 需要按字符边界切片，所以文本会驻留内存（有 64 MiB 上限）。
 */
export interface PreparedTransfer {
  summary: TransferJobSummary
  /** 准备时读到的文件指纹（大小 + 修改时间），用于判断能否复用哈希 */
  stamp: { size: number; mtimeMs: number }
  /** 开始帧（接收端据此建立任务、校验规模与整文件哈希） */
  beginFrame(): string
  /** 结束帧（携带整文件哈希，接收端靠它做最终校验） */
  endFrame(): string
  /** 渲染某一数据帧（返回单行文本，含发送前自检） */
  renderFrame(index: number): Promise<string>
  /** 某一帧的字符数（用于进度与耗时预估） */
  frameChars(index: number): number
  dispose(): Promise<void>
}

const HASH_CHUNK_BYTES = 1 << 20
const UTF8_HINT_BYTES = 64 * 1024

/**
 * 扫描结果。
 *
 * 一次读盘同时产出两样东西：整文件 SHA-256，以及（压缩编码时）每片压缩后的字节数。
 * 后者让"要打多少字符、大概多久"在发送前就是精确值，而不是估算。
 */
interface ScanResult {
  sha256: string
  wireBytes: Uint32Array | null
}

/**
 * @description 计算一段字节 deflate 之后的大小（不保留结果，只用于统计）
 * @param buffer 待压缩的缓冲
 * @param length 有效长度
 * @returns 压缩后的字节数
 */
function compressedLength(buffer: Buffer, length: number): number {
  return deflateRawSync(buffer.subarray(0, length), { level: COMPRESSION_LEVEL }).length
}

/**
 * @description 流式扫描文件并计算 SHA-256（压缩编码时顺带统计每片压缩后大小）；
 * 大文件不会一次读进内存，且可被取消
 * @param input 路径、大小、片大小、是否压缩、可复用的哈希与进度/取消钩子
 * @returns 哈希与每片线上字节数
 */
async function scanFile(input: {
  path: string
  size: number
  chunkBytes: number
  compress: boolean
  cachedSha256?: string
  deps: PrepareDeps
}): Promise<ScanResult> {
  const { path, size, chunkBytes, compress, cachedSha256, deps } = input
  const wireBytes = compress ? new Uint32Array(chunkCount(size, chunkBytes)) : null
  if (size === 0) {
    return { sha256: cachedSha256 ?? createHash('sha256').digest('hex'), wireBytes }
  }

  const hash = cachedSha256 === undefined ? createHash('sha256') : null
  const handle = await open(path, 'r')
  const block = Buffer.allocUnsafe(Math.min(Math.max(HASH_CHUNK_BYTES, chunkBytes), size))
  const pending = wireBytes ? Buffer.allocUnsafe(Math.min(chunkBytes, size)) : null
  let pendingLength = 0
  let chunkIndex = 0
  let position = 0
  try {
    while (position < size) {
      if (canceled(deps)) throw new TransferError('canceled', '已取消')
      const read = await handle.read(block, 0, block.length, position)
      if (read.bytesRead <= 0) break
      const piece = block.subarray(0, read.bytesRead)
      position += read.bytesRead
      hash?.update(piece)
      if (wireBytes && pending) {
        let cursor = 0
        while (cursor < piece.length) {
          const take = Math.min(pending.length - pendingLength, piece.length - cursor)
          piece.copy(pending, pendingLength, cursor, cursor + take)
          pendingLength += take
          cursor += take
          if (pendingLength === pending.length) {
            wireBytes[chunkIndex] = compressedLength(pending, pendingLength)
            chunkIndex += 1
            pendingLength = 0
          }
        }
      }
      // 压缩编码下这一趟同时在压缩，进度文案要如实反映
      deps.onProgress?.({ phase: wireBytes ? 'compress' : 'hash', done: position, total: size })
    }
    if (wireBytes && pending && pendingLength > 0) {
      wireBytes[chunkIndex] = compressedLength(pending, pendingLength)
    }
  } finally {
    await handle.close()
  }

  if (hash) return { sha256: hash.digest('hex'), wireBytes }
  if (cachedSha256 === undefined) throw new TransferError('io', '内部错误：缺少整文件哈希')
  return { sha256: cachedSha256, wireBytes }
}

/**
 * @description 把数值夹取到闭区间内（非有限数取区间下界）
 * @param value 原始值
 * @param range 合法区间 [min, max]
 * @returns 夹取后的值
 */
function clamp(value: number, range: readonly [number, number]): number {
  const [min, max] = range
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

/**
 * @description 询问依赖是否已被要求取消
 * @param deps 准备阶段依赖
 * @returns 是否应中止
 */
function canceled(deps: PrepareDeps): boolean {
  return deps.shouldCancel?.() === true
}

/**
 * @description 读取文件开头的若干字节，避免为大文件做无谓的全量读取
 * @param path 文件路径
 * @param length 期望读取的字节数
 * @returns 实际读到的头部字节
 */
async function readHead(path: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return Buffer.from(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/**
 * @description 生成前若干行的十六进制预览（偏移 + hex + ASCII）
 * @param bytes 文件头部字节
 * @returns 预览行（最多 HEX_PREVIEW_ROWS 行）
 */
function buildPreview(bytes: Buffer): HexPreviewRow[] {
  const rows: HexPreviewRow[] = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, bytes.length))
    rows.push({
      offset,
      hex: [...slice]
        .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
        .join(' ')
        .padEnd(16 * 3 - 1, ' '),
      ascii: [...slice]
        .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
        .join('')
    })
    if (rows.length >= HEX_PREVIEW_ROWS) break
  }
  return rows
}

/**
 * @description 统计需要额外计数的代理对数量（emoji 等会拆成两个 Unicode 报文，动作数要按码点算）
 * @param text 待统计文本
 * @returns 额外动作数
 */
function astralCount(text: string): number {
  let extra = 0
  for (const char of text) {
    if (char.length > 1) extra += 1
  }
  return extra
}

/**
 * @description 估算给定字节数在某种编码下会变成多少字符（口径与 `encodePayload` 一致：
 * hex 每字节 2 个字符、base64 每 3 字节 4 个字符、txt 与字节数相等）
 * @param wireBytes 线上字节数
 * @param encoding 载荷编码
 * @returns 载荷字符数
 */
function payloadCharsFor(wireBytes: number, encoding: TransferPrepareOptions['encoding']): number {
  const codec = payloadEncoding(encoding)
  if (codec === 'hex') return wireBytes * 2
  if (codec === 'b64') return Math.ceil(wireBytes / 3) * 4
  return wireBytes
}

export interface PrepareTransferInput {
  path: string
  options: TransferPrepareOptions
  /**
   * 已知的整文件哈希。
   *
   * 只有在"大小 + 修改时间"都一致时才会复用，因此改片大小/编码时不必重新哈希大文件；
   * 一旦文件被动过（哪怕只是被重新保存），就退回完整哈希，保证校验的有效性。
   */
  cached?: { sha256: string; size: number; mtimeMs: number }
  deps?: PrepareDeps
}

/**
 * @description 准备一个文件传输任务：校验参数 → 哈希整文件 → 建立分片表 → 给出摘要；整文件哈希不可跳过，否则接收端无法证明合并结果逐字节一致
 * @param input 文件路径、传输选项、可复用的哈希与进度/取消钩子
 * @returns 可用的传输任务（数据帧按需渲染）
 */
export async function prepareTransfer(input: PrepareTransferInput): Promise<PreparedTransfer> {
  const deps = input.deps ?? {}
  const path = input.path
  const encoding = input.options.encoding
  const chunkBytes = clamp(Math.floor(input.options.chunkBytes), TRANSFER_LIMITS.chunkBytes)
  const maxFrameChars = clamp(
    Math.floor(input.options.maxFrameChars),
    TRANSFER_LIMITS.maxFrameChars
  )

  const info = await stat(path).catch(() => null)
  if (!info) throw new TransferError('not-found', `无法读取文件：${path}`)
  if (!info.isFile()) throw new TransferError('not-file', `不是普通文件：${path}`)
  const size = info.size

  if (encoding === 'txt' && size > TXT_MAX_BYTES) {
    throw new TransferError(
      'too-large',
      `文本编码需要把整个文件读进内存，上限 ${Math.round(
        TXT_MAX_BYTES / 1024 / 1024
      )} MB；更大的文件请改用十六进制或 Base64（流式读取，内存恒定）`
    )
  }

  const name = input.options.name?.trim() || basename(path)
  const job = randomJobId()

  // 1) 整文件哈希 +（压缩编码时）每片压缩后大小。文件指纹（大小 + 修改时间）都没变时可复用哈希，
  //    但压缩编码仍需读一遍才能知道压缩后有多大——要的是准确的字符数与耗时。
  const reusable =
    input.cached !== undefined &&
    input.cached.size === size &&
    input.cached.mtimeMs === info.mtimeMs
  const compressing = encoding === 'gzb64'

  const scan =
    reusable && !compressing
      ? null
      : await scanFile({
          path,
          size,
          chunkBytes,
          compress: compressing,
          cachedSha256: reusable ? (input.cached as { sha256: string }).sha256 : undefined,
          deps
        })
  const sha256 = scan?.sha256 ?? (input.cached as { sha256: string }).sha256
  const wireBytes = scan?.wireBytes ?? null
  if (!reusable && canceled(deps)) throw new TransferError('canceled', '已取消')

  // 2) 预览 + UTF-8 提示（只看开头：结论只用于界面提示，真正的校验在 txt 模式里做）
  const head = await readHead(path, Math.max(3, Math.min(size, UTF8_HINT_BYTES)))
  const preview = buildPreview(head)
  const hasBom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  const looksUtf8 = !hasBom && isValidUtf8(head)

  // 3) 分片表
  deps.onProgress?.({ phase: 'plan', done: 0, total: size })

  let textChunks: Array<{ text: string; bytes: number; chars: number }> | null = null
  if (encoding === 'txt') textChunks = await planTextChunksForFile(path, chunkBytes, hasBom)

  const total = textChunks === null ? chunkCount(size, chunkBytes) : textChunks.length
  const tailBytes =
    total === 0
      ? 0
      : textChunks === null
        ? chunkSlice(size, chunkBytes, total - 1).bytes
        : (textChunks[total - 1]?.bytes ?? 0)

  // 4) 帧长与字符量统计：不发一个字节就能算出"要打多少字符、大概多久"
  const wireRatio =
    wireBytes === null || size === 0 ? 1 : wireBytes.reduce((sum, value) => sum + value, 0) / size
  const stats = collectFrameStats({
    job,
    total,
    encoding,
    size,
    chunkBytes,
    maxFrameChars,
    textChunks,
    wireBytes,
    wireRatio
  })

  const beginText = buildBeginFrame({
    job,
    total,
    size,
    enc: encoding,
    chunk: chunkBytes,
    name,
    sha256
  })
  const endText = buildEndFrame({ job, total, size, sha256 })

  const summary: TransferJobSummary = {
    path,
    name,
    size,
    job,
    encoding,
    chunkBytes,
    maxFrameChars,
    total,
    sha256,
    wireBytes: stats.wireBytes,
    tailBytes,
    peakFrameChars: stats.peakFrameChars,
    frameChars: stats.frameChars + beginText.length + 1 + endText.length + 1,
    typedActions: stats.typedActions + beginText.length + endText.length + 2,
    preview,
    looksUtf8
  }

  return createPreparedTransfer(
    summary,
    { path, textChunks, beginText, endText, wireBytes },
    { size, mtimeMs: info.mtimeMs }
  )
}

/**
 * @description 读取整个文件并按字符边界切片（仅 txt 编码使用，需要文本驻留内存）
 * @param path 文件路径
 * @param chunkBytes 每片目标的字节数
 * @param hasBom 文件是否带 BOM（带 BOM 直接拒绝：字节与文本不再是同一份数据）
 * @returns 分片数组（含每片的文本、字节数与字符数）
 */
async function planTextChunksForFile(
  path: string,
  chunkBytes: number,
  hasBom: boolean
): Promise<Array<{ text: string; bytes: number; chars: number }>> {
  const handle = await open(path, 'r')
  let bytes: Buffer
  try {
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }

  if (hasBom) {
    throw new TransferError(
      'bom',
      '文本编码不接受带 BOM 的文件：BOM 会让"文本"与"字节"不再是同一份数据，整文件校验必然失败。请改用十六进制或 Base64'
    )
  }
  if (!isValidUtf8(bytes)) {
    throw new TransferError(
      'not-utf8',
      '文本编码要求文件是合法 UTF-8。GBK 等编码的文件请改用十六进制或 Base64（能逐字节还原）'
    )
  }

  return planTextChunks(bytes.toString('utf8'), chunkBytes, (chunk) =>
    Buffer.byteLength(chunk, 'utf8')
  )
}

interface FrameStatsInput {
  job: string
  total: number
  encoding: TransferPrepareOptions['encoding']
  size: number
  chunkBytes: number
  maxFrameChars: number
  textChunks: Array<{ text: string; bytes: number; chars: number }> | null
  /** 每片线上字节数（压缩编码时由扫描阶段给出） */
  wireBytes: Uint32Array | null
  /** 线上字节数 ÷ 原始字节数（未压缩为 1），用于给出片大小建议 */
  wireRatio: number
}

/**
 * @description 逐帧累加字符数与动作数，并在这里就把"帧太长"的问题挡掉
 * @param input 分片表、线上字节数与帧长上限
 * @returns 总字符数、总动作数、最长帧字符数与线上字节总量
 */
function collectFrameStats(input: FrameStatsInput): {
  frameChars: number
  typedActions: number
  peakFrameChars: number
  wireBytes: number
} {
  let frameChars = 0
  let typedActions = 0
  let peakFrameChars = 0
  let wireTotal = 0

  for (let index = 0; index < input.total; index++) {
    const wire =
      input.textChunks === null
        ? (input.wireBytes?.[index] ?? chunkSlice(input.size, input.chunkBytes, index).bytes)
        : (input.textChunks[index]?.bytes ?? 0)
    const payloadChars =
      input.textChunks === null
        ? payloadCharsFor(wire, input.encoding)
        : escapeText(input.textChunks[index]?.text ?? '').length
    const headerChars = estimateDataFrameChars({
      job: input.job,
      seq: index,
      total: input.total,
      bytes: wire,
      enc: input.encoding,
      payloadChars: 0
    })
    const lineChars = headerChars + payloadChars

    if (lineChars > input.maxFrameChars) {
      throw new TransferError(
        'frame-too-long',
        `第 ${index} 帧约 ${lineChars} 字符，超过上限 ${input.maxFrameChars}。` +
          `请把片大小降到 ${suggestChunkBytes(input)} 字节左右，或提高帧长上限（设置 → 文件传输）`
      )
    }

    frameChars += lineChars + 1
    typedActions += payloadChars + 1
    if (input.textChunks !== null) typedActions += astralCount(input.textChunks[index]?.text ?? '')
    peakFrameChars = Math.max(peakFrameChars, lineChars)
    wireTotal += wire
  }

  return { frameChars, typedActions, peakFrameChars, wireBytes: wireTotal }
}

/**
 * @description 按帧长上限反推建议的片大小（用作报错提示里的修复建议）
 * @param input 分片表与帧长上限
 * @returns 建议的片字节数
 */
function suggestChunkBytes(input: FrameStatsInput): number {
  const codec = payloadEncoding(input.encoding)
  const perByte =
    codec === 'hex' ? 2 : codec === 'b64' ? 4 / 3 : codec === 'txt' ? 1 : input.wireRatio * (4 / 3)
  return Math.max(1, Math.floor((input.maxFrameChars - 64) / perByte))
}

interface PreparedInternals {
  path: string
  textChunks: Array<{ text: string; bytes: number; chars: number }> | null
  beginText: string
  endText: string
  /** 每片线上字节数（压缩编码时有值） */
  wireBytes: Uint32Array | null
}

/**
 * @description 组装传输任务实现；文件句柄延迟打开并复用，避免为每个数据帧反复 open
 * @param summary 摘要（同时暴露给界面）
 * @param internals 渲染所需的开始/结束帧与分片表
 * @param stamp 准备时读到的文件指纹
 * @returns 传输任务
 */
function createPreparedTransfer(
  summary: TransferJobSummary,
  internals: PreparedInternals,
  stamp: { size: number; mtimeMs: number }
): PreparedTransfer {
  let handle: Awaited<ReturnType<typeof open>> | null = null

  /**
   * @description 惰性打开文件句柄并复用（最多打开一次）
   * @returns 已打开的文件句柄
   */
  const openOnce = async (): Promise<Awaited<ReturnType<typeof open>>> => {
    handle ??= await open(internals.path, 'r')
    return handle
  }

  /**
   * @description 取某一片的线上字节数与载荷字符数
   * @param index 片号
   * @returns 该片的线上字节数与载荷字符数
   */
  const payloadOf = (index: number): { bytes: number; payloadChars: number } => {
    if (internals.textChunks === null) {
      const bytes =
        internals.wireBytes?.[index] ?? chunkSlice(summary.size, summary.chunkBytes, index).bytes
      return { bytes, payloadChars: payloadCharsFor(bytes, summary.encoding) }
    }
    const chunk = internals.textChunks[index]
    if (!chunk) throw new FrameError('range', `片号超出范围：${index}`)
    return { bytes: chunk.bytes, payloadChars: escapeText(chunk.text).length }
  }

  /**
   * @description 断言片号在有效范围内
   * @param index 片号
   */
  const assertIndex = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= summary.total) {
      throw new FrameError('range', `片号超出范围：${index}（共 ${summary.total} 片）`)
    }
  }

  return {
    summary,
    stamp,
    /**
     * @description 开始帧文本（接收端据此建立任务、校验规模与整文件哈希）
     * @returns 开始帧单行文本
     */
    beginFrame: () => internals.beginText,
    /**
     * @description 结束帧文本（携带整文件哈希，接收端靠它做最终校验）
     * @returns 结束帧单行文本
     */
    endFrame: () => internals.endText,

    /**
     * @description 某一帧的字符数（用于进度与耗时预估）
     * @param index 片号
     * @returns 该帧的字符数
     */
    frameChars(index: number): number {
      assertIndex(index)
      const { bytes, payloadChars } = payloadOf(index)
      const header = estimateDataFrameChars({
        job: summary.job,
        seq: index,
        total: summary.total,
        bytes,
        enc: summary.encoding,
        payloadChars: 0
      })
      return header + payloadChars
    },

    /**
     * @description 渲染某一数据帧，并在返回前用同一套解析器自检长度 / CRC32 / 强校验
     * @param index 片号
     * @returns 该帧的单行文本
     */
    async renderFrame(index: number): Promise<string> {
      assertIndex(index)

      let wire: Uint8Array
      let payload: string

      if (internals.textChunks === null) {
        const slice = chunkSlice(summary.size, summary.chunkBytes, index)
        const file = await openOnce()
        const buffer = Buffer.allocUnsafe(slice.bytes)
        const { bytesRead } = await file.read(buffer, 0, slice.bytes, slice.offset)
        if (bytesRead !== slice.bytes) {
          throw new TransferError(
            'io',
            `读取第 ${index} 片失败：期望 ${slice.bytes} 字节，实际 ${bytesRead}（文件在传输过程中被修改了？）`
          )
        }
        wire = toWireBytes(buffer, summary.encoding)
        payload = encodeBytes(wire, payloadEncoding(summary.encoding))
      } else {
        const chunk = internals.textChunks[index]
        if (!chunk) throw new FrameError('range', `片号超出范围：${index}`)
        wire = Buffer.from(chunk.text, 'utf8')
        payload = escapeText(chunk.text)
      }

      const line = buildDataFrame({
        job: summary.job,
        seq: index,
        total: summary.total,
        bytes: wire.length,
        crc32: crc32Hex(wire),
        sha16: sha16Hex(wire),
        enc: summary.encoding,
        payload
      })

      // 发送前自检：用同一套解析器解回并比对长度 / CRC32 / 强校验。
      // 一旦这里不一致，说明渲染逻辑本身出了问题，必须立刻停下来，而不是把坏数据打出去。
      const parsed = parseFrame(line)
      if (parsed.kind !== 'data') {
        throw new TransferError('self-check', '自检失败：渲染结果不是数据帧')
      }
      verifyDataFrame(parsed, wire)

      return line
    },

    /**
     * @description 关闭文件句柄并释放驻留的文本分片
     * @returns 释放完成后 resolve
     */
    async dispose(): Promise<void> {
      if (handle) {
        await handle.close()
        handle = null
      }
      internals.textChunks = null
    }
  }
}

/**
 * @description 判断一段文本是否是"帧文本"（用于文本页提示可切换为逐帧节奏发送）
 * @param text 待判断文本
 * @returns 是否是帧文本
 */
export function looksLikeFrameText(text: string): boolean {
  return text.trimStart().startsWith('@TYPER1/')
}

/**
 * @description 统计帧文本里的非空行数（逐帧发送时的总帧数）
 * @param text 帧文本
 * @returns 非空行数
 */
export function countFrameLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length
}
