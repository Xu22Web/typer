import { LayoutBuilder, type KeyboardLayout } from './types'
import { VK } from './common'
import { US_LAYOUT } from './us'

/**
 * 英式布局（en-GB，ISO 键盘）。
 *
 * 与 US 的差异（Windows 下 VK 语义）：
 * - `#` / `~` 在单独的键上（VK_OEM_8）
 * - Shift+2 = `"`，Shift+3 = `£`
 * - `'` / `@` 共键（VK_OEM_7）
 * - `\` / `|` 位于左侧（VK 仍是 VK_OEM_5）
 * - 数字 1 左边的键是 `` ` `` / `¬`
 */
export function createUkLayout(): KeyboardLayout {
  const builder = new LayoutBuilder()

  for (const [char, key] of Object.entries(US_LAYOUT.charMap)) {
    builder.add(char, key.vk, ...key.modifiers)
  }

  builder.add('#', VK.OEM_8)
  builder.add('~', VK.OEM_8, 'shift')
  builder.add('@', VK.OEM_7, 'shift')
  builder.add('"', 0x32, 'shift')
  builder.add('£', 0x33, 'shift')
  builder.add('¬', VK.OEM_3, 'shift')

  return builder.build('uk', 'English (UK)', '与 US 的差异为 # ~ @ " £ ¬ 六个字符')
}

export const UK_LAYOUT = createUkLayout()
