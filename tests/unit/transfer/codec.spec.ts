import { describe, expect, it } from 'vitest'
import {
  CodecError,
  decodeSymbols,
  encodeSymbols,
  getAlphabet,
  isAlphabetId,
  symbolCount
} from '@main/util/codec'

const ALPHABETS = ['ascii32', 'ascii64', 'hex'] as const

/**
 * @description 造一段确定性二进制（含 0x00 / 0xFF）
 * @param size 字节数
 * @param seed 种子
 * @returns 字节
 */
function binary(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size)
  let state = seed >>> 0
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) >>> 0
    bytes[index] = index % 53 === 0 ? 0 : index % 97 === 0 ? 0xff : (state >>> 16) & 0xff
  }
  return bytes
}

describe('符号表', () => {
  it('三种符号表的容量与位宽符合"每字符承载的比特数"', () => {
    expect(getAlphabet('ascii32').bits).toBe(5)
    expect(getAlphabet('ascii32').table).toHaveLength(32)
    expect(getAlphabet('ascii64').bits).toBe(6)
    expect(getAlphabet('ascii64').table).toHaveLength(64)
    expect(getAlphabet('hex').bits).toBe(4)
    expect(getAlphabet('hex').table).toHaveLength(16)
  })

  it('ascii32 只用数字与小写字母：零 Shift，不会被输入法与编辑器干扰', () => {
    const { table } = getAlphabet('ascii32')
    const text = String.fromCharCode(...table)
    expect(text).toMatch(/^[0-9a-z]{32}$/)
    expect(new Set(table).size).toBe(32)
  })

  it('ascii64 不含空白、引号、括号与 @（帧分隔符必须是载荷里不存在的字符）', () => {
    const { table } = getAlphabet('ascii64')
    const text = String.fromCharCode(...table)
    expect(text).not.toMatch(/[\s"'`()[\]{}@]/)
    expect(new Set(table).size).toBe(64)
  })

  it('isAlphabetId 只认三个合法值', () => {
    expect(isAlphabetId('ascii32')).toBe(true)
    expect(isAlphabetId('bmp15')).toBe(false)
    expect(isAlphabetId('b64')).toBe(false)
    expect(isAlphabetId(undefined)).toBe(false)
  })

  it('symbolCount 与"8 字节 = 12.8 个 5 位字符"一致', () => {
    expect(symbolCount(0, 'ascii32')).toBe(0)
    expect(symbolCount(8, 'ascii32')).toBe(Math.ceil((8 * 8) / 5))
    expect(symbolCount(3, 'ascii64')).toBe(4)
    expect(symbolCount(1, 'hex')).toBe(2)
  })
})

describe('位打包往返', () => {
  it.each(ALPHABETS)('%s：各种长度都能逐字节还原', (alphabet) => {
    for (const size of [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 64, 255, 1000, 8192]) {
      const bytes = binary(size, size + 1)
      const text = encodeSymbols(bytes, alphabet)
      expect(text).toHaveLength(symbolCount(size, alphabet))
      const back = decodeSymbols(text, alphabet, size)
      expect(Buffer.compare(Buffer.from(back), Buffer.from(bytes))).toBe(0)
    }
  })

  it('5 位档每个字节的字符数比十六进制少 20%', () => {
    const bytes = binary(1024)
    expect(encodeSymbols(bytes, 'ascii32')).toHaveLength(Math.ceil((1024 * 8) / 5))
    expect(encodeSymbols(bytes, 'ascii32').length).toBeLessThan(encodeSymbols(bytes, 'hex').length)
  })

  it('载荷里没有任何空白字符（帧是空格分隔的）', () => {
    for (const alphabet of ALPHABETS) {
      expect(encodeSymbols(binary(500), alphabet)).not.toMatch(/\s/)
    }
  })
})

describe('严格校验：宁可报错也不写出坏数据', () => {
  it('符号数量不符（截断）时报错', () => {
    const text = encodeSymbols(binary(100), 'ascii32')
    expect(() => decodeSymbols(text.slice(0, -1), 'ascii32', 100)).toThrow(CodecError)
  })

  it('出现符号表之外的字符时报错', () => {
    const text = encodeSymbols(binary(20), 'hex')
    const broken = `${text.slice(0, 5)}Z${text.slice(6)}`
    expect(() => decodeSymbols(broken, 'hex', 20)).toThrow(/符号表之外/)
  })

  it('末组补位被改写时报错', () => {
    const text = encodeSymbols(binary(1), 'ascii32')
    // 1 字节 = 8 位 → 2 个 5 位符号，最后一组低 2 位是补位；改成最大符号即补位非零
    const alphabet = getAlphabet('ascii32')
    const maxChar = String.fromCharCode(alphabet.table[alphabet.table.length - 1])
    const tampered = text.slice(0, -1) + maxChar
    if (tampered !== text) {
      expect(() => decodeSymbols(tampered, 'ascii32', 1)).toThrow(/补位/)
    }
  })

  it('字节数为负或非整数时报错', () => {
    expect(() => decodeSymbols('', 'hex', -1)).toThrow(CodecError)
    expect(() => symbolCount(1.5, 'hex')).toThrow(CodecError)
  })
})
