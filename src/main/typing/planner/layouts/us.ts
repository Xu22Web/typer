import { LayoutBuilder, type KeyboardLayout } from './types'
import { VK, addStandardLetters, addUsDigitRow } from './common'

/**
 * @description 美式布局（Windows 默认 en-US）：唯一完整覆盖 95 个可打印 ASCII 的布局
 * @returns 美式布局
 */
export function createUsLayout(): KeyboardLayout {
  const builder = new LayoutBuilder()

  builder.pair('`', '~', VK.OEM_3)
  addUsDigitRow(builder)
  builder.pair('-', '_', VK.OEM_MINUS)
  builder.pair('=', '+', VK.OEM_PLUS)

  addStandardLetters(builder, 'qwertyuiopasdfghjklzxcvbnm')

  builder.pair('[', '{', VK.OEM_4)
  builder.pair(']', '}', VK.OEM_6)
  builder.pair('\\', '|', VK.OEM_5)
  builder.pair(';', ':', VK.OEM_1)
  builder.pair("'", '"', VK.OEM_7)
  builder.pair(',', '<', VK.OEM_COMMA)
  builder.pair('.', '>', VK.OEM_PERIOD)
  builder.pair('/', '?', VK.OEM_2)
  builder.pair(' ', ' ', VK.SPACE)

  return builder.build('us', 'English (US)', '完整覆盖可打印 ASCII，无需 Unicode 回退')
}

export const US_LAYOUT = createUsLayout()
