/**
 * 文件传输的**纯**类型与常量（主进程、preload、渲染进程共用）。
 *
 * 这里刻意不引用任何 node: 模块或主进程实现：渲染进程要据此渲染选项与限制，
 * 而线格式（编解码 / 校验）的唯一实现在 `tools/lib/frame.mjs`（只有主进程与脚本用）。
 */

/** 载荷编码（与线格式的 `enc` 字段一致）。 */
export type TransferEncoding = 'hex' | 'b64' | 'txt'

export interface TransferEncodingOption {
  value: TransferEncoding
  label: string
  description: string
  /** 相对原始字节的体积倍数（用于界面提示与耗时预估） */
  overhead: number
  /** 是否只适用于 UTF-8 文本文件 */
  textOnly?: boolean
}

export const TRANSFER_ENCODING_OPTIONS: readonly TransferEncodingOption[] = [
  {
    value: 'hex',
    label: '十六进制（推荐）',
    description: '只有 0-9 A-F，最抗终端与输入法干扰；能逐字节还原任何文件（含 GBK、EXE）',
    overhead: 2
  },
  {
    value: 'b64',
    label: 'Base64',
    description: '体积约为十六进制的一半，含大小写与 + / =，目标端可靠时更快',
    overhead: 4 / 3
  },
  {
    value: 'txt',
    label: '文本（UTF-8）',
    description: '可读性最好；仅适用于合法 UTF-8 文本，空格与换行会转义成 \\x20 / \\n',
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
 * 帧长 ≈ 45 + 数字位数 + 载荷字符数：`hex` 时约为 `2 × 片字节数`。
 * 终端/剪贴板对单行长度都有限制，"保守"永远比"快"重要。
 */
export const CHUNK_PRESETS: readonly ChunkPreset[] = [
  {
    id: 'narrow',
    label: '窄终端',
    chunkBytes: 256,
    maxFrameChars: 1024,
    description: '串口、老式控制台与限宽终端（帧长约 560 字符）'
  },
  {
    id: 'default',
    label: '默认',
    chunkBytes: 1024,
    maxFrameChars: 4096,
    description: '终端 raw 模式与剪贴板粘贴的通用选择（帧长约 2.1 K 字符）'
  },
  {
    id: 'wide',
    label: '宽松',
    chunkBytes: 4096,
    maxFrameChars: 16384,
    description: '目标端可靠、粘贴不截断时使用（帧长约 8.2 K 字符）'
  },
  {
    id: 'paste',
    label: '仅粘贴',
    chunkBytes: 16384,
    maxFrameChars: 65536,
    description: '已知无行宽限制、只走剪贴板时使用（帧长约 32.8 K 字符）'
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
  phase: 'hash' | 'plan'
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

/** 把字节数格式化成人类可读文本（纯函数，界面与日志共用）。 */
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

/** 把毫秒格式化成"预计耗时"（粗粒度即可，用于提示用户量级）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
}

/** 耗时量级分级：界面据此决定提示强度（黄/红）。 */
export function durationTone(ms: number): 'ok' | 'warn' | 'danger' {
  if (ms > 60 * 60 * 1000) return 'danger'
  if (ms > 10 * 60 * 1000) return 'warn'
  return 'ok'
}
