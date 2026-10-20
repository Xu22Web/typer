import { describe, expect, it } from 'vitest'
import { classifyDelivery } from '../../system/helpers/system'

describe('classifyDelivery', () => {
  it('内容完全一致时算完成', () => {
    expect(classifyDelivery('Hello !@#', 'Hello !@#')).toBe('complete')
  })

  it('只收到合法前缀（含 0 个字符）算环境中断', () => {
    expect(classifyDelivery('Hello', 'Hello !@#')).toBe('interrupted')
    expect(classifyDelivery('', 'Hello !@#')).toBe('interrupted')
  })

  it('字符内容对不上算回归', () => {
    expect(classifyDelivery('Hekko', 'Hello')).toBe('mismatch')
    expect(classifyDelivery('Hello !\\b', 'Hello !')).toBe('mismatch')
  })
})
