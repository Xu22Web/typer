import { describe, expect, it } from 'vitest'
import {
  describeSkipped,
  isCjk,
  isPrintableAscii,
  normalizeText,
  toCodePoints,
  toUtf16Units
} from '@main/typing/planner/text'

describe('normalizeText', () => {
  it('把各种换行统一成 \\n，并把 CRLF 合并为单个换行', () => {
    expect(normalizeText('a\r\nb').text).toBe('a\nb')
    expect(normalizeText('a\rb').text).toBe('a\nb')
    expect(normalizeText('a\u2028b\u2029c').text).toBe('a\nb\nc')
    expect(normalizeText('a\u0085b').text).toBe('a\nb')
    // 连续多个换行（空行）不应被压掉
    expect(normalizeText('a\r\n\r\nb').text).toBe('a\n\nb')
    expect(normalizeText('a\n\n\nb').text).toBe('a\n\n\nb')
  })

  it('去掉开头的 BOM，并跳过中间的零宽字符', () => {
    const result = normalizeText('\uFEFFhello\u200Bworld\u2060!')
    expect(result.text).toBe('helloworld!')
    expect(result.skipped['\u200B']).toBe(1)
    expect(result.skipped['\u2060']).toBe(1)
    expect(result.skipped['\uFEFF']).toBe(1)
  })

  it('跳过控制字符但保留 Tab', () => {
    const result = normalizeText('a\u0000b\u0007c\td\u001b')
    expect(result.text).toBe('abc\td')
    expect(result.skipped['\u0000']).toBe(1)
    expect(result.skipped['\u0007']).toBe(1)
    expect(result.skipped['\u001b']).toBe(1)
    expect(result.skipped['\t']).toBeUndefined()
  })

  it('保留 emoji、变体选择符与组合字符（信息不能丢）', () => {
    expect(normalizeText('❤️').text).toBe('❤️')
    expect(normalizeText('e\u0301').text).toBe('e\u0301')
    expect(normalizeText('👨‍👩‍👧').text).toBe('👨‍👩‍👧')
  })

  it('空字符串与纯控制字符不抛错', () => {
    expect(normalizeText('').text).toBe('')
    expect(normalizeText('\u0000\u0001').text).toBe('')
    expect(normalizeText('\u0000\u0001').skipped).toEqual({ '\u0000': 1, '\u0001': 1 })
  })

  it('describeSkipped 输出可读名字', () => {
    const { skipped } = normalizeText('a\u001bb\u007f')
    const text = describeSkipped(skipped)
    expect(text).toContain('ESC×1')
    expect(text).toContain('DEL×1')
  })
})

describe('字符分类与拆分', () => {
  it('识别 CJK（含中文标点与全角形式）', () => {
    expect(isCjk('中')).toBe(true)
    expect(isCjk('，')).toBe(true)
    expect(isCjk('。')).toBe(true)
    expect(isCjk('あ')).toBe(true)
    expect(isCjk('한')).toBe(true)
    expect(isCjk('Ａ')).toBe(true)
    expect(isCjk('a')).toBe(false)
    expect(isCjk('😀')).toBe(false)
  })

  it('只有单个 ASCII 码点才算可打印 ASCII', () => {
    expect(isPrintableAscii('a')).toBe(true)
    expect(isPrintableAscii('~')).toBe(true)
    expect(isPrintableAscii(' ')).toBe(true)
    expect(isPrintableAscii('中')).toBe(false)
    expect(isPrintableAscii('😀')).toBe(false)
  })

  it('按码点拆分（emoji 不拆散）', () => {
    expect(toCodePoints('a中😀')).toEqual(['a', '中', '😀'])
    expect(toCodePoints('😀').length).toBe(1)
  })

  it('emoji 拆成两个 UTF-16 码元', () => {
    expect(toUtf16Units('😀')).toEqual([0xd83d, 0xde00])
    expect(toUtf16Units('中')).toEqual([0x4e2d])
    expect(toUtf16Units('a')).toEqual([0x61])
  })
})
