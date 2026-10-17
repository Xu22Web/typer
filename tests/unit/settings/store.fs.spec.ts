import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, NUMERIC_BOUNDS } from '@main/settings/schema'
import { SettingsStore, describeFsFailure } from '@main/settings/store'

/**
 * 用真实文件系统验证设置持久化：内存 fs 无法覆盖 Windows 上的目录创建与
 * 临时文件 + rename 覆盖，而"保存没生效"往往正好出在这些环节。
 */
describe('SettingsStore 真实落盘', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typer-settings-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * @description 生成一个尚不存在的多级设置文件路径
   * @returns 设置文件绝对路径
   */
  const filePath = (): string => join(dir, 'nested', 'deeper', 'settings.json')

  it('首次保存会创建缺失的目录并写出文件', () => {
    const store = new SettingsStore({ filePath: filePath() })
    store.load()
    expect(() => store.update({ startDelayMs: 1200 })).not.toThrow()

    const saved = JSON.parse(readFileSync(filePath(), 'utf8')) as { startDelayMs: number }
    expect(saved.startDelayMs).toBe(1200)
  })

  it('再次保存能覆盖已有文件（Windows 上 rename 必须替换目标）', () => {
    const store = new SettingsStore({ filePath: filePath() })
    store.load()
    store.update({ startDelayMs: 1000 })
    store.update({ startDelayMs: 2000, chunkSize: 16 })

    const saved = JSON.parse(readFileSync(filePath(), 'utf8')) as {
      startDelayMs: number
      chunkSize: number
    }
    expect(saved.startDelayMs).toBe(2000)
    expect(saved.chunkSize).toBe(16)
  })

  it('保存后的文件可被新实例读回（真正的持久化）', () => {
    const first = new SettingsStore({ filePath: filePath() })
    first.load()
    first.update({ startDelayMs: 777, timing: { cps: 15 } })

    const second = new SettingsStore({ filePath: filePath() })
    const reloaded = second.load()
    expect(reloaded.startDelayMs).toBe(777)
    expect(reloaded.timing.cps).toBe(15)
    // 其余字段保持默认
    expect(reloaded.typo.rate).toBe(DEFAULT_SETTINGS.typo.rate)
  })

  it('文件损坏时备份原文件并回退默认值', () => {
    const path = filePath()
    const store = new SettingsStore({ filePath: path })
    store.load()
    store.update({ startDelayMs: 5 })

    writeFileSync(path, '{ 这不是合法 JSON', 'utf8')

    const recovered = new SettingsStore({ filePath: path })
    expect(recovered.load()).toEqual(DEFAULT_SETTINGS)
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{ 这不是合法 JSON')
  })

  it('persistSettings = false 时不写盘，文件保持原样', () => {
    const path = filePath()
    const store = new SettingsStore({ filePath: path })
    store.load()
    store.update({ startDelayMs: 100 })

    const before = readFileSync(path, 'utf8')
    store.update({ privacy: { persistSettings: false }, startDelayMs: 200 })

    expect(readFileSync(path, 'utf8')).toBe(before)
    // 内存态仍然生效
    expect(store.get().startDelayMs).toBe(200)
  })

  it('并发快速保存不会留下半截文件（最终内容始终是合法 JSON）', async () => {
    const store = new SettingsStore({ filePath: filePath() })
    store.load()

    for (let index = 0; index < 20; index++) store.update({ startDelayMs: index })

    await Promise.resolve()
    const raw = readFileSync(filePath(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect((JSON.parse(raw) as { startDelayMs: number }).startDelayMs).toBe(19)
  })

  it('归一化后的值才落盘（越界值被夹取）', () => {
    const store = new SettingsStore({ filePath: filePath() })
    store.load()
    store.update({ startDelayMs: 999_999, chunkSize: 999 })

    const saved = JSON.parse(readFileSync(filePath(), 'utf8')) as {
      startDelayMs: number
      chunkSize: number
    }
    expect(saved.startDelayMs).toBe(60_000)
    expect(saved.chunkSize).toBe(NUMERIC_BOUNDS.chunkSize[1])
  })

  it('保存成功时报告 ok + written', () => {
    const store = new SettingsStore({ filePath: filePath() })
    const result = store.update({ startDelayMs: 100 })

    expect(result.ok).toBe(true)
    expect(result.written).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.settings.startDelayMs).toBe(100)
  })

  it('按隐私设置跳过落盘时不算失败（ok: true, written: false）', () => {
    const store = new SettingsStore({ filePath: filePath() })
    store.load()
    store.update({ privacy: { persistSettings: false } })

    const result = store.update({ startDelayMs: 300 })
    expect(result.ok).toBe(true)
    expect(result.written).toBe(false)
  })

  it('磁盘写入失败时必须如实上报（否则界面会假报"已保存"）', () => {
    const path = filePath()
    const store = new SettingsStore({ filePath: path })
    store.update({ startDelayMs: 100 })

    // 让目标路径变成目录：临时文件能写，但 rename 到该路径一定失败
    rmSync(path, { force: true })
    mkdirSync(path, { recursive: true })

    const result = store.update({ startDelayMs: 200 })

    expect(result.ok).toBe(false)
    expect(result.written).toBe(false)
    expect(result.error).toBeTruthy()
    // 内存态仍然生效，用户可以看到自己刚改的值
    expect(result.settings.startDelayMs).toBe(200)
  })

  it('写入失败后恢复可写，下一次保存能成功', () => {
    const path = filePath()
    const store = new SettingsStore({ filePath: path })
    store.update({ startDelayMs: 100 })

    rmSync(path, { force: true })
    mkdirSync(path, { recursive: true })
    expect(store.update({ startDelayMs: 200 }).ok).toBe(false)

    rmSync(path, { recursive: true, force: true })
    const recovered = store.update({ startDelayMs: 300 })
    expect(recovered.ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).startDelayMs).toBe(300)
  })

  it('失败原因会被翻成可读中文（不把 errno 与长路径甩给用户）', () => {
    const path = filePath()
    const store = new SettingsStore({ filePath: path })
    store.update({ startDelayMs: 100 })
    rmSync(path, { force: true })
    mkdirSync(path, { recursive: true })

    const result = store.update({ startDelayMs: 200 })
    expect(result.error).toBeTruthy()
    // EPERM / EACCES / EBUSY 一类都归到"权限或占用"
    expect(result.error).toMatch(/权限|占用|路径不可用/)
    expect(result.error).not.toMatch(/EPERM|rename|C:\\/)
  })
})

describe('describeFsFailure', () => {
  it('把常见 errno 映射成中文说明', () => {
    expect(
      describeFsFailure(
        "EPERM: operation not permitted, rename 'C:\\a\\settings.json.tmp' -> 'C:\\a\\settings.json'"
      )
    ).toContain('权限')
    expect(describeFsFailure('EACCES: permission denied')).toContain('权限')
    expect(describeFsFailure('EBUSY: resource busy or locked')).toContain('占用')
    expect(describeFsFailure('ENOSPC: no space left on device')).toBe('磁盘空间不足')
    expect(describeFsFailure('EISDIR: illegal operation on a directory')).toContain('路径不可用')
    expect(describeFsFailure('EROFS: read-only file system')).toContain('只读')
  })

  it('无法识别的错误保留原始文本，便于排查', () => {
    expect(describeFsFailure('一些未知的底层错误')).toBe('一些未知的底层错误')
  })
})
