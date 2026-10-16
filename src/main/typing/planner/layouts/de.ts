import { LayoutBuilder, type KeyboardLayout } from './types'
import { addStandardLetters } from './common'

/**
 * @description 德语布局（de-DE，QWERTZ）：只收录确定无误的键位（字母含 y/z 互换、数字行与 , .），
 * 其余（ö ä ü ß 以及 - _ + * # 等符号）一律回退到 Unicode 注入；德语符号在 Windows 各版本间的
 * 物理位置与"US 位置直觉"差异较大，凭推测填表反而会打错字符
 * @returns 德语布局
 */
export function createDeLayout(): KeyboardLayout {
  const builder = new LayoutBuilder()

  // 字母：y / z 物理位置互换（VK_Z 位置是 y，VK_Y 位置是 z）
  addStandardLetters(builder, 'qwertzuiopasdfghjklxcvbnm')
  builder.remove('y', 'z')
  builder.add('z', 0x59)
  builder.add('Z', 0x59, 'shift')
  builder.add('y', 0x5a)
  builder.add('Y', 0x5a, 'shift')

  // 数字行：Shift 后为 ! " § $ % & / ( ) =
  const digitShifts = ['!', '"', '§', '$', '%', '&', '/', '(', ')', '=']
  '1234567890'.split('').forEach((digit, index) => {
    const vk = digit.charCodeAt(0)
    builder.add(digit, vk)
    const shifted = digitShifts[index]
    if (shifted) builder.add(shifted, vk, 'shift')
  })

  // 逗号 / 句号（Shift 为 ; :）
  builder.pair(',', ';', 0xbc)
  builder.pair('.', ':', 0xbe)
  builder.pair(' ', ' ', 0x20)

  builder.markAltGr('@', '€', '~', '\\', '|', '[', ']', '{', '}')
  builder.markDead('^', '´', '`')

  return builder.build(
    'de',
    'Deutsch',
    '仅收录字母（含 y/z 互换）、数字行与 , . ；其余字符（含 ö ä ü ß 等）走 Unicode 注入'
  )
}

export const DE_LAYOUT = createDeLayout()
