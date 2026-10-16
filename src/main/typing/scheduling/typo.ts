import type { KeyAction } from '../planner/types'
import { VK } from '../planner/keymap'
import type { Rng } from './rng'

export type TypoStyle = 'adjacent' | 'lookalike' | 'transpose'
export type TypoCorrection = 'auto' | 'none'

export interface TypoOptions {
  /** 0 ~ 1 */
  rate: number
  style: TypoStyle
  /** auto：打错后自动退格纠正；none：保留错字 */
  correction: TypoCorrection
  rng: Rng
}

/** 纠正错字时使用的退格键动作。 */
export const BACKSPACE_ACTION: KeyAction = {
  kind: 'key',
  vk: VK.BACKSPACE,
  modifiers: [],
  char: '\b'
}

/**
 * 物理键盘邻键表（近似真实指法热点）。
 * 用"行 + 错位偏移"建模，避免手写 26 份邻接表。
 */
const ROWS: ReadonlyArray<{ keys: string; offset: number; y: number }> = [
  { keys: '`1234567890-=', offset: 0, y: 0 },
  { keys: 'qwertyuiop[]\\', offset: 0.5, y: 1 },
  { keys: "asdfghjkl;'", offset: 0.75, y: 2 },
  { keys: 'zxcvbnm,./', offset: 1.25, y: 3 }
]

/**
 * @description 由物理键盘行构建邻接表（用"行 + 错位偏移"建模，避免手写 26 份）
 * @returns 字符 → 相邻字符
 */
function buildAdjacency(): Record<string, string[]> {
  const positions = new Map<string, { x: number; y: number }>()

  const shiftMap: Record<string, string> = {
    '`': '~',
    '-': '_',
    '=': '+',
    '[': '{',
    ']': '}',
    '\\': '|',
    ';': ':',
    "'": '"',
    ',': '<',
    '.': '>',
    '/': '?',
    '1': '!',
    '2': '@',
    '3': '#',
    '4': '$',
    '5': '%',
    '6': '^',
    '7': '&',
    '8': '*',
    '9': '(',
    '0': ')'
  }

  for (const row of ROWS) {
    for (let i = 0; i < row.keys.length; i++) {
      const char = row.keys[i] as string
      const position = { x: row.offset + i, y: row.y }
      const upper = char.toUpperCase()
      positions.set(char, position)
      positions.set(upper, position)
      const shiftedChar = shiftMap[char]
      if (shiftedChar) positions.set(shiftedChar, position)
    }
  }

  const adjacency: Record<string, string[]> = {}
  const entries = [...positions.entries()]
  for (const [char, pos] of entries) {
    const neighbours: string[] = []
    for (const [other, otherPos] of entries) {
      if (other === char) continue
      const dy = Math.abs(otherPos.y - pos.y)
      const dx = Math.abs(otherPos.x - pos.x)
      if (dy <= 1 && dx <= 1.1) neighbours.push(other)
    }
    adjacency[char] = neighbours
  }
  return adjacency
}

/** 字符 → 相邻键位上的字符（含 Shift 形态）。 */
export const ADJACENT_KEYS: Readonly<Record<string, readonly string[]>> = buildAdjacency()

/** 形近/易混字符（ASCII 与常见中日文字形）。 */
export const LOOKALIKE_CHARS: Readonly<Record<string, readonly string[]>> = {
  '0': ['o', 'O'],
  o: ['0', 'O'],
  O: ['0', 'o'],
  '1': ['l', 'I'],
  l: ['1', 'I'],
  I: ['1', 'l'],
  '5': ['S'],
  S: ['5'],
  '8': ['B'],
  B: ['8'],
  rn: ['m'],
  m: ['rn'],
  己: ['已', '巳'],
  已: ['己', '巳'],
  巳: ['己', '已'],
  未: ['末'],
  末: ['未'],
  日: ['曰'],
  曰: ['日'],
  人: ['入'],
  入: ['人'],
  大: ['太', '犬'],
  太: ['大'],
  天: ['夫', '夭'],
  夫: ['天'],
  土: ['士'],
  士: ['土'],
  木: ['本', '术'],
  本: ['木'],
  千: ['干', '于'],
  干: ['千', '于'],
  白: ['自'],
  自: ['白'],
  乌: ['鸟'],
  鸟: ['乌'],
  处: ['外'],
  外: ['处'],
  拨: ['拔'],
  拔: ['拨'],
  分: ['份'],
  份: ['分']
}

/**
 * @description 为某个字符挑一个"看起来像打错"的替代字符；emoji 与生僻字等不适合造错的字符返回 null
 * @param char 原字符
 * @param style 造错风格
 * @param rng 随机源
 * @returns 替代字符，无可选时返回 null
 */
export function pickTypoChar(char: string, style: TypoStyle, rng: Rng): string | null {
  if (style === 'adjacent') {
    const candidates = ADJACENT_KEYS[char]
    if (candidates && candidates.length > 0) {
      return rng.pick(candidates)
    }
    const lookalikes = LOOKALIKE_CHARS[char]
    if (lookalikes && lookalikes.length > 0) return rng.pick(lookalikes)
    return null
  }

  if (style === 'lookalike') {
    const lookalikes = LOOKALIKE_CHARS[char]
    if (lookalikes && lookalikes.length > 0) return rng.pick(lookalikes)
    return null
  }

  // transpose 由 planner 在字符对层面处理，这里不单独产错字
  return null
}

/**
 * @description 按 rate 概率决定本字符是否造错
 * @param options 造错设置（含随机源）
 * @returns 是否应当造错
 */
export function shouldMakeTypo(options: TypoOptions): boolean {
  return options.rate > 0 && options.rng.bool(options.rate)
}

/**
 * @description 仅测试/调试用：暴露邻接表构建结果，便于断言
 * @param char 待查询字符
 * @returns 该字符的相邻字符；未收录时为空数组
 */
export function adjacencyOf(char: string): readonly string[] {
  return ADJACENT_KEYS[char] ?? []
}
