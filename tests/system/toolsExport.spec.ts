import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { copyToolsTo } from '@main/transfer/session'

/**
 * 「导出脚本」要整份带走 tools/ 里随安装包分发的东西：`electron-builder.yml` 的 `extraResources`
 * 把 tools/ 原样拷进 resources/tools（并按 filter 只留产物与说明文档）。
 *
 * 这里对着**真实目录**校验，而不是构造一份假想清单：清单一旦与实际产物脱节（漏掉某个产物、
 * 或留着已经不再生成的文件名），导出目录就会残缺或对不上，用户拿到的东西与安装包里不一致。
 */
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const toolsDir = join(root, 'tools')

/** 只留在仓库里的源码与类型声明：安装包与导出都不带 */
const SOURCE_ONLY = /\.(?:ts|mts|cts)$/

/** 构建产物之一：它不存在就说明没跑过构建，此时校验会失去意义 */
const REQUIRED_ARTIFACT = 'typer-recv.mjs'

let destination: string | null = null

afterEach(() => {
  if (destination) rmSync(destination, { recursive: true, force: true })
  destination = null
})

/**
 * @description 递归列出目录下的文件（相对 given 目录，用路径分隔符拼接）
 * @param relative 相对 tools/ 的子路径
 * @returns 文件相对路径列表
 */
function listFiles(relative = ''): string[] {
  const dir = relative.length > 0 ? join(toolsDir, relative) : toolsDir
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const child = relative.length > 0 ? join(relative, entry) : entry
    if (statSync(join(toolsDir, child)).isDirectory()) files.push(...listFiles(child))
    else files.push(child)
  }
  return files
}

describe('导出脚本 · 真实产物', () => {
  it('tools/ 里每个非源码文件都会被导出（产物不会被静默漏掉）', () => {
    if (!existsSync(join(toolsDir, REQUIRED_ARTIFACT))) {
      throw new Error(
        `缺少接收端构建产物 ${join(toolsDir, REQUIRED_ARTIFACT)}：请先运行 pnpm build:tools`
      )
    }

    const shipped = listFiles()
      .filter((file) => !SOURCE_ONLY.test(file))
      .sort()
    // 导出前先自证清单本身是完整的：产物、启动脚本与说明文档都在
    expect(shipped).toEqual(expect.arrayContaining(['README.md', 'run.bat', REQUIRED_ARTIFACT]))

    destination = mkdtempSync(join(tmpdir(), 'typer-export-'))
    const copied = copyToolsTo(toolsDir, destination).sort()

    expect(copied).toEqual(shipped)
    expect(copied).not.toContain('typer-recv.ts')
  })
})
