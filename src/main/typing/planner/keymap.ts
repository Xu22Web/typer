import type { Modifier } from './types'
import { VK } from './layouts/common'
import { DE_LAYOUT } from './layouts/de'
import { ES_LAYOUT } from './layouts/es'
import { FR_LAYOUT } from './layouts/fr'
import { UK_LAYOUT } from './layouts/uk'
import { US_LAYOUT } from './layouts/us'
import type { KeyboardLayout, LayoutId, LayoutKey } from './layouts/types'

export { VK }
export type { KeyboardLayout, LayoutId, LayoutKey }
export type { LayoutBuilder } from './layouts/types'

export const LAYOUT_IDS: readonly LayoutId[] = ['us', 'uk', 'de', 'fr', 'es']

export const LAYOUTS: Readonly<Record<LayoutId, KeyboardLayout>> = {
  us: US_LAYOUT,
  uk: UK_LAYOUT,
  de: DE_LAYOUT,
  fr: FR_LAYOUT,
  es: ES_LAYOUT
}

export const DEFAULT_LAYOUT_ID: LayoutId = 'us'

/**
 * @description 判断任意值是否是已知的布局 id
 * @param value 待判定的值
 * @returns 是否是合法布局 id
 */
export function isLayoutId(value: unknown): value is LayoutId {
  return typeof value === 'string' && (LAYOUT_IDS as readonly string[]).includes(value)
}

/**
 * @description 按 id 取布局；id 缺失或非法时回退到默认布局
 * @param id 布局 id
 * @returns 键盘布局
 */
export function getLayout(id: LayoutId | string | undefined): KeyboardLayout {
  if (isLayoutId(id)) return LAYOUTS[id]
  return LAYOUTS[DEFAULT_LAYOUT_ID]
}

/**
 * @description 查询字符在该布局下的键位
 * @param layout 键盘布局
 * @param char 单个码点
 * @returns 键位；undefined 表示需要回退到 Unicode 注入
 */
export function lookupLayoutKey(layout: KeyboardLayout, char: string): LayoutKey | undefined {
  return Object.prototype.hasOwnProperty.call(layout.charMap, char)
    ? layout.charMap[char]
    : undefined
}

/**
 * @description 该布局是否收录了某字符（用于区分"非 ASCII 回退"与"布局缺失回退"）
 * @param layout 键盘布局
 * @param char 单个码点
 * @returns 是否收录
 */
export function layoutHasChar(layout: KeyboardLayout, char: string): boolean {
  return Object.prototype.hasOwnProperty.call(layout.charMap, char)
}

export interface LayoutIssue {
  severity: 'error' | 'warning'
  message: string
}

const VALID_MODIFIERS: readonly Modifier[] = ['shift', 'ctrl', 'alt', 'win']

/**
 * @description 布局自检：`error` 表示映射本身不合法（会打错字符），`warning` 只是提示
 * @param layout 待校验的布局
 * @returns 发现的问题清单
 */
export function validateLayout(layout: KeyboardLayout): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const seenKeys = new Map<string, string>()

  if (!layout.id) issues.push({ severity: 'error', message: '布局缺少 id' })
  if (!layout.label) issues.push({ severity: 'error', message: `布局 ${layout.id} 缺少 label` })

  for (const [char, key] of Object.entries(layout.charMap)) {
    if (Array.from(char).length !== 1) {
      issues.push({
        severity: 'error',
        message: `[${layout.id}] 键 "${char}" 不是单个码点`
      })
    }

    if (!Number.isInteger(key.vk) || key.vk < 0x08 || key.vk > 0xff) {
      issues.push({
        severity: 'error',
        message: `[${layout.id}] 字符 "${char}" 的 vk=${key.vk} 不是合法虚拟键码`
      })
    }

    const uniqueModifiers = new Set(key.modifiers)
    if (uniqueModifiers.size !== key.modifiers.length) {
      issues.push({
        severity: 'error',
        message: `[${layout.id}] 字符 "${char}" 的修饰键重复`
      })
    }
    for (const modifier of key.modifiers) {
      if (!VALID_MODIFIERS.includes(modifier)) {
        issues.push({
          severity: 'error',
          message: `[${layout.id}] 字符 "${char}" 含未知修饰键 ${String(modifier)}`
        })
      }
    }

    // 同一个 (vk, 修饰键) 组合不可能产出两个不同字符
    const signature = `${key.vk}+${[...uniqueModifiers].sort().join(',')}`
    const previous = seenKeys.get(signature)
    if (previous !== undefined && previous !== char) {
      issues.push({
        severity: 'error',
        message: `[${layout.id}] "${previous}" 与 "${char}" 映射到了同一个键位 (vk=${key.vk})`
      })
    } else {
      seenKeys.set(signature, char)
    }
  }

  return issues
}
