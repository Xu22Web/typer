import { describe, expect, it } from 'vitest'
import {
  FrameError,
  MAX_FRAME_CHARS,
  MARKERS,
  buildBeginFrame,
  buildDataFrame,
  buildEndFrame,
  buildResumeToken,
  chunkCount,
  chunkSlice,
  crc32,
  crc32Hex,
  createLineSplitter,
  decodeSymbols,
  encodeSymbols,
  formatIndexList,
  isFrameLine,
  missingIndexes,
  parseFrame,
  parseIndexList,
  randomJobId,
  resolveIndexes,
  sanitizeLine,
  sha256Hex,
  verifyDataFrame,
  verifyIntegrity
} from '@main/util/frame'

const JOB = 'a1b2c3d4'
const SHA = 'a'.repeat(64)

/**
 * @description 造一个开始帧字段
 * @param overrides 覆盖项
 * @returns 开始帧字段
 */
function beginMeta(overrides: Record<string, unknown> = {}): Parameters<typeof buildBeginFrame>[0] {
  return {
    job: JOB,
    total: 3,
    size: 1000,
    wire: 400,
    chunk: 128,
    name: '示例.bin',
    alphabet: 'ascii32',
    compression: 'br',
    mode: 'term',
    sha256: SHA,
    ...overrides
  } as Parameters<typeof buildBeginFrame>[0]
}

describe('校验实现', () => {
  it('CRC32 与标准向量一致', () => {
    expect(crc32Hex('123456789')).toBe('cbf43926')
    expect(crc32Hex('')).toBe('00000000')
    expect(crc32('The quick brown fox jumps over the lazy dog')).toBe(0x414fa339)
  })

  it('SHA-256 与标准向量一致', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('job id 是 8 位小写 hex，且可注入随机源', () => {
    expect(randomJobId()).toMatch(/^[0-9a-f]{8}$/)
    expect(randomJobId(() => 0.5)).toBe('88888888')
  })
})

describe('开始帧', () => {
  it('构造 → 解析后字段完全一致（含文件名与中文）', () => {
    const line = buildBeginFrame(beginMeta())
    expect(line.startsWith(`${MARKERS.begin} `)).toBe(true)
    const frame = parseFrame(line)
    if (frame.kind !== 'begin') throw new Error('应为开始帧')
    expect(frame.job).toBe(JOB)
    expect(frame.total).toBe(3)
    expect(frame.size).toBe(1000)
    expect(frame.wire).toBe(400)
    expect(frame.chunk).toBe(128)
    expect(frame.name).toBe('示例.bin')
    expect(frame.alphabet).toBe('ascii32')
    expect(frame.compression).toBe('br')
    expect(frame.mode).toBe('term')
    expect(frame.sha256).toBe(SHA)
  })

  it('文件名为空时写 `-`，解析回 null', () => {
    const frame = parseFrame(buildBeginFrame(beginMeta({ name: null })))
    if (frame.kind !== 'begin') throw new Error('应为开始帧')
    expect(frame.name).toBeNull()
  })

  it('字段非法时拒绝构造', () => {
    expect(() => buildBeginFrame(beginMeta({ job: 'XYZ' }))).toThrow(FrameError)
    expect(() => buildBeginFrame(beginMeta({ alphabet: 'b64' }))).toThrow(/符号表/)
    expect(() => buildBeginFrame(beginMeta({ compression: 'gzip' }))).toThrow(/压缩/)
    expect(() => buildBeginFrame(beginMeta({ mode: 'x' }))).toThrow(/目标端/)
    expect(() => buildBeginFrame(beginMeta({ sha256: 'zz' }))).toThrow(/sha256/)
    expect(() => buildBeginFrame(beginMeta({ total: -1 }))).toThrow(/total/)
  })

  it('字段数量不对时解析报 field', () => {
    expect(() => parseFrame(`${MARKERS.begin} ${JOB} 1 2 3`)).toThrow(/应有 11 个字段/)
  })

  it('帧头丢一个字符（size 少一位）会被 CRC 抓到，而不是按错误规模接收', () => {
    const line = buildBeginFrame(beginMeta())
    const tampered = line.replace(' 1000 ', ' 100 ')
    expect(tampered).not.toBe(line)
    expect(() => parseFrame(tampered)).toThrow(/帧头校验失败|帧头 CRC/)
  })
})

describe('数据帧', () => {
  const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x42])
  const payload = encodeSymbols(bytes, 'ascii32')

  it('构造 → 解析 → 解码后逐字节一致', () => {
    const line = buildDataFrame({
      job: JOB,
      seq: 2,
      bytes: bytes.length,
      crc32: crc32Hex(bytes),
      payload
    })
    const frame = parseFrame(line)
    if (frame.kind !== 'data') throw new Error('应为数据帧')
    expect(frame.seq).toBe(2)
    expect(frame.bytes).toBe(bytes.length)
    expect(frame.crc32).toBe(crc32Hex(bytes))
    const decoded = decodeSymbols(frame.payload, 'ascii32', frame.bytes)
    expect(Buffer.compare(Buffer.from(decoded), bytes)).toBe(0)
  })

  it('CRC 不符时 verifyDataFrame 抛 crc', () => {
    const frame = parseFrame(
      buildDataFrame({ job: JOB, seq: 0, bytes: bytes.length, crc32: '00000000', payload })
    )
    if (frame.kind !== 'data') throw new Error('应为数据帧')
    expect(() => verifyDataFrame(frame, bytes)).toThrow(/校验失败/)
  })

  it('长度不符时抛 len（先于 CRC 判断）', () => {
    const frame = parseFrame(
      buildDataFrame({ job: JOB, seq: 0, bytes: bytes.length, crc32: crc32Hex(bytes), payload })
    )
    if (frame.kind !== 'data') throw new Error('应为数据帧')
    expect(() => verifyDataFrame(frame, Buffer.concat([bytes, Buffer.from([1])]))).toThrow(
      /长度与声明不一致/
    )
  })

  it('载荷为空或含空白时拒绝构造', () => {
    expect(() =>
      buildDataFrame({ job: JOB, seq: 0, bytes: 1, crc32: '00000000', payload: '' })
    ).toThrow(/载荷/)
    expect(() =>
      buildDataFrame({ job: JOB, seq: 0, bytes: 1, crc32: '00000000', payload: 'ab cd' })
    ).toThrow(/载荷/)
  })
})

describe('结束帧与续传帧', () => {
  it('结束帧携带规模与整文件哈希', () => {
    const frame = parseFrame(
      buildEndFrame({ job: JOB, total: 3, size: 1000, wire: 400, sha256: SHA })
    )
    if (frame.kind !== 'end') throw new Error('应为结束帧')
    expect(frame).toMatchObject({ job: JOB, total: 3, size: 1000, wire: 400, sha256: SHA })
  })

  it('续传令牌用 `-` 表示无缺失，区间文本原样解析', () => {
    const none = parseFrame(buildResumeToken({ job: JOB, total: 10, missing: [] }))
    if (none.kind !== 'resume') throw new Error('应为续传帧')
    expect(none.missing).toEqual([])

    const some = parseFrame(buildResumeToken({ job: JOB, total: 10, missing: [3, 4, 5, 9] }))
    if (some.kind !== 'resume') throw new Error('应为续传帧')
    expect(some.missing).toEqual([3, 4, 5, 9])
  })
})

describe('解析的严格性', () => {
  it('未知标记报 marker', () => {
    expect(() => parseFrame('@TYPER1/D a1b2c3d4 0 1 deadbeef AA')).toThrow(/无法识别的帧标记/)
  })

  it('空行报 empty', () => {
    try {
      parseFrame('   ')
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as FrameError).code).toBe('empty')
    }
  })

  it('超过硬上限报 overlong', () => {
    const line = `@T2D ${JOB} 0 1 00000000 ${'A'.repeat(MAX_FRAME_CHARS)}`
    expect(() => parseFrame(line)).toThrow(/上限/)
  })

  it('isFrameLine 只认 v2 标记', () => {
    expect(isFrameLine(`  ${MARKERS.begin} ${JOB} …`)).toBe(true)
    expect(isFrameLine('@TYPER1/B x')).toBe(false)
    expect(isFrameLine('hello')).toBe(false)
  })
})

describe('整文件校验', () => {
  it('大小与哈希都匹配时通过，任何一项不符都抛错', () => {
    const bytes = Buffer.from('hello 世界')
    const sha = sha256Hex(bytes)
    const verified = verifyIntegrity(bytes, sha, bytes.length)
    expect(Buffer.compare(Buffer.from(verified), bytes)).toBe(0)
    expect(() => verifyIntegrity(bytes, sha, bytes.length + 1)).toThrow(/大小不符/)
    expect(() => verifyIntegrity(bytes, 'b'.repeat(64))).toThrow(/校验失败/)
  })
})

describe('分片规划', () => {
  it('空文件 0 片；末片按余数计算', () => {
    expect(chunkCount(0, 100)).toBe(0)
    expect(chunkCount(250, 100)).toBe(3)
    expect(chunkSlice(250, 100, 2)).toEqual({ offset: 200, bytes: 50 })
    expect(() => chunkSlice(250, 100, 3)).toThrow(/超出范围/)
  })
})

describe('片号集合', () => {
  it('区间解析与格式化互逆', () => {
    expect(parseIndexList('3,5,12-14', 20)).toEqual([3, 5, 12, 13, 14])
    expect(formatIndexList([14, 12, 13, 5, 3], 20)).toBe('3,5,12-14')
    expect(formatIndexList([], 20)).toBe('')
  })

  it('越界与倒序区间被拒绝', () => {
    expect(() => parseIndexList('1-5', 3)).toThrow(/超出总数/)
    expect(() => parseIndexList('5-1', 10)).toThrow(/起点大于终点/)
    expect(() => parseIndexList('abc')).toThrow(/无法解析/)
  })

  it('分隔符只接受英文字符：中文标点当场报错并指出是哪个字符', () => {
    // 线路上的片号列表永远由 formatIndexList 产出，所以只有 ASCII 分隔符是合法输入
    expect(parseIndexList('3; 5\t12', 20)).toEqual([3, 5, 12])
    expect(parseIndexList('3\r\n5', 20)).toEqual([3, 5])
    expect(parseIndexList('3  5', 20)).toEqual([3, 5])

    for (const bad of ['3、5', '3，5', '3；5', '3　5']) {
      expect(() => parseIndexList(bad, 20)).toThrow(/只接受英文字符/)
    }
    // 全角空格（U+3000）也不再算空白，报错要把"是哪个字符"说清楚
    expect(() => parseIndexList('3、5', 20)).toThrow(/U\+3001/)
    expect(() => parseIndexList('3　5', 20)).toThrow(/U\+3000/)
  })

  it('缺失片与 from/only 归一化', () => {
    expect(missingIndexes(5, [0, 2, 4])).toEqual([1, 3])
    expect(resolveIndexes(4)).toEqual([0, 1, 2, 3])
    expect(resolveIndexes(4, { from: 2 })).toEqual([2, 3])
    expect(resolveIndexes(4, { from: 2, only: '1' })).toEqual([1])
  })
})

describe('输入流处理', () => {
  it('sanitizeLine 去掉 bracketed paste 标记与首尾空白', () => {
    expect(sanitizeLine('\u001b[200~@T2D abc\u001b[201~')).toBe('@T2D abc')
    expect(sanitizeLine('  @T2H x  ')).toBe('@T2H x')
    expect(sanitizeLine('\uFEFF@T2H y')).toBe('@T2H y')
  })

  it('行切分器把 CR / LF / CRLF 都当行尾，允许任意分块', () => {
    const splitter = createLineSplitter()
    const lines: string[] = []
    for (const chunk of ['a\r', '\nb\r', 'c\nd', '\re']) lines.push(...splitter.push(chunk))
    lines.push(...splitter.flush())
    expect(lines).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
