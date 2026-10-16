import { describe, expect, it } from 'vitest'
import { decodeText, isValidUtf8 } from '@main/util/textFile'

describe('isValidUtf8', () => {
  it('ASCII 与合法中文都是合法 UTF-8', () => {
    expect(isValidUtf8(Buffer.from('hello', 'utf8'))).toBe(true)
    expect(isValidUtf8(Buffer.from('中文测试', 'utf8'))).toBe(true)
    expect(isValidUtf8(Buffer.from('😀', 'utf8'))).toBe(true)
  })

  it('GBK 的中文不是合法 UTF-8（自动探测依据）', () => {
    // GBK 的 "中文" = D6 D0 CE C4
    expect(isValidUtf8(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(false)
  })

  it('截断的多字节序列不合法', () => {
    expect(isValidUtf8(Buffer.from([0xe4, 0xb8]))).toBe(false)
    expect(isValidUtf8(Buffer.from([0x80]))).toBe(false)
  })
})

describe('decodeText', () => {
  it('utf8：去掉 BOM', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文', 'utf8')])
    const result = decodeText(withBom, 'utf8')
    expect(result.text).toBe('中文')
    expect(result.hadBom).toBe(true)
    expect(result.charset).toBe('utf8')
  })

  it('utf16le：按指定编码解码并识别 BOM', () => {
    const payload = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文abc', 'utf16le')])
    const result = decodeText(payload, 'utf16le')
    expect(result.text).toBe('中文abc')
    expect(result.hadBom).toBe(true)
  })

  it('gbk：显式指定编码时按 GBK 解码', () => {
    const result = decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'gbk')
    expect(result.text).toBe('中文')
    expect(result.charset).toBe('gbk')
  })

  it('auto：识别 UTF-8 BOM', () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好', 'utf8')])
    expect(decodeText(buffer, 'auto')).toEqual({ text: '你好', charset: 'utf8', hadBom: true })
  })

  it('auto：识别 UTF-16 LE BOM', () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好', 'utf16le')])
    const result = decodeText(buffer, 'auto')
    expect(result.charset).toBe('utf16le')
    expect(result.text).toBe('你好')
  })

  it('auto：识别 UTF-16 BE BOM（需要字节交换）', () => {
    const le = Buffer.from('你好', 'utf16le')
    const be = Buffer.alloc(le.length)
    for (let index = 0; index < le.length; index += 2) {
      be[index] = le[index + 1] as number
      be[index + 1] = le[index] as number
    }
    const buffer = Buffer.concat([Buffer.from([0xfe, 0xff]), be])
    const result = decodeText(buffer, 'auto')
    expect(result.text).toBe('你好')
    expect(result.charset).toBe('utf16be')
  })

  it('auto：无 BOM 的纯 ASCII 判定为 UTF-8', () => {
    expect(decodeText(Buffer.from('plain text', 'utf8'), 'auto')).toEqual({
      text: 'plain text',
      charset: 'utf8',
      hadBom: false
    })
  })

  it('auto：无 BOM 的 UTF-8 中文判定为 UTF-8', () => {
    const result = decodeText(Buffer.from('中文内容', 'utf8'), 'auto')
    expect(result.charset).toBe('utf8')
    expect(result.text).toBe('中文内容')
  })

  it('auto：GBK 文件不会被误判成 UTF-8', () => {
    const result = decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'auto')
    expect(result.charset).toBe('gbk')
    expect(result.text).toBe('中文')
  })

  it('空文件不抛错', () => {
    expect(decodeText(Buffer.alloc(0), 'auto').text).toBe('')
    expect(decodeText(Buffer.alloc(0), 'utf16le').text).toBe('')
  })
})
