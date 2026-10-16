import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface HostLocatorContext {
  isPackaged: boolean
  /** 开发模式下即项目根目录（`app.getAppPath()`） */
  appPath: string
  /** 打包后即 `process.resourcesPath` */
  resourcesPath: string
  exists?: (path: string) => boolean
}

const RELATIVE_SCRIPT = ['scripts', 'typing-host.ps1'] as const

/**
 * @description 按优先级列出可能的宿主脚本路径（打包后优先 extraResources）
 * @param context 打包状态与两个资源根目录
 * @returns 候选路径，按查找优先级排列
 */
export function hostScriptCandidates(context: HostLocatorContext): string[] {
  const { isPackaged, appPath, resourcesPath } = context
  const ordered = isPackaged ? [resourcesPath, appPath] : [appPath, resourcesPath]
  return ordered.map((root) => join(root, ...RELATIVE_SCRIPT))
}

/** 所有候选路径都不存在时抛出，便于界面直接展示尝试过的位置。 */
export class HostScriptNotFoundError extends Error {
  readonly candidates: string[]

  /**
   * @description 记录已尝试的候选路径，便于界面直接展示
   * @param candidates 尝试过的候选路径
   */
  constructor(candidates: string[]) {
    super(
      `找不到输入宿主脚本 typing-host.ps1，已尝试：\n${candidates.map((p) => `  - ${p}`).join('\n')}`
    )
    this.name = 'HostScriptNotFoundError'
    this.candidates = candidates
  }
}

/**
 * @description 在候选路径中找出实际存在的宿主脚本
 * @param context 打包状态、资源根目录与可选的存在性判定（便于测试）
 * @returns 命中的脚本绝对路径
 */
export function resolveHostScriptPath(context: HostLocatorContext): string {
  const exists = context.exists ?? existsSync
  const candidates = hostScriptCandidates(context)
  const found = candidates.find((candidate) => exists(candidate))
  if (!found) throw new HostScriptNotFoundError(candidates)
  return found
}
