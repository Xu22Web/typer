import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  NUMERIC_BOUNDS,
  toEngineSettings
} from '@main/settings/schema'

describe('normalizeSettings', () => {
  it('空输入得到完整默认值', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('不是对象')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('丢弃未知字段', () => {
    const settings = normalizeSettings({ 未知字段: 1, timing: { 另一个未知: true } })
    expect('未知字段' in settings).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(settings.timing, '另一个未知')).toBe(false)
  })

  it('类型错误时回退默认值', () => {
    const settings = normalizeSettings({
      startDelayMs: '很快',
      insertMode: 42,
      verifyStuckKeys: 'yes'
    })
    expect(settings.startDelayMs).toBe(DEFAULT_SETTINGS.startDelayMs)
    expect(settings.insertMode).toBe(DEFAULT_SETTINGS.insertMode)
    expect(settings.verifyStuckKeys).toBe(DEFAULT_SETTINGS.verifyStuckKeys)
  })

  it('数值越界时夹取到边界', () => {
    const settings = normalizeSettings({
      startDelayMs: 999_999,
      chunkSize: 0,
      timing: { cps: 1000, jitterMs: -50, burstSize: -1 },
      typo: { rate: 5 }
    })
    expect(settings.startDelayMs).toBe(NUMERIC_BOUNDS.startDelayMs[1])
    expect(settings.chunkSize).toBe(NUMERIC_BOUNDS.chunkSize[0])
    expect(settings.timing.cps).toBe(NUMERIC_BOUNDS.cps[1])
    expect(settings.timing.jitterMs).toBe(0)
    expect(settings.timing.burstSize).toBe(0)
    expect(settings.typo.rate).toBe(NUMERIC_BOUNDS.typoRate[1])
  })

  it('NaN / Infinity 回退默认值', () => {
    const settings = normalizeSettings({
      startDelayMs: Number.NaN,
      chunkSize: Number.POSITIVE_INFINITY
    })
    expect(settings.startDelayMs).toBe(DEFAULT_SETTINGS.startDelayMs)
    expect(settings.chunkSize).toBe(8)
  })

  it('枚举值非法时回退默认，合法时保留', () => {
    expect(normalizeSettings({ insertMode: 'telepathy' }).insertMode).toBe('auto')
    expect(normalizeSettings({ insertMode: 'paste' }).insertMode).toBe('paste')
    expect(normalizeSettings({ focusGuard: 'chaos' }).focusGuard).toBe('warn')
    expect(normalizeSettings({ focusGuard: 'strict' }).focusGuard).toBe('strict')
    expect(normalizeSettings({ timing: { speedMode: 'warp' } }).timing.speedMode).toBe('cps')
    expect(normalizeSettings({ typo: { style: 'random' } }).typo.style).toBe('adjacent')
  })

  it('非法布局回退 us', () => {
    expect(normalizeSettings({ keyboard: { layout: 'klingon' } }).keyboard.layout).toBe('us')
    expect(normalizeSettings({ keyboard: { layout: 'de' } }).keyboard.layout).toBe('de')
  })

  it('seed 取整并夹取到 32 位无符号范围', () => {
    expect(normalizeSettings({ seed: 12.9 }).seed).toBe(12)
    expect(normalizeSettings({ seed: -5 }).seed).toBe(0)
    expect(normalizeSettings({ seed: 5e10 }).seed).toBe(NUMERIC_BOUNDS.seed[1])
  })

  it('部分字段缺失时其余保持默认', () => {
    const settings = normalizeSettings({ clipboard: { importCharset: 'gbk' } })
    expect(settings.clipboard.importCharset).toBe('gbk')
    expect(settings.clipboard.restore).toBe(true)
    expect(settings.timing.cps).toBe(DEFAULT_SETTINGS.timing.cps)
  })

  it('序列化再归一化是幂等的', () => {
    const once = normalizeSettings({ startDelayMs: 1500, timing: { cps: 12 } })
    const twice = normalizeSettings(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })

  it('更新偏好默认为启动时检查，且接受显式关闭', () => {
    expect(normalizeSettings({}).update.checkOnStartup).toBe(true)
    expect(normalizeSettings({ update: { checkOnStartup: false } }).update.checkOnStartup).toBe(
      false
    )
    // 类型不对时回退默认值，而不是把 "false" 字符串当成真值
    expect(normalizeSettings({ update: { checkOnStartup: 'false' } }).update.checkOnStartup).toBe(
      true
    )
  })
})

describe('mergeSettings', () => {
  it('深合并嵌套分组，只覆盖提供的字段', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      startDelayMs: 1000,
      timing: { cps: 20 },
      typo: { rate: 0 }
    })
    expect(merged.startDelayMs).toBe(1000)
    expect(merged.timing.cps).toBe(20)
    // 未提供的字段保持
    expect(merged.timing.jitterMs).toBe(DEFAULT_SETTINGS.timing.jitterMs)
    expect(merged.typo.style).toBe(DEFAULT_SETTINGS.typo.style)
    expect(merged.typo.rate).toBe(0)
  })

  it('合并结果同样经过校验（越界值被夹取）', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { chunkSize: 9999 })
    expect(merged.chunkSize).toBe(NUMERIC_BOUNDS.chunkSize[1])
  })

  it('非法补丁不会破坏现有设置', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { timing: '坏了' })
    expect(merged.timing.cps).toBe(DEFAULT_SETTINGS.timing.cps)
  })

  it('不修改传入的原始对象', () => {
    const base = normalizeSettings({ timing: { cps: 7 } })
    const snapshot = JSON.parse(JSON.stringify(base))
    mergeSettings(base, { timing: { cps: 30 } })
    expect(base).toEqual(snapshot)
  })
})

describe('toEngineSettings', () => {
  it('把设置投影成引擎需要的结构', () => {
    const settings = normalizeSettings({
      startDelayMs: 1234,
      insertMode: 'paste',
      autoPasteThreshold: 300,
      chunkSize: 5,
      seed: 99,
      focusGuard: 'strict',
      keyboard: { layout: 'de', forceUnicodeForAll: true },
      typo: { rate: 0.1, style: 'transpose', correction: 'none' },
      timing: { cps: 15 }
    })

    expect(toEngineSettings(settings)).toEqual({
      startDelayMs: 1234,
      insertMode: 'paste',
      autoPasteThreshold: 300,
      chunkSize: 5,
      layout: 'de',
      forceUnicodeForAll: true,
      focusGuard: 'strict',
      seed: 99,
      verifyStuckKeys: settings.verifyStuckKeys,
      timing: settings.timing,
      typo: { rate: 0.1, style: 'transpose', correction: 'none' }
    })
  })
})
