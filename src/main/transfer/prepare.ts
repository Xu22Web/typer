import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import {
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
  planTextChunks,
  randomJobId,
  sha16Hex,
  verifyDataFrame
} from '@tools/lib/frame.mjs'

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

function clamp(value: number, range: readonly [number, number]): number {
  const [min, max] = range
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function canceled(deps: PrepareDeps): boolean {
  return deps.shouldCancel?.() === true
}

/** 流式读取文件并计算 SHA-256（大文件不会一次读进内存）。 */
async function hashFile(path: string, size: number, deps: PrepareDeps): Promise<string> {
  const hash = createHash('sha256')
  if (size === 0) return hash.digest('hex')

  const handle = await open(path, 'r')
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, size))
  let position = 0
  try {
    while (position < size) {
      if (canceled(deps)) throw new TransferError('canceled', '已取消')
      const read = await handle.read(buffer, 0, buffer.length, position)
      if (read.bytesRead <= 0) break
      hash.update(buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
      deps.onProgress?.({ phase: 'hash', done: position, total: size })
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/** 读取文件开头的若干字节（预览与 UTF-8 提示都用它，避免为大文件做无谓的全量读取）。 */
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

/** 前若干行的十六进制预览（偏移 + hex + ASCII），满足"看一眼二进制内容"的需求。 */
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

/** 代理对（emoji 等）会拆成两个 Unicode 报文，动作数要按码点算。 */
function astralCount(text: string): number {
  let extra = 0
  for (const char of text) {
    if (char.length > 1) extra += 1
  }
  return extra
}

/** `hex` / `b64` 的载荷字符数（与 frame.mjs 的估算口径一致）。 */
function encodedChars(bytes: number, encoding: TransferPrepareOptions['encoding']): number {
  if (encoding === 'hex') return bytes * 2
  if (encoding === 'b64') return Math.ceil(bytes / 3) * 4
  return bytes
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
 * 准备一个文件传输任务：校验参数 → 哈希整文件 → 建立分片表 → 给出摘要。
 *
 * 之所以坚持"先算整文件哈希"：接收端只有用同一哈希校验合并结果，才算真正证明"传过去的文件
 * 逐字节一致"。这一步是流式的、可取消的；把它做成可选会直接削弱完整性保证（协议里开始帧与
 * 结束帧都必须带 sha256）。
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

  // 1) 整文件哈希。文件指纹（大小 + 修改时间）都没变时可直接复用上次结果，
  //    这样"改片大小"这类操作不会把 GB 级文件重新读一遍。
  const reusable =
    input.cached !== undefined &&
    input.cached.size === size &&
    input.cached.mtimeMs === info.mtimeMs

  const sha256 = reusable
    ? (input.cached as { sha256: string }).sha256
    : await hashFile(path, size, deps)
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
  const stats = collectFrameStats({
    job,
    total,
    encoding,
    size,
    chunkBytes,
    maxFrameChars,
    textChunks
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
    tailBytes,
    peakFrameChars: stats.peakFrameChars,
    frameChars: stats.frameChars + beginText.length + 1 + endText.length + 1,
    typedActions: stats.typedActions + beginText.length + endText.length + 2,
    preview,
    looksUtf8
  }

  return createPreparedTransfer(
    summary,
    { path, textChunks, beginText, endText },
    { size, mtimeMs: info.mtimeMs }
  )
}

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
}

/** 逐帧累加字符数 / 动作数，并在这里就把"帧太长"的问题挡掉。 */
function collectFrameStats(input: FrameStatsInput): {
  frameChars: number
  typedActions: number
  peakFrameChars: number
} {
  let frameChars = 0
  let typedActions = 0
  let peakFrameChars = 0

  for (let index = 0; index < input.total; index++) {
    const bytes =
      input.textChunks === null
        ? chunkSlice(input.size, input.chunkBytes, index).bytes
        : (input.textChunks[index]?.bytes ?? 0)
    const payloadChars =
      input.textChunks === null
        ? encodedChars(bytes, input.encoding)
        : escapeText(input.textChunks[index]?.text ?? '').length
    const headerChars = estimateDataFrameChars({
      job: input.job,
      seq: index,
      total: input.total,
      bytes,
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
  }

  return { frameChars, typedActions, peakFrameChars }
}

function suggestChunkBytes(input: FrameStatsInput): number {
  const overhead = input.encoding === 'hex' ? 2 : input.encoding === 'b64' ? 4 / 3 : 1
  return Math.max(1, Math.floor((input.maxFrameChars - 64) / overhead))
}

interface PreparedInternals {
  path: string
  textChunks: Array<{ text: string; bytes: number; chars: number }> | null
  beginText: string
  endText: string
}

function createPreparedTransfer(
  summary: TransferJobSummary,
  internals: PreparedInternals,
  stamp: { size: number; mtimeMs: number }
): PreparedTransfer {
  let handle: Awaited<ReturnType<typeof open>> | null = null

  const openOnce = async (): Promise<Awaited<ReturnType<typeof open>>> => {
    handle ??= await open(internals.path, 'r')
    return handle
  }

  const payloadOf = (index: number): { bytes: number; payloadChars: number } => {
    if (internals.textChunks === null) {
      const bytes = chunkSlice(summary.size, summary.chunkBytes, index).bytes
      return { bytes, payloadChars: encodedChars(bytes, summary.encoding) }
    }
    const chunk = internals.textChunks[index]
    if (!chunk) throw new FrameError('range', `片号超出范围：${index}`)
    return { bytes: chunk.bytes, payloadChars: escapeText(chunk.text).length }
  }

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

    async renderFrame(index: number): Promise<string> {
      assertIndex(index)

      let bytes: Buffer
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
        bytes = buffer
        payload = encodeBytes(buffer, summary.encoding === 'b64' ? 'b64' : 'hex')
      } else {
        const chunk = internals.textChunks[index]
        if (!chunk) throw new FrameError('range', `片号超出范围：${index}`)
        bytes = Buffer.from(chunk.text, 'utf8')
        payload = escapeText(chunk.text)
      }

      const line = buildDataFrame({
        job: summary.job,
        seq: index,
        total: summary.total,
        bytes: bytes.length,
        crc32: crc32Hex(bytes),
        sha16: sha16Hex(bytes),
        enc: summary.encoding,
        payload
      })

      // 发送前自检：用同一套解析器解回并比对长度 / CRC32 / 强校验。
      // 一旦这里不一致，说明渲染逻辑本身出了问题，必须立刻停下来，而不是把坏数据打出去。
      const parsed = parseFrame(line)
      if (parsed.kind !== 'data') {
        throw new TransferError('self-check', '自检失败：渲染结果不是数据帧')
      }
      verifyDataFrame(parsed, bytes)

      return line
    },

    async dispose(): Promise<void> {
      if (handle) {
        await handle.close()
        handle = null
      }
      internals.textChunks = null
    }
  }
}

/** 判断一段文本是否是"帧文本"（用于文本页提示可切换为逐帧节奏发送）。 */
export function looksLikeFrameText(text: string): boolean {
  return text.trimStart().startsWith('@TYPER1/')
}

/** 统计帧文本里的非空行数（逐帧发送时的总帧数）。 */
export function countFrameLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length
}
