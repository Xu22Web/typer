import { describe, expect, it } from 'vitest'
import {
  DEPRECATED_SETTING_RULES,
  collectDeprecatedSettingHints
} from '@main/settings/deprecatedSettings'

describe('collectDeprecatedSettingHints', () => {
  it('命中已移除的取值时给出提示', () => {
    const hints = collectDeprecatedSettingHints({ transfer: { paceMode: 'turbo' } })
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('极速')
  })

  it('当前合法取值不提示', () => {
    expect(collectDeprecatedSettingHints({ transfer: { paceMode: 'fast' } })).toEqual([])
    expect(collectDeprecatedSettingHints({ transfer: { paceMode: 'safe' } })).toEqual([])
  })

  it('路径缺失或配置不是对象时不报错', () => {
    expect(collectDeprecatedSettingHints({})).toEqual([])
    expect(collectDeprecatedSettingHints({ transfer: null })).toEqual([])
    expect(collectDeprecatedSettingHints(null)).toEqual([])
    expect(collectDeprecatedSettingHints('not-json')).toEqual([])
  })

  it('每条规则都带计划移除版本（防止把过渡机制当成永久兼容层）', () => {
    for (const rule of DEPRECATED_SETTING_RULES) {
      expect(rule.removeIn).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
