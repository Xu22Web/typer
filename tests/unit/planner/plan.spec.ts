import { describe, expect, it } from 'vitest'
import {
  buildPlan,
  countTypedActions,
  iterateActions,
  resolveChar,
  type PlanOptions
} from '@main/typing/planner/plan'
import { getLayout, VK } from '@main/typing/planner/keymap'
import { createRng } from '@main/typing/scheduling/rng'
import { BACKSPACE_ACTION } from '@main/typing/scheduling/typo'
import type { KeystrokeAction, KeyAction } from '@main/typing/planner/types'

/**
 * @description 过滤出动作流中的真实按键动作
 * @param actions 待过滤的动作流
 * @returns 真实按键动作数组
 */
const keysOf = (actions: KeystrokeAction[]): KeyAction[] =>
  actions.filter((action): action is KeyAction => action.kind === 'key')

/**
 * @description 取出动作流对应的字符（跳过显式停顿）
 * @param actions 动作流
 * @returns 与动作一一对应的字符数组
 */
const charsOf = (actions: KeystrokeAction[]): string[] =>
  actions.map((action) => (action.kind === 'delay' ? '' : action.char))

describe('resolveChar', () => {
  const us = getLayout('us')

  it('换行与 Tab 始终走真实按键（与布局无关）', () => {
    expect(resolveChar('\n', us)).toEqual({
      kind: 'key',
      action: { kind: 'key', vk: VK.ENTER, modifiers: [], char: '\n' }
    })
    expect(resolveChar('\t', us)).toEqual({
      kind: 'key',
      action: { kind: 'key', vk: VK.TAB, modifiers: [], char: '\t' }
    })
  })

  it('US 布局下的特殊符号走 Shift 组合的真实按键', () => {
    const resolution = resolveChar('!', us)
    expect(resolution.kind).toBe('key')
    if (resolution.kind === 'key') {
      expect(resolution.action.vk).toBe(0x31)
      expect(resolution.action.modifiers).toEqual(['shift'])
    }
  })

  it('中文与 emoji 没有物理键位，标为 unsupported', () => {
    expect(resolveChar('中', us)).toEqual({ kind: 'unsupported', char: '中' })
    expect(resolveChar('😀', us)).toEqual({ kind: 'unsupported', char: '😀' })
  })

  it('布局未收录的字符同样标为 unsupported（不再回退到 Unicode）', () => {
    expect(resolveChar('ö', getLayout('de')).kind).toBe('unsupported')
    expect(resolveChar('(', getLayout('fr')).kind).toBe('unsupported')
  })
})

describe('buildPlan', () => {
  it('ASCII 全部用真实按键，顺序与原文一致', () => {
    const plan = buildPlan('Hi !')
    expect(charsOf(plan.actions)).toEqual(['H', 'i', ' ', '!'])
    expect(keysOf(plan.actions).map((action) => action.char)).toEqual(['H', 'i', ' ', '!'])
    expect(plan.stats.chars).toBe(4)
    expect(plan.stats.unsupported).toEqual({})
  })

  it('CRLF 只产生一个回车', () => {
    const plan = buildPlan('a\r\nb')
    expect(keysOf(plan.actions).map((action) => [action.char, action.vk])).toEqual([
      ['a', 0x41],
      ['\n', VK.ENTER],
      ['b', 0x42]
    ])
  })

  it('统计信息覆盖 CJK、不可输入字符、跳过字符与动作数', () => {
    const plan = buildPlan('中文abc\u0000', { layout: 'fr' })
    expect(plan.stats.cjk).toBe(2)
    expect(plan.stats.chars).toBe(5)
    expect(plan.stats.skipped['\u0000']).toBe(1)
    expect(plan.stats.unsupported['中']).toBe(1)
    expect(plan.stats.unsupported['文']).toBe(1)
    // 'a' 'b' 'c' 在法语布局里都有收录，应全部是真实按键
    expect(plan.stats.typed).toBe(3)
  })

  it('emoji 计为不可输入，不产生动作', () => {
    const plan = buildPlan('😀')
    expect(plan.stats.typed).toBe(0)
    expect(plan.actions).toHaveLength(0)
    expect(plan.stats.unsupported['😀']).toBe(1)
  })

  it('空文本产生空计划', () => {
    const plan = buildPlan('')
    expect(plan.actions).toEqual([])
    expect(plan.stats.typed).toBe(0)
  })

  it('流式生成与一次性构建结果一致', () => {
    const input = 'Hello 世界 123 !@#\n第二行'
    const streamed = [...iterateActions(input)]
    const built = buildPlan(input).actions
    expect(streamed).toEqual(built)
    expect(countTypedActions(input)).toBe(built.length)
  })
})

describe('错字模拟', () => {
  const text = 'hello world'

  it('typoRate = 0 时不产生错字', () => {
    const plan = buildPlan(text, {
      typo: { rate: 0, style: 'adjacent', correction: 'auto', rng: createRng(1) }
    })
    expect(plan.stats.typos).toBe(0)
    expect(charsOf(plan.actions).join('')).toBe(text)
  })

  it('typoRate = 1 且自动纠正时：错字 + 退格 + 正确字符，最终内容仍正确', () => {
    const plan = buildPlan('ab', {
      typo: { rate: 1, style: 'adjacent', correction: 'auto', rng: createRng(42) }
    })
    expect(plan.stats.typos).toBeGreaterThan(0)
    expect(plan.actions).toContainEqual(BACKSPACE_ACTION)
    expect(charsOf(plan.actions)).toContain('\b')

    // 应用退格后的净结果应与原文一致
    const typed = applyBackspaces(plan.actions)
    expect(typed).toBe('ab')
  })

  it('correction = none 时保留错字（净结果与原文不同）', () => {
    const plan = buildPlan('ab', {
      typo: { rate: 1, style: 'adjacent', correction: 'none', rng: createRng(7) }
    })
    expect(plan.stats.typos).toBeGreaterThan(0)
    expect(charsOf(plan.actions)).not.toContain('\b')
    expect(applyBackspaces(plan.actions)).not.toBe('ab')
  })

  it('transpose：先打错顺序，纠正后仍得到原文', () => {
    const plan = buildPlan('ab', {
      typo: { rate: 1, style: 'transpose', correction: 'auto', rng: createRng(3) }
    })
    expect(plan.stats.typos).toBe(1)
    expect(charsOf(plan.actions.slice(0, 2))).toEqual(['b', 'a'])
    expect(applyBackspaces(plan.actions)).toBe('ab')
  })

  it('同一网格上 emoji/生僻字不造错（没有可用的形近字）', () => {
    const plan = buildPlan('😀中', {
      typo: { rate: 1, style: 'lookalike', correction: 'auto', rng: createRng(9) }
    })
    expect(plan.stats.typos).toBe(0)
  })

  it('计数遍历与产出遍历使用同种子时总数一致', () => {
    /**
     * @description 构造一份固定种子的错字选项
     * @returns 错字模拟配置
     */
    const options = (): PlanOptions => ({
      typo: {
        rate: 0.5,
        style: 'adjacent' as const,
        correction: 'auto' as const,
        rng: createRng(123)
      }
    })
    const total = countTypedActions('hello world', options())
    const actions = [...iterateActions('hello world', options())]
    expect(actions).toHaveLength(total)
  })
})

/**
 * @description 简单模拟"在目标窗口里按键 + 退格"的净效果，用于验证错字纠正后的内容
 * @param actions 待应用的动作流
 * @returns 应用退格后的净文本
 */
function applyBackspaces(actions: KeystrokeAction[]): string {
  let output = ''
  for (const action of actions) {
    if (action.kind === 'delay') continue
    if (action.kind === 'key' && action.vk === VK.BACKSPACE) {
      output = Array.from(output).slice(0, -1).join('')
      continue
    }
    output += action.char
  }
  return output
}
