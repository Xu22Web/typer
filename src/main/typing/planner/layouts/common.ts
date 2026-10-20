import { LayoutBuilder } from './types'

/** Windows 虚拟键码（只收录本项目用得到的部分）。 */
export const VK = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  ESCAPE: 0x1b,
  /** End / Home：扩展键，宿主会自动加 KEYEVENTF_EXTENDEDKEY */
  END: 0x23,
  HOME: 0x24,
  SPACE: 0x20,
  SHIFT: 0x10,
  CONTROL: 0x11,
  ALT: 0x12,
  WIN: 0x5b,
  /** ; : */
  OEM_1: 0xba,
  /** = + */
  OEM_PLUS: 0xbb,
  OEM_COMMA: 0xbc,
  /** - _ */
  OEM_MINUS: 0xbd,
  OEM_PERIOD: 0xbe,
  /** / ? */
  OEM_2: 0xbf,
  /** ` ~ */
  OEM_3: 0xc0,
  /** [ { */
  OEM_4: 0xdb,
  /** \ | */
  OEM_5: 0xdc,
  /** ] } */
  OEM_6: 0xdd,
  /** ' " */
  OEM_7: 0xde,
  OEM_8: 0xdf
} as const

/**
 * @description 加入一对大小写字母；虚拟键码就是大写字母的 ASCII 码
 * @param builder 布局构造器
 * @param char 小写字母
 * @param vk 显式指定的虚拟键码，用于"物理位置与字符错位"的布局
 */
export function addLetterPair(builder: LayoutBuilder, char: string, vk?: number): void {
  const key = (vk ?? char.toUpperCase().charCodeAt(0)) >>> 0
  builder.pair(char, char.toUpperCase(), key)
}

/**
 * @description 按给定顺序把字母加进布局；`letters` 描述的是物理位置顺序（如 AZERTY 的
 * `azertyuiop...`），但每个字母默认仍取自身大写 ASCII 码作为 vk，需要"物理位置与字符错位"
 * 的布局应显式用 `addLetterPair(builder, char, vk)` 指定
 * @param builder 布局构造器
 * @param letters 按物理位置排列的字母
 */
export function addStandardLetters(builder: LayoutBuilder, letters: string): void {
  for (const char of letters) addLetterPair(builder, char)
}

/**
 * @description 加入美式数字行（1! 2@ 3# 4$ 5% 6^ 7& 8* 9( 0)）
 * @param builder 布局构造器
 */
export function addUsDigitRow(builder: LayoutBuilder): void {
  const pairs: Array<[string, string]> = [
    ['1', '!'],
    ['2', '@'],
    ['3', '#'],
    ['4', '$'],
    ['5', '%'],
    ['6', '^'],
    ['7', '&'],
    ['8', '*'],
    ['9', '('],
    ['0', ')']
  ]
  for (const [digit, shifted] of pairs) {
    builder.pair(digit, shifted, digit.charCodeAt(0))
  }
}

/**
 * @description 只添加数字本身（不带 Shift 符号），供 AZERTY 这类"数字需要 Shift"的布局使用
 * @param builder 布局构造器
 * @param shifts 与 1–0 对应的 Shift 字符
 */
export function addShiftedDigits(builder: LayoutBuilder, shifts: ReadonlyArray<string>): void {
  '1234567890'.split('').forEach((digit, index) => {
    builder.add(digit, digit.charCodeAt(0), 'shift')
    const shifted = shifts[index]
    if (shifted) builder.add(shifted, digit.charCodeAt(0), 'shift')
  })
}
