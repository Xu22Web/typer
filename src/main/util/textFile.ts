import iconv from 'iconv-lite'
import type { ImportCharset } from '../settings/types'

export interface DecodeResult {
  text: string
  /** 实际使用的编码（auto 模式下是探测结果） */
  charset: Exclude<ImportCharset, 'auto'> | 'utf16be'
  hadBom: boolean
}

/**
 * @description 按指定编码解码文本文件；auto 模式依次尝试 BOM、严格 UTF-8，最后按 GBK 处理（中文用户最常见的本地编码）
 * @param buffer 文件原始字节
 * @param charset 指定编码或 auto
 * @returns 解码结果（含实际使用的编码与是否带 BOM）
 */
export function decodeText(buffer: Buffer, charset: ImportCharset = 'auto'): DecodeResult {
  if (charset === 'utf8') {
    return stripBomAndDecode(buffer, 'utf8')
  }
  if (charset === 'utf16le') {
    return stripBomAndDecode(buffer, 'utf16le')
  }
  if (charset === 'gbk') {
    return { text: iconv.decode(buffer, 'gbk'), charset: 'gbk', hadBom: false }
  }

  // auto
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), charset: 'utf8', hadBom: true }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), charset: 'utf16le', hadBom: true }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return { text: swapped.toString('utf16le'), charset: 'utf16be', hadBom: true }
  }

  if (isValidUtf8(buffer)) {
    return { text: buffer.toString('utf8'), charset: 'utf8', hadBom: false }
  }

  return { text: iconv.decode(buffer, 'gbk'), charset: 'gbk', hadBom: false }
}

/**
 * @description 按指定编码解码，并在有匹配 BOM 时剥掉 BOM
 * @param buffer 文件原始字节
 * @param charset 目标编码
 * @returns 解码结果
 */
function stripBomAndDecode(buffer: Buffer, charset: 'utf8' | 'utf16le'): DecodeResult {
  const hasUtf8Bom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const hasUtf16Bom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe

  if (charset === 'utf8' && hasUtf8Bom) {
    return { text: buffer.subarray(3).toString('utf8'), charset: 'utf8', hadBom: true }
  }
  if (charset === 'utf16le' && hasUtf16Bom) {
    return { text: buffer.subarray(2).toString('utf16le'), charset: 'utf16le', hadBom: true }
  }

  return {
    text: buffer.toString(charset),
    charset,
    hadBom: charset === 'utf8' ? hasUtf8Bom : hasUtf16Bom
  }
}

/**
 * @description 严格 UTF-8 校验：出现非法序列即判定不是 UTF-8（不做替换式解码）
 * @param buffer 待校验字节
 * @returns 是否是合法 UTF-8
 */
export function isValidUtf8(buffer: Buffer): boolean {
  let index = 0
  while (index < buffer.length) {
    const byte = buffer[index] as number
    if (byte < 0x80) {
      index += 1
      continue
    }

    let extra = 0
    if (byte >= 0xc2 && byte <= 0xdf) extra = 1
    else if (byte >= 0xe0 && byte <= 0xef) extra = 2
    else if (byte >= 0xf0 && byte <= 0xf4) extra = 3
    else return false

    if (index + extra >= buffer.length) return false
    for (let offset = 1; offset <= extra; offset++) {
      const next = buffer[index + offset] as number
      if (next < 0x80 || next > 0xbf) return false
    }
    index += extra + 1
  }
  return true
}
