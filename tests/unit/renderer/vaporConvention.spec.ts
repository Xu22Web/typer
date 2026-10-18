import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 允许按 vdom 编译的例外文件：vapor 插槽子节点会被 interop 包装成不透明片段，
 * 依赖 vnode 检视的组件（ElTour 按组件名过滤 ElTourStep）必须以 vdom 模板编译。
 * 新增例外请附上文件头注释说明原因，并在这里登记。
 */
const VDOM_ALLOWLIST = new Set(['src/renderer/src/components/FirstRunTour.vue'])

/** @description 递归收集目录下所有 .vue 文件（相对项目根，正斜杠分隔） */
function collectVueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return collectVueFiles(full)
    return name.endsWith('.vue') ? [full.replaceAll('\\', '/')] : []
  })
}

/** @description 读取 <script setup> 开始标签；没有 script 块时返回 null */
function readScriptSetupTag(source: string): string | null {
  return source.match(/<script\s+setup[^>]*>/)?.[0] ?? null
}

describe('Vapor 约定', () => {
  it('渲染进程所有 SFC 都声明 vapor 属性（vapor 是文件级 opt-in，忘写会静默退回 vdom）', () => {
    const offenders: string[] = []
    for (const file of collectVueFiles('src/renderer')) {
      if (VDOM_ALLOWLIST.has(file)) continue
      const tag = readScriptSetupTag(readFileSync(file, 'utf8'))
      if (!tag) {
        offenders.push(`${file}：缺少 <script setup vapor>（纯模板 SFC 也会退回 vdom）`)
      } else if (!/\svapor[\s=>]/.test(tag)) {
        offenders.push(`${file}：<script setup> 缺少 vapor 属性`)
      }
    }
    expect(offenders.join('\n')).toBe('')
  })
})
