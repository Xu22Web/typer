import { LayoutBuilder } from './types'

/** Windows 虚拟键码（只收录本项目用得到的部分）。 */
export const VK = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  ESCAPE: 0x1b,
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

/** 字母键的虚拟键码就是大写字母的 ASCII 码。 */
export function addLetterPair(builder: LayoutBuilder, char: string, vk?: number): void {
  const key = (vk ?? char.toUpperCase().charCodeAt(0)) >>> 0
  builder.pair(char, char.toUpperCase(), key)
}

/**
 * 按给定顺序把字母加进布局。
 * `order` 描述的是**物理位置顺序**（如 AZERTY 的 `azertyuiop...`），
 * 但每个字母的 vk 默认仍取自身大写 ASCII 码；需要"物理位置与字符错位"的布局
 * 应显式用 `addLetterPair(builder, char, vk)` 指定。
 */
export function addStandardLetters(builder: LayoutBuilder, letters: string): void {
  for (const char of letters) addLetterPair(builder, char)
}

/** 美式数字行（1! 2@ 3# 4$ 5% 6^ 7& 8* 9( 0)）。 */
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

/** 只添加数字本身（不带 Shift 符号），供 AZERTY 这类"数字需要 Shift"的布局使用。 */
export function addShiftedDigits(builder: LayoutBuilder, shifts: ReadonlyArray<string>): void {
  '1234567890'.split('').forEach((digit, index) => {
    builder.add(digit, digit.charCodeAt(0), 'shift')
    const shifted = shifts[index]
    if (shifted) builder.add(shifted, digit.charCodeAt(0), 'shift')
  })
}
