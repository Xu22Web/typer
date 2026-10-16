import { describe, expect, it } from 'vitest'
import { SettingsStore } from '@main/settings/store'
import { DEFAULT_SETTINGS, normalizeSettings } from '@main/settings/schema'
import { createMemoryFs } from '../../helpers/fakes'

const FILE = 'C:\\userData\\settings.json'

function createStore(
  fs: ReturnType<typeof createMemoryFs>,
  filePath = FILE
): {
  store: SettingsStore
  logs: string[]
} {
  const logs: string[] = []
  const store = new SettingsStore({
    filePath,
    fs,
    logger: (_level, message) => logs.push(message)
  })
  return { store, logs }
}

describe('SettingsStore 读取', () => {
  it('文件不存在时使用默认值，且不创建文件', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    expect(store.load()).toEqual(DEFAULT_SETTINGS)
    expect(fs.files.size).toBe(0)
  })

  it('读取已有设置并做归一化（越界值被夹取）', () => {
    const fs = createMemoryFs({
      [FILE]: JSON.stringify({ startDelayMs: 999999, insertMode: 'paste' })
    })
    const { store } = createStore(fs)
    const settings = store.load()
    expect(settings.startDelayMs).toBe(60_000)
    expect(settings.insertMode).toBe('paste')
  })

  it('JSON 损坏时备份原文件并回退默认值', () => {
    const fs = createMemoryFs({ [FILE]: '{ 这不是 JSON' })
    const { store, logs } = createStore(fs)

    expect(store.load()).toEqual(DEFAULT_SETTINGS)
    expect(fs.files.get(`${FILE}.corrupt`)).toBe('{ 这不是 JSON')
    expect(logs.some((line) => line.includes('损坏'))).toBe(true)
  })

  it('读取抛错时回退默认值并记录日志', () => {
    const fs = createMemoryFs({ [FILE]: '{}' })
    fs.readFileSync = () => {
      throw new Error('EIO')
    }
    const { store, logs } = createStore(fs)
    expect(store.load()).toEqual(DEFAULT_SETTINGS)
    expect(logs.some((line) => line.includes('读取设置失败'))).toBe(true)
  })

  it('存在但内容是合法 JSON 时按内容生效', () => {
    const fs = createMemoryFs({ [FILE]: JSON.stringify({ chunkSize: 16 }) })
    const { store } = createStore(fs)
    expect(store.load().chunkSize).toBe(16)
  })
})

describe('SettingsStore 保存', () => {
  it('更新时先写临时文件再原子 rename', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    store.load()
    store.update({ startDelayMs: 500 })

    expect(fs.files.has(`${FILE}.tmp`)).toBe(false)
    const saved = JSON.parse(fs.files.get(FILE) as string) as Record<string, unknown>
    expect(saved.startDelayMs).toBe(500)
    expect(fs.dirs.has('C:\\userData')).toBe(true)
  })

  it('写入内容是可读的格式化 JSON（末尾带换行）', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    store.load()
    store.update({})
    const raw = fs.files.get(FILE) as string
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('\n  ')
    expect(JSON.parse(raw)).toEqual(DEFAULT_SETTINGS)
  })

  it('persistSettings = false 时不写盘，但内存态仍然更新', () => {
    const fs = createMemoryFs()
    const { store, logs } = createStore(fs)
    store.load()
    const result = store.update({ privacy: { persistSettings: false }, startDelayMs: 700 })

    expect(fs.files.has(FILE)).toBe(false)
    expect(store.get().startDelayMs).toBe(700)
    // 有意跳过落盘不算失败
    expect(result.ok).toBe(true)
    expect(result.written).toBe(false)
    expect(logs.some((line) => line.includes('persistSettings'))).toBe(true)
  })

  it('写盘失败不抛错，但会如实返回 ok: false', () => {
    const fs = createMemoryFs()
    const { store, logs } = createStore(fs)
    store.load()
    fs.failWrites = true

    let result: ReturnType<typeof store.update> | undefined
    expect(() => {
      result = store.update({ startDelayMs: 100 })
    }).not.toThrow()

    expect(result?.ok).toBe(false)
    expect(result?.written).toBe(false)
    expect(result?.error).toBeTruthy()
    expect(logs.some((line) => line.includes('保存设置失败'))).toBe(true)
    expect(store.get().startDelayMs).toBe(100)
  })

  it('save 会用完整对象覆盖并归一化', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    store.load()
    store.save({ startDelayMs: 10, timing: { cps: 3 } })
    expect(store.get().startDelayMs).toBe(10)
    expect(store.get().timing.cps).toBe(3)
    // 未提供的字段回默认（save 是覆盖语义）
    expect(store.get().typo.rate).toBe(DEFAULT_SETTINGS.typo.rate)
  })

  it('reset 恢复默认并落盘', () => {
    const fs = createMemoryFs({ [FILE]: JSON.stringify({ startDelayMs: 111 }) })
    const { store } = createStore(fs)
    store.load()
    store.reset()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(JSON.parse(fs.files.get(FILE) as string)).toEqual(DEFAULT_SETTINGS)
  })

  it('未显式 load 时 update 会自动加载', () => {
    const fs = createMemoryFs({ [FILE]: JSON.stringify({ chunkSize: 32 }) })
    const { store } = createStore(fs)
    store.update({ startDelayMs: 1 })
    expect(store.get().chunkSize).toBe(32)
    expect(store.get().startDelayMs).toBe(1)
  })

  it('多次更新串行落盘，最终文件是最新状态', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    store.load()
    for (let index = 0; index < 5; index++) store.update({ startDelayMs: index * 100 })
    expect(JSON.parse(fs.files.get(FILE) as string).startDelayMs).toBe(400)
  })
})

describe('SettingsStore 订阅', () => {
  it('更新/重置都会通知订阅者', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    store.load()

    const seen: number[] = []
    const unsubscribe = store.subscribe((settings) => seen.push(settings.startDelayMs))

    store.update({ startDelayMs: 100 })
    store.update({ startDelayMs: 200 })
    store.reset()
    unsubscribe()
    store.update({ startDelayMs: 300 })

    expect(seen).toEqual([100, 200, DEFAULT_SETTINGS.startDelayMs])
  })

  it('订阅者抛错不影响其它订阅者与主流程', () => {
    const fs = createMemoryFs()
    const { store, logs } = createStore(fs)
    store.load()
    store.subscribe(() => {
      throw new Error('订阅者炸了')
    })
    const seen: string[] = []
    store.subscribe(() => seen.push('ok'))

    expect(() => store.update({ startDelayMs: 1 })).not.toThrow()
    expect(seen).toEqual(['ok'])
    expect(logs.some((line) => line.includes('订阅者抛错'))).toBe(true)
  })

  it('文件路径可查询（便于日志展示）', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    expect(store.file).toBe(FILE)
  })

  it('归一化结果与 schema 保持一致', () => {
    const fs = createMemoryFs()
    const { store } = createStore(fs)
    expect(store.get()).toEqual(normalizeSettings(DEFAULT_SETTINGS))
  })
})
