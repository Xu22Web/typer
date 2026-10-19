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
  /** 字符 → 键位；查不到的字符一律视为不可输入，因此非 US 布局只需收录确定无误的键位 */
  charMap: Readonly<Record<string, LayoutKey>>
  /** 该布局下需要 AltGr（Ctrl+Alt）才能输入的字符：当前实现统一视为不可输入。 */
  altGrChars: readonly string[]
  /** 死键字符（需连按两次）：当前实现统一视为不可输入。 */
  deadKeys: readonly string[]
  notes?: string
}

/** 布局构造器：让各布局文件只声明差异，避免重复。 */
export class LayoutBuilder {
  private readonly map: Record<string, LayoutKey> = {}
  private readonly altGr: string[] = []
  private readonly dead: string[] = []

  /**
   * @description 直接登记一个字符的键位
   * @param char 该键位产出的字符
   * @param vk 虚拟键码
   * @param modifiers 需要同时按下的修饰键
   * @returns 构造器本身，便于链式调用
   */
  add(char: string, vk: number, ...modifiers: Modifier[]): this {
    this.map[char] = { vk, modifiers }
    return this
  }

  /**
   * @description 登记同一物理键上的两个字符（无 Shift / 有 Shift）；两者相同时只记一次
   * @param unshifted 未按 Shift 时的字符
   * @param shifted 按住 Shift 时的字符
   * @param vk 虚拟键码
   * @returns 构造器本身，便于链式调用
   */
  pair(unshifted: string, shifted: string, vk: number): this {
    if (unshifted) this.add(unshifted, vk)
    if (shifted && shifted !== unshifted) this.add(shifted, vk, 'shift')
    return this
  }

  /**
   * @description 移除若干字符的登记，用于覆盖"先按标准布局铺开再纠正错位"的场景
   * @param chars 要移除的字符
   * @returns 构造器本身，便于链式调用
   */
  remove(...chars: string[]): this {
    for (const char of chars) delete this.map[char]
    return this
  }

  /**
   * @description 标记"需要 AltGr"的字符（仅用于自检说明，注入时统一视为不可输入）
   * @param chars 需要 AltGr 的字符
   * @returns 构造器本身，便于链式调用
   */
  markAltGr(...chars: string[]): this {
    this.altGr.push(...chars)
    return this
  }

  /**
   * @description 标记死键字符（仅用于自检说明，注入时统一视为不可输入）
   * @param chars 死键字符
   * @returns 构造器本身，便于链式调用
   */
  markDead(...chars: string[]): this {
    this.dead.push(...chars)
    return this
  }

  /**
   * @description 查询某字符是否已登记
   * @param char 待查询字符
   * @returns 是否已登记
   */
  has(char: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.map, char)
  }

  /**
   * @description 取某字符的键位
   * @param char 待查询字符
   * @returns 键位，未登记时为 undefined
   */
  get(char: string): LayoutKey | undefined {
    return this.map[char]
  }

  /**
   * @description 冻结成不可变布局（复制一份，避免后续 add 影响已构建结果）
   * @param id 布局 id
   * @param label 界面展示名
   * @param notes 该布局收录范围的说明
   * @returns 键盘布局
   */
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
