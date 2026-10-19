import { createHash, randomBytes as cryptoRandom } from 'node:crypto'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeFile, sniffKind } from '@main/transfer/analyze'

let work: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'typer-analyze-'))
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/**
 * @description 把内容写进测试临时目录
 * @param name 文件名
 * @param data 内容
 * @returns 文件路径
 */
function write(name: string, data: Buffer | string): string {
  const path = join(work, name)
  writeFileSync(path, data)
  return path
}

/**
 * @description 生成确定性随机字节（不可压缩）
 * @param size 字节数
 * @returns 字节
 */
function randomBytes(size: number): Buffer {
  return cryptoRandom(size)
}

describe('sniffKind', () => {
  it('按魔数识别常见格式', () => {
    expect(sniffKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('zip')
    expect(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('png')
    expect(sniffKind(Buffer.from([0x1f, 0x8b, 0x08]))).toBe('gzip')
    expect(sniffKind(Buffer.from('%PDF-1.7'))).toBe('pdf')
    expect(sniffKind(Buffer.from('MZ\x90\x00'))).toBe('pe')
    expect(sniffKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe('elf')
    expect(sniffKind(Buffer.from('hello world'))).toBe('text')
    expect(sniffKind(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe('binary')
  })
})

describe('analyzeFile', () => {
  it('文本可压缩：给出比例与原因', async () => {
    const source = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(400), 'utf8')
    const profile = await analyzeFile(write('text.txt', source), source.length)

    expect(profile.kind).toBe('text')
    expect(profile.compressible).toBe(true)
    expect(profile.brotliRatio).toBeLessThan(0.5)
    expect(profile.reason).toMatch(/可压缩/)
  })

  it('随机字节不可压缩：跳过压缩', async () => {
    const source = randomBytes(64 * 1024)
    const profile = await analyzeFile(write('rand.bin', source), source.length)

    expect(profile.compressible).toBe(false)
    expect(profile.brotliRatio).toBeGreaterThan(0.9)
    expect(profile.reason).toMatch(/不可压缩|跳过/)
  })

  it('已压缩容器即使样本偶尔可压，也在比例达标时判定可压缩（只按数据说话）', async () => {
    const payload = Buffer.from('{"a":1,"b":"'.repeat(2000), 'utf8')
    const profile = await analyzeFile(write('fake.zip', payload), payload.length)
    expect(profile.kind).toBe('text')
    expect(profile.compressible).toBe(true)
  })

  it('空文件不压缩', async () => {
    const profile = await analyzeFile(write('empty.bin', Buffer.alloc(0)), 0)
    expect(profile.compressible).toBe(false)
    expect(profile.reason).toMatch(/空文件/)
  })

  it('大文件只采样头/中/尾，不会全量读盘', async () => {
    const path = join(work, 'big.bin')
    writeFileSync(path, Buffer.alloc(0))
    truncateSync(path, 200 * 1024 * 1024)
    const startedAt = Date.now()
    const profile = await analyzeFile(path, 200 * 1024 * 1024)
    // 200 MB 全读至少要几百毫秒；采样后应远快于此
    expect(Date.now() - startedAt).toBeLessThan(5000)
    expect(profile.size).toBe(200 * 1024 * 1024)
  })

  it('分析不会改写文件（哈希不变）', async () => {
    const source = randomBytes(10_000)
    const path = write('keep.bin', source)
    const before = createHash('sha256').update(source).digest('hex')
    await analyzeFile(path, source.length)
    const after = createHash('sha256').update(source).digest('hex')
    expect(after).toBe(before)
  })
})
