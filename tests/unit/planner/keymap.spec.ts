import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_ID,
  LAYOUTS,
  LAYOUT_IDS,
  VK,
  getLayout,
  layoutHasChar,
  lookupLayoutKey,
  validateLayout
} from '@main/typing/planner/keymap'

/** US 布局上 95 个可打印 ASCII 字符。 */
const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(0x20 + index))

describe('键位表完整性', () => {
  it('US 布局覆盖全部 95 个可打印 ASCII（含空格）', () => {
    const us = LAYOUTS.us
    const missing = PRINTABLE_ASCII.filter((char) => !layoutHasChar(us, char))
    expect(missing).toEqual([])
  })

  it('默认布局是 US', () => {
    expect(DEFAULT_LAYOUT_ID).toBe('us')
    expect(getLayout(undefined).id).toBe('us')
    expect(getLayout('不存在的布局').id).toBe('us')
  })

  it('每个布局都能通过自检（无重复键位、vk 合法）', () => {
    for (const id of LAYOUT_IDS) {
      expect(validateLayout(LAYOUTS[id]), `${id} 布局自检`).toEqual([])
    }
  })
})

describe('US 布局的关键映射', () => {
  const us = LAYOUTS.us
  const expectKey = (char: string, vk: number, modifiers: string[]): void => {
    expect(lookupLayoutKey(us, char), `${char} 未收录`).toEqual({ vk, modifiers })
  }

  it('小写字母不需要 Shift，大写需要', () => {
    expectKey('a', 0x41, [])
    expectKey('A', 0x41, ['shift'])
    expectKey('z', 0x5a, [])
    expectKey('Z', 0x5a, ['shift'])
  })

  it('数字与符号（Shift 组合）', () => {
    expectKey('1', 0x31, [])
    expectKey('!', 0x31, ['shift'])
    expectKey('2', 0x32, [])
    expectKey('@', 0x32, ['shift'])
    expectKey('3', 0x33, [])
    expectKey('#', 0x33, ['shift'])
    expectKey('0', 0x30, [])
    expectKey(')', 0x30, ['shift'])
  })

  it('全部需要 Shift 的符号都指向正确的基准键', () => {
    const shifted: Array<[string, number]> = [
      ['~', VK.OEM_3],
      ['!', 0x31],
      ['@', 0x32],
      ['#', 0x33],
      ['$', 0x34],
      ['%', 0x35],
      ['^', 0x36],
      ['&', 0x37],
      ['*', 0x38],
      ['(', 0x39],
      [')', 0x30],
      ['_', VK.OEM_MINUS],
      ['+', VK.OEM_PLUS],
      ['{', VK.OEM_4],
      ['}', VK.OEM_6],
      ['|', VK.OEM_5],
      [':', VK.OEM_1],
      ['"', VK.OEM_7],
      ['<', VK.OEM_COMMA],
      ['>', VK.OEM_PERIOD],
      ['?', VK.OEM_2]
    ]
    for (const [char, vk] of shifted) {
      expectKey(char, vk, ['shift'])
    }
  })

  it('空格是真实空格键', () => {
    expectKey(' ', VK.SPACE, [])
  })
})

describe('英美布局差异', () => {
  it('UK 的 # ~ @ " £ 与 US 不同', () => {
    const uk = LAYOUTS.uk
    expect(lookupLayoutKey(uk, '#')).toEqual({ vk: VK.OEM_8, modifiers: [] })
    expect(lookupLayoutKey(uk, '~')).toEqual({ vk: VK.OEM_8, modifiers: ['shift'] })
    expect(lookupLayoutKey(uk, '@')).toEqual({ vk: VK.OEM_7, modifiers: ['shift'] })
    expect(lookupLayoutKey(uk, '"')).toEqual({ vk: 0x32, modifiers: ['shift'] })
    expect(lookupLayoutKey(uk, '£')).toEqual({ vk: 0x33, modifiers: ['shift'] })
    expect(lookupLayoutKey(uk, '¬')).toEqual({ vk: VK.OEM_3, modifiers: ['shift'] })
  })

  it('德语布局 y/z 互换', () => {
    const de = LAYOUTS.de
    expect(lookupLayoutKey(de, 'z')).toEqual({ vk: 0x59, modifiers: [] })
    expect(lookupLayoutKey(de, 'y')).toEqual({ vk: 0x5a, modifiers: [] })
    expect(lookupLayoutKey(de, 'Y')).toEqual({ vk: 0x5a, modifiers: ['shift'] })
  })

  it('法语布局 a/q、z/w、m 错位，且数字需要 Shift', () => {
    const fr = LAYOUTS.fr
    expect(lookupLayoutKey(fr, 'a')).toEqual({ vk: 0x51, modifiers: [] })
    expect(lookupLayoutKey(fr, 'q')).toEqual({ vk: 0x41, modifiers: [] })
    expect(lookupLayoutKey(fr, 'z')).toEqual({ vk: 0x57, modifiers: [] })
    expect(lookupLayoutKey(fr, 'w')).toEqual({ vk: 0x5a, modifiers: [] })
    expect(lookupLayoutKey(fr, 'm')).toEqual({ vk: VK.OEM_1, modifiers: [] })
    expect(lookupLayoutKey(fr, '1')).toEqual({ vk: 0x31, modifiers: ['shift'] })
  })

  it('西班牙语布局有 ñ', () => {
    expect(lookupLayoutKey(LAYOUTS.es, 'ñ')).toEqual({ vk: VK.OEM_1, modifiers: [] })
    expect(lookupLayoutKey(LAYOUTS.es, 'Ñ')).toEqual({ vk: VK.OEM_1, modifiers: ['shift'] })
  })

  it('非 US 布局故意只收录确定项，其余交给 Unicode 回退', () => {
    // ö 这类字符在德语布局中位置不确定，宁可不收录（回退 Unicode 一定正确）
    expect(layoutHasChar(LAYOUTS.de, 'ö')).toBe(false)
    expect(layoutHasChar(LAYOUTS.fr, '(')).toBe(false)
  })
})
