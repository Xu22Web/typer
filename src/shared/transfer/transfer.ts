/**
 * 文件传输的**纯**类型与常量（主进程、preload、渲染进程共用）。
 * 刻意不引用任何 `node:` 模块，因为渲染进程要据此渲染选项；
 * 线格式（编解码 / 校验）的唯一实现在 `src/main/util/frame.ts`，符号表在 `src/main/util/codec.ts`。
 */

/** 载荷符号表：每字符承载多少比特，直接决定要打多少个字符。 */
export type TransferAlphabet = 'ascii32' | 'ascii64' | 'hex'

/** 压缩方式选项（`auto` 表示按样本试压结果决定）。 */
export type TransferCompression = 'auto' | 'br' | 'none'

/** 实际写进帧里的压缩方式。 */
export type TransferWireCompression = 'none' | 'br'

/** 目标端换行方式。 */
export type TransferTargetMode = 'term' | 'editor' | 'line'

export interface TransferAlphabetOption {
  value: TransferAlphabet
  label: string
  bits: number
  description: string
  /** 每字节需要的字符数（8 / bits） */
  charsPerByte: number
}

export const TRANSFER_BITS: Readonly<Record<TransferAlphabet, number>> = {
  ascii32: 5,
  ascii64: 6,
  hex: 4
}

export const TRANSFER_ALPHABET_OPTIONS: readonly TransferAlphabetOption[] = [
  {
    value: 'ascii32',
    label: 'ASCII 5 位（云桌面推荐）',
    bits: 5,
    charsPerByte: 8 / 5,
    description:
      '只用数字与小写字母：完全不发 Shift，远程桌面下不会被输入法中英文切换干扰；字符数比 6 位档多 20%，但实际更快'
  },
  {
    value: 'ascii64',
    label: 'ASCII 6 位（最快）',
    bits: 6,
    charsPerByte: 8 / 6,
    description:
      '数字 / 大小写字母 / `-` / `_`：字符数最少，但大写字母需要 Shift；远程桌面下每个修饰键切换要多花约 25ms'
  },
  {
    value: 'hex',
    label: '十六进制 4 位（最稳）',
    bits: 4,
    charsPerByte: 2,
    description: '只有 0-9 与 A-F，最抗终端与远控干扰；字符数最多，仅在排查链路问题时使用'
  }
]

export const TRANSFER_ALPHABETS: readonly TransferAlphabet[] = TRANSFER_ALPHABET_OPTIONS.map(
  (option) => option.value
)

export const TRANSFER_COMPRESSIONS: readonly TransferCompression[] = ['auto', 'br', 'none']
export const TRANSFER_WIRE_COMPRESSIONS: readonly TransferWireCompression[] = ['none', 'br']
export const TRANSFER_TARGET_MODES: readonly TransferTargetMode[] = ['term', 'editor', 'line']

export const TRANSFER_MODE_OPTIONS: ReadonlyArray<{
  value: TransferTargetMode
  label: string
  description: string
}> = [
  {
    value: 'term',
    label: '终端 / 命令行',
    description: '接收端跑在终端：每帧用真回车提交，关回显，最快'
  },
  {
    value: 'editor',
    label: '记事本 / VS Code',
    description: '接收端离线解码：用真回车换行；请配合 ASCII 6 位档，避免自动闭合与缩进'
  },
  {
    value: 'line',
    label: '单行输入框',
    description: '没有换行的输入框：帧之间用标记分隔，只能配 ASCII/十六进制档'
  }
]

export interface ChunkPreset {
  id: string
  label: string
  chunkBytes: number
  maxFrameChars: number
  description: string
}

/**
 * 片大小预设（线上字节数）。
 *
 * 帧是逐字符打出去的：片越大，单帧越长、重传成本越高；片太小则帧头与序号开销变多。
 * 16 KiB 在 15 位档下约 8.7 K 字符/帧，帧头占比 <0.4%。
 */
export const CHUNK_PRESETS: readonly ChunkPreset[] = [
  {
    id: 'tiny',
    label: '小片',
    chunkBytes: 2048,
    maxFrameChars: 8192,
    description: '链路不稳、需要频繁重传时用（单帧约 1.1 K 字符）'
  },
  {
    id: 'default',
    label: '默认',
    chunkBytes: 16384,
    maxFrameChars: 65536,
    description: '帧头占比 <0.4%，重传成本也还可以接受（单帧约 8.7 K 字符）'
  },
  {
    id: 'large',
    label: '大片',
    chunkBytes: 65536,
    maxFrameChars: 262144,
    description: '链路可靠时用于大文件（单帧约 105 K 字符，失败要重打这么多）'
  }
]

/** 取值范围（设置层与 IPC 校验共用，避免两处各写一份）。 */
export const TRANSFER_LIMITS = {
  chunkBytes: [1024, 262144],
  maxFrameChars: [4096, 4 * 1024 * 1024],
  interFrameDelayMs: [0, 10_000],
  quality: [1, 11]
} as const satisfies Record<string, readonly [number, number]>

/** 十六进制预览的行数（每行 16 字节）。 */
export const HEX_PREVIEW_ROWS = 16

/**
 * 开始帧 / 结束帧各发几遍。
 *
 * 这两帧决定接收端能不能开工、什么时候合并校验，丢一个字符就得整趟重来；
 * 而实测链路上确实出现过"整行只丢一个字符"，接收端的帧头 CRC 能当场发现但没东西可补。
 * 接收端对同一 job 的重复开始帧是幂等的，结束帧重复到达也无副作用，重复成本只有几百个字符。
 *
 * 引擎按它决定实际发送量，界面按同一个值估算耗时——两边必须同源，否则预估会偏小。
 */
export const FRAME_HEAD_REDUNDANCY = 3

export interface HexPreviewRow {
  offset: number
  hex: string
  ascii: string
}

export interface TransferPrepareOptions {
  alphabet: TransferAlphabet
  compression: TransferCompression
  /** Brotli 质量（1~11） */
  quality: number
  /** 每片线上字节数 */
  chunkBytes: number
  /** 单帧字符上限 */
  maxFrameChars: number
  mode: TransferTargetMode
  /** 接收端使用的文件名（默认取源文件名） */
  name?: string
}

/** 准备（读文件 + 哈希 + 压缩 + 分片）的进度。 */
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
  alphabet: TransferAlphabet
  compression: TransferWireCompression
  quality: number
  mode: TransferTargetMode
  chunkBytes: number
  maxFrameChars: number
  total: number
  /** 原文件 SHA-256（接收端靠它做最终校验） */
  sha256: string
  /** 实际要打出去的字节总量（压缩后） */
  wireBytes: number
  /** 末片线上字节数（空文件为 0） */
  tailBytes: number
  /** 最长帧的字符数 */
  peakFrameChars: number
  /** 所有帧（含行尾）的字符总量 */
  frameChars: number
  /** 预计产生的键盘动作数 */
  typedActions: number
  preview: HexPreviewRow[]
  /** 文件字节是否完全等于 UTF-8 文本（仅用于提示） */
  looksUtf8: boolean
  /** 压缩决策的说明（为什么压 / 为什么不压） */
  compressionNote: string
  /** 文件类型（魔数识别结果） */
  kind: string
  /** 文件类型的中文说明（界面直接展示，避免出现 text/binary 这类英文代号） */
  kindLabel: string
  /** 准备阶段耗时（毫秒） */
  prepareMs: number
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

/**
 * @description 给定线上字节数与符号表，算出载荷字符数（与线格式实现口径一致）
 * @param bytes 线上字节数
 * @param alphabet 符号表
 * @returns 字符数
 */
export function symbolsForBytes(bytes: number, alphabet: TransferAlphabet): number {
  return bytes <= 0 ? 0 : Math.ceil((bytes * 8) / TRANSFER_BITS[alphabet])
}
