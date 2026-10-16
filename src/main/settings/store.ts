import { dirname } from 'node:path'
import * as nodeFs from 'node:fs'
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings, type Settings } from './schema'

/** 只用到的最小文件系统接口，便于测试注入内存实现。 */
export interface SettingsFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  renameSync(oldPath: string, newPath: string): void
  mkdirSync(path: string, options: { recursive: true }): string | undefined
}

export const nodeSettingsFs: SettingsFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path, encoding) => nodeFs.readFileSync(path, encoding),
  writeFileSync: (path, data, encoding) => nodeFs.writeFileSync(path, data, encoding),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path, options)
}

export interface SettingsStoreOptions {
  filePath: string
  fs?: SettingsFs
  logger?: (level: 'warn' | 'error', message: string) => void
}

export type SettingsListener = (settings: Settings) => void

/** 一次持久化的结果：`ok` 为 false 表示"没有按预期落盘"，调用方必须把它当成错误上报。 */
export interface PersistResult {
  /** 是否按预期完成了持久化（写入成功，或按隐私设置有意跳过） */
  ok: boolean
  /** 是否真的写了磁盘 */
  written: boolean
  error?: string
}

export interface SettingsUpdateResult extends PersistResult {
  settings: Settings
}

/** 常见文件系统错误 → 面向用户的中文说明。 */
const FS_ERROR_HINTS: ReadonlyArray<{ test: RegExp; hint: string }> = [
  { test: /\b(EPERM|EACCES|EBUSY)\b/i, hint: '没有写入权限，或文件正被其它程序占用' },
  { test: /\bENOSPC\b/i, hint: '磁盘空间不足' },
  { test: /\b(EISDIR|ENOTDIR)\b/i, hint: '设置文件的路径不可用（位于非目录中，或被目录占用）' },
  { test: /\bEROFS\b/i, hint: '所在磁盘为只读' },
  { test: /\bENOENT\b/i, hint: '所在目录不存在且无法创建' },
  { test: /\bEMFILE\b|\bENFILE\b/i, hint: '打开的文件过多' }
]

/**
 * 把底层文件系统错误翻成可读原因。
 * 原始文本仍会写进日志，界面只展示这段说明，避免出现一长串英文 errno 路径。
 */
export function describeFsFailure(raw: string): string {
  const matched = FS_ERROR_HINTS.find((item) => item.test.test(raw))
  if (matched) return matched.hint
  return raw
}

/**
 * 设置持久化。
 *
 * 关键点：
 * - **原子写**：先写临时文件再 rename，避免进程中断留下半个 JSON
 * - **损坏回退**：JSON 解析失败时把原文件另存为 `.corrupt`，然后回退默认值
 * - **永不抛错**：读写失败只记录日志，不能让设置问题阻断输入功能
 * - `privacy.persistSettings = false` 时不写盘（只保留内存态）
 */
export class SettingsStore {
  private readonly filePath: string
  private readonly fs: SettingsFs
  private readonly logger: (level: 'warn' | 'error', message: string) => void
  private readonly listeners = new Set<SettingsListener>()
  private current: Settings
  private loaded = false

  constructor(options: SettingsStoreOptions) {
    this.filePath = options.filePath
    this.fs = options.fs ?? nodeSettingsFs
    this.logger = options.logger ?? (() => {})
    this.current = { ...DEFAULT_SETTINGS }
  }

  get file(): string {
    return this.filePath
  }

  get(): Settings {
    return this.current
  }

  /** 读取设置；文件不存在或损坏时回退默认值。 */
  load(): Settings {
    this.loaded = true
    if (!this.fs.existsSync(this.filePath)) {
      this.current = { ...DEFAULT_SETTINGS }
      return this.current
    }

    let raw: string
    try {
      raw = this.fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      this.logger(
        'warn',
        `读取设置失败，使用默认值：${error instanceof Error ? error.message : String(error)}`
      )
      this.current = { ...DEFAULT_SETTINGS }
      return this.current
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      this.current = normalizeSettings(parsed)
    } catch (error) {
      this.logger(
        'warn',
        `设置文件已损坏，已备份并回退默认值：${
          error instanceof Error ? error.message : String(error)
        }`
      )
      this.backupCorrupt(raw)
      this.current = { ...DEFAULT_SETTINGS }
    }

    return this.current
  }

  /** 局部更新并持久化。返回结果里包含是否真的落盘，供调用方决定如何提示。 */
  update(patch: unknown): SettingsUpdateResult {
    this.ensureLoaded()
    this.current = mergeSettings(this.current, patch)
    const result = this.persist()
    this.notify()
    return { ...result, settings: this.current }
  }

  /** 覆盖全部设置并持久化（用于设置界面"保存"）。 */
  save(next: unknown): SettingsUpdateResult {
    this.ensureLoaded()
    this.current = normalizeSettings(next)
    const result = this.persist()
    this.notify()
    return { ...result, settings: this.current }
  }

  reset(): SettingsUpdateResult {
    this.ensureLoaded()
    this.current = { ...DEFAULT_SETTINGS }
    const result = this.persist()
    this.notify()
    return { ...result, settings: this.current }
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  private persist(): PersistResult {
    if (!this.current.privacy.persistSettings) {
      // 按隐私设置有意不落盘，不算失败
      this.logger('warn', '按隐私设置未写入设置文件（persistSettings = false）')
      return { ok: true, written: false }
    }

    const tempPath = `${this.filePath}.tmp`
    try {
      this.fs.mkdirSync(dirname(this.filePath), { recursive: true })
      this.fs.writeFileSync(tempPath, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8')
      this.fs.renameSync(tempPath, this.filePath)
      return { ok: true, written: true }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      this.logger('error', `保存设置失败：${raw}`)
      // 失败必须如实上报：否则界面会显示"已保存"而磁盘上其实没变
      return { ok: false, written: false, error: describeFsFailure(raw) }
    }
  }

  private backupCorrupt(raw: string): void {
    try {
      this.fs.writeFileSync(`${this.filePath}.corrupt`, raw, 'utf8')
    } catch {
      // 备份失败无所谓，不能影响主流程
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current)
      } catch (error) {
        this.logger(
          'warn',
          `设置订阅者抛错：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}
