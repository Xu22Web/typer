// `frame.mjs` 的类型声明。
//
// 为什么手写声明而不是把 frame.mjs 改写为 TypeScript：
//   - tools/ 下的脚本必须能直接 `node tools/xxx.mjs` 运行（目标机不一定有构建环境），
//     所以实现必须是普通 JS；主进程用同名 `.d.mts` 拿到完整类型检查。
//   - 声明是唯一需要与实现同步的东西，且两者相邻，改动时一眼可见。

/** 载荷编码：hex（最抗终端干扰，默认）/ base64（紧凑）/ 转义文本（按字符切分）。 */
export type FrameEncoding = 'hex' | 'b64' | 'txt'

/** 可当字节序列使用的输入。 */
export type BytesLike = Uint8Array | string | ArrayBuffer | ArrayBufferView

export declare const FRAME_VERSION: 1
export declare const MARKERS: {
  readonly begin: '@TYPER1/B'
  readonly data: '@TYPER1/D'
  readonly end: '@TYPER1/E'
  readonly resume: '@TYPER1/R'
}
export declare const ENCODINGS: readonly FrameEncoding[]
export declare const DEFAULT_CHUNK_BYTES: number
export declare const DEFAULT_MAX_FRAME_CHARS: number
export declare const MAX_CHUNK_BYTES: number
export declare const MAX_FRAME_CHARS: number
export declare const MAX_LINE_CHARS: number

/** 协议层错误码。 */
export type FrameErrorCode =
  'marker' | 'field' | 'crc' | 'len' | 'enc' | 'overlong' | 'job' | 'range' | 'empty'

export declare class FrameError extends Error {
  readonly name: 'FrameError'
  readonly code: FrameErrorCode
  readonly detail?: string
  constructor(code: FrameErrorCode, message: string, detail?: string)
}

/** 错误码 → 可操作建议。 */
export declare const ERROR_HINTS: Readonly<Record<string, string>>

export declare function toBytes(input: BytesLike): Uint8Array

export declare function crc32(input: BytesLike): number
export declare function crc32Hex(input: BytesLike): string
export declare function sha256Hex(input: BytesLike): string
export declare function sha16Hex(input: BytesLike): string
export declare function randomJobId(random?: () => number): string

export declare function isEncoding(value: unknown): value is FrameEncoding
export declare function encodeBytes(bytes: BytesLike, enc: Exclude<FrameEncoding, 'txt'>): string
export declare function decodeBytes(payload: string, enc: Exclude<FrameEncoding, 'txt'>): Uint8Array
export declare function escapeText(text: string): string
export declare function unescapeText(payload: string): string

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

export interface EndFrameMeta {
  job: string
  total: number
  size: number
  sha256: string
}

export interface ResumeTokenMeta {
  job: string
  total: number
  missing: number[] | string
}

export declare function buildBeginFrame(meta: BeginFrameMeta): string
export declare function buildDataFrame(meta: DataFrameMeta): string
export declare function buildEndFrame(meta: EndFrameMeta): string
export declare function buildResumeToken(meta: ResumeTokenMeta): string
export declare function isFrameLine(line: string): boolean

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

export interface ParsedEndFrame {
  kind: 'end'
  version: number
  job: string
  total: number
  size: number
  sha256: string
}

export interface ParsedResumeFrame {
  kind: 'resume'
  version: number
  job: string
  total: number
  missing: number[]
}

export type ParsedFrame = ParsedBeginFrame | ParsedDataFrame | ParsedEndFrame | ParsedResumeFrame

export declare function parseFrame(line: string): ParsedFrame
export declare function verifyDataFrame(frame: ParsedDataFrame, bytes: BytesLike): Uint8Array
export declare function verifyIntegrity(
  bytes: BytesLike,
  expectedSha256: string,
  expectedSize?: number
): Uint8Array

export declare function chunkCount(size: number, chunkBytes: number): number
export declare function chunkSlice(
  size: number,
  chunkBytes: number,
  seq: number
): { offset: number; bytes: number }
export declare function planTextChunks(
  text: string,
  maxBytes: number,
  byteLength?: (chunk: string) => number
): Array<{ text: string; bytes: number; chars: number }>
export declare function estimateDataFrameChars(meta: {
  job?: string
  seq: number
  total: number
  bytes: number
  enc: FrameEncoding
  payloadChars?: number
}): number

export declare function parseIndexList(text: string, total?: number): number[]
export declare function formatIndexList(indexes: readonly number[], total?: number): string
export declare function missingIndexes(total: number, done: readonly number[]): number[]
export declare function resolveIndexes(
  total: number,
  options?: { from?: number | null; only?: string | number[] | null }
): number[]

export declare function sanitizeLine(line: string): string
export declare function createLineSplitter(): {
  push: (chunk: string | Uint8Array) => string[]
  flush: () => string[]
}
