import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decodeSymbols,
  parseFrame,
  payloadCharsFor,
  symbolCount,
  verifyDataFrame,
  verifyIntegrity
} from '@main/util/frame'
import { TransferError, prepareTransfer, type PreparedTransfer } from '@main/transfer/prepare'
import type { TransferPrepareOptions, TransferPrepareProgress } from '@shared/transfer/transfer'

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

/**
 * @description 把内容写进测试临时目录并返回路径
 * @param name 文件名
 * @param data 文件内容
 * @returns 文件绝对路径
 */
function writeSource(name: string, data: Buffer | string): string {
  const path = join(work, name)
  writeFileSync(path, data)
  return path
}

/**
 * @description 生成确定性二进制内容（含 0x00，覆盖二进制边界）
 * @param size 字节数
 * @param seed 随机种子
 * @returns 二进制内容
 */
function binary(size: number, seed = 3): Buffer {
  const buffer = Buffer.allocUnsafe(size)
  let state = seed >>> 0
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) >>> 0
    buffer[index] = index % 41 === 0 ? 0 : (state >>> 17) & 0xff
  }
  return buffer
}

/**
 * @description 用默认选项准备一次传输，并登记到 afterEach 的释放列表
 * @param path 源文件路径
 * @param overrides 覆盖默认选项
 * @param deps 进度回调与取消检查
 * @returns 准备好的传输任务
 */
async function prepare(
  path: string,
  overrides: Partial<TransferPrepareOptions> = {},
  deps: {
    onProgress?: (progress: TransferPrepareProgress) => void
    shouldCancel?: () => boolean
  } = {}
): Promise<PreparedTransfer> {
  const job = await prepareTransfer({
    path,
    options: {
      alphabet: overrides.alphabet ?? 'hex',
      compression: overrides.compression ?? 'none',
      quality: overrides.quality ?? 9,
      mode: overrides.mode ?? 'term',
      chunkBytes: overrides.chunkBytes ?? 1024,
      maxFrameChars: overrides.maxFrameChars ?? 65536
    },
    deps
  })
  created.push(job)
  return job
}

/**
 * @description 把一帧解回线上字节
 * @param job 传输任务
 * @param index 片号
 * @returns 线上字节
 */
async function renderWire(job: PreparedTransfer, index: number): Promise<Buffer> {
  const frame = parseFrame(await job.renderFrame(index))
  if (frame.kind !== 'data') throw new Error('应为数据帧')
  const bytes = decodeSymbols(frame.payload, job.summary.alphabet, frame.bytes)
  verifyDataFrame(frame, bytes)
  return Buffer.from(bytes)
}

describe('prepareTransfer · 不压缩（原字节）', () => {
  it('片数、末片、哈希与帧长统计都正确', async () => {
    const source = binary(2500)
    const job = await prepare(writeSource('src.bin', source), {
      chunkBytes: 1024,
      alphabet: 'ascii32'
    })

    expect(job.summary.compression).toBe('none')
    expect(job.summary.total).toBe(3)
    expect(job.summary.tailBytes).toBe(452)
    expect(job.summary.size).toBe(2500)
    expect(job.summary.wireBytes).toBe(2500)
    expect(job.summary.sha256).toBe(createHash('sha256').update(source).digest('hex'))
    expect(job.summary.job).toMatch(/^[0-9a-f]{8}$/)
    expect(job.summary.preview).toHaveLength(16)
    expect(job.summary.preview[0]?.hex.split(' ')).toHaveLength(16)
    expect(job.summary.peakFrameChars).toBeLessThanOrEqual(job.summary.maxFrameChars)
  })

  it('5 位档：字符串长度约为字节数的 1.6 倍（比十六进制少 20%）', async () => {
    const source = binary(20_000)
    const job = await prepare(writeSource('src.bin', source), {
      alphabet: 'ascii32',
      chunkBytes: 4096
    })
    const payloadChars = 20_000 * (8 / 5)
    expect(job.summary.frameChars).toBeGreaterThan(payloadChars)
    expect(job.summary.frameChars).toBeLessThan(payloadChars * 1.06)
  })

  it('空文件：0 片、只有开始与结束帧，渲染任何片都报越界', async () => {
    const job = await prepare(writeSource('empty.bin', Buffer.alloc(0)))
    expect(job.summary.total).toBe(0)
    expect(job.summary.wireBytes).toBe(0)
    expect(job.summary.frameChars).toBe(job.beginFrame().length + 1 + job.endFrame().length + 1)
    await expect(job.renderFrame(0)).rejects.toThrow(/超出范围/)
  })

  it('开始/结束帧包含任务标识、规模、压缩方式与整文件哈希', async () => {
    const source = binary(2500)
    const job = await prepare(writeSource('src.bin', source), { chunkBytes: 1024 })

    const begin = parseFrame(job.beginFrame())
    if (begin.kind !== 'begin') throw new Error('应为开始帧')
    expect(begin.job).toBe(job.summary.job)
    expect(begin.total).toBe(3)
    expect(begin.size).toBe(2500)
    expect(begin.wire).toBe(2500)
    expect(begin.chunk).toBe(1024)
    expect(begin.alphabet).toBe('hex')
    expect(begin.compression).toBe('none')
    expect(begin.mode).toBe('term')
    expect(begin.sha256).toBe(job.summary.sha256)
    expect(begin.name).toBe('src.bin')

    const end = parseFrame(job.endFrame())
    if (end.kind !== 'end') throw new Error('应为结束帧')
    expect(end).toMatchObject({ job: job.summary.job, size: 2500, wire: 2500 })
    expect(end.sha256).toBe(job.summary.sha256)
  })
})

describe('prepareTransfer · 逐片渲染', () => {
  it.each(['ascii32', 'ascii64', 'hex'] as const)(
    '%s：每片解码后与源区间逐字节一致',
    async (alphabet) => {
      const source = binary(2500)
      const job = await prepare(writeSource('src.bin', source), { alphabet, chunkBytes: 1024 })

      for (let index = 0; index < job.summary.total; index++) {
        const line = await job.renderFrame(index)
        const frame = parseFrame(line)
        if (frame.kind !== 'data') throw new Error('应为数据帧')
        expect(frame.seq).toBe(index)
        expect(frame.bytes).toBe(Math.min(1024, source.length - index * 1024))
        const bytes = decodeSymbols(frame.payload, alphabet, frame.bytes)
        expect(
          Buffer.compare(
            Buffer.from(bytes),
            source.subarray(index * 1024, index * 1024 + bytes.length)
          )
        ).toBe(0)
        // 帧长不变量：统计值必须与实际渲染结果一致（进度与 ETA 靠它）
        expect(job.frameChars(index)).toBe(line.length)
      }
    }
  )

  it('大文件也是流式读取：首片与末片都正确', async () => {
    const size = 4 * 1024 * 1024
    const source = binary(size, 9)
    const job = await prepare(writeSource('big.bin', source), {
      alphabet: 'ascii32',
      chunkBytes: 16384
    })

    expect(job.summary.total).toBe(256)
    expect(job.summary.sha256).toBe(createHash('sha256').update(source).digest('hex'))

    const first = parseFrame(await job.renderFrame(0))
    const last = parseFrame(await job.renderFrame(job.summary.total - 1))
    if (first.kind !== 'data' || last.kind !== 'data') throw new Error('应为数据帧')
    expect(first.bytes).toBe(16384)
    expect(last.bytes).toBe(16384)
  })

  it('单行模式不把行尾算进字符数', async () => {
    const lineMode = await prepare(writeSource('line.bin', binary(2500)), {
      chunkBytes: 1024,
      mode: 'line'
    })
    let sum = lineMode.beginFrame().length + lineMode.endFrame().length
    for (let index = 0; index < lineMode.summary.total; index++) {
      sum += (await lineMode.renderFrame(index)).length
    }
    expect(lineMode.summary.frameChars).toBe(sum)
  })
})

describe('prepareTransfer · 整文件压缩', () => {
  it('文本显著变小，接收端解压后逐字节一致', async () => {
    const text = '压缩传输自检：文件、代码与 JSON 都能显著变小。\n'.repeat(200)
    const source = Buffer.from(text, 'utf8')
    const job = await prepare(writeSource('note.txt', source), {
      alphabet: 'ascii32',
      compression: 'br',
      chunkBytes: 2048
    })

    expect(job.summary.compression).toBe('br')
    expect(job.summary.wireBytes).toBeLessThan(source.length / 4)
    // 5 位档下字符数远少于原始字节数
    expect(job.summary.frameChars).toBeLessThan(source.length)

    const parts: Buffer[] = []
    for (let index = 0; index < job.summary.total; index++) {
      parts.push(await renderWire(job, index))
    }
    expect(brotliDecompressSync(Buffer.concat(parts)).equals(source)).toBe(true)
    verifyIntegrity(source, job.summary.sha256, job.summary.size)
  })

  it('auto：已压缩数据（随机字节）自动跳过压缩，线上字节等于源大小', async () => {
    const source = binary(8192, 5)
    const job = await prepare(writeSource('rand.bin', source), {
      compression: 'auto',
      chunkBytes: 1024
    })
    expect(job.summary.compression).toBe('none')
    expect(job.summary.wireBytes).toBe(source.length)
    expect(job.summary.compressionNote).toMatch(/不可压缩|跳过/)
  })

  it('auto：文本自动选择压缩', async () => {
    const source = Buffer.from('hello world\n'.repeat(500), 'utf8')
    const job = await prepare(writeSource('text.txt', source), {
      compression: 'auto',
      chunkBytes: 1024
    })
    expect(job.summary.compression).toBe('br')
    expect(job.summary.wireBytes).toBeLessThan(source.length)
  })

  it('压完反而更大时回退为原字节（不留临时文件）', async () => {
    const source = binary(1, 1)
    const job = await prepare(writeSource('one.bin', source), { compression: 'br' })
    expect(job.summary.compression).toBe('none')
    expect(job.summary.wireBytes).toBe(1)
  })

  it('压缩产物超过管道高水位时也能完成（回归：终点用没人读的 Transform 会永久挂起）', async () => {
    // 真随机数据压不动；让"压缩后"仍远大于 16 KiB 默认高水位，才能覆盖到那条死路
    const source = randomBytes(512 * 1024)
    const startedAt = Date.now()
    const job = await prepare(writeSource('big-rand.bin', source), {
      compression: 'br',
      chunkBytes: 16384,
      maxFrameChars: 262144
    })
    // 随机数据压不动 → 回退为原字节，但仍然必须"跑完"而不是卡住
    expect(job.summary.wireBytes).toBe(source.length)
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  }, 60_000)

  it('可压缩的大文件压缩后远超高水位时同样完成', async () => {
    // 随机十六进制：Brotli 能压掉一半左右，压缩产物远大于 16 KiB
    const source = Buffer.from(randomBytes(512 * 1024).toString('hex'), 'utf8')
    const startedAt = Date.now()
    const job = await prepare(writeSource('big-text.txt', source), {
      compression: 'br',
      chunkBytes: 16384,
      maxFrameChars: 262144
    })
    expect(job.summary.compression).toBe('br')
    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(job.summary.wireBytes).toBeGreaterThan(16 * 1024)
  }, 60_000)
})

describe('prepareTransfer · 校验与取消', () => {
  it('帧长超限时提前失败并给出建议片大小', async () => {
    await expect(
      prepare(writeSource('src.bin', binary(8192)), { chunkBytes: 4096, maxFrameChars: 4096 })
    ).rejects.toThrow(/超过上限/)
  })

  it('片大小与帧长上限都会被夹取到合法区间', async () => {
    const job = await prepare(writeSource('src.bin', binary(100)), {
      chunkBytes: 0,
      maxFrameChars: 1
    })
    expect(job.summary.chunkBytes).toBeGreaterThanOrEqual(1024)
    expect(job.summary.maxFrameChars).toBeGreaterThanOrEqual(4096)
  })

  it('取消准备：哈希阶段立即中止', async () => {
    const path = writeSource('src.bin', binary(10_000))
    let calls = 0
    await expect(prepare(path, {}, { shouldCancel: () => calls++ > 0 })).rejects.toThrow(/取消/)
  })

  it('哈希进度单调递增并最终等于文件大小', async () => {
    const size = 3 * 1024 * 1024
    const path = writeSource('src.bin', binary(size))
    const steps: number[] = []
    await prepare(
      path,
      { chunkBytes: 4096 },
      {
        onProgress: (progress) => {
          if (progress.phase === 'hash') steps.push(progress.done)
        }
      }
    )

    expect(steps.length).toBeGreaterThan(0)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(steps.at(-1)).toBe(size)
  })

  it('压缩进度也会报出来', async () => {
    const path = writeSource('note.txt', Buffer.from('x'.repeat(100_000), 'utf8'))
    const phases = new Set<string>()
    await prepare(
      path,
      { compression: 'br', chunkBytes: 2048 },
      { onProgress: (progress) => phases.add(progress.phase) }
    )
    expect(phases.has('compress')).toBe(true)
    expect(phases.has('plan')).toBe(true)
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

describe('payloadCharsFor', () => {
  it('与符号表的位宽口径一致', () => {
    expect(payloadCharsFor(8, 'ascii32')).toBe(Math.ceil(64 / 5))
    expect(payloadCharsFor(8, 'ascii64')).toBe(Math.ceil(64 / 6))
    expect(payloadCharsFor(8, 'hex')).toBe(16)
    expect(symbolCount(8, 'ascii32')).toBe(payloadCharsFor(8, 'ascii32'))
  })
})
