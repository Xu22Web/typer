import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  NUMERIC_BOUNDS,
  toEngineSettings
} from '@main/settings/schema'
import { TRANSFER_LIMITS } from '@shared/transfer/transfer'

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
      verifyStuckKeys: 'yes'
    })
    expect(settings.startDelayMs).toBe(DEFAULT_SETTINGS.startDelayMs)
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
    expect(normalizeSettings({ focusGuard: 'chaos' }).focusGuard).toBe('warn')
    expect(normalizeSettings({ focusGuard: 'strict' }).focusGuard).toBe('strict')
    expect(normalizeSettings({ timing: { speedMode: 'warp' } }).timing.speedMode).toBe('cps')
    expect(normalizeSettings({ typo: { style: 'random' } }).typo.style).toBe('adjacent')
  })

  it('注入档位与传输节奏：非法值回退默认', () => {
    expect(normalizeSettings({ injection: { profile: 'warp' } }).injection.profile).toBe('normal')
    expect(normalizeSettings({ transfer: { paceMode: 'warp' } }).transfer.paceMode).toBe('safe')
    expect(normalizeSettings({ transfer: { paceMode: 'fast' } }).transfer.paceMode).toBe('fast')
  })

  it('极速档放开字符/秒与每批动作数的上限', () => {
    const turbo = normalizeSettings({
      injection: { profile: 'turbo' },
      chunkSize: 512,
      timing: { cps: 2000 }
    })
    expect(turbo.chunkSize).toBe(512)
    expect(turbo.timing.cps).toBe(2000)

    // 同一份数值在标准档会被夹回人速区间
    const normal = normalizeSettings({
      injection: { profile: 'normal' },
      chunkSize: 512,
      timing: { cps: 2000 }
    })
    expect(normal).toMatchObject({ chunkSize: 64, timing: { cps: 200 } })
  })

  it('"不限速"只在极速档有效，标准档退回字符/秒', () => {
    expect(
      normalizeSettings({ injection: { profile: 'turbo' }, timing: { speedMode: 'max' } }).timing
        .speedMode
    ).toBe('max')
    expect(
      normalizeSettings({ injection: { profile: 'normal' }, timing: { speedMode: 'max' } }).timing
        .speedMode
    ).toBe('cps')
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
    const settings = normalizeSettings({ files: { importCharset: 'gbk' } })
    expect(settings.files.importCharset).toBe('gbk')
    expect(settings.timing.cps).toBe(DEFAULT_SETTINGS.timing.cps)
  })

  it('旧的 clipboard 分组被丢弃（粘贴注入已移除）', () => {
    const settings = normalizeSettings({ clipboard: { restore: false, importCharset: 'gbk' } })
    expect('clipboard' in settings).toBe(false)
    expect(settings.files.importCharset).toBe('auto')
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

  it('快捷键里的跨平台写法统一成 Ctrl（本程序只有 Windows 版本）', () => {
    expect(normalizeSettings({}).hotkeys.stop).toBe('Ctrl+Alt+X')
    expect(normalizeSettings({ hotkeys: { stop: 'CommandOrControl+Alt+X' } }).hotkeys.stop).toBe(
      'Ctrl+Alt+X'
    )
    expect(normalizeSettings({ hotkeys: { stop: 'Command+Alt+X' } }).hotkeys.stop).toBe(
      'Ctrl+Alt+X'
    )
    expect(normalizeSettings({ hotkeys: { stop: 'Cmd+Shift+S' } }).hotkeys.stop).toBe(
      'Ctrl+Shift+S'
    )
    // 已经是 Ctrl 的写法原样保留
    expect(normalizeSettings({ hotkeys: { stop: 'Ctrl+Alt+Q' } }).hotkeys.stop).toBe('Ctrl+Alt+Q')
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
      chunkSize: 5,
      seed: 99,
      focusGuard: 'strict',
      keyboard: { layout: 'de', forceUnicodeForAll: true },
      typo: { rate: 0.1, style: 'transpose', correction: 'none' },
      timing: { cps: 15 }
    })

    expect(toEngineSettings(settings)).toEqual({
      startDelayMs: 1234,
      chunkSize: 5,
      layout: 'de',
      forceUnicodeForAll: true,
      focusGuard: 'strict',
      seed: 99,
      verifyStuckKeys: settings.verifyStuckKeys,
      profile: 'normal',
      transferPace: 'safe',
      interFrameDelayMs: settings.transfer.interFrameDelayMs,
      timing: settings.timing,
      typo: { rate: 0.1, style: 'transpose', correction: 'none' }
    })
  })

  it('文件传输设置：默认值、夹取与非法枚举回退', () => {
    expect(DEFAULT_SETTINGS.transfer).toEqual({
      encoding: 'gzb64',
      paceMode: 'safe',
      chunkBytes: 8192,
      maxFrameChars: 24576,
      interFrameDelayMs: 120
    })

    // 从未改过传输设置的用户（存盘值等于旧默认值）升级后直接采用新默认值
    expect(
      normalizeSettings({
        transfer: {
          encoding: 'hex',
          paceMode: 'safe',
          chunkBytes: 1024,
          maxFrameChars: 4096,
          interFrameDelayMs: 400
        }
      }).transfer
    ).toEqual(DEFAULT_SETTINGS.transfer)

    // 只要改过某一项，就完整保留用户的选择
    const customized = normalizeSettings({
      transfer: {
        encoding: 'hex',
        paceMode: 'fast',
        chunkBytes: 1024,
        maxFrameChars: 4096,
        interFrameDelayMs: 400
      }
    })
    expect(customized.transfer.encoding).toBe('hex')
    expect(customized.transfer.chunkBytes).toBe(1024)
    expect(customized.transfer.paceMode).toBe('fast')

    const clamped = normalizeSettings({
      transfer: { chunkBytes: 99999999, maxFrameChars: 1, interFrameDelayMs: 99999 }
    })
    expect(clamped.transfer.chunkBytes).toBe(NUMERIC_BOUNDS.chunkBytes[1])
    expect(clamped.transfer.maxFrameChars).toBe(NUMERIC_BOUNDS.maxFrameChars[0])
    expect(clamped.transfer.interFrameDelayMs).toBe(TRANSFER_LIMITS.interFrameDelayMs[1])

    const fallback = normalizeSettings({ transfer: { encoding: 'rot13' } })
    expect(fallback.transfer.encoding).toBe(DEFAULT_SETTINGS.transfer.encoding)
  })

  it('浮窗摆放设置：默认值、非法枚举回退与坐标夹取', () => {
    expect(DEFAULT_SETTINGS.floating).toEqual({
      mode: 'docked',
      edge: 'right',
      offset: 24,
      x: 0,
      y: 0
    })

    const fallback = normalizeSettings({ floating: { mode: '中间', edge: '中间', offset: 'x' } })
    expect(fallback.floating).toEqual(DEFAULT_SETTINGS.floating)

    const clamped = normalizeSettings({ floating: { edge: 'top', offset: -999_999 } })
    expect(clamped.floating.edge).toBe('top')
    expect(clamped.floating.offset).toBe(NUMERIC_BOUNDS.floatOffset[0])

    const floating = normalizeSettings({
      floating: { mode: 'floating', x: 400, y: 300 }
    })
    expect(floating.floating.mode).toBe('floating')
    expect(floating.floating.x).toBe(400)
    expect(floating.floating.y).toBe(300)
  })

  it('局部更新浮窗设置时保留其它项（嵌套分组逐层合并）', () => {
    const base = normalizeSettings({ floating: { edge: 'bottom', offset: 320 } })
    const merged = mergeSettings(base, { floating: { offset: 480 } })
    expect(merged.floating).toEqual({ mode: 'docked', edge: 'bottom', offset: 480, x: 0, y: 0 })
  })
})
