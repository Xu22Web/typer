import { describe, expect, it } from 'vitest'
import { formatDuration } from '@shared/format/duration'

describe('formatDuration', () => {
  it('不足一分钟只显示秒', () => {
    expect(formatDuration(0)).toBe('0秒')
    expect(formatDuration(1000)).toBe('1秒')
    expect(formatDuration(32_000)).toBe('32秒')
    expect(formatDuration(59_400)).toBe('59秒')
  })

  it('分与秒：值为 0 的位不显示', () => {
    expect(formatDuration(60_000)).toBe('1分')
    expect(formatDuration(95_000)).toBe('1分35秒')
    expect(formatDuration(600_000)).toBe('10分')
  })

  it('小时位：分或秒为 0 时省略该位', () => {
    expect(formatDuration(3_600_000)).toBe('1小时')
    expect(formatDuration(3_661_000)).toBe('1小时1分1秒')
    expect(formatDuration(3_725_000)).toBe('1小时2分5秒')
    expect(formatDuration(7_200_000)).toBe('2小时')
    expect(formatDuration(3_600_000 + 300_000)).toBe('1小时5分')
    expect(formatDuration(3_600_000 + 5_000)).toBe('1小时5秒')
  })

  it('秒按四舍五入', () => {
    expect(formatDuration(1_499)).toBe('1秒')
    expect(formatDuration(1_500)).toBe('2秒')
  })

  it('非法输入返回破折号', () => {
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('负数按 0 处理', () => {
    expect(formatDuration(-5)).toBe('0秒')
  })
})
