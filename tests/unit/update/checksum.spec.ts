import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  digestEquals,
  normalizeDigest,
  parseChecksumManifest,
  sha256File,
  sha256Text
} from '@main/update/checksum'

const workDir = mkdtempSync(join(tmpdir(), 'typer-checksum-'))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('sha256File', () => {
  it('与内存计算结果一致（空文件/多块数据）', async () => {
    const empty = join(workDir, 'empty.bin')
    writeFileSync(empty, '')
    expect(await sha256File(empty)).toBe(sha256Text(''))

    const big = join(workDir, 'big.bin')
    const content = 'x'.repeat(300_000)
    writeFileSync(big, content)
    expect(await sha256File(big)).toBe(sha256Text(content))
  })
})

describe('normalizeDigest', () => {
  it('接受裸十六进制与 sha256: 前缀', () => {
    const hex = 'a'.repeat(64)
    expect(normalizeDigest(hex)).toBe(hex)
    expect(normalizeDigest(`sha256:${hex}`)).toBe(hex)
    expect(normalizeDigest(`SHA256:${hex.toUpperCase()}`)).toBe(hex)
  })

  it('长度不对或非十六进制时返回 null', () => {
    expect(normalizeDigest('abc')).toBeNull()
    expect(normalizeDigest(undefined)).toBeNull()
    expect(normalizeDigest('z'.repeat(64))).toBeNull()
  })
})

describe('parseChecksumManifest', () => {
  const hash = 'b'.repeat(64)

  it('解析 sha256sum 风格（两个空格 / 星号）', () => {
    expect(parseChecksumManifest(`${hash}  typer-0.2.0-setup.exe`, 'typer-0.2.0-setup.exe')).toBe(
      hash
    )
    expect(parseChecksumManifest(`${hash} *typer-0.2.0-setup.exe`, 'typer-0.2.0-setup.exe')).toBe(
      hash
    )
  })

  it('解析 certutil 风格', () => {
    const text = `SHA256 (typer-0.2.0-setup.exe) = ${hash.toUpperCase()}`
    expect(parseChecksumManifest(text, 'typer-0.2.0-setup.exe')).toBe(hash)
  })

  it('忽略注释与空行，只在文件名匹配时命中', () => {
    const text = ['# checksums', '', `${hash}  other.exe`, `${hash}  target.exe`].join('\n')
    expect(parseChecksumManifest(text, 'target.exe')).toBe(hash)
    expect(parseChecksumManifest(text, 'missing.exe')).toBeNull()
  })

  it('大小写不敏感，且拒绝非法摘要行', () => {
    expect(parseChecksumManifest(`${hash}  TYPER.EXE`, 'typer.exe')).toBe(hash)
    expect(parseChecksumManifest('deadbeef  typer.exe', 'typer.exe')).toBeNull()
    expect(parseChecksumManifest('', 'typer.exe')).toBeNull()
  })
})

describe('digestEquals', () => {
  it('只有完全一致才为真', () => {
    const a = 'c'.repeat(64)
    expect(digestEquals(a, a)).toBe(true)
    expect(digestEquals(a, 'd'.repeat(64))).toBe(false)
    expect(digestEquals(a, null)).toBe(false)
    expect(digestEquals(null, null)).toBe(false)
    expect(digestEquals(a, a.slice(0, 63))).toBe(false)
  })
})
