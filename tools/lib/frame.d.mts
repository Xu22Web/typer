// `frame.mjs` 的类型声明。
//
// 为什么手写声明而不是把 frame.mjs 改写为 TypeScript：tools/ 下的脚本必须能直接 `node tools/xxx.mjs` 运行（目标机不一定有构建环境），实现只能是普通 JS；主进程用同名 `.d.mts` 拿到完整类型检查。

/** 载荷编码：hex（最抗终端干扰，默认）/ base64（紧凑）/ 转义文本（按字符切分）。 */
export type FrameEncoding = 'hex' | 'b64' | 'txt'

/** 可当字节序列使用的输入。 */
export type BytesLike = Uint8Array | string | ArrayBuffer | ArrayBufferView

/** 线格式版本；字段含义变化时必须递增，接收端据此拒绝不认识的帧。 */
export declare const FRAME_VERSION: 1

/** 帧标记，`@TYPER1/` 后缀区分帧类型。 */
export declare const MARKERS: {
  readonly begin: '@TYPER1/B'
  readonly data: '@TYPER1/D'
  readonly end: '@TYPER1/E'
  readonly resume: '@TYPER1/R'
}

/** 全部受支持的载荷编码。 */
export declare const ENCODINGS: readonly FrameEncoding[]

/** 默认每片字节数。 */
export declare const DEFAULT_CHUNK_BYTES: number

/** 默认单帧字符上限。 */
export declare const DEFAULT_MAX_FRAME_CHARS: number

/** 硬上限：单片字节数（更大的片在终端 / 剪贴板上几乎必然失败）。 */
export declare const MAX_CHUNK_BYTES: number

/** 硬上限：单帧字符数（接收端要先把整行读进内存）。 */
export declare const MAX_FRAME_CHARS: number

/** 行长上限：超过即认为行宽异常，不做无限缓冲。 */
export declare const MAX_LINE_CHARS: number

/** 协议层错误码。 */
export type FrameErrorCode =
  'marker' | 'field' | 'crc' | 'len' | 'enc' | 'overlong' | 'job' | 'range' | 'empty'

/** 协议层错误：带稳定的 `code`，便于上层分类并给出可操作建议。 */
export declare class FrameError extends Error {
  readonly name: 'FrameError'
  readonly code: FrameErrorCode
  readonly detail?: string
  /**
   * @description 构造协议层错误
   * @param code 机器可读错误码
   * @param message 面向用户的中文说明
   * @param detail 附加细节（不包含数据原文）
   */
  constructor(code: FrameErrorCode, message: string, detail?: string)
}

/** 错误码 → 可操作建议。 */
export declare const ERROR_HINTS: Readonly<Record<string, string>>

/**
 * @description 把各种二进制输入统一成字节序列
 * @param input 字节序列
 * @returns 等价的 Uint8Array
 */
export declare function toBytes(input: BytesLike): Uint8Array

/**
 * @description 标准 CRC32（IEEE 802.3，与 `zlib.crc32` 同值）
 * @param input 字节序列
 * @returns 无符号 32 位整数
 */
export declare function crc32(input: BytesLike): number

/**
 * @description 计算 CRC32 文本
 * @param input 字节序列
 * @returns 8 位小写 hex
 */
export declare function crc32Hex(input: BytesLike): string

/**
 * @description 计算 SHA-256 文本
 * @param input 字节序列
 * @returns 64 位小写 hex
 */
export declare function sha256Hex(input: BytesLike): string

/**
 * @description 计算片级强校验值：SHA-256 的前 8 字节
 * @param input 字节序列
 * @returns 16 位小写 hex
 */
export declare function sha16Hex(input: BytesLike): string

/**
 * @description 生成随机 job id
 * @param random 随机源（可注入以便测试得到确定值）
 * @returns 8 位小写 hex
 */
export declare function randomJobId(random?: () => number): string

/**
 * @description 判断取值是否为受支持的载荷编码
 * @param value 待判断的值
 * @returns 是否为 FrameEncoding
 */
export declare function isEncoding(value: unknown): value is FrameEncoding

/**
 * @description 字节 → 可安全输入的单行载荷字符串
 * @param bytes 原始字节
 * @param enc 目标编码（txt 请用 escapeText）
 * @returns 编码后的载荷
 */
export declare function encodeBytes(bytes: BytesLike, enc: Exclude<FrameEncoding, 'txt'>): string

/**
 * @description 单行载荷字符串 → 字节，并做严格校验
 * @param payload 单行载荷
 * @param enc 载荷编码
 * @returns 解码后的字节
 */
export declare function decodeBytes(payload: string, enc: Exclude<FrameEncoding, 'txt'>): Uint8Array

/**
 * @description 文本 → 单行转义载荷（按字符边界切分）
 * @param text 原文
 * @returns 单行转义载荷
 */
export declare function escapeText(text: string): string

/**
 * @description 转义载荷还原成原文（未知转义序列原样保留）
 * @param payload 单行转义载荷
 * @returns 还原后的文本
 */
export declare function unescapeText(payload: string): string

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

/** 结束帧字段。 */
export interface EndFrameMeta {
  job: string
  total: number
  size: number
  sha256: string
}

/** 续传令牌字段。 */
export interface ResumeTokenMeta {
  job: string
  total: number
  missing: number[] | string
}

/**
 * @description 构造开始帧
 * @param meta 开始帧字段
 * @returns 单行帧文本
 */
export declare function buildBeginFrame(meta: BeginFrameMeta): string

/**
 * @description 构造数据帧
 * @param meta 数据帧字段
 * @returns 单行帧文本
 */
export declare function buildDataFrame(meta: DataFrameMeta): string

/**
 * @description 构造结束帧
 * @param meta 结束帧字段
 * @returns 单行帧文本
 */
export declare function buildEndFrame(meta: EndFrameMeta): string

/**
 * @description 构造续传令牌
 * @param meta 续传字段
 * @returns 单行令牌文本
 */
export declare function buildResumeToken(meta: ResumeTokenMeta): string

/**
 * @description 判断该行是否看起来是 Typer 帧
 * @param line 待判断的行
 * @returns 是否为帧行
 */
export declare function isFrameLine(line: string): boolean

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
 * @description 严格解析一行帧，字段数量或取值不符时抛 FrameError
 * @param line 单行帧文本
 * @returns 解析结果
 */
export declare function parseFrame(line: string): ParsedFrame

/**
 * @description 校验数据帧载荷与其声明的长度 / 校验和是否一致
 * @param frame 已解析的数据帧
 * @param bytes 载荷解码后的字节
 * @returns 通过校验的字节
 */
export declare function verifyDataFrame(frame: ParsedDataFrame, bytes: BytesLike): Uint8Array

/**
 * @description 校验整文件（大小 + SHA-256）
 * @param bytes 整文件字节
 * @param expectedSha256 期望的 SHA-256
 * @param expectedSize 期望的字节数（省略则不校验大小）
 * @returns 通过校验的字节
 */
export declare function verifyIntegrity(
  bytes: BytesLike,
  expectedSha256: string,
  expectedSize?: number
): Uint8Array

/**
 * @description 计算总片数（空文件算 0 片）
 * @param size 文件字节数
 * @param chunkBytes 每片字节数
 * @returns 总片数
 */
export declare function chunkCount(size: number, chunkBytes: number): number

/**
 * @description 计算第 seq 片的偏移与长度
 * @param size 文件字节数
 * @param chunkBytes 每片字节数
 * @param seq 片号
 * @returns 该片的偏移与字节数
 */
export declare function chunkSlice(
  size: number,
  chunkBytes: number,
  seq: number
): { offset: number; bytes: number }

/**
 * @description 文本按字符边界切分（避免把多字节字符劈成两片）
 * @param text 原文
 * @param maxBytes 每片允许的最大字节数
 * @param byteLength 计算某段文本在目标编码下的字节数
 * @returns 分片列表
 */
export declare function planTextChunks(
  text: string,
  maxBytes: number,
  byteLength?: (chunk: string) => number
): Array<{ text: string; bytes: number; chars: number }>

/**
 * @description 估算一帧的字符数（用于校验 maxFrameChars）
 * @param meta 帧字段（可给出 payloadChars 以覆盖转义后长度）
 * @returns 估算的字符数
 */
export declare function estimateDataFrameChars(meta: {
  job?: string
  seq: number
  total: number
  bytes: number
  enc: FrameEncoding
  payloadChars?: number
}): number

/**
 * @description 把片号集合文本解析成升序去重的数组
 * @param text 形如 `3,5,12-20` 的文本
 * @param total 片总数（给出时校验越界）
 * @returns 升序去重的片号数组
 */
export declare function parseIndexList(text: string, total?: number): number[]

/**
 * @description 把片号数组压成紧凑区间文本
 * @param indexes 片号数组
 * @param total 片总数（给出时校验越界）
 * @returns 形如 `3,5,12-13` 的紧凑文本
 */
export declare function formatIndexList(indexes: readonly number[], total?: number): string

/**
 * @description 计算缺失片号
 * @param total 片总数
 * @param done 已完成的片号
 * @returns 升序的缺失片号
 */
export declare function missingIndexes(total: number, done: readonly number[]): number[]

/**
 * @description 把 from / only 归一化成实际要发送的片号列表
 * @param total 片总数
 * @param options 起始片号与"只发指定片"设置
 * @returns 升序的片号数组
 */
export declare function resolveIndexes(
  total: number,
  options?: { from?: number | null; only?: string | number[] | null }
): number[]

/**
 * @description 清理一行：去掉 bracketed-paste 标记与首尾空白
 * @param line 原始行
 * @returns 清理后的行
 */
export declare function sanitizeLine(line: string): string

/**
 * @description 行切分器：`\n`、`\r\n`、裸 `\r` 都当行尾
 * @returns 带 push / flush 的切分器
 */
export declare function createLineSplitter(): {
  push: (chunk: string | Uint8Array) => string[]
  flush: () => string[]
}
