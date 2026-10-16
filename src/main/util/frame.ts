// Typer 文件传输「线格式」v1 的唯一实现。
// 主进程（生成帧、算续传计划）与接收端脚本（tools/typer-recv.ts）共用同一份实现，收发两端不可能出现实现漂移。
// 只用 node: 内置模块、零第三方依赖，Node >= 16 可运行。
// 帧一定是单行、纯 ASCII、无空白：目标是终端或串口，回车即提交，任何控制字符都会把数据搅乱，所以二进制必须先编码。

import { createHash } from 'node:crypto'

/** 载荷编码：hex（最抗终端干扰，默认）/ base64（紧凑）/ 转义文本（按字符切分）。 */
export type FrameEncoding = 'hex' | 'b64' | 'txt'

/** 可当字节序列使用的输入。 */
export type BytesLike = Uint8Array | string | ArrayBuffer | ArrayBufferView

/** 线格式版本。字段含义变化时必须递增，接收端据此拒绝不认识的帧。 */
export const FRAME_VERSION = 1

/** 帧标记（`@TYPER1/` 后缀区分帧类型，见 tools/README.md）。 */
export const MARKERS = {
  begin: '@TYPER1/B',
  data: '@TYPER1/D',
  end: '@TYPER1/E',
  resume: '@TYPER1/R'
} as const

/** 全部受支持的载荷编码。 */
export const ENCODINGS: readonly FrameEncoding[] = ['hex', 'b64', 'txt']
export const DEFAULT_CHUNK_BYTES = 1024
export const DEFAULT_MAX_FRAME_CHARS = 4096
/** 硬上限：单片字节数（更大的片在终端/剪贴板上几乎必然失败）。 */
export const MAX_CHUNK_BYTES = 1024 * 1024
/** 硬上限：单帧字符数（接收端要先把整行读进内存）。 */
export const MAX_FRAME_CHARS = 1024 * 1024

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
   * @param code 机器可读错误码（marker / field / crc / len / enc / overlong / job / range / empty）
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
  enc: '载荷编码不合法（含非法字符或长度不对），该片需重传',
  overlong: '该帧超出长度上限（终端/剪贴板截断），请用更小的片或「窄终端」预设',
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
// 校验与编码：CRC32 / SHA-256
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
 * Node 20.15+，而接收端脚本要能在 Node 16 上跑
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
 * @description 片级强校验值：SHA-256 的前 8 字节；与 CRC32 组合，兼顾"查错"与"防碰巧"
 * @param input 字节序列
 * @returns 16 位小写 hex
 */
export function sha16Hex(input: BytesLike): string {
  return createHash('sha256').update(toBytes(input)).digest('hex').slice(0, 16)
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

// ---------------------------------------------------------------------------
// 载荷编码
// ---------------------------------------------------------------------------

/**
 * @description 判断取值是否为受支持的载荷编码
 * @param value 待判断的值
 * @returns 是否为 FrameEncoding
 */
export function isEncoding(value: unknown): value is FrameEncoding {
  return typeof value === 'string' && (ENCODINGS as readonly string[]).includes(value)
}

/**
 * @description 字节 → 可安全输入的单行载荷字符串（hex 大写；b64 标准 base64）
 * @param bytes 原始字节
 * @param enc 目标编码（txt 请改用 escapeText）
 * @returns 编码后的载荷
 */
export function encodeBytes(bytes: BytesLike, enc: FrameEncoding): string {
  const input = toBytes(bytes)
  if (enc === 'hex') {
    let out = ''
    for (let index = 0; index < input.length; index++) {
      out += input[index].toString(16).padStart(2, '0').toUpperCase()
    }
    return out
  }
  if (enc === 'b64') return Buffer.from(input).toString('base64')
  if (enc === 'txt') throw new FrameError('enc', 'txt 编码请使用 escapeText（需要按字符切分）')
  throw new FrameError('enc', `不支持的编码 ${String(enc)}`)
}

/**
 * @description 载荷字符串 → 字节，并做严格校验；必须严格是因为 `Buffer.from` 对非法输入是
 * "尽力而为"，不校验会把"看起来像但其实是噪声"的内容解出错误结果
 * @param payload 单行载荷
 * @param enc 载荷编码
 * @returns 解码后的字节
 */
export function decodeBytes(payload: string, enc: FrameEncoding): Uint8Array {
  if (enc === 'hex') {
    if (payload.length % 2 !== 0) {
      throw new FrameError('enc', 'hex 载荷长度为奇数', `长度 ${payload.length}`)
    }
    if (!/^[0-9a-fA-F]*$/.test(payload)) {
      throw new FrameError('enc', 'hex 载荷含非十六进制字符')
    }
    const out = new Uint8Array(payload.length / 2)
    for (let index = 0; index < out.length; index++) {
      out[index] = parseInt(payload.slice(index * 2, index * 2 + 2), 16)
    }
    return out
  }
  if (enc === 'b64') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
      throw new FrameError('enc', 'base64 载荷格式不合法')
    }
    const buffer = Buffer.from(payload, 'base64')
    // 往返比对：`Buffer.from` 对非法输入是"尽力而为"，不比对会把坏数据当成功
    if (buffer.toString('base64') !== payload) {
      throw new FrameError('enc', 'base64 载荷无法原样还原')
    }
    return new Uint8Array(buffer)
  }
  if (enc === 'txt') {
    throw new FrameError('enc', 'txt 载荷请使用 unescapeText（需要按字符切分）')
  }
  throw new FrameError('enc', `不支持的编码 ${String(enc)}`)
}

const TEXT_ESCAPES: Record<string, string> = { '\\': '\\\\', '\r': '\\r', '\n': '\\n', '\t': '\\t' }

/**
 * @description 文本 → 单行转义载荷（`txt` 编码），按字符边界切分，CJK / emoji 原样保留；
 * 必须转义的是反斜杠与 CR / LF / TAB（会破坏"单行"约束）、空格（会把帧字段切错）
 * 以及会被解析端 `trim()` 吃掉的其它空白字符
 * @param text 原文
 * @returns 单行转义载荷
 */
export function escapeText(text: string): string {
  let out = ''
  for (const char of String(text)) {
    const simple = TEXT_ESCAPES[char]
    if (simple) {
      out += simple
      continue
    }
    // 逐个码点迭代，codePointAt 必然有值
    const code = char.codePointAt(0) as number
    if (code <= 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`
      continue
    }
    // 非 ASCII 的空白（如 U+00A0、U+3000、U+FEFF）用 \uXXXX，避免被 trim/分词吞掉
    if (/[\s\uFEFF]/.test(char)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += char
  }
  return out
}

/**
 * @description 转义载荷还原成原文；未知转义序列原样保留（宽容处理），非法 `\xNN` / `\uXXXX` 会报错
 * @param payload 单行转义载荷
 * @returns 还原后的文本
 */
export function unescapeText(payload: string): string {
  let out = ''
  for (let index = 0; index < payload.length; index++) {
    const char = payload[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = payload[index + 1]
    if (next === undefined) {
      throw new FrameError('enc', '转义载荷以孤立的反斜杠结尾')
    }
    if (next === '\\') {
      out += '\\'
      index += 1
      continue
    }
    if (next === 'r') {
      out += '\r'
      index += 1
      continue
    }
    if (next === 'n') {
      out += '\n'
      index += 1
      continue
    }
    if (next === 't') {
      out += '\t'
      index += 1
      continue
    }
    if (next === 'x') {
      const hex = payload.slice(index + 2, index + 4)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new FrameError('enc', '转义载荷含非法 \\x 序列')
      }
      out += String.fromCharCode(parseInt(hex, 16))
      index += 3
      continue
    }
    if (next === 'u') {
      const hex = payload.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new FrameError('enc', '转义载荷含非法 \\u 序列')
      }
      out += String.fromCharCode(parseInt(hex, 16))
      index += 5
      continue
    }
    // 未知转义：保留原文（例如目标文本里确实写了 \d）
    out += char
  }
  return out
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
  total: number
  size: number
  enc: FrameEncoding
  chunk: number
  /** 原名（可省略；接收端也可用 `-o` 覆盖） */
  name?: string | null
  /** 整文件 SHA-256（64 位小写 hex） */
  sha256: string
}

/**
 * @description 构造开始帧：接收端据此知道任务规模与期望哈希，从而能边收边判并提前建工作目录
 * @param meta 开始帧字段
 * @returns 单行帧文本
 */
export function buildBeginFrame(meta: BeginFrameMeta): string {
  assertJobPart(meta.job)
  assertUint(meta.total, 'total', 0xffffffff)
  assertUint(meta.size, 'size', Number.MAX_SAFE_INTEGER)
  assertUint(meta.chunk, 'chunk', MAX_CHUNK_BYTES)
  if (!isEncoding(meta.enc)) throw new FrameError('enc', `不支持的编码 ${String(meta.enc)}`)
  if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
    throw new FrameError('field', '整文件 sha256 不合法（应为 64 位小写 hex）')
  }
  const name = meta.name ? Buffer.from(String(meta.name), 'utf8').toString('base64url') : '-'
  return [
    MARKERS.begin,
    meta.job,
    String(meta.total),
    String(meta.size),
    meta.enc,
    String(meta.chunk),
    name,
    meta.sha256
  ].join(' ')
}

/** 数据帧字段。 */
export interface DataFrameMeta {
  job: string
  seq: number
  total: number
  /** 本片原始字节数（txt 编码为目标编码下的字节数） */
  bytes: number
  crc32: string
  sha16: string
  enc: FrameEncoding
  /** 已编码的单行载荷 */
  payload: string
}

/**
 * @description 构造数据帧
 * @param meta 数据帧字段（payload 必须是已经编码好的单行字符串）
 * @returns 单行帧文本
 */
export function buildDataFrame(meta: DataFrameMeta): string {
  assertJobPart(meta.job)
  assertUint(meta.seq, 'seq', 0xffffffff)
  assertUint(meta.total, 'total', 0xffffffff)
  assertUint(meta.bytes, 'bytes', MAX_CHUNK_BYTES)
  if (!isEncoding(meta.enc)) throw new FrameError('enc', `不支持的编码 ${String(meta.enc)}`)
  if (typeof meta.payload !== 'string' || meta.payload.length === 0 || /\s/.test(meta.payload)) {
    throw new FrameError('field', '载荷不能为空或包含空白字符')
  }
  return [
    MARKERS.data,
    meta.job,
    String(meta.seq),
    String(meta.total),
    String(meta.bytes),
    meta.crc32,
    meta.sha16,
    meta.enc,
    meta.payload
  ].join(' ')
}

/** 结束帧字段。 */
export interface EndFrameMeta {
  job: string
  total: number
  size: number
  sha256: string
}

/**
 * @description 构造结束帧：携带整文件哈希与大小，接收端只有在全部片都通过后才会用它做最终校验
 * @param meta 结束帧字段
 * @returns 单行帧文本
 */
export function buildEndFrame(meta: EndFrameMeta): string {
  assertJobPart(meta.job)
  assertUint(meta.total, 'total', 0xffffffff)
  assertUint(meta.size, 'size', Number.MAX_SAFE_INTEGER)
  if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
    throw new FrameError('field', '整文件 sha256 不合法（应为 64 位小写 hex）')
  }
  return [MARKERS.end, meta.job, String(meta.total), String(meta.size), meta.sha256].join(' ')
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
  enc: FrameEncoding
  chunk: number
  name: string | null
  sha256: string
}

/** 解析后的数据帧。 */
export interface ParsedDataFrame {
  kind: 'data'
  version: number
  job: string
  seq: number
  total: number
  bytes: number
  crc32: string
  sha16: string
  enc: FrameEncoding
  payload: string
}

/** 解析后的结束帧。 */
export interface ParsedEndFrame {
  kind: 'end'
  version: number
  job: string
  total: number
  size: number
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
    if (parts.length !== 8) {
      throw new FrameError('field', `开始帧应有 7 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    const enc = parts[4]
    if (!isEncoding(enc)) throw new FrameError('enc', `不支持的编码 ${String(enc)}`)
    const sha256 = parts[7]
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new FrameError('field', '开始帧的 sha256 不合法')
    return {
      kind: 'begin',
      version: FRAME_VERSION,
      job,
      total: readUint(parts[2], 'total'),
      size: readUint(parts[3], 'size'),
      enc,
      chunk: readUint(parts[5], 'chunk'),
      name: parts[6] === '-' ? null : decodeName(parts[6]),
      sha256
    }
  }

  if (marker === MARKERS.data) {
    if (parts.length !== 9) {
      throw new FrameError('field', `数据帧应有 8 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    const enc = parts[7]
    if (!isEncoding(enc)) throw new FrameError('enc', `不支持的编码 ${String(enc)}`)
    const crc = parts[5]
    if (!/^[0-9a-f]{8}$/.test(crc)) throw new FrameError('field', '数据帧的 crc32 不合法')
    const sha16 = parts[6]
    if (!/^[0-9a-f]{16}$/.test(sha16)) throw new FrameError('field', '数据帧的 sha16 不合法')
    return {
      kind: 'data',
      version: FRAME_VERSION,
      job,
      seq: readUint(parts[2], 'seq'),
      total: readUint(parts[3], 'total'),
      bytes: readUint(parts[4], 'bytes'),
      crc32: crc,
      sha16,
      enc,
      payload: parts[8]
    }
  }

  if (marker === MARKERS.end) {
    if (parts.length !== 5) {
      throw new FrameError('field', `结束帧应有 4 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    const sha256 = parts[4]
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new FrameError('field', '结束帧的 sha256 不合法')
    return {
      kind: 'end',
      version: FRAME_VERSION,
      job,
      total: readUint(parts[2], 'total'),
      size: readUint(parts[3], 'size'),
      sha256
    }
  }

  if (marker === MARKERS.resume) {
    if (parts.length !== 4) {
      throw new FrameError('field', `续传令应有 3 个字段，实际 ${parts.length - 1}`)
    }
    const job = parts[1]
    assertJobPart(job)
    const total = readUint(parts[2], 'total')
    return {
      kind: 'resume',
      version: FRAME_VERSION,
      job,
      total,
      missing: parts[3] === '-' ? [] : parseIndexList(parts[3], total)
    }
  }

  throw new FrameError('marker', '无法识别的帧标记', marker.slice(0, 16))
}

/**
 * @description 把十进制字段解析为安全整数
 * @param text 字段原文
 * @param name 字段名（用于报错）
 * @returns 解析出的整数
 */
function readUint(text: string, name: string): number {
  if (!/^\d{1,16}$/.test(text)) throw new FrameError('field', `${name} 字段不是十进制整数`)
  const value = Number(text)
  if (!Number.isSafeInteger(value)) throw new FrameError('range', `${name} 超出安全范围`)
  return value
}

/**
 * @description 还原开始帧里 base64url 编码的文件名
 * @param encoded 编码后的文件名
 * @returns 还原后的文件名（无名字时为 null）
 */
function decodeName(encoded: string): string | null {
  try {
    const name = Buffer.from(encoded, 'base64url').toString('utf8')
    return name.length > 0 ? name : null
  } catch {
    throw new FrameError('field', '文件名（base64url）无法解码')
  }
}

/**
 * @description 校验数据帧的载荷与其声明的长度 / crc32 / sha16 是否一致
 * @param frame 已解析的数据帧
 * @param bytes 载荷解码后的字节
 * @returns 通过校验的字节
 */
export function verifyDataFrame(frame: ParsedDataFrame, bytes: BytesLike): Uint8Array {
  const data = toBytes(bytes)
  if (data.length !== frame.bytes) {
    throw new FrameError('len', `片长度不符：声明 ${frame.bytes}，实际 ${data.length}`)
  }
  const actualCrc = crc32Hex(data)
  if (actualCrc !== frame.crc32) {
    throw new FrameError('crc', `片校验失败：声明 ${frame.crc32}，实际 ${actualCrc}`)
  }
  const actualSha = sha16Hex(data)
  if (actualSha !== frame.sha16) {
    throw new FrameError('crc', `片强校验失败：声明 ${frame.sha16}，实际 ${actualSha}`)
  }
  return data
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
 * @param size 文件字节数
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
 * @description 计算第 seq 片在文件中的偏移与长度（不读取数据，便于大文件惰性发送）
 * @param size 文件字节数
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
 * @description 文本按字符边界切分（`txt` 编码用，避免把一个多字节字符劈成两片）
 * @param text 原文
 * @param maxBytes 每片允许的最大字节数
 * @param byteLength 计算某段文本在目标编码下的字节数
 * @returns 分片列表（含每片文本、字节数与字符数）
 */
export function planTextChunks(
  text: string,
  maxBytes: number,
  byteLength: (chunk: string) => number = (chunk) => Buffer.byteLength(chunk, 'utf8')
): Array<{ text: string; bytes: number; chars: number }> {
  const chunks: Array<{ text: string; bytes: number; chars: number }> = []
  let current = ''

  for (const char of String(text)) {
    const candidate = current + char
    if (current.length > 0 && byteLength(candidate) > maxBytes) {
      chunks.push({ text: current, bytes: byteLength(current), chars: current.length })
      current = char
      continue
    }
    if (current.length === 0 && byteLength(char) > maxBytes) {
      throw new FrameError('overlong', '单个字符就超过片大小上限，请增大片大小')
    }
    current = candidate
  }

  if (current.length > 0) {
    chunks.push({ text: current, bytes: byteLength(current), chars: current.length })
  }
  return chunks
}

/**
 * @description 估算一帧的字符数（用于校验 `maxFrameChars`）
 * @param meta 帧字段（可给出 payloadChars，因为 txt 编码转义后的长度无法只靠字节数推出）
 * @returns 估算的字符数
 */
export function estimateDataFrameChars(meta: {
  job?: string
  seq: number
  total: number
  bytes: number
  enc: FrameEncoding
  payloadChars?: number
}): number {
  const header =
    MARKERS.data.length +
    1 +
    String(meta.job ?? '').length +
    1 +
    String(meta.seq).length +
    1 +
    String(meta.total).length +
    1 +
    String(meta.bytes).length +
    1 +
    8 +
    1 +
    16 +
    1 +
    String(meta.enc).length +
    1
  const payload =
    meta.payloadChars !== undefined
      ? meta.payloadChars
      : meta.enc === 'hex'
        ? meta.bytes * 2
        : meta.enc === 'b64'
          ? Math.ceil(meta.bytes / 3) * 4
          : meta.bytes
  return header + payload
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
// 行切分：把 stdin 的字节流切成"帧行"
// ---------------------------------------------------------------------------

/** 行长上限（字符）。超过即认为行宽异常，不做无限缓冲。 */
export const MAX_LINE_CHARS = MAX_FRAME_CHARS + 4096

/**
 * @description 清理一行：去掉 bracketed-paste 标记（`ESC[200~` / `ESC[201~`）与首尾空白；
 * 必须清理是因为把帧粘到启用了 bracketed paste 的 shell 提示符下，行首会多出 `ESC[200~`
 * @param line 原始行
 * @returns 清理后的行
 */
export function sanitizeLine(line: string): string {
  return (
    String(line)
      // eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符：清理 bracketed-paste 标记
      .replace(/\u001b\[20[01]~/g, '')
      // eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符：清掉 C0/DEL 噪声（含回显里的退格、响铃）
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
  )
}

/**
 * @description 行切分器：`\n`、`\r\n`、裸 `\r` 都当行尾（raw 模式下回车只产生 `\r`）
 * @returns 带 push / flush 的切分器
 */
export function createLineSplitter(): {
  push: (chunk: string | Uint8Array) => string[]
  flush: () => string[]
} {
  let buffer = ''
  let overflow = false
  const decoder = new TextDecoder('utf-8')

  /**
   * @description 把一段文本按行尾切开，返回完整行与残留尾巴
   * @param text 待切分的文本
   * @returns 完整行与未闭合的尾巴
   */
  const drain = (text: string): { lines: string[]; rest: string } => {
    const lines: string[] = []
    let start = 0
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (char !== '\n' && char !== '\r') continue
      // `\r\n` 只算一个行尾
      const end = index
      if (char === '\r' && text[index + 1] === '\n') index += 1
      lines.push(text.slice(start, end))
      start = index + 1
    }
    return { lines, rest: text.slice(start) }
  }

  return {
    /**
     * @description 把一段输入喂进切分器，返回这次切出的完整行
     * @param chunk 文本或字节
     * @returns 完整行
     */
    push(chunk: string | Uint8Array): string[] {
      const text =
        typeof chunk === 'string' ? chunk : decoder.decode(toBytes(chunk), { stream: true })
      const { lines, rest } = drain(buffer + text)
      buffer = rest
      if (buffer.length > MAX_LINE_CHARS) {
        // 行宽异常：只保留尾巴（真正需要的帧头在下一处行尾之后），并标记过载
        buffer = buffer.slice(-MAX_LINE_CHARS)
        overflow = true
      }
      return lines
    },
    /**
     * @description 收尾：吐出未闭合的尾巴，行宽异常时明确报错
     * @returns 剩余行
     */
    flush(): string[] {
      const lines: string[] = []
      if (buffer.length > 0) {
        lines.push(buffer)
        buffer = ''
      }
      if (overflow) {
        overflow = false
        throw new FrameError('overlong', `输入中存在超长行（> ${MAX_LINE_CHARS} 字符）`)
      }
      return lines
    }
  }
}
