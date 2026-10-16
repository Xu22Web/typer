import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ToolsLocatorContext {
  isPackaged: boolean
  /** 开发模式下即项目根目录（`app.getAppPath()`） */
  appPath: string
  /** 打包后即 `process.resourcesPath` */
  resourcesPath: string
  exists?: (path: string) => boolean
}

/** 接收/分片脚本必须能被用户取出来放到目标机，所以打包时随 extraResources 分发。 */
const RELATIVE_DIR = ['tools'] as const
const PROBE_FILE = 'typer-recv.mjs'

export function toolsDirCandidates(context: ToolsLocatorContext): string[] {
  const { isPackaged, appPath, resourcesPath } = context
  const ordered = isPackaged ? [resourcesPath, appPath] : [appPath, resourcesPath]
  return ordered.map((root) => join(root, ...RELATIVE_DIR))
}

export class ToolsDirNotFoundError extends Error {
  readonly candidates: string[]

  constructor(candidates: string[]) {
    super(
      `找不到文件传输脚本目录（应以 ${PROBE_FILE} 为准），已尝试：\n` +
        candidates.map((path) => `  - ${path}`).join('\n')
    )
    this.name = 'ToolsDirNotFoundError'
    this.candidates = candidates
  }
}

/** 定位 tools/ 目录（用 `typer-recv.mjs` 作为存在性探针）。 */
export function resolveToolsDir(context: ToolsLocatorContext): string {
  const exists = context.exists ?? existsSync
  const candidates = toolsDirCandidates(context)
  const found = candidates.find((candidate) => exists(join(candidate, PROBE_FILE)))
  if (!found) throw new ToolsDirNotFoundError(candidates)
  return found
}
