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

/**
 * 接收脚本文件名。它现在是 esbuild 打包出的构建产物（`tools/typer-recv.ts` → `tools/typer-recv.mjs`），
 * 随 extraResources 一起分发，源码与类型声明不会跟着进安装目录。
 */
export const RECV_SCRIPT_FILE = 'typer-recv.mjs'

/** tools 目录随包分发的是接收端构建产物（用户要能取出来直接拷到目标机运行）。 */
const RELATIVE_DIR = ['tools'] as const

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
   * @description 建立错误并附带全部候选路径，便于用户自查；开发模式下额外提示产物需要先构建
   * @param candidates 已尝试过的候选目录
   * @param options isPackaged 为 false 时（开发模式）附上构建提示
   */
  constructor(candidates: string[], options: { isPackaged?: boolean } = {}) {
    const hint =
      options.isPackaged === false
        ? `\n开发模式下 ${RECV_SCRIPT_FILE} 是构建产物：请先运行 npm run build:tools 生成它`
        : ''
    super(
      `找不到文件传输脚本目录（应以 ${RECV_SCRIPT_FILE} 为准），已尝试：\n` +
        candidates.map((path) => `  - ${path}`).join('\n') +
        hint
    )
    this.name = 'ToolsDirNotFoundError'
    this.candidates = candidates
  }
}

/**
 * @description 定位 tools/ 目录（用接收端构建产物 typer-recv.mjs 作为存在性探针）
 * @param context 运行形态与两个根路径
 * @returns 命中的目录
 */
export function resolveToolsDir(context: ToolsLocatorContext): string {
  const exists = context.exists ?? existsSync
  const candidates = toolsDirCandidates(context)
  const found = candidates.find((candidate) => exists(join(candidate, RECV_SCRIPT_FILE)))
  if (!found) throw new ToolsDirNotFoundError(candidates, { isPackaged: context.isPackaged })
  return found
}
