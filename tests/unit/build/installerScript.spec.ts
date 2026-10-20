/**
 * "更新会不会重置设置"这件事，最终由 NSIS 卸载脚本决定，而 `.nsh` 只能靠人工读。
 * 这里把关键约束钉成测试：
 *
 * - 应用内更新是**覆盖安装**：安装器会先用 `--updated` 调用旧卸载程序
 *   （app-builder-lib/templates/nsis/include/installUtil.nsh 里写死了这一点），
 *   官方模板据此跳过 `deleteAppDataOnUninstall` 的删除；
 * - 但 `build/installer.nsh` 里的清理是手写的，之前**没有加这层判断**，
 *   于是每次升级都会删掉 `%APPDATA%\typer`（旧产品名下的 settings.json）与
 *   `%LOCALAPPDATA%\Typer`，表现就是"更新后设置被重置"。
 *
 * 所以这里断言：卸载脚本里所有 `RMDir` 都被 `${ifNot} ${isUpdated}` 包住。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** 仓库根目录（本文件在 tests/unit/build 下） */
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

/**
 * @description 取出 `customUnInstall` 宏的正文
 * @returns 宏正文（不含宏声明与结尾）
 */
function uninstallMacro(): string {
  const source = readFileSync(resolve(repoRoot, 'build', 'installer.nsh'), 'utf8')
  const start = source.indexOf('!macro customUnInstall')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('!macroend', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('NSIS 卸载脚本：升级不删用户数据', () => {
  it('所有删除动作都在 ${ifNot} ${isUpdated} 保护块内', () => {
    const body = uninstallMacro()

    const guardAt = body.indexOf('${ifNot} ${isUpdated}')
    expect(guardAt).toBeGreaterThanOrEqual(0)
    const guardEnd = body.indexOf('${endif}', guardAt)
    expect(guardEnd).toBeGreaterThan(guardAt)

    const deletions = [...body.matchAll(/RMDir[^\n]*/g)].map((match) => match.index ?? -1)
    expect(deletions.length).toBeGreaterThan(0)
    for (const index of deletions) {
      expect(index).toBeGreaterThan(guardAt)
      expect(index).toBeLessThan(guardEnd)
    }
  })

  it('保护块之外不再出现任何 $APPDATA 删除（那正是"更新后设置被重置"的元凶）', () => {
    const body = uninstallMacro()
    const guardAt = body.indexOf('${ifNot} ${isUpdated}')
    const guardEnd = body.indexOf('${endif}', guardAt)
    const outside = body.slice(0, guardAt) + body.slice(guardEnd)

    expect(outside).not.toMatch(/\$APPDATA/i)
    expect(outside).not.toMatch(/\$LOCALAPPDATA/i)
  })

  it('真正卸载时仍会清掉安装程序副本（约 88MB 的残留）', () => {
    // 清理逻辑保留，只是被挪进了"不是升级"的分支
    expect(uninstallMacro()).toContain('${APP_FILENAME}-updater')
  })
})
