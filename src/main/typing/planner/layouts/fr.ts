import { LayoutBuilder, type KeyboardLayout } from './types'
import { addStandardLetters } from './common'

/**
 * @description 法语布局（fr-FR，AZERTY）：只收录确定无误的键位——字母 a/q、z/w、m 的物理位置
 * 与 QWERTY 不同，且数字本身需要按 Shift；其余符号（& é " ' ( - è _ ç à ) = 等）走 Unicode 注入
 * @returns 法语布局
 */
export function createFrLayout(): KeyboardLayout {
  const builder = new LayoutBuilder()

  // 先按标准 QWERTY 放置，再纠正错位的键
  addStandardLetters(builder, 'azertyuiopqsdfghjklmwxcvbn')
  builder.remove('a', 'q', 'z', 'w', 'm', 'A', 'Q', 'Z', 'W', 'M')
  builder.add('a', 0x51)
  builder.add('A', 0x51, 'shift')
  builder.add('q', 0x41)
  builder.add('Q', 0x41, 'shift')
  builder.add('z', 0x57)
  builder.add('Z', 0x57, 'shift')
  builder.add('w', 0x5a)
  builder.add('W', 0x5a, 'shift')
  builder.add('m', 0xba)
  builder.add('M', 0xba, 'shift')

  // AZERTY：数字需要 Shift
  '1234567890'.split('').forEach((digit) => {
    builder.add(digit, digit.charCodeAt(0), 'shift')
  })

  builder.pair(' ', ' ', 0x20)
  builder.markAltGr('@', '€', '~', '#', '{', '[', ']', '}', '\\', '|')
  builder.markDead('^', '¨', '´', '`', '~')

  return builder.build(
    'fr',
    'Français',
    '仅收录字母与数字；符号（& é " \' ( - è _ ç à 等）走 Unicode 注入'
  )
}

export const FR_LAYOUT = createFrLayout()
