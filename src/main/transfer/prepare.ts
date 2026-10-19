import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createBrotliCompress } from 'node:zlib'

import {
  FrameError,
  buildBeginFrame,
  buildDataFrame,
  buildEndFrame,
  chunkCount,
  chunkSlice,
  crc32Hex,
  decodeSymbols,
  encodeSymbols,
  estimateDataFrameChars,
  parseFrame,
  payloadCharsFor,
  randomJobId,
  symbolCount,
  verifyDataFrame
} from '@main/util/frame'
import { isValidUtf8 } from '@main/util/textFile'
import {
  HEX_PREVIEW_ROWS,
  TRANSFER_LIMITS,
  type HexPreviewRow,
  type TransferJobSummary,
  type TransferPrepareOptions,
  type TransferPrepareProgress,
  type TransferWireCompression
} from '@shared/transfer/transfer'

import { analyzeFile, KIND_LABELS } from './analyze'

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
 * 关键设计：
 * · `none` 压缩时，线上字节就是源文件本身，渲染第 N 片只从磁盘读这一片（内存恒定）；
 * · `br` 压缩时，整文件先压成一条连续的压缩流（小文件驻留内存，大文件落临时文件），
 *   分片是这条流的切片——只有整文件压缩才能吃到跨片冗余，也才谈得上 15 位字符密度。
 *
 * 无论哪条路径，接收端合并后校验的都是**原文件**的 SHA-256：不做任何容器改写。
 */
export interface PreparedTransfer {
  summary: TransferJobSummary
  /** 准备时读到的文件指纹（大小 + 修改时间），用于判断能否复用哈希 */
  stamp: { size: number; mtimeMs: number }
  beginFrame(): string
  endFrame(): string
  renderFrame(index: number): Promise<string>
  frameChars(index: number): number
  dispose(): Promise<void>
}

/** 线上字节的来源：内存或临时文件。 */
interface WireSource {
  kind: 'memory' | 'file'
  data: Buffer | null
  path: string | null
  size: number
}

/** 压缩产物驻留内存的上限；超过就落临时文件，避免 GB 级文件把内存吃光。 */
const MEMORY_WIRE_LIMIT = 96 * 1024 * 1024
/** 原文件哈希的读块大小。 */
const HASH_BLOCK_BYTES = 1 << 20
/** UTF-8 提示只看开头这么多字节。 */
const UTF8_HINT_BYTES = 64 * 1024

/**
 * @description 询问依赖是否已被要求取消
 * @param deps 准备阶段依赖
 * @returns 是否应中止
 */
function canceled(deps: PrepareDeps): boolean {
  return deps.shouldCancel?.() === true
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
 * @description 读取文件开头的若干字节（预览与 UTF-8 提示）
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
 * @description 流式读取文件并计算 SHA-256
 * @param path 文件路径
 * @param size 文件大小
 * @param deps 进度与取消钩子
 * @returns 整文件 SHA-256
 */
async function hashFile(path: string, size: number, deps: PrepareDeps): Promise<string> {
  const hash = createHash('sha256')
  if (size === 0) return hash.digest('hex')
  const handle = await open(path, 'r')
  const block = Buffer.allocUnsafe(Math.min(HASH_BLOCK_BYTES, size))
  let position = 0
  try {
    while (position < size) {
      if (canceled(deps)) throw new TransferError('canceled', '已取消')
      const { bytesRead } = await handle.read(block, 0, block.length, position)
      if (bytesRead <= 0) break
      hash.update(block.subarray(0, bytesRead))
      position += bytesRead
      deps.onProgress?.({ phase: 'hash', done: position, total: size })
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * @description 整文件 Brotli 压缩：一次读取同时算 SHA-256，产物按大小落内存或临时文件
 * @param input 路径、大小、质量、job 与依赖
 * @returns 线上字节来源与整文件哈希
 */
async function compressFile(input: {
  path: string
  size: number
  quality: number
  job: string
  deps: PrepareDeps
}): Promise<{ source: WireSource; sha256: string }> {
  const { path, size, quality, job, deps } = input
  const keepInMemory = size <= MEMORY_WIRE_LIMIT
  const tempPath = keepInMemory ? null : join(tmpdir(), `typer-${job}.br`)
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let readBytes = 0
  let written = 0

  // 读入侧：更新整文件哈希 + 报进度（哈希与压缩共用同一次读取）
  const reader = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (canceled(deps)) {
        callback(new TransferError('canceled', '已取消'))
        return
      }
      hash.update(chunk)
      readBytes += chunk.length
      deps.onProgress?.({ phase: 'compress', done: readBytes, total: size })
      callback(null, chunk)
    }
  })

  // 输出侧：统计压缩后字节数；内存档顺便收集。
  // 必须是 Writable 而不是 Transform —— pipeline 的终点若是一个没人读的 Transform，
  // 它的可读侧一旦填满高水位（默认 16 KiB）就会永久挂起（实测 4.8 MB 的 VSIX 卡在 50%）。
  const sink = keepInMemory
    ? new Writable({
        write(chunk: Buffer, _encoding, callback) {
          written += chunk.length
          chunks.push(chunk)
          callback()
        }
      })
    : createWriteStream(tempPath as string)

  const brotli = createBrotliCompress({
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: size,
      [zlibConstants.BROTLI_PARAM_LGWIN]: 24
    }
  })

  await pipeline(createReadStream(path), reader, brotli, sink)

  return {
    source: {
      kind: keepInMemory ? 'memory' : 'file',
      data: keepInMemory ? Buffer.concat(chunks) : null,
      path: tempPath,
      size: written
    },
    sha256: hash.digest('hex')
  }
}

/**
 * @description 顺序读取线上字节，算出每片的 CRC32
 * @param source 线上字节来源
 * @param chunkBytes 每片线上字节数
 * @param total 总片数
 * @returns 每片 CRC32（小写 hex）与每片字节数
 */
async function scanChunks(
  source: WireSource,
  chunkBytes: number,
  total: number
): Promise<{ crcs: string[]; sizes: Uint32Array }> {
  const crcs: string[] = new Array(total)
  const sizes = new Uint32Array(total)
  if (total === 0) return { crcs, sizes }

  if (source.kind === 'memory' && source.data) {
    for (let index = 0; index < total; index++) {
      const slice = chunkSlice(source.size, chunkBytes, index)
      const bytes = source.data.subarray(slice.offset, slice.offset + slice.bytes)
      crcs[index] = crc32Hex(bytes)
      sizes[index] = bytes.length
    }
    return { crcs, sizes }
  }

  const handle = await open(source.path as string, 'r')
  const block = Buffer.allocUnsafe(chunkBytes)
  try {
    for (let index = 0; index < total; index++) {
      const slice = chunkSlice(source.size, chunkBytes, index)
      const { bytesRead } = await handle.read(block, 0, slice.bytes, slice.offset)
      if (bytesRead !== slice.bytes) {
        throw new TransferError('io', `读取线上数据失败：第 ${index} 片期望 ${slice.bytes} 字节`)
      }
      crcs[index] = crc32Hex(block.subarray(0, bytesRead))
      sizes[index] = bytesRead
    }
  } finally {
    await handle.close()
  }
  return { crcs, sizes }
}

export interface PrepareTransferInput {
  path: string
  options: TransferPrepareOptions
  /**
   * 已知的整文件哈希（只在"大小 + 修改时间"都一致时才复用）。
   * 压缩档下压缩本身就要读一遍文件，因此顺带算出来更划算。
   */
  cached?: { sha256: string; size: number; mtimeMs: number }
  deps?: PrepareDeps
}

/**
 * @description 准备一个文件传输任务：识别文件 → 决定是否压缩 → 哈希 → 分片；整文件哈希不可跳过，否则接收端无法证明合并结果逐字节一致
 * @param input 文件路径、传输选项、可复用的哈希与进度/取消钩子
 * @returns 可用的传输任务（数据帧按需渲染）
 */
export async function prepareTransfer(input: PrepareTransferInput): Promise<PreparedTransfer> {
  const startedAt = Date.now()
  const deps = input.deps ?? {}
  const path = input.path
  const options = input.options
  const chunkBytes = clamp(Math.floor(options.chunkBytes), TRANSFER_LIMITS.chunkBytes)
  const maxFrameChars = clamp(Math.floor(options.maxFrameChars), TRANSFER_LIMITS.maxFrameChars)
  const quality = clamp(Math.floor(options.quality), TRANSFER_LIMITS.quality)

  const info = await stat(path).catch(() => null)
  if (!info) throw new TransferError('not-found', `无法读取文件：${path}`)
  if (!info.isFile()) throw new TransferError('not-file', `不是普通文件：${path}`)
  const size = info.size

  const name = options.name?.trim() || basename(path)
  const job = randomJobId()

  // 1) 文件画像：只读样本、不改写文件；决定"要不要压"
  const profile = await analyzeFile(path, size)
  const compression: TransferWireCompression =
    options.compression === 'auto'
      ? profile.compressible && size > 0
        ? 'br'
        : 'none'
      : options.compression

  // 2) 线上字节 + 整文件哈希
  const reusable =
    input.cached !== undefined &&
    input.cached.size === size &&
    input.cached.mtimeMs === info.mtimeMs

  let wire: WireSource
  let sha256: string
  let actualCompression = compression
  if (compression === 'br' && size > 0) {
    const result = await compressFile({ path, size, quality, job, deps })
    wire = result.source
    sha256 = result.sha256
    // 压完反而更大（极小文件 / 已压缩数据）：丢掉压缩结果，按原字节发，省字符也省时间
    if (wire.size >= size) {
      if (wire.path) await unlink(wire.path).catch(() => undefined)
      wire = { kind: 'file', data: null, path, size }
      actualCompression = 'none'
    }
  } else {
    wire = { kind: 'file', data: null, path, size }
    sha256 = reusable
      ? (input.cached as { sha256: string }).sha256
      : await hashFile(path, size, deps)
  }
  if (canceled(deps)) throw new TransferError('canceled', '已取消')

  // 3) 预览与 UTF-8 提示（只看开头：仅用于界面提示）
  const head = await readHead(path, Math.max(3, Math.min(size, UTF8_HINT_BYTES)))
  const preview = buildPreview(head)
  const hasBom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  const looksUtf8 = !hasBom && isValidUtf8(head)

  // 4) 分片与每片校验
  deps.onProgress?.({ phase: 'plan', done: 0, total: wire.size })
  const total = chunkCount(wire.size, chunkBytes)
  const { crcs, sizes } = await scanChunks(wire, chunkBytes, total)
  deps.onProgress?.({ phase: 'plan', done: wire.size, total: wire.size })

  const tailBytes = total === 0 ? 0 : sizes[total - 1]
  const lineChars = options.mode === 'line' ? 0 : 1
  const beginText = buildBeginFrame({
    job,
    total,
    size,
    wire: wire.size,
    chunk: chunkBytes,
    name,
    alphabet: options.alphabet,
    compression: actualCompression,
    mode: options.mode,
    sha256
  })
  const endText = buildEndFrame({ job, total, size, wire: wire.size, sha256 })

  // 5) 帧字符数与峰值：不发一个字节就能算出"要打多少字符、大概多久"
  let frameChars = 0
  let peakFrameChars = 0
  for (let index = 0; index < total; index++) {
    const payloadChars = payloadCharsFor(sizes[index], options.alphabet)
    const frame =
      estimateDataFrameChars({
        job,
        seq: index,
        bytes: sizes[index],
        payloadChars
      }) + lineChars
    frameChars += frame
    if (frame > peakFrameChars) peakFrameChars = frame
  }
  frameChars += beginText.length + lineChars + endText.length + lineChars
  if (peakFrameChars > maxFrameChars) {
    const suggested = Math.max(1024, Math.floor((chunkBytes * maxFrameChars) / peakFrameChars))
    throw new TransferError(
      'overlong',
      `单帧最长 ${peakFrameChars} 字符，超过上限 ${maxFrameChars}：请把片大小调到 ${suggested} 字节以内`
    )
  }

  const summary: TransferJobSummary = {
    path,
    name,
    size,
    job,
    alphabet: options.alphabet,
    compression: actualCompression,
    quality: actualCompression === 'br' ? quality : 0,
    mode: options.mode,
    chunkBytes,
    maxFrameChars,
    total,
    sha256,
    wireBytes: wire.size,
    tailBytes,
    peakFrameChars,
    frameChars,
    typedActions: frameChars,
    preview,
    looksUtf8,
    compressionNote:
      actualCompression === 'br'
        ? profile.compressible
          ? `${profile.reason}；已按 q${quality} 整文件压缩`
          : `实测压缩收益很小（${
              size > 0 ? Math.round((1 - wire.size / size) * 100) : 0
            }%），但按设置强制压缩了；改用「自动」可跳过这一步，省掉准备时间`
        : profile.reason,
    kind: profile.kind,
    kindLabel: KIND_LABELS[profile.kind],
    prepareMs: Date.now() - startedAt
  }

  return createPreparedTransfer(
    summary,
    { wire, crcs, beginText, endText },
    { size, mtimeMs: info.mtimeMs }
  )
}

interface PreparedInternals {
  wire: WireSource
  /** 每片线上字节的 CRC32（小写 hex） */
  crcs: string[]
  beginText: string
  endText: string
}

/**
 * @description 组装传输任务实现；文件句柄延迟打开并复用，避免为每个数据帧反复 open
 * @param summary 摘要（同时暴露给界面）
 * @param internals 渲染所需的开始/结束帧与校验值
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
   * @description 惰性打开线上数据文件并复用（最多打开一次）
   * @returns 已打开的文件句柄
   */
  const openOnce = async (): Promise<Awaited<ReturnType<typeof open>>> => {
    handle ??= await open(internals.wire.path as string, 'r')
    return handle
  }

  /**
   * @description 读取第 index 片的线上字节
   * @param index 片号
   * @returns 线上字节
   */
  const sliceOf = async (index: number): Promise<Buffer> => {
    const slice = chunkSlice(internals.wire.size, summary.chunkBytes, index)
    if (internals.wire.kind === 'memory' && internals.wire.data) {
      return internals.wire.data.subarray(slice.offset, slice.offset + slice.bytes)
    }
    const file = await openOnce()
    const buffer = Buffer.allocUnsafe(slice.bytes)
    const { bytesRead } = await file.read(buffer, 0, slice.bytes, slice.offset)
    if (bytesRead !== slice.bytes) {
      throw new TransferError(
        'io',
        `读取第 ${index} 片失败：期望 ${slice.bytes} 字节，实际 ${bytesRead}（文件在传输过程中被修改了？）`
      )
    }
    return buffer
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
    beginFrame: () => internals.beginText,
    endFrame: () => internals.endText,

    /**
     * @description 某一帧的字符数（用于进度与耗时预估，不触发磁盘读取）
     * @param index 片号
     * @returns 该帧的字符数（含行尾）
     */
    frameChars(index: number): number {
      assertIndex(index)
      const slice = chunkSlice(internals.wire.size, summary.chunkBytes, index)
      const payloadChars = payloadCharsFor(slice.bytes, summary.alphabet)
      return estimateDataFrameChars({
        job: summary.job,
        seq: index,
        bytes: slice.bytes,
        payloadChars
      })
    },

    /**
     * @description 渲染某一数据帧，并在返回前解回、比对字节（自检）
     * @param index 片号
     * @returns 该帧的单行文本
     */
    async renderFrame(index: number): Promise<string> {
      assertIndex(index)
      const wire = await sliceOf(index)
      const payload = encodeSymbols(wire, summary.alphabet)

      const line = buildDataFrame({
        job: summary.job,
        seq: index,
        bytes: wire.length,
        crc32: internals.crcs[index],
        payload
      })

      // 发送前自检：用同一套解析器解回并逐字节比对。
      // 一旦这里不一致，说明渲染或编码逻辑本身出了问题，必须立刻停下，而不是把坏数据打出去。
      const parsed = parseFrame(line)
      if (parsed.kind !== 'data') {
        throw new TransferError('self-check', '自检失败：渲染结果不是数据帧')
      }
      verifyDataFrame(parsed, wire)
      const decoded = decodeSymbols(parsed.payload, summary.alphabet, parsed.bytes)
      if (Buffer.compare(Buffer.from(decoded), Buffer.from(wire)) !== 0) {
        throw new TransferError('self-check', `自检失败：第 ${index} 片解码结果与原文不一致`)
      }
      if (symbolCount(wire.length, summary.alphabet) !== payload.length) {
        throw new TransferError('self-check', `自检失败：第 ${index} 片载荷长度不符`)
      }

      return line
    },

    /**
     * @description 关闭文件句柄、删除临时压缩产物
     * @returns 释放完成后 resolve
     */
    async dispose(): Promise<void> {
      if (handle) {
        await handle.close()
        handle = null
      }
      const temp = internals.wire.path
      if (internals.wire.kind === 'file' && temp && temp !== summary.path) {
        await unlink(temp).catch(() => undefined)
      }
      internals.wire = { kind: 'memory', data: null, path: null, size: 0 }
    }
  }
}

/**
 * @description 判断一段文本是否是"帧文本"（用于文本页提示可切换为逐帧节奏发送）
 * @param text 待判断文本
 * @returns 是否是帧文本
 */
export function looksLikeFrameText(text: string): boolean {
  return text.trimStart().startsWith('@T2')
}

/**
 * @description 统计帧文本里的非空行数（逐帧发送时的总帧数）
 * @param text 帧文本
 * @returns 非空行数
 */
export function countFrameLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length
}
