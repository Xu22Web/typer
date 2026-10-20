import { describe, expect, it } from 'vitest'
import { buildPlan } from '@main/typing/planner/plan'
import {
  describePunctuation,
  mapPunctuation,
  toAsciiPunctuation
} from '@main/typing/planner/punctuation'

describe('toAsciiPunctuation', () => {
  it('中文标点换成语义等价的 ASCII', () => {
    expect(toAsciiPunctuation('、')).toBe(',')
    expect(toAsciiPunctuation('。')).toBe('.')
    expect(toAsciiPunctuation('“')).toBe('"')
    expect(toAsciiPunctuation('【')).toBe('[')
    expect(toAsciiPunctuation('　')).toBe(' ')
  })

  it('全角 ASCII 按码点折叠成半角', () => {
    expect(toAsciiPunctuation('，')).toBe(',')
    expect(toAsciiPunctuation('！')).toBe('!')
    expect(toAsciiPunctuation('？')).toBe('?')
    expect(toAsciiPunctuation('：')).toBe(':')
    expect(toAsciiPunctuation('（')).toBe('(')
    expect(toAsciiPunctuation('％')).toBe('%')
    expect(toAsciiPunctuation('１')).toBe('1')
    expect(toAsciiPunctuation('Ａ')).toBe('A')
  })

  it('省略号可以换成多个字符', () => {
    expect(toAsciiPunctuation('…')).toBe('...')
  })

  it('汉字、emoji 与书名号没有近似写法', () => {
    expect(toAsciiPunctuation('中')).toBeUndefined()
    expect(toAsciiPunctuation('😀')).toBeUndefined()
    // 《》刻意不映射到 <>：`<`/`>` 在目标程序里可能有语义
    expect(toAsciiPunctuation('《')).toBeUndefined()
    expect(toAsciiPunctuation('》')).toBeUndefined()
  })
})

describe('mapPunctuation', () => {
  it('替换文本并统计次数（按首次出现顺序）', () => {
    const result = mapPunctuation('你好，世界，再见。')
    expect(result.text).toBe('你好,世界,再见.')
    expect(result.replaced).toBe(3)
    expect(result.changes).toEqual([
      { from: '，', to: ',', count: 2 },
      { from: '。', to: '.', count: 1 }
    ])
  })

  it('没有标点时不改文本', () => {
    const result = mapPunctuation('plain ascii 123')
    expect(result.text).toBe('plain ascii 123')
    expect(result.replaced).toBe(0)
    expect(result.changes).toEqual([])
  })

  it('汉字与 emoji 原样保留', () => {
    const result = mapPunctuation('中文😀，好')
    expect(result.text).toBe('中文😀,好')
    expect(result.replaced).toBe(1)
  })

  it('是幂等的：替换过的文本再映射不会有新的替换', () => {
    const once = mapPunctuation('“引号”，顿号、省略号…')
    expect(mapPunctuation(once.text).replaced).toBe(0)
  })

  it('替换后纯标点文本不再有 unsupported 字符', () => {
    const text = '、。，！？；：（）【】“”‘’…—　'
    expect(Object.keys(buildPlan(text, { layout: 'us' }).stats.unsupported).length).toBeGreaterThan(
      0
    )
    expect(buildPlan(mapPunctuation(text).text, { layout: 'us' }).stats.unsupported).toEqual({})
  })

  it('替换不了汉字，unsupported 仍然存在', () => {
    const mapped = mapPunctuation('中文，标点')
    expect(buildPlan(mapped.text, { layout: 'us' }).stats.unsupported).toEqual({
      中: 1,
      文: 1,
      标: 1,
      点: 1
    })
  })
})

describe('describePunctuation', () => {
  it('清单为空时返回空串', () => {
    expect(describePunctuation([])).toBe('')
  })

  it('按 `原字符 → 替换（×次数）` 拼接', () => {
    expect(
      describePunctuation([
        { from: '、', to: ',', count: 2 },
        { from: '。', to: '.', count: 1 }
      ])
    ).toBe('、 → ,（×2），。 → .（×1）')
  })

  it('超出上限时只报种类数', () => {
    const changes = ['a', 'b', 'c'].map((from) => ({ from, to: from, count: 1 }))
    expect(describePunctuation(changes, 2)).toBe('a → a（×1），b → b（×1） …（共 3 种）')
  })
})
