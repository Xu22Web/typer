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

/** 按优先级列出可能的宿主脚本路径（打包后优先 extraResources）。 */
export function hostScriptCandidates(context: HostLocatorContext): string[] {
  const { isPackaged, appPath, resourcesPath } = context
  const ordered = isPackaged ? [resourcesPath, appPath] : [appPath, resourcesPath]
  return ordered.map((root) => join(root, ...RELATIVE_SCRIPT))
}

export class HostScriptNotFoundError extends Error {
  readonly candidates: string[]

  constructor(candidates: string[]) {
    super(
      `找不到输入宿主脚本 typing-host.ps1，已尝试：\n${candidates.map((p) => `  - ${p}`).join('\n')}`
    )
    this.name = 'HostScriptNotFoundError'
    this.candidates = candidates
  }
}

export function resolveHostScriptPath(context: HostLocatorContext): string {
  const exists = context.exists ?? existsSync
  const candidates = hostScriptCandidates(context)
  const found = candidates.find((candidate) => exists(candidate))
  if (!found) throw new HostScriptNotFoundError(candidates)
  return found
}
