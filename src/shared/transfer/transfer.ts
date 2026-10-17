/**
 * 文件传输的**纯**类型与常量（主进程、preload、渲染进程共用）。
 * 刻意不引用任何 `node:` 模块，因为渲染进程要据此渲染选项；线格式（编解码 / 校验）的唯一实现在 `src/main/util/frame.ts`。
 */

/** 载荷编码（与线格式的 `enc` 字段一致）。 */
export type TransferEncoding = 'hex' | 'b64' | 'txt' | 'gzb64'

export interface TransferEncodingOption {
  value: TransferEncoding
  label: string
  description: string
  /** 相对原始字节的体积倍数（用于界面提示与耗时预估） */
  overhead: number
  /** 是否只适用于 UTF-8 文本文件 */
  textOnly?: boolean
  /** 接收端需要同版本脚本才能解开（新增编码用） */
  requiresNewReceiver?: boolean
}

export const TRANSFER_ENCODING_OPTIONS: readonly TransferEncodingOption[] = [
  {
    value: 'gzb64',
    label: '压缩（推荐）',
    description:
      '先逐片压缩再 Base64：文本、代码、JSON 通常只有十六进制约三分之一的字符；已压缩的包也略优于 Base64。接收端需与 Typer 同版本',
    overhead: 1 / 3,
    requiresNewReceiver: true
  },
  {
    value: 'b64',
    label: 'Base64',
    description: '体积约为十六进制的一半，含大小写与 + / =；任何文件都能逐字节还原',
    overhead: 4 / 3
  },
  {
    value: 'hex',
    label: '十六进制',
    description: '只有 0-9 A-F，最抗终端与输入法干扰，任何版本的接收端都能解；字符数最多',
    overhead: 2
  },
  {
    value: 'txt',
    label: '文本（UTF-8）',
    description: '可读性最好；仅适用于合法 UTF-8 文本，空格与换行会转义成 \\s / \\n',
    overhead: 1,
    textOnly: true
  }
]

export const TRANSFER_ENCODINGS: readonly TransferEncoding[] = TRANSFER_ENCODING_OPTIONS.map(
  (option) => option.value
)

export interface ChunkPreset {
  id: string
  label: string
  chunkBytes: number
  maxFrameChars: number
  description: string
}

/**
 * 片大小预设。
 *
 * 帧长 ≈ 45 + 数字位数 + 载荷字符数：`hex` 时约为 `2 × 片字节数`（最长的情形），
 * `gzb64` 时通常不到一半。因此「帧长上限」按 hex 的最坏情况给，实际帧长由编码自己决定。
 * 帧是逐字符打出去的，片越大帧越长、重传成本也越高，所以仍保留小片预设。
 */
export const CHUNK_PRESETS: readonly ChunkPreset[] = [
  {
    id: 'narrow',
    label: '窄终端',
    chunkBytes: 256,
    maxFrameChars: 1024,
    description: '串口、老式控制台与限宽终端（帧长只有几百字符）'
  },
  {
    id: 'conservative',
    label: '保守',
    chunkBytes: 1024,
    maxFrameChars: 4096,
    description: '目标端不稳或需要频繁续传时（十六进制帧长约 2.1 K 字符）'
  },
  {
    id: 'default',
    label: '默认',
    chunkBytes: 8192,
    maxFrameChars: 24576,
    description: '压缩编码下的通用选择：帧头占比最小、分片数最少'
  },
  {
    id: 'large',
    label: '大文件',
    chunkBytes: 32768,
    maxFrameChars: 66560,
    description: '目标端可靠、链路稳定时用于大文件（重传成本更高）'
  }
]

/** 取值范围（设置层与 IPC 校验共用，避免两处各写一份）。 */
export const TRANSFER_LIMITS = {
  chunkBytes: [64, 1024 * 1024],
  maxFrameChars: [256, 1024 * 1024],
  interFrameDelayMs: [0, 10_000]
} as const satisfies Record<string, readonly [number, number]>

/**
 * `txt` 编码的文件大小上限。
 *
 * 该模式下必须把整个文本读进内存（要按字符边界切片），64 MiB 之后再大就没有意义了——
 * 二进制/超大文件应该用 hex 或 b64（它们是流式读取，内存恒定）。
 */
export const TXT_MAX_BYTES = 64 * 1024 * 1024

/** 十六进制预览的行数（每行 16 字节）。 */
export const HEX_PREVIEW_ROWS = 16

export interface HexPreviewRow {
  offset: number
  hex: string
  ascii: string
}

export interface TransferPrepareOptions {
  encoding: TransferEncoding
  /** 每片原始字节数 */
  chunkBytes: number
  /** 单帧字符上限 */
  maxFrameChars: number
  /** 接收端使用的文件名（默认取源文件名） */
  name?: string
}

/** 准备（读文件 + 哈希 + 分片）的进度。 */
export interface TransferPrepareProgress {
  phase: 'hash' | 'compress' | 'plan'
  done: number
  total: number
}

/** 界面需要的任务摘要（不含任何文件内容）。 */
export interface TransferJobSummary {
  path: string
  name: string
  size: number
  job: string
  encoding: TransferEncoding
  chunkBytes: number
  maxFrameChars: number
  total: number
  /** 整文件 SHA-256（始终计算：接收端要靠它做最终校验） */
  sha256: string
  /** 实际要打出去的字节总量（压缩编码下是压缩后的字节数） */
  wireBytes: number
  /** 末片字节数（空文件为 0） */
  tailBytes: number
  /** 最长帧的字符数 */
  peakFrameChars: number
  /** 所有帧（含行尾）的字符总量 */
  frameChars: number
  /** 预计产生的键盘动作数（CJK/emoji 会拆成多个 Unicode 报文） */
  typedActions: number
  preview: HexPreviewRow[]
  /** 文件字节是否完全等于 UTF-8 文本（决定能否用 txt 编码） */
  looksUtf8: boolean
}

/** 接收端 `resume.json` / 续传令牌归一化后的结果。 */
export interface ResumeState {
  job: string
  total: number
  size: number
  sha256: string | null
  doneRanges: string
  missing: number[]
  source: 'report' | 'token' | 'ranges'
}

/** 续传状态与当前任务比对的结果。 */
export interface ResumeMatch {
  state: ResumeState
  /** 需要补传的片号（已按升序） */
  missing: number[]
  /** 非致命的差异说明（例如哈希为空、完成片数与任务不符） */
  warnings: string[]
}

/**
 * @description 把字节数格式化成人类可读文本（纯函数，界面与日志共用）
 * @param bytes 字节数
 * @returns 人类可读的文本（非法输入返回破折号）
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/**
 * @description 按耗时量级给出提示强度（界面据此决定黄 / 红）
 * @param ms 毫秒数
 * @returns 提示强度分级
 */
export function durationTone(ms: number): 'ok' | 'warn' | 'danger' {
  if (ms > 60 * 60 * 1000) return 'danger'
  if (ms > 10 * 60 * 1000) return 'warn'
  return 'ok'
}
