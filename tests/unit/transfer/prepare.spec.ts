import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFrame, unescapeText } from '@tools/lib/frame.mjs'
import { TransferError, prepareTransfer } from '@main/transfer/prepare'
import type { TransferPrepareProgress } from '@shared/transfer/transfer'
import type { PreparedTransfer } from '@main/transfer/prepare'

let work: string
const created: PreparedTransfer[] = []

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'typer-prepare-'))
  created.length = 0
})

afterEach(async () => {
  for (const job of created) await job.dispose()
  rmSync(work, { recursive: true, force: true })
})

function writeSource(name: string, data: Buffer | string): string {
  const path = join(work, name)
  writeFileSync(path, data)
  return path
}

function binary(size: number, seed = 3): Buffer {
  const buffer = Buffer.allocUnsafe(size)
  let state = seed >>> 0
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) >>> 0
    buffer[index] = index % 41 === 0 ? 0 : (state >>> 17) & 0xff
  }
  return buffer
}

async function prepare(
  path: string,
  overrides: Partial<{
    encoding: 'hex' | 'b64' | 'txt'
    chunkBytes: number
    maxFrameChars: number
  }> = {},
  deps: {
    onProgress?: (progress: TransferPrepareProgress) => void
    shouldCancel?: () => boolean
  } = {}
): Promise<PreparedTransfer> {
  const job = await prepareTransfer({
    path,
    options: {
      encoding: overrides.encoding ?? 'hex',
      chunkBytes: overrides.chunkBytes ?? 256,
      maxFrameChars: overrides.maxFrameChars ?? 4096
    },
    deps
  })
  created.push(job)
  return job
}

describe('prepareTransfer · 基本摘要', () => {
  it('hex：片数、末片大小、整文件哈希、帧长统计都正确', async () => {
    const source = binary(600)
    const path = writeSource('src.bin', source)
    const job = await prepare(path, { chunkBytes: 256 })

    expect(job.summary.total).toBe(3)
    expect(job.summary.tailBytes).toBe(88)
    expect(job.summary.size).toBe(600)
    expect(job.summary.sha256).toBe(createHash('sha256').update(source).digest('hex'))
    expect(job.summary.encoding).toBe('hex')
    expect(job.summary.chunkBytes).toBe(256)
    expect(job.summary.job).toMatch(/^[0-9a-f]{8}$/)
    expect(job.summary.preview).toHaveLength(16)
    expect(job.summary.preview[0]?.offset).toBe(0)
    expect(job.summary.preview[0]?.hex.split(' ')).toHaveLength(16)
    expect(job.summary.peakFrameChars).toBeLessThanOrEqual(job.summary.maxFrameChars)
    // 每片 = 头部 + 2×字节数，再加行尾；至少一顿饭的字符量
    expect(job.summary.frameChars).toBeGreaterThan(600 * 2)
    expect(job.summary.typedActions).toBeGreaterThan(600 * 2)
  })

  it('空文件：0 片、0 字节尾部，帧仍然只有开始与结束帧', async () => {
    const path = writeSource('empty.bin', Buffer.alloc(0))
    const job = await prepare(path)

    expect(job.summary.total).toBe(0)
    expect(job.summary.tailBytes).toBe(0)
    expect(job.summary.frameChars).toBe(job.beginFrame().length + 1 + job.endFrame().length + 1)
    await expect(job.renderFrame(0)).rejects.toThrow(/超出范围/)
  })

  it('开始帧/结束帧包含任务标识、规模与整文件哈希', async () => {
    const source = binary(300)
    const job = await prepare(writeSource('src.bin', source), { chunkBytes: 256 })

    const begin = parseFrame(job.beginFrame())
    if (begin.kind !== 'begin') throw new Error('应为开始帧')
    expect(begin.job).toBe(job.summary.job)
    expect(begin.total).toBe(2)
    expect(begin.size).toBe(300)
    expect(begin.enc).toBe('hex')
    expect(begin.chunk).toBe(256)
    expect(begin.sha256).toBe(job.summary.sha256)

    const end = parseFrame(job.endFrame())
    if (end.kind !== 'end') throw new Error('应为结束帧')
    expect(end.job).toBe(job.summary.job)
    expect(end.sha256).toBe(job.summary.sha256)
    expect(end.size).toBe(300)
  })
})

describe('prepareTransfer · 逐片渲染', () => {
  it('hex：每片解码后与源文件对应区间逐字节一致，帧头字段与内容自洽', async () => {
    const source = binary(1000)
    const job = await prepare(writeSource('src.bin', source), { chunkBytes: 256 })

    for (let index = 0; index < job.summary.total; index++) {
      const line = await job.renderFrame(index)
      const frame = parseFrame(line)
      if (frame.kind !== 'data') throw new Error('应为数据帧')
      expect(frame.seq).toBe(index)
      expect(frame.total).toBe(job.summary.total)
      expect(frame.bytes).toBe(Math.min(256, source.length - index * 256))

      const payload = frame.payload
      const bytes = Buffer.from(payload.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [])
      expect(bytes.equals(source.subarray(index * 256, index * 256 + bytes.length))).toBe(true)
      // 帧长不变量：统计值必须与实际渲染结果一致（进度与 ETA 靠它）
      expect(job.frameChars(index)).toBe(line.length)
    }
  })

  it('b64：同样逐字节还原', async () => {
    const source = binary(700)
    const job = await prepare(writeSource('src.bin', source), { encoding: 'b64', chunkBytes: 256 })

    const line = await job.renderFrame(2)
    const frame = parseFrame(line)
    if (frame.kind !== 'data') throw new Error('应为数据帧')
    const bytes = Buffer.from(frame.payload, 'base64')
    expect(bytes.equals(source.subarray(512, 512 + bytes.length))).toBe(true)
    expect(frame.enc).toBe('b64')
  })

  it('大文件也是流式读取：首片与末片都正确（内存恒定）', async () => {
    const size = 5 * 1024 * 1024
    const source = binary(size, 9)
    const job = await prepare(writeSource('big.bin', source), {
      chunkBytes: 4096,
      maxFrameChars: 16384
    })

    expect(job.summary.total).toBe(1280)
    expect(job.summary.sha256).toBe(createHash('sha256').update(source).digest('hex'))

    const first = parseFrame(await job.renderFrame(0))
    const last = parseFrame(await job.renderFrame(job.summary.total - 1))
    if (first.kind !== 'data' || last.kind !== 'data') throw new Error('应为数据帧')
    expect(first.payload.length).toBe(4096 * 2)
    expect(last.bytes).toBe(4096)
  })
})

describe('prepareTransfer · txt 编码', () => {
  it('按字符边界切分，转义载荷不含空白，解码回原文', async () => {
    const text = '第一行内容\r\n第二行 带空格\tTab\r\nemoji 😀 与全角空格　结束'
    const path = writeSource('note.txt', Buffer.from(text, 'utf8'))
    // 片大小下限是 64 字节（TRANSFER_LIMITS），所以这里用 64 验证"按字符边界切分"
    const job = await prepare(path, { encoding: 'txt', chunkBytes: 64 })

    expect(job.summary.encoding).toBe('txt')
    expect(job.summary.chunkBytes).toBe(64)
    expect(job.summary.looksUtf8).toBe(true)
    expect(job.summary.total).toBeGreaterThan(1)

    let rebuilt = ''
    let bytesTotal = 0
    for (let index = 0; index < job.summary.total; index++) {
      const line = await job.renderFrame(index)
      const frame = parseFrame(line)
      if (frame.kind !== 'data') throw new Error('应为数据帧')
      expect(frame.bytes).toBeGreaterThan(0)
      expect(frame.bytes).toBeLessThanOrEqual(64)
      rebuilt += unescapeText(frame.payload)
      bytesTotal += frame.bytes
      // 含空格的载荷必须被转义：帧是空格分隔的
      expect(frame.payload).not.toMatch(/\s/)
      expect(job.frameChars(index)).toBe(line.length)
    }

    // 逐字节还原（切分没有劈开多字节字符）
    expect(rebuilt).toBe(text)
    expect(bytesTotal).toBe(Buffer.byteLength(text, 'utf8'))
    expect(job.summary.tailBytes).toBeLessThanOrEqual(64)
  })

  it('拒绝 GBK 文本（字节无法逐字节还原）', async () => {
    // GBK 的 "中文" = D6 D0 CE C4
    const path = writeSource('gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
    await expect(prepare(path, { encoding: 'txt' })).rejects.toThrow(/UTF-8/)
  })

  it('拒绝带 BOM 的文件（文本与字节不再是同一份数据）', async () => {
    const path = writeSource(
      'bom.txt',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')])
    )
    await expect(prepare(path, { encoding: 'txt' })).rejects.toThrow(/BOM/)
  })

  it('超过 txt 上限时报错并建议改用 hex/b64', async () => {
    // 用一个稀疏的"大文件"来避免真的写 64 MiB 以上数据
    const path = join(work, 'huge.txt')
    writeFileSync(path, Buffer.from('x'))
    const { truncateSync } = await import('node:fs')
    truncateSync(path, 65 * 1024 * 1024)
    await expect(prepare(path, { encoding: 'txt' })).rejects.toThrow(/64 MB/)
  })
})

describe('prepareTransfer · 校验与取消', () => {
  it('帧长超限时提前失败并给出建议片大小', async () => {
    const job = prepare(writeSource('src.bin', binary(2048)), {
      chunkBytes: 1024,
      maxFrameChars: 512
    })
    await expect(job).rejects.toThrow(/超过上限/)
    await expect(job).rejects.toThrow(/片大小降到/)
  })

  it('片大小与帧长上限都会被夹取到合法区间', async () => {
    const job = await prepare(writeSource('src.bin', binary(100)), {
      chunkBytes: 0,
      maxFrameChars: 1
    })
    expect(job.summary.chunkBytes).toBeGreaterThanOrEqual(64)
    expect(job.summary.maxFrameChars).toBeGreaterThanOrEqual(256)
  })

  it('取消准备：哈希阶段立即中止', async () => {
    const path = writeSource('src.bin', binary(10_000))
    let calls = 0
    await expect(prepare(path, {}, { shouldCancel: () => calls++ > 0 })).rejects.toThrow(/取消/)
  })

  it('哈希进度单调递增并最终等于文件大小', async () => {
    const size = 3 * 1024 * 1024
    const path = writeSource('src.bin', binary(size))
    const hashSteps: number[] = []
    await prepare(
      path,
      { chunkBytes: 1024 },
      {
        onProgress: (progress) => {
          if (progress.phase === 'hash') hashSteps.push(progress.done)
        }
      }
    )

    expect(hashSteps.length).toBeGreaterThan(0)
    expect(hashSteps).toEqual([...hashSteps].sort((a, b) => a - b))
    expect(hashSteps.at(-1)).toBe(size)
  })

  it('文件不存在 / 不是普通文件时给出可读错误', async () => {
    await expect(prepare(join(work, 'nope.bin'))).rejects.toBeInstanceOf(TransferError)
    await expect(prepare(join(work, 'nope.bin'))).rejects.toThrow(/无法读取文件/)
    await expect(prepare(work)).rejects.toThrow(/不是普通文件/)
  })

  it('dispose 可以重复调用且不抛错', async () => {
    const job = await prepare(writeSource('src.bin', binary(100)))
    await job.dispose()
    await job.dispose()
  })
})
