// Typer 文件传输「线格式」v2 的唯一实现。
// 主进程（生成帧、算续传计划）与接收端脚本（tools/typer-recv.ts）共用同一份实现，收发两端不可能出现实现漂移。
// 只用 node: 内置模块、零第三方依赖，Node >= 14 可运行。
// 帧一定是单行：ASCII 帧头 + 不含空白的符号载荷。目标是终端或输入框，回车即提交，
// 任何控制字符都会把数据搅乱，所以二进制必须先编码（见 util/codec.ts）。

import { createHash } from 'node:crypto'

import {
  CodecError,
  decodeSymbols,
  encodeSymbols,
  getAlphabet,
  isAlphabetId,
  symbolCount,
  type AlphabetId
} from './codec'

export {
  CodecError,
  decodeSymbols,
  encodeSymbols,
  getAlphabet,
  isAlphabetId,
  symbolCount,
  type AlphabetId
}

/** 可当字节序列使用的输入。 */
export type BytesLike = Uint8Array | string | ArrayBuffer | ArrayBufferView

/** 线格式版本。字段含义变化时必须递增，接收端据此拒绝不认识的帧。 */
export const FRAME_VERSION = 2

/** 帧标记（`@T2` 后缀区分帧类型）。 */
export const MARKERS = {
  begin: '@T2H',
  data: '@T2D',
  end: '@T2E',
  resume: '@T2R'
} as const

/** 载荷压缩方式：`none` 原样，`br` 整文件 Brotli（分片是压缩流的切片）。 */
export type CompressionId = 'none' | 'br'
export const COMPRESSIONS: readonly CompressionId[] = ['none', 'br']

/** 目标端换行方式：终端用 CR 报文，编辑器用真回车，单行输入框不加换行。 */
export type TargetMode = 'term' | 'editor' | 'line'
export const TARGET_MODES: readonly TargetMode[] = ['term', 'editor', 'line']

export const DEFAULT_CHUNK_BYTES = 16384
export const DEFAULT_MAX_FRAME_CHARS = 65536
/** 硬上限：单片线上字节数。 */
export const MAX_CHUNK_BYTES = 1024 * 1024
/** 硬上限：单帧字符数（接收端要先把整行读进内存）。 */
export const MAX_FRAME_CHARS = 4 * 1024 * 1024

/** 协议层错误码。 */
export type FrameErrorCode =
  'marker' | 'field' | 'crc' | 'len' | 'enc' | 'overlong' | 'job' | 'range' | 'empty'

/** 协议层错误：带稳定的 `code`，便于上层分类与给出可操作建议。 */
export class FrameError extends Error {
  declare readonly name: 'FrameError'
  declare readonly code: FrameErrorCode
  declare readonly detail?: string

  /**
   * @description 构造协议层错误
   * @param code 机器可读错误码
   * @param message 面向用户的中文说明
   * @param detail 附加细节（不包含数据原文，避免把内容写进日志）
   */
  constructor(code: FrameErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'FrameError'
    this.code = code
    this.detail = detail
  }
}

/** 错误码 → 可操作建议（脚本与界面共用）。 */
export const ERROR_HINTS: Readonly<Record<string, string>> = {
  marker: '该行不是 Typer 帧，可能被终端回显、提示符或其它输出混入；确认输入流里只有帧',
  field: '帧字段数量或格式不对，通常是传输过程中被截断或插入字符；请重传该片',
  crc: '片校验失败（数据与校验和不一致），该片需重传',
  len: '片长度与声明不一致，通常是被截断；请减小片大小或降低输入速率后重传该片',
  enc: '载荷含符号表之外的字符或长度不对，该片需重传',
  overlong: '该帧超出长度上限（终端/剪贴板截断），请用更小的片',
  job: '帧属于另一次任务（job 不一致），请确认没有混入上一次的数据',
  range: '序号或区间不合法',
  empty: '内容为空'
}

/**
 * @description 把各种二进制输入统一成 Uint8Array
 * @param input 字节序列
 * @returns 等价的 Uint8Array
 */
export function toBytes(input: BytesLike): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (typeof input === 'string') return new TextEncoder().encode(input)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new FrameError('field', '无法把该值当作字节序列处理')
}

// ---------------------------------------------------------------------------
// 校验：CRC32 / SHA-256
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null

/**
 * @description 惰性构建并缓存 CRC32 查表
 * @returns 256 项查表
 */
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  crcTable = table
  return table
}

/**
 * @description 标准 CRC32（IEEE 802.3，与 `zlib.crc32` 同值）；自带实现是因为 `zlib.crc32` 需要
 * Node 20.15+，而接收端脚本要能在 Node 14 上跑
 * @param input 字节序列
 * @returns 无符号 32 位整数
 */
export function crc32(input: BytesLike): number {
  const bytes = toBytes(input)
  const table = getCrcTable()
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    value = table[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * @description 计算字节序列的 CRC32 文本
 * @param input 字节序列
 * @returns 8 位小写 hex
 */
export function crc32Hex(input: BytesLike): string {
  return crc32(input).toString(16).padStart(8, '0')
}

/**
 * @description 计算字节序列的 SHA-256 文本
 * @param input 字节序列
 * @returns 64 位小写 hex
 */
export function sha256Hex(input: BytesLike): string {
  return createHash('sha256').update(toBytes(input)).digest('hex')
}

/**
 * @description 生成随机 job id（8 位小写 hex）
 * @param random 随机源（可注入以便测试得到确定值）
 * @returns 8 位小写 hex
 */
export function randomJobId(random: () => number = Math.random): string {
  let out = ''
  for (let index = 0; index < 8; index++) out += Math.floor(random() * 16).toString(16)
  return out
}

/**
 * @description 判断取值是否为受支持的压缩方式
 * @param value 待判断的值
 * @returns 是否为 CompressionId
 */
export function isCompression(value: unknown): value is CompressionId {
  return value === 'none' || value === 'br'
}

/**
 * @description 判断取值是否为受支持的目标端模式
 * @param value 待判断的值
 * @returns 是否为 TargetMode
 */
export function isTargetMode(value: unknown): value is TargetMode {
  return value === 'term' || value === 'editor' || value === 'line'
}

/**
 * @description 给定线上字节数需要的载荷字符数（用于发送前的精确耗时预估）
 * @param bytes 线上字节数
 * @param alphabet 符号表
 * @returns 载荷字符数
 */
export function payloadCharsFor(bytes: number, alphabet: AlphabetId): number {
  return symbolCount(bytes, alphabet)
}

// ---------------------------------------------------------------------------
// 帧的构造与解析
// ---------------------------------------------------------------------------

/**
 * @description 校验 job 标识是否为合法任务 id
 * @param job 任务 id
 */
function assertJobPart(job: string): void {
  if (typeof job !== 'string' || !/^[0-9a-f]{4,16}$/.test(job)) {
    throw new FrameError('job', `job 标识不合法：${String(job)}`)
  }
}

/**
 * @description 校验取值为非负整数且不超过上限
 * @param value 待校验的值
 * @param name 字段名（用于报错）
 * @param max 允许的最大值
 */
function assertUint(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new FrameError('range', `${name} 不合法：${String(value)}`)
  }
}

/** 开始帧字段。 */
export interface BeginFrameMeta {
  job: string
  /** 数据片总数（不含开始/结束帧） */
  total: number
  /** 原始文件字节数 */
  size: number
  /** 线上字节数（压缩后的字节数；`none` 时等于 size） */
  wire: number
  /** 每片线上字节数 */
  chunk: number
  /** 文件名（UTF-8 base64url；`-` 表示不指定） */
  name?: string | null
  alphabet: AlphabetId
  compression: CompressionId
  mode: TargetMode
  /** 原始文件的整文件 SHA-256 */
  sha256: string
}

/**
 * @description 构造开始帧：接收端据此知道任务规模、编码与期望哈希，从而能边收边判并提前建工作目录
 * @param meta 开始帧字段
 * @returns 单行帧文本
 */
export function buildBeginFrame(meta: BeginFrameMeta): string {
  assertJobPart(meta.job)
  assertUint(meta.total, 'total', 0xffffffff)
  assertUint(meta.size, 'size', Number.MAX_SAFE_INTEGER)
  assertUint(meta.wire, 'wire', Number.MAX_SAFE_INTEGER)
  assertUint(meta.chunk, 'chunk', MAX_CHUNK_BYTES)
  if (!isAlphabetId(meta.alphabet)) {
    throw new FrameError('enc', `不支持的符号表 ${String(meta.alphabet)}`)
  }
  if (!isCompression(meta.compression)) {
    throw new FrameError('enc', `不支持的压缩方式 ${String(meta.compression)}`)
  }
  if (!isTargetMode(meta.mode)) {
    throw new FrameError('field', `不支持的目标端模式 ${String(meta.mode)}`)
  }
  if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
    throw new FrameError('field', '整文件 sha256 不合法（应为 64 位小写 hex）')
  }
  const name = meta.name ? encodeName(String(meta.name)) : '-'
  const head = [
    MARKERS.begin,
    meta.job,
    String(meta.total),
    String(meta.size),
    String(meta.wire),
    String(meta.chunk),
    name,
    meta.alphabet,
    meta.compression,
    meta.mode
  ].join(' ')
  // 帧头自带 CRC：链路偶尔会丢一个字符（尤其攒批直投时），
  // 而"size 少一位"这种改动会让接收端按错误规模合并，必须当场判出来。
  return `${head} ${crc32Hex(head)} ${meta.sha256}`
}

/** 数据帧字段。 */
export interface DataFrameMeta {
  job: string
  seq: number
  /** 本片线上字节数（压缩流切片长度） */
  bytes: number
  /** 本片线上字节的 CRC32（8 位小写 hex） */
  crc32: string
  /** 已编码的符号载荷 */
  payload: string
}

/**
 * @description 构造数据帧
 * @param meta 数据帧字段（payload 必须是已经编码好的符号串）
 * @returns 单行帧文本
 */
export function buildDataFrame(meta: DataFrameMeta): string {
  assertJobPart(meta.job)
  assertUint(meta.seq, 'seq', 0xffffffff)
  assertUint(meta.bytes, 'bytes', MAX_CHUNK_BYTES)
  if (!/^[0-9a-f]{8}$/.test(meta.crc32)) {
    throw new FrameError('field', '数据帧的 crc32 不合法（应为 8 位小写 hex）')
  }
  if (typeof meta.payload !== 'string' || meta.payload.length === 0 || /\s/.test(meta.payload)) {
    throw new FrameError('field', '载荷不能为空或包含空白字符')
  }
  const head = [MARKERS.data, meta.job, String(meta.seq), String(meta.bytes), meta.crc32].join(' ')
  // 同开始帧：帧头也带 CRC，避免"字节数/序号少一位"被当成合法帧
  return `${head} ${crc32Hex(head)} ${meta.payload}`
}

/** 结束帧字段。 */
export interface EndFrameMeta {
  job: string
  total: number
  size: number
  wire: number
  sha256: string
}

/**
 * @description 构造结束帧：携带整文件哈希与规模，接收端只有在全部片都通过后才会用它做最终校验
 * @param meta 结束帧字段
 * @returns 单行帧文本
 */
export function buildEndFrame(meta: EndFrameMeta): string {
  assertJobPart(meta.job)
  assertUint(meta.total, 'total', 0xffffffff)
  assertUint(meta.size, 'size', Number.MAX_SAFE_INTEGER)
  assertUint(meta.wire, 'wire', Number.MAX_SAFE_INTEGER)
  if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
    throw new FrameError('field', '整文件 sha256 不合法（应为 64 位小写 hex）')
  }
  const head = [
    MARKERS.end,
    meta.job,
    String(meta.total),
    String(meta.size),
    String(meta.wire)
  ].join(' ')
  return `${head} ${crc32Hex(head)} ${meta.sha256}`
}

/** 续传令牌字段。 */
export interface ResumeTokenMeta {
  job: string
  total: number
  /** 缺失片号：数组会被压成区间文本，字符串原样使用 */
  missing: number[] | string | null
}

/**
 * @description 构造续传令牌：由接收端打印，操作者回填给 Typer（或脚本 `--only`）
 * @param meta 续传字段
 * @returns 单行令牌文本
 */
export function buildResumeToken(meta: ResumeTokenMeta): string {
  assertJobPart(meta.job)
  assertUint(meta.total, 'total', 0xffffffff)
  const missing = Array.isArray(meta.missing)
    ? formatIndexList(meta.missing, meta.total)
    : String(meta.missing ?? '')
  return [MARKERS.resume, meta.job, String(meta.total), missing || '-'].join(' ')
}

/**
 * @description 判断该行看起来是不是 Typer 帧（文本页据此识别"粘贴进来的是帧文本"）
 * @param line 待判断的行
 * @returns 是否为帧行
 */
export function isFrameLine(line: string): boolean {
  const text = typeof line === 'string' ? line.trim() : ''
  return Object.values(MARKERS).some((marker) => text.startsWith(`${marker} `))
}

/** 解析后的开始帧。 */
export interface ParsedBeginFrame {
  kind: 'begin'
  version: number
  job: string
  total: number
  size: number
  wire: number
  chunk: number
  name: string | null
  alphabet: AlphabetId
  compression: CompressionId
  mode: TargetMode
  sha256: string
}

/** 解析后的数据帧。 */
export interface ParsedDataFrame {
  kind: 'data'
  version: number
  job: string
  seq: number
  bytes: number
  crc32: string
  payload: string
}

/** 解析后的结束帧。 */
export interface ParsedEndFrame {
  kind: 'end'
  version: number
  job: string
  total: number
  size: number
  wire: number
  sha256: string
}

/** 解析后的续传帧。 */
export interface ParsedResumeFrame {
  kind: 'resume'
  version: number
  job: string
  total: number
  missing: number[]
}

/** 解析后的帧（四种类型之一）。 */
export type ParsedFrame = ParsedBeginFrame | ParsedDataFrame | ParsedEndFrame | ParsedResumeFrame

/**
 * @description 解析一行帧，严格校验字段数量与取值；任何不符都抛 `FrameError`，
 * 由调用方决定"重传该片"还是"当作噪声忽略"
 * @param line 单行帧文本
 * @returns 解析结果（begin / data / end / resume 四种之一）
 */
export function parseFrame(line: string): ParsedFrame {
  const text = typeof line === 'string' ? line.replace(/[\r\n]+$/, '').trim() : ''
  if (text.length === 0) throw new FrameError('empty', '空行不是帧')
  if (text.length > MAX_FRAME_CHARS) {
    throw new FrameError('overlong', `该帧超过 ${MAX_FRAME_CHARS} 字符上限`, `实际 ${text.length}`)
  }

  const parts = text.split(' ')
  const marker = parts[0]

  if (marker === MARKERS.begin) {
    if (parts.length !== 12) {
      throw new FrameError('field', `开始帧应有 11 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    const alphabet = parts[7]
    if (!isAlphabetId(alphabet)) {
      throw new FrameError('enc', `不支持的符号表 ${String(alphabet)}`)
    }
    const compression = parts[8]
    if (!isCompression(compression)) {
      throw new FrameError('enc', `不支持的压缩方式 ${String(compression)}`)
    }
    const mode = parts[9]
    if (!isTargetMode(mode)) {
      throw new FrameError('field', `不支持的目标端模式 ${String(mode)}`)
    }
    verifyHeaderCrc(parts, 10)
    const sha256 = parts[11]
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new FrameError('field', '开始帧的 sha256 不合法')
    return {
      kind: 'begin',
      version: FRAME_VERSION,
      job,
      total: readUint(parts[2], 'total'),
      size: readUint(parts[3], 'size'),
      wire: readUint(parts[4], 'wire'),
      chunk: readUint(parts[5], 'chunk'),
      name: parts[6] === '-' ? null : decodeName(parts[6]),
      alphabet,
      compression,
      mode,
      sha256
    }
  }

  if (marker === MARKERS.data) {
    if (parts.length !== 7) {
      throw new FrameError('field', `数据帧应有 6 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    const crc = parts[4]
    if (!/^[0-9a-f]{8}$/.test(crc)) throw new FrameError('field', '数据帧的 crc32 不合法')
    verifyHeaderCrc(parts, 5)
    return {
      kind: 'data',
      version: FRAME_VERSION,
      job,
      seq: readUint(parts[2], 'seq'),
      bytes: readUint(parts[3], 'bytes'),
      crc32: crc,
      payload: parts[6]
    }
  }

  if (marker === MARKERS.end) {
    if (parts.length !== 7) {
      throw new FrameError('field', `结束帧应有 6 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    verifyHeaderCrc(parts, 5)
    const sha256 = parts[6]
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new FrameError('field', '结束帧的 sha256 不合法')
    return {
      kind: 'end',
      version: FRAME_VERSION,
      job,
      total: readUint(parts[2], 'total'),
      size: readUint(parts[3], 'size'),
      wire: readUint(parts[4], 'wire'),
      sha256
    }
  }

  if (marker === MARKERS.resume) {
    if (parts.length !== 4) {
      throw new FrameError('field', `续传帧应有 3 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    const total = readUint(parts[2], 'total')
    const missingText = parts[3]
    return {
      kind: 'resume',
      version: FRAME_VERSION,
      job,
      total,
      missing: missingText === '-' ? [] : parseIndexList(missingText, total)
    }
  }

  throw new FrameError('marker', `无法识别的帧标记：${marker}`)
}

/**
 * @description 校验帧头 CRC：`parts[crcIndex]` 必须是 `parts[0..crcIndex-1]` 用空格连接后的 CRC32。
 *
 * 为什么帧头也要 CRC：链路上偶发丢一个字符时，"size 少一位"这类改动不会破坏字段数量，
 * 接收端会按错误规模合并——那是最难排查的一类故障。帧头 CRC 让它在解析阶段就失败。
 * @param parts 已按空格切分的帧字段
 * @param crcIndex 帧头 CRC 所在的下标
 */
function verifyHeaderCrc(parts: string[], crcIndex: number): void {
  const expected = parts[crcIndex]
  if (typeof expected !== 'string' || !/^[0-9a-f]{8}$/.test(expected)) {
    throw new FrameError('field', '帧头 CRC 字段不合法')
  }
  const actual = crc32Hex(parts.slice(0, crcIndex).join(' '))
  if (actual !== expected) {
    throw new FrameError(
      'crc',
      '帧头校验失败：这一行有字符丢失或被改写',
      `期望 ${expected}，实际 ${actual}`
    )
  }
}

/**
 * @description 解析帧里的无符号整数字段
 * @param text 字段文本
 * @param name 字段名（用于报错）
 * @returns 数值
 */
function readUint(text: string, name: string): number {
  if (!/^\d{1,16}$/.test(text)) throw new FrameError('field', `${name} 字段不是合法数字`)
  const value = Number(text)
  if (!Number.isSafeInteger(value)) throw new FrameError('field', `${name} 超出安全整数范围`)
  return value
}

/**
 * @description 文件名 → base64url 文本。
 *
 * 不用 `Buffer.toString('base64url')`：那要 Node 14.18+，而接收端脚本可能跑在更老的 Node 14 上。
 * 改成标准 base64 再手工换字符并去掉补位 `=`（解码端由 Buffer 自己容错缺位）。
 * @param name 文件名
 * @returns base64url 文本（不含 `=`）
 */
function encodeName(name: string): string {
  return Buffer.from(name, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * @description 还原 base64url 编码的文件名（非法内容按"未指定"处理，不阻断传输）
 * @param encoded base64url 文本
 * @returns 文件名或 null
 */
function decodeName(encoded: string): string | null {
  try {
    const text = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8'
    )
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * @description 用帧里的 CRC32 校验一片的线上字节
 * @param frame 解析后的数据帧
 * @param wire 该片的线上字节（解码后的压缩流切片）
 * @returns 校验通过的线上字节
 */
export function verifyDataFrame(frame: ParsedDataFrame, wire: BytesLike): Uint8Array {
  const bytes = toBytes(wire)
  if (bytes.length !== frame.bytes) {
    throw new FrameError(
      'len',
      `片长度与声明不一致：声明 ${frame.bytes}，实际 ${bytes.length}`,
      `seq=${frame.seq}`
    )
  }
  const actual = crc32Hex(bytes)
  if (actual !== frame.crc32) {
    throw new FrameError('crc', `片 ${frame.seq} 校验失败`, `期望 ${frame.crc32}，实际 ${actual}`)
  }
  return bytes
}

/**
 * @description 校验整文件（大小 + SHA-256）
 * @param bytes 整文件字节
 * @param expectedSha256 期望的 SHA-256
 * @param expectedSize 期望的字节数（省略则不校验大小）
 * @returns 通过校验的字节
 */
export function verifyIntegrity(
  bytes: BytesLike,
  expectedSha256: string,
  expectedSize?: number
): Uint8Array {
  const data = toBytes(bytes)
  if (expectedSize !== undefined && data.length !== expectedSize) {
    throw new FrameError('len', `整文件大小不符：期望 ${expectedSize}，实际 ${data.length}`)
  }
  const actual = sha256Hex(data)
  if (actual !== expectedSha256) {
    throw new FrameError('crc', `整文件校验失败：期望 ${expectedSha256}，实际 ${actual}`)
  }
  return data
}

// ---------------------------------------------------------------------------
// 分片规划
// ---------------------------------------------------------------------------

/**
 * @description 计算总片数（空文件算 0 片）
 * @param size 字节数
 * @param chunkBytes 每片字节数
 * @returns 总片数
 */
export function chunkCount(size: number, chunkBytes: number): number {
  if (!Number.isInteger(size) || size < 0) throw new FrameError('range', '文件大小不合法')
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new FrameError('range', `片大小不合法（1 ~ ${MAX_CHUNK_BYTES}）`)
  }
  return size === 0 ? 0 : Math.ceil(size / chunkBytes)
}

/**
 * @description 计算第 seq 片在字节流中的偏移与长度（不读取数据，便于大文件惰性发送）
 * @param size 字节数
 * @param chunkBytes 每片字节数
 * @param seq 片号
 * @returns 该片的偏移与字节数
 */
export function chunkSlice(
  size: number,
  chunkBytes: number,
  seq: number
): { offset: number; bytes: number } {
  const total = chunkCount(size, chunkBytes)
  if (!Number.isInteger(seq) || seq < 0 || seq >= total) {
    throw new FrameError('range', `片号超出范围：${seq}（共 ${total} 片）`)
  }
  const offset = seq * chunkBytes
  return { offset, bytes: Math.min(chunkBytes, size - offset) }
}

/**
 * @description 估算一帧的字符数（帧头 + 载荷）
 * @param meta 帧字段（`payloadChars` 可由 `payloadCharsFor(bytes, alphabet)` 得到）
 * @returns 估算的字符数
 */
export function estimateDataFrameChars(meta: {
  job?: string
  seq: number
  bytes: number
  payloadChars: number
}): number {
  const header =
    MARKERS.data.length +
    1 +
    String(meta.job ?? '').length +
    1 +
    String(meta.seq).length +
    1 +
    String(meta.bytes).length +
    1 +
    8 +
    1 +
    8 +
    1
  return header + meta.payloadChars
}

// ---------------------------------------------------------------------------
// 片号集合：续传与重传都靠它
// ---------------------------------------------------------------------------

/**
 * @description 把片号集合文本解析成升序去重的数组
 * @param text 形如 `3,5,12-20` 的文本（片号数组会被转成同形文本）
 * @param total 片总数（给出时校验越界）
 * @returns 升序去重的片号数组
 */
export function parseIndexList(text: string | number[], total?: number): number[] {
  const indexes = new Set<number>()
  const parts = String(text)
    .split(/[,;、\s]+/)
    .filter((part) => part.length > 0)

  for (const part of parts) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!match) throw new FrameError('range', `无法解析片号：${part}`)
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (start > end) throw new FrameError('range', `区间起点大于终点：${part}`)
    if (total !== undefined && end >= total) {
      throw new FrameError('range', `片号超出总数：${part}（共 ${total} 片）`)
    }
    if (end - start > MAX_FRAME_CHARS) throw new FrameError('range', `区间过大：${part}`)
    for (let index = start; index <= end; index++) indexes.add(index)
  }

  return [...indexes].sort((a, b) => a - b)
}

/**
 * @description 把片号数组压成紧凑区间文本
 * @param indexes 片号数组
 * @param total 片总数（给出时校验越界）
 * @returns 形如 `3,5,12-13` 的紧凑文本
 */
export function formatIndexList(indexes: readonly number[], total?: number): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b)
  const parts: string[] = []
  let start: number | null = null
  let previous: number | null = null

  for (const index of sorted) {
    if (total !== undefined && (index < 0 || index >= total)) {
      throw new FrameError('range', `片号超出总数：${index}`)
    }
    if (start === null) {
      start = index
      previous = index
      continue
    }
    // start 与 previous 同生命周期，走到这里两者都已有值
    if (index === (previous as number) + 1) {
      previous = index
      continue
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`)
    start = index
    previous = index
  }

  if (start !== null) parts.push(start === previous ? String(start) : `${start}-${previous}`)
  return parts.join(',')
}

/**
 * @description 计算缺失片号
 * @param total 片总数
 * @param done 已完成的片号
 * @returns 升序的缺失片号
 */
export function missingIndexes(total: number, done: readonly number[]): number[] {
  const finished = new Set(done)
  const missing: number[] = []
  for (let index = 0; index < total; index++) {
    if (!finished.has(index)) missing.push(index)
  }
  return missing
}

/**
 * @description 把 `from` / `only` 归一化成实际要发送的片号列表
 * @param total 片总数
 * @param options 起始片号与"只发指定片"设置
 * @returns 升序的片号数组
 */
export function resolveIndexes(
  total: number,
  options: { from?: number | null; only?: string | number[] | null } = {}
): number[] {
  if (!Number.isInteger(total) || total < 0) throw new FrameError('range', 'total 不合法')
  if (options.only !== undefined && options.only !== null && String(options.only).length > 0) {
    return parseIndexList(options.only, total)
  }
  const from = options.from === undefined || options.from === null ? 0 : Number(options.from)
  if (!Number.isInteger(from) || from < 0 || from > total) {
    throw new FrameError('range', `起始片号不合法：${String(options.from)}`)
  }
  const indexes: number[] = []
  for (let index = from; index < total; index++) indexes.push(index)
  return indexes
}

// ---------------------------------------------------------------------------
// 输入流处理：接收端逐行解析用
// ---------------------------------------------------------------------------

/** 单行硬上限（含行尾）：超过即认为链路把两行粘在一起或被截断。 */
export const MAX_LINE_CHARS = MAX_FRAME_CHARS + 4096

/**
 * @description 清理一行：去掉 bracketed-paste 标记（`ESC[200~` / `ESC[201~`）与首尾空白；
 * 某些终端/远控会把这些标记混进粘贴流，不清理会让整行无法解析
 * @param line 原始行
 * @returns 清理后的行
 */
export function sanitizeLine(line: string): string {
  let text = String(line)
  if (text.includes('\u001b')) {
    // eslint-disable-next-line no-control-regex -- 这里要处理的正是 ESC 控制字符
    text = text.replace(/\u001b\[20[01]~/g, '')
  }
  return text.replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, '')
}

/**
 * @description 行切分器：`\n`、`\r\n`、裸 `\r` 都当行尾（raw 模式下回车只产生 `\r`）
 * @returns 可增量喂入的切分器
 */
export function createLineSplitter(): {
  push(chunk: string): string[]
  flush(): string[]
} {
  let tail = ''

  /**
   * @description 把一段文本按行尾切开，返回完整行与残留尾巴
   * @param chunk 新到的文本
   * @returns 完整行
   */
  function push(chunk: string): string[] {
    tail += chunk
    const lines: string[] = []
    let start = 0
    for (let index = 0; index < tail.length; index++) {
      const char = tail[index]
      if (char !== '\n' && char !== '\r') continue
      lines.push(tail.slice(start, index))
      // \r\n 只算一个行尾
      if (char === '\r' && tail[index + 1] === '\n') index += 1
      start = index + 1
    }
    tail = tail.slice(start)
    if (tail.length > MAX_LINE_CHARS) {
      throw new FrameError('overlong', `单行超过 ${MAX_LINE_CHARS} 字符上限`)
    }
    // 空行不是帧：直接丢掉，避免调用方反复做无意义的解析
    return lines.filter((line) => line.length > 0)
  }

  /**
   * @description 收尾：吐出未闭合的尾巴，行宽异常时明确报错
   * @returns 最后一行（若有）
   */
  function flush(): string[] {
    const rest = tail
    tail = ''
    if (rest.length === 0) return []
    if (rest.length > MAX_LINE_CHARS) {
      throw new FrameError('overlong', `单行超过 ${MAX_LINE_CHARS} 字符上限`)
    }
    return [rest]
  }

  return { push, flush }
}
