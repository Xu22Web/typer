import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TransferToolScriptPayload } from '../ipc/contracts'
import { RECV_SCRIPT_FILE, resolveToolsDir, type ToolsLocatorContext } from './toolsLocator'

export interface ToolScriptDeps {
  /** 读取文本文件；缺省用同步读取（脚本只有几十 KB，不值得为它走一次异步往返） */
  readText?: (path: string) => string
}

/**
 * @description 定位并读取接收端脚本全文：脚本是随包分发的构建产物，界面拿到全文后可以直接展示 / 复制，用户不必去安装目录翻文件
 * @param context 运行形态与两个根路径（开发模式下为仓库根目录，打包后为 resources）
 * @param deps 读取实现（便于单测注入内存文件系统）
 * @returns 脚本路径与全文
 */
export function readToolScript(
  context: ToolsLocatorContext,
  deps: ToolScriptDeps = {}
): TransferToolScriptPayload {
  const dir = resolveToolsDir(context)
  const path = join(dir, RECV_SCRIPT_FILE)
  const readText = deps.readText ?? ((target: string) => readFileSync(target, 'utf8'))

  try {
    return { path, text: readText(path) }
  } catch (error) {
    // 目录探针过了但读不出来（权限、被杀软锁住等）时也要给出可读原因
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`读取接收端脚本失败（${path}）：${reason}`)
  }
}
