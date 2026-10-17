import { describe, expect, it } from 'vitest'
import {
  ERROR_HINTS,
  FrameError,
  MAX_FRAME_CHARS,
  buildBeginFrame,
  buildDataFrame,
  buildEndFrame,
  buildResumeToken,
  chunkCount,
  chunkSlice,
  createLineSplitter,
  crc32,
  crc32Hex,
  decodeBytes,
  decodePayload,
  encodeBytes,
  encodePayload,
  escapeText,
  estimateDataFrameChars,
  formatIndexList,
  fromWireBytes,
  isFrameLine,
  missingIndexes,
  parseFrame,
  parseIndexList,
  planTextChunks,
  randomJobId,
  resolveIndexes,
  sanitizeLine,
  sha16Hex,
  sha256Hex,
  unescapeText,
  verifyDataFrame,
  verifyIntegrity
} from '@main/util/frame'

/**
 * @description 生成确定性随机字节，避免测试依赖 Math.random
 * @param length 字节数
 * @param seed 随机种子
 * @returns 随机字节数组
 */
function randomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let index = 0; index < length; index++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[index] = (state >>> 24) & 0xff
  }
  return out
}

/**
 * @description 走一遍完整的"构造 → 解析 → 校验 → 合并"，并断言结束帧哈希一致
 * @param source 原始字节
 * @param chunkBytes 片大小
 * @param enc 载荷编码
 * @returns 合并后的字节
 */
function roundTrip(source: Uint8Array, chunkBytes: number, enc: 'hex' | 'b64'): Uint8Array {
  const job = 'a1b2c3d4'
  const total = chunkCount(source.length, chunkBytes)
  const lines = [
    buildBeginFrame({
      job,
      total,
      size: source.length,
      enc,
      chunk: chunkBytes,
      name: '示例 文件.bin',
      sha256: sha256Hex(source)
    })
  ]

  for (let seq = 0; seq < total; seq++) {
    const { offset, bytes } = chunkSlice(source.length, chunkBytes, seq)
    const slice = source.subarray(offset, offset + bytes)
    lines.push(
      buildDataFrame({
        job,
        seq,
        total,
        bytes,
        enc,
        crc32: crc32Hex(slice),
        sha16: sha16Hex(slice),
        payload: encodeBytes(slice, enc)
      })
    )
  }
  const endLine = buildEndFrame({ job, total, size: source.length, sha256: sha256Hex(source) })
  lines.push(endLine)

  const collected: Uint8Array[] = []
  let endSeen: string | null = null
  for (const line of lines) {
    const frame = parseFrame(line)
    if (frame.kind === 'begin') continue
    if (frame.kind === 'end') {
      endSeen = frame.sha256
      continue
    }
    if (frame.kind !== 'data') continue
    collected.push(verifyDataFrame(frame, decodeBytes(frame.payload, enc)))
  }

  const merged = new Uint8Array(collected.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of collected) {
    merged.set(part, offset)
    offset += part.length
  }
  expect(endSeen).toBe(sha256Hex(source))
  return merged
}

describe('crc32 / sha256', () => {
  it('CRC32 与标准测试向量一致', () => {
    expect(crc32('')).toBe(0)
    expect(crc32('123456789')).toBe(0xcbf43926)
    expect(crc32('a')).toBe(0xe8b7be43)
    expect(crc32Hex('123456789')).toBe('cbf43926')
  })

  it('SHA-256 与标准向量一致（片级强校验取前 8 字节）', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(sha16Hex('abc')).toBe('ba7816bf8f01cfea')
  })

  it('job id 固定 8 位小写 hex，注入随机源可得确定值', () => {
    expect(randomJobId(() => 0.5)).toBe('88888888')
    expect(randomJobId()).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('载荷编码', () => {
  it('hex / base64 往返一致（含 0x00 与 0xFF 等二进制字节）', () => {
    const bytes = randomBytes(257, 7)

    const hex = encodeBytes(bytes, 'hex')
    expect(hex).toMatch(/^[0-9A-F]+$/)
    expect(hex).not.toMatch(/\s/)
    expect([...decodeBytes(hex, 'hex')]).toEqual([...bytes])

    const b64 = encodeBytes(bytes, 'b64')
    expect(b64).not.toMatch(/\s/)
    expect([...decodeBytes(b64, 'b64')]).toEqual([...bytes])
  })

  it('hex 载荷做严格校验', () => {
    expect(() => decodeBytes('ABC', 'hex')).toThrow(/奇数/)
    expect(() => decodeBytes('ABZZ', 'hex')).toThrow(/非十六进制/)
  })

  it('base64 载荷拒绝非法字符与无法原样还原的内容', () => {
    expect(() => decodeBytes('abc', 'b64')).toThrow(/不合法/)
    expect(() => decodeBytes('a-b=', 'b64')).toThrow(/不合法/)
    expect(() => decodeBytes('AB==', 'b64')).toThrow(/原样还原/)
  })

  it('hex / b64 编码不接受 txt（避免调用方走错分支）', () => {
    expect(() => encodeBytes('x', 'txt' as never)).toThrow(FrameError)
    expect(() => decodeBytes('x', 'txt' as never)).toThrow(FrameError)
  })

  it('gzb64 只能经由 encodePayload / decodePayload 使用', () => {
    expect(() => encodeBytes('x', 'gzb64')).toThrow(/encodePayload/)
    expect(() => decodeBytes('x', 'gzb64')).toThrow(/decodePayload/)
  })

  it('gzb64：先压缩再 Base64，线上字节是压缩后的长度', () => {
    const text = new TextEncoder().encode('Typer 文件传输压缩自检。'.repeat(40))
    const { wire, payload } = encodePayload(text, 'gzb64')

    expect(wire.length).toBeLessThan(text.length / 2)
    expect(payload.length).toBe(Math.ceil(wire.length / 3) * 4)
    expect(payload).not.toMatch(/[\s]/)
    expect([...fromWireBytes(decodePayload(payload, 'gzb64'), 'gzb64')]).toEqual([...text])
  })

  it('gzb64：不可压缩数据的线上字节略大于原始片，但仍能逐字节还原', () => {
    const bytes = randomBytes(4096, 11)
    const { wire, payload } = encodePayload(bytes, 'gzb64')

    expect(wire.length).toBeGreaterThanOrEqual(bytes.length)
    expect([...fromWireBytes(decodePayload(payload, 'gzb64'), 'gzb64')]).toEqual([...bytes])
  })

  it('gzb64：被截断的压缩片解压时报错，而不是产出错误数据', () => {
    const { wire } = encodePayload(new TextEncoder().encode('x'.repeat(500)), 'gzb64')
    expect(() => fromWireBytes(wire.subarray(0, wire.length - 6), 'gzb64')).toThrow(FrameError)
  })

  it('txt 转义：往返一致且不含空白与控制字符', () => {
    const text = '第一行\r\n第二行 空格\tTab\\反斜杠\u0000\u001b结束\u00a0\u3000😀'
    const payload = escapeText(text)
    expect(payload).not.toMatch(/[\s\uFEFF]/)
    expect(unescapeText(payload)).toBe(text)
    expect(payload).toContain('\\r\\n')
    expect(payload).toContain('\\t')
    expect(payload).toContain('\\\\')
    expect(payload).toContain('\\x00')
    expect(payload).toContain('\\x1b')
    // 空格必须转义：帧是空格分隔的，载荷里的空格会把字段切错
    expect(payload).toContain('\\s')
    // 非 ASCII 空白用 \uXXXX
    expect(payload).toContain('\\u00a0')
    expect(payload).toContain('\\u3000')
  })

  it('反转义宽容未知序列，但对残缺序列报错', () => {
    expect(unescapeText('a\\db')).toBe('a\\db')
    expect(unescapeText('a\\sb')).toBe('a b')
    expect(() => unescapeText('abc\\')).toThrow(/反斜杠/)
    expect(() => unescapeText('a\\xzz')).toThrow(/\\x/)
    expect(() => unescapeText('a\\uzzzz')).toThrow(/\\u/)
  })
})

describe('帧构造与解析', () => {
  const begin = {
    job: 'a1b2c3d4',
    total: 2,
    size: 300,
    enc: 'hex' as const,
    chunk: 256,
    name: '示例 文件.bin',
    sha256: sha256Hex('demo')
  }

  it('开始帧往返（文件名走 base64url，可含空格与中文）', () => {
    const frame = parseFrame(buildBeginFrame(begin))
    if (frame.kind !== 'begin') throw new Error('应为开始帧')
    expect(frame.name).toBe('示例 文件.bin')
    expect(frame.total).toBe(2)
    expect(frame.size).toBe(300)
    expect(frame.enc).toBe('hex')
    expect(frame.chunk).toBe(256)
    expect(frame.sha256).toBe(begin.sha256)
  })

  it('省略文件名时用 `-` 占位，解析为 null', () => {
    const frame = parseFrame(buildBeginFrame({ ...begin, name: null }))
    if (frame.kind !== 'begin') throw new Error('应为开始帧')
    expect(frame.name).toBeNull()
  })

  it('数据帧与结束帧往返', () => {
    const bytes = randomBytes(16, 3)
    const data = parseFrame(
      buildDataFrame({
        job: 'a1b2c3d4',
        seq: 1,
        total: 2,
        bytes: bytes.length,
        enc: 'hex',
        crc32: crc32Hex(bytes),
        sha16: sha16Hex(bytes),
        payload: encodeBytes(bytes, 'hex')
      })
    )
    if (data.kind !== 'data') throw new Error('应为数据帧')
    expect(data.seq).toBe(1)
    expect([...verifyDataFrame(data, decodeBytes(data.payload, 'hex'))]).toEqual([...bytes])

    const end = parseFrame(
      buildEndFrame({ job: 'a1b2c3d4', total: 2, size: 300, sha256: begin.sha256 })
    )
    if (end.kind !== 'end') throw new Error('应为结束帧')
    expect(end.size).toBe(300)
    expect(end.sha256).toBe(begin.sha256)
  })

  it('数据帧拒绝空载荷与含空白的载荷', () => {
    const meta = {
      job: 'a1b2c3d4',
      seq: 0,
      total: 1,
      bytes: 1,
      enc: 'hex' as const,
      crc32: '00000000',
      sha16: '0000000000000000'
    }
    expect(() => buildDataFrame({ ...meta, payload: '' })).toThrow(/载荷/)
    expect(() => buildDataFrame({ ...meta, payload: 'AA BB' })).toThrow(/载荷/)
  })

  it('续传令往返（区间会被展开成片号）', () => {
    const frame = parseFrame(
      buildResumeToken({ job: 'a1b2c3d4', total: 10, missing: [3, 5, 4, 7] })
    )
    if (frame.kind !== 'resume') throw new Error('应为续传令')
    expect(frame.total).toBe(10)
    expect(frame.missing).toEqual([3, 4, 5, 7])
    expect(buildResumeToken({ job: 'a1b2c3d4', total: 10, missing: [] })).toMatch(/ -$/)
  })

  it('畸形帧被拒绝且错误码分类明确', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['@TYPER1/X 1 2 3', 'marker'],
      ['@TYPER1/D a1b2c3d4 0 1 16', 'field'],
      ['@TYPER1/B a1b2c3d4 1 1 hex 256 - zz', 'field'],
      [`@TYPER1/B a1b2c3d4 1 1 qqq 256 - ${sha256Hex('x')}`, 'enc'],
      ['@TYPER1/D ZZZZ 0 1 1 00000000 0000000000000000 hex AA', 'job'],
      ['@TYPER1/D a1b2c3d4 0 1 1 0000000 0000000000000000 hex AA', 'field'],
      ['@TYPER1/E a1b2c3d4 1 1 zz', 'field']
    ]
    for (const [line, code] of cases) {
      let caught: unknown
      try {
        parseFrame(line)
      } catch (error) {
        caught = error
      }
      expect(caught, `期望 ${line || '(空行)'} 报错`).toBeInstanceOf(FrameError)
      expect((caught as FrameError).code).toBe(code)
      expect(ERROR_HINTS[(caught as FrameError).code]).toBeTruthy()
    }
  })

  it('超过帧长上限的行报 overlong', () => {
    const line = `@TYPER1/D a1b2c3d4 0 1 1 00000000 0000000000000000 hex ${'A'.repeat(MAX_FRAME_CHARS)}`
    expect(() => parseFrame(line)).toThrow(/上限/)
  })

  it('isFrameLine 能识别帧文本（供文本页判断"粘贴进来的是帧"）', () => {
    expect(isFrameLine(buildBeginFrame(begin))).toBe(true)
    expect(isFrameLine('  @TYPER1/D a1 0 1 1 0 0 hex AA  ')).toBe(true)
    expect(isFrameLine('普通文本 @TYPER1/B')).toBe(false)
    expect(isFrameLine('')).toBe(false)
  })
})

describe('片级与整文件校验', () => {
  const bytes = randomBytes(32, 11)

  it('数据帧校验：长度、CRC32、SHA-16 任一不符都失败', () => {
    const frame = parseFrame(
      buildDataFrame({
        job: 'a1b2c3d4',
        seq: 0,
        total: 1,
        bytes: bytes.length,
        enc: 'hex',
        crc32: crc32Hex(bytes),
        sha16: sha16Hex(bytes),
        payload: encodeBytes(bytes, 'hex')
      })
    )
    if (frame.kind !== 'data') throw new Error('应为数据帧')
    expect(verifyDataFrame(frame, bytes).length).toBe(32)
    expect(() => verifyDataFrame(frame, bytes.subarray(0, 31))).toThrow(/长度不符/)
    expect(() => verifyDataFrame({ ...frame, crc32: '00000000' }, bytes)).toThrow(/片校验失败/)
    expect(() => verifyDataFrame({ ...frame, sha16: '0000000000000000' }, bytes)).toThrow(
      /强校验失败/
    )
  })

  it('整文件校验：大小与哈希都要对', () => {
    const digest = sha256Hex(bytes)
    expect(verifyIntegrity(bytes, digest, 32).length).toBe(32)
    expect(() => verifyIntegrity(bytes, digest, 33)).toThrow(/大小不符/)
    expect(() => verifyIntegrity(bytes, sha256Hex('other'), 32)).toThrow(/整文件校验失败/)
  })
})

describe('分片规划', () => {
  it('片数：空文件 0 片，整除与不整除都对', () => {
    expect(chunkCount(0, 1024)).toBe(0)
    expect(chunkCount(1, 1024)).toBe(1)
    expect(chunkCount(2048, 1024)).toBe(2)
    expect(chunkCount(2049, 1024)).toBe(3)
  })

  it('片偏移与长度正确，越界报错', () => {
    expect(chunkSlice(2049, 1024, 0)).toEqual({ offset: 0, bytes: 1024 })
    expect(chunkSlice(2049, 1024, 2)).toEqual({ offset: 2048, bytes: 1 })
    expect(() => chunkSlice(2049, 1024, 3)).toThrow(/超出范围/)
    expect(() => chunkCount(100, 0)).toThrow(/片大小不合法/)
  })

  it('txt 分片按字符边界切分，不会劈开多字节字符', () => {
    const text = '中文abc中文'
    const chunks = planTextChunks(text, 6)
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.bytes).toBeLessThanOrEqual(6)
      expect(chunk.chars).toBe(chunk.text.length)
    }
  })

  it('txt 分片支持自定义 charset 字节长度（如 GBK 中文占 2 字节）', () => {
    /**
     * @description 按 GBK 规则估算字符串的字节长度
     * @param chunk 文本片
     * @returns 字节数
     */
    const gbkLength = (chunk: string): number => chunk.length * 2
    const chunks = planTextChunks('中文', 3, gbkLength)
    expect(chunks.length).toBe(2)
    expect(chunks.every((chunk) => chunk.bytes <= 3)).toBe(true)
  })

  it('单字符超过片大小上限时明确报错', () => {
    expect(() => planTextChunks('中', 2)).toThrow(/超过片大小上限/)
  })

  it('帧长估算覆盖各编码与显式载荷长度', () => {
    const base = { seq: 0, total: 10, bytes: 1024, job: 'a1b2c3d4' }
    const hex = estimateDataFrameChars({ ...base, enc: 'hex' })
    expect(hex).toBeGreaterThan(2048)
    expect(estimateDataFrameChars({ ...base, enc: 'b64' })).toBeLessThan(hex)
    expect(estimateDataFrameChars({ ...base, enc: 'txt', payloadChars: 5 })).toBeLessThan(hex)
    // gzb64 的 bytes 已是压缩后长度，载荷按 Base64 折算；头部只多出编码名的两个字符
    expect(estimateDataFrameChars({ ...base, enc: 'gzb64' })).toBe(
      estimateDataFrameChars({ ...base, enc: 'b64' }) + 2
    )
  })
})

describe('片号集合', () => {
  it('区间语法解析：排序、去重、支持多种分隔符', () => {
    expect(parseIndexList('3,5,12-14', 100)).toEqual([3, 5, 12, 13, 14])
    expect(parseIndexList('1 2,1;3', 100)).toEqual([1, 2, 3])
    expect(parseIndexList('', 100)).toEqual([])
    expect(() => parseIndexList('5-3', 100)).toThrow(/起点大于终点/)
    expect(() => parseIndexList('x', 100)).toThrow(/无法解析/)
    expect(() => parseIndexList('100', 100)).toThrow(/超出总数/)
  })

  it('片号集合格式化回紧凑区间', () => {
    expect(formatIndexList([], 10)).toBe('')
    expect(formatIndexList([3], 10)).toBe('3')
    expect(formatIndexList([3, 4, 5, 7], 10)).toBe('3-5,7')
    expect(() => formatIndexList([10], 10)).toThrow(/超出总数/)
  })

  it('缺失片计算与 from / only 归一化', () => {
    expect(missingIndexes(4, [0, 2])).toEqual([1, 3])
    expect(resolveIndexes(4)).toEqual([0, 1, 2, 3])
    expect(resolveIndexes(4, { from: 2 })).toEqual([2, 3])
    expect(resolveIndexes(4, { from: 2, only: '0,3' })).toEqual([0, 3])
    expect(resolveIndexes(4, { from: 4 })).toEqual([])
    expect(() => resolveIndexes(4, { from: 5 })).toThrow(/起始片号不合法/)
  })
})

describe('行切分与清理', () => {
  it('sanitizeLine 去掉 bracketed-paste 标记与首尾空白', () => {
    expect(sanitizeLine('\u001b[200~@TYPER1/D a 0 1 1 0 0 hex AA\u001b[201~')).toBe(
      '@TYPER1/D a 0 1 1 0 0 hex AA'
    )
    expect(sanitizeLine('  @TYPER1/B x  \r')).toBe('@TYPER1/B x')
    expect(sanitizeLine('a\u0007b')).toBe('ab')
  })

  it('行切分器支持 \\n、\\r\\n 与裸 \\r（raw 模式的回车）', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c'])
    expect(splitter.flush()).toEqual(['d'])
  })

  it('行切分器能处理跨 chunk 断开的一行', () => {
    const splitter = createLineSplitter()
    const text = '@TYPER1/D a1b2 0 1 3 0 0 hex AABBCC\n'
    const bytes = Buffer.from(text, 'utf8')
    expect(splitter.push(bytes.subarray(0, 10))).toEqual([])
    expect(splitter.push(bytes.subarray(10))).toEqual([text.trim()])
  })

  it('超长行只在 flush 时集中报错（避免逐块误报）', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('x'.repeat(MAX_FRAME_CHARS + 5000))).toEqual([])
    expect(() => splitter.flush()).toThrow(/超长行/)
  })
})

describe('端到端（纯内存）：分片 → 解析 → 校验 → 合并', () => {
  it('hex 编码、含 0x00/0xFF 的二进制文件逐字节还原', () => {
    const source = randomBytes(5000, 42)
    const merged = roundTrip(source, 1024, 'hex')
    expect([...merged]).toEqual([...source])
    expect(sha256Hex(merged)).toBe(sha256Hex(source))
  })

  it('b64 编码、非整除片大小同样逐字节还原', () => {
    const source = randomBytes(1000, 9)
    expect([...roundTrip(source, 333, 'b64')]).toEqual([...source])
  })

  it('gzb64：按压缩后的字节声明片长与校验，合并后逐字节还原', () => {
    const source = new TextEncoder().encode('文件传输 gzb64 端到端自检。'.repeat(60))
    const chunkBytes = 512
    const job = 'a1b2c3d4'
    const total = chunkCount(source.length, chunkBytes)
    const lines: string[] = []

    for (let seq = 0; seq < total; seq++) {
      const { offset, bytes } = chunkSlice(source.length, chunkBytes, seq)
      const slice = source.subarray(offset, offset + bytes)
      const { wire, payload } = encodePayload(slice, 'gzb64')
      lines.push(
        buildDataFrame({
          job,
          seq,
          total,
          bytes: wire.length,
          crc32: crc32Hex(wire),
          sha16: sha16Hex(wire),
          enc: 'gzb64',
          payload
        })
      )
    }

    const merged: number[] = []
    for (const line of lines) {
      const frame = parseFrame(line)
      expect(frame.kind).toBe('data')
      if (frame.kind !== 'data') continue
      const wire = verifyDataFrame(frame, decodePayload(frame.payload, 'gzb64'))
      merged.push(...fromWireBytes(wire, 'gzb64'))
    }

    expect(merged).toEqual([...source])
    // 压缩确实生效：线上字符数远小于十六进制（2 倍）与原始字节数
    expect(lines.join('').length).toBeLessThan(source.length)
  })

  it('空文件：没有数据帧，只有开始与结束帧', () => {
    expect(roundTrip(new Uint8Array(0), 1024, 'hex').length).toBe(0)
    expect(chunkCount(0, 1024)).toBe(0)
  })

  it('单字节文件', () => {
    expect([...roundTrip(new Uint8Array([0xff]), 1024, 'hex')]).toEqual([0xff])
  })
})
