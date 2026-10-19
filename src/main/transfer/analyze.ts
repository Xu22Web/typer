// 发送前的文件画像：只看"能不能压、压多少、像什么"，不做任何改写。
//
// 约束：线格式 v2 只传**原文件字节**，接收端合并后校验的 SHA-256 必须等于源文件。
// 因此这里不做容器重打包 / 解包 / 二次解压，只根据样本决定"要不要压缩、压几级"，
// 并给出一个可解释的结论（界面直接展示 reason）。

import { open } from 'node:fs/promises'
import { brotliCompressSync, constants as zlibConstants, deflateRawSync } from 'node:zlib'

/** 采样上限：最多读这么多字节用于试压（小文件就是全量）。 */
const SAMPLE_BUDGET_BYTES = 3 * 1024 * 1024
/** 单个采样点的大小。 */
const SAMPLE_POINT_BYTES = 512 * 1024
/** 试压用的 Brotli 等级：只是判断"有没有压缩空间"，用低等级换取速度。 */
const PROBE_QUALITY = 5
/** 试压比例高于这个值就认为"基本不可压缩"，不值得花时间真压。 */
const INCOMPRESSIBLE_RATIO = 0.97

/** 文件类型（只用于提示与快速判定）。 */
export type FileKind =
  | 'zip'
  | 'gzip'
  | '7z'
  | 'rar'
  | 'xz'
  | 'zstd'
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'mp4'
  | 'pdf'
  | 'pe'
  | 'ole'
  | 'elf'
  | 'text'
  | 'binary'

export interface FileProfile {
  size: number
  kind: FileKind
  /** 采样试压后估算的 Brotli 比例（0~1；无样本时为 1） */
  brotliRatio: number
  /** 采样试压后估算的 Deflate 比例 */
  deflateRatio: number
  /** 是否值得压缩 */
  compressible: boolean
  /** 判定依据（中文，直接展示） */
  reason: string
}

/** 常见"已经是压缩格式"的魔数：这些类型再去压缩基本是白花时间。 */
const PACKED_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'zip',
  'gzip',
  '7z',
  'rar',
  'xz',
  'zstd',
  'jpeg',
  'png',
  'gif',
  'webp',
  'mp4'
])

/**
 * @description 读一小段文件内容（用于魔数识别与试压）
 * @param path 文件路径
 * @param offset 起始偏移
 * @param length 期望长度
 * @returns 实际读到的字节
 */
async function readAt(path: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * @description 按魔数判断文件类型
 * @param head 文件开头的字节
 * @returns 类型
 */
export function sniffKind(head: Buffer): FileKind {
  const at = (offset: number, ...bytes: number[]): boolean =>
    head.length >= offset + bytes.length &&
    bytes.every((byte, index) => head[offset + index] === byte)

  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'zip'
  if (at(0, 0x1f, 0x8b)) return 'gzip'
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z'
  if (at(0, 0x52, 0x61, 0x72, 0x21)) return 'rar'
  if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz'
  if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) return 'zstd'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return 'mp4'
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf'
  if (at(0, 0x4d, 0x5a)) return 'pe'
  if (at(0, 0xd0, 0xcf, 0x11, 0xe0)) return 'ole'
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return 'elf'
  return looksLikeText(head) ? 'text' : 'binary'
}

/**
 * @description 粗略判断一段字节是否像 UTF-8 文本（只看可打印比例与控制字符）
 * @param bytes 字节
 * @returns 是否像文本
 */
function looksLikeText(bytes: Buffer): boolean {
  if (bytes.length === 0) return true
  let printable = 0
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]
    if (byte === 0) return false
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte < 0x7f)) {
      printable += 1
      continue
    }
    // 高位字节（中文等）不在这里判定，交给压缩比例说话
    if (byte >= 0x80) printable += 1
  }
  return printable / bytes.length > 0.9
}

/** 类型 → 中文说明 */
const KIND_LABELS: Readonly<Record<FileKind, string>> = {
  zip: 'ZIP 类容器（VSIX/JAR/DOCX/APK…）',
  gzip: 'gzip',
  '7z': '7z',
  rar: 'RAR',
  xz: 'xz',
  zstd: 'zstd',
  jpeg: 'JPEG 图片',
  png: 'PNG 图片',
  gif: 'GIF 图片',
  webp: 'WebP 图片',
  mp4: 'MP4 视频',
  pdf: 'PDF',
  pe: 'Windows 可执行文件',
  ole: 'OLE 复合文档（MSI/DOC…）',
  elf: 'ELF 可执行文件',
  text: '文本',
  binary: '二进制'
}

/**
 * @description 取一段代表性样本：小文件全读，大文件取头/中/尾三段
 * @param path 文件路径
 * @param size 文件大小
 * @returns 样本字节
 */
async function sampleFile(path: string, size: number): Promise<Buffer> {
  if (size <= SAMPLE_BUDGET_BYTES) return readAt(path, 0, size)
  const points = [
    Math.max(0, Math.floor(size * 0.1) - SAMPLE_POINT_BYTES / 2),
    Math.max(0, Math.floor(size / 2) - SAMPLE_POINT_BYTES / 2),
    Math.max(0, size - SAMPLE_POINT_BYTES)
  ]
  const parts = await Promise.all(points.map((offset) => readAt(path, offset, SAMPLE_POINT_BYTES)))
  return Buffer.concat(parts)
}

/**
 * @description 分析文件，决定是否值得压缩
 * @param path 文件路径
 * @param size 文件大小
 * @returns 文件画像
 */
export async function analyzeFile(path: string, size: number): Promise<FileProfile> {
  if (size === 0) {
    return {
      size,
      kind: 'binary',
      brotliRatio: 0,
      deflateRatio: 0,
      compressible: false,
      reason: '空文件：没有数据需要压缩'
    }
  }

  const head = await readAt(path, 0, Math.min(64 * 1024, size))
  const kind = sniffKind(head)
  const sample = await sampleFile(path, size)

  let brotliRatio = 1
  let deflateRatio = 1
  if (sample.length > 0) {
    const brotli = brotliCompressSync(sample, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: PROBE_QUALITY,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: sample.length
      }
    })
    const deflate = deflateRawSync(sample, { level: 6 })
    brotliRatio = brotli.length / sample.length
    deflateRatio = deflate.length / sample.length
  }

  if (PACKED_KINDS.has(kind) && brotliRatio >= INCOMPRESSIBLE_RATIO) {
    return {
      size,
      kind,
      brotliRatio,
      deflateRatio,
      compressible: false,
      reason: `${KIND_LABELS[kind]} 本身已是压缩格式，实测只能缩小 ${percent(1 - brotliRatio)}：跳过压缩直接发原字节`
    }
  }

  if (brotliRatio >= INCOMPRESSIBLE_RATIO) {
    return {
      size,
      kind,
      brotliRatio,
      deflateRatio,
      compressible: false,
      reason: `样本几乎不可压缩（Brotli 仅缩小 ${percent(1 - brotliRatio)}）：跳过压缩，省下准备时间`
    }
  }

  return {
    size,
    kind,
    brotliRatio,
    deflateRatio,
    compressible: true,
    reason: `样本可压缩到 ${percent(brotliRatio)}（Brotli）：值得压缩，线上字节约 ${Math.round(
      size * brotliRatio
    )}`
  }
}

/**
 * @description 把比例格式化成百分比文本
 * @param ratio 比例（0~1）
 * @returns 形如 `42.3%`
 */
function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}
