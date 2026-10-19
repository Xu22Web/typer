import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  hostScriptCandidates,
  HostScriptNotFoundError,
  resolveHostScriptPath
} from '@main/typing/drivers/hostLocator'

/** 仓库根目录：不依赖 process.cwd()，否则从子目录/IDE 直接跑就会找不到脚本 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const context = { appPath: 'C:\\app', resourcesPath: 'C:\\app\\resources' }

describe('hostScriptCandidates', () => {
  it('开发模式优先项目目录', () => {
    const candidates = hostScriptCandidates({ ...context, isPackaged: false })
    expect(candidates[0]).toBe('C:\\app\\scripts\\typing-host.ps1')
    expect(candidates[1]).toBe('C:\\app\\resources\\scripts\\typing-host.ps1')
  })

  it('打包模式优先 resources 目录（extraResources 落点）', () => {
    const candidates = hostScriptCandidates({ ...context, isPackaged: true })
    expect(candidates[0]).toBe('C:\\app\\resources\\scripts\\typing-host.ps1')
    expect(candidates[1]).toBe('C:\\app\\scripts\\typing-host.ps1')
  })
})

describe('resolveHostScriptPath', () => {
  it('返回第一个存在的候选路径', () => {
    const path = resolveHostScriptPath({
      ...context,
      isPackaged: true,
      exists: (candidate) => candidate.startsWith('C:\\app\\resources')
    })
    expect(path).toBe('C:\\app\\resources\\scripts\\typing-host.ps1')
  })

  it('一个候选都不存在时抛出包含所有候选路径的错误', () => {
    try {
      resolveHostScriptPath({ ...context, isPackaged: false, exists: () => false })
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(HostScriptNotFoundError)
      const notFound = error as HostScriptNotFoundError
      expect(notFound.candidates).toHaveLength(2)
      expect(notFound.message).toContain('C:\\app\\scripts\\typing-host.ps1')
      expect(notFound.message).toContain('typing-host.ps1，已尝试')
    }
  })

  it('默认使用真实文件系统（当前仓库里脚本确实存在）', () => {
    const path = resolveHostScriptPath({
      isPackaged: false,
      appPath: REPO_ROOT,
      resourcesPath: 'C:\\不存在'
    })
    expect(path.endsWith('typing-host.ps1')).toBe(true)
  })
})
