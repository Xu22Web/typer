import { LayoutBuilder, type KeyboardLayout } from './types'
import { VK, addStandardLetters } from './common'

/**
 * @description 西班牙语布局（es-ES）：与 US 基本一致（字母 + 数字行），另收录 `ñ` / `Ñ`；
 * 其余符号（¿ ¡ ´ ¨ ç 等）不可输入
 * @returns 西班牙语布局
 */
export function createEsLayout(): KeyboardLayout {
  const builder = new LayoutBuilder()

  addStandardLetters(builder, 'qwertyuiopasdfghjklzxcvbnm')
  builder.add('ñ', VK.OEM_1)
  builder.add('Ñ', VK.OEM_1, 'shift')

  const digitShifts = ['!', '"', '·', '$', '%', '&', '/', '(', ')', '=']
  '1234567890'.split('').forEach((digit, index) => {
    const vk = digit.charCodeAt(0)
    builder.add(digit, vk)
    const shifted = digitShifts[index]
    if (shifted) builder.add(shifted, vk, 'shift')
  })

  builder.pair(' ', ' ', VK.SPACE)
  builder.markAltGr('|', '@', '#', '~', '\\', '{', '[', ']', '}')
  builder.markDead('`', '´', '¨', '^')

  return builder.build('es', 'Español', '仅收录字母（含 ñ）、数字行与空格；其余符号不可输入')
}

export const ES_LAYOUT = createEsLayout()
