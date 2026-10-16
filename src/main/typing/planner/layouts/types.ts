import type { Modifier } from '../types'

export type LayoutId = 'us' | 'uk' | 'de' | 'fr' | 'es'

/** 一个字符在某个布局下的键位。 */
export interface LayoutKey {
  vk: number
  modifiers: Modifier[]
}

export interface KeyboardLayout {
  id: LayoutId
  label: string
  /**
   * 字符 → 键位。**查不到的字符一律回退到 Unicode 注入**（结果同样正确，
   * 只是不再经过真实按键路径），因此非 US 布局只需收录"确定无误"的键位。
   */
  charMap: Readonly<Record<string, LayoutKey>>
  /** 该布局下需要 AltGr（Ctrl+Alt）才能输入的字符：当前实现统一走 Unicode 回退。 */
  altGrChars: readonly string[]
  /** 死键字符（需连按两次）：当前实现统一走 Unicode 回退。 */
  deadKeys: readonly string[]
  notes?: string
}

/** 布局构造器：让各布局文件只声明差异，避免重复。 */
export class LayoutBuilder {
  private readonly map: Record<string, LayoutKey> = {}
  private readonly altGr: string[] = []
  private readonly dead: string[] = []

  add(char: string, vk: number, ...modifiers: Modifier[]): this {
    this.map[char] = { vk, modifiers }
    return this
  }

  /** 同一物理键上的两个字符（无 Shift / 有 Shift）。shifted 与 unshifted 相同时只记一次。 */
  pair(unshifted: string, shifted: string, vk: number): this {
    if (unshifted) this.add(unshifted, vk)
    if (shifted && shifted !== unshifted) this.add(shifted, vk, 'shift')
    return this
  }

  remove(...chars: string[]): this {
    for (const char of chars) delete this.map[char]
    return this
  }

  markAltGr(...chars: string[]): this {
    this.altGr.push(...chars)
    return this
  }

  markDead(...chars: string[]): this {
    this.dead.push(...chars)
    return this
  }

  has(char: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.map, char)
  }

  get(char: string): LayoutKey | undefined {
    return this.map[char]
  }

  build(id: LayoutId, label: string, notes?: string): KeyboardLayout {
    return {
      id,
      label,
      charMap: { ...this.map },
      altGrChars: [...this.altGr],
      deadKeys: [...this.dead],
      notes
    }
  }
}
