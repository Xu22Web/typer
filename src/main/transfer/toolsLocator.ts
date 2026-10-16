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

/**
 * @description 按运行形态给出 tools/ 的候选位置（打包后优先 resources，开发时优先项目根目录）
 * @param context 运行形态与两个根路径
 * @returns 候选目录列表（按优先级排序）
 */
export function toolsDirCandidates(context: ToolsLocatorContext): string[] {
  const { isPackaged, appPath, resourcesPath } = context
  const ordered = isPackaged ? [resourcesPath, appPath] : [appPath, resourcesPath]
  return ordered.map((root) => join(root, ...RELATIVE_DIR))
}

export class ToolsDirNotFoundError extends Error {
  readonly candidates: string[]

  /**
   * @description 建立错误并附带全部候选路径，便于用户自查
   * @param candidates 已尝试过的候选目录
   */
  constructor(candidates: string[]) {
    super(
      `找不到文件传输脚本目录（应以 ${PROBE_FILE} 为准），已尝试：\n` +
        candidates.map((path) => `  - ${path}`).join('\n')
    )
    this.name = 'ToolsDirNotFoundError'
    this.candidates = candidates
  }
}

/**
 * @description 定位 tools/ 目录（用 typer-recv.mjs 作为存在性探针）
 * @param context 运行形态与两个根路径
 * @returns 命中的目录
 */
export function resolveToolsDir(context: ToolsLocatorContext): string {
  const exists = context.exists ?? existsSync
  const candidates = toolsDirCandidates(context)
  const found = candidates.find((candidate) => exists(join(candidate, PROBE_FILE)))
  if (!found) throw new ToolsDirNotFoundError(candidates)
  return found
}
