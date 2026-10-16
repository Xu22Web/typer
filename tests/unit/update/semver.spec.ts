import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isNewerVersion,
  normalizeVersion,
  parseVersion
} from '@main/update/semver'

describe('parseVersion', () => {
  it('接受带 v 前缀与不完整的版本号', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.2')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: [] })
    expect(parseVersion('2')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] })
  })

  it('拆分预发布标识，并忽略构建元数据', () => {
    expect(parseVersion('v1.0.0-beta.4')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['beta', '4']
    })
    expect(parseVersion('1.0.0+build.7')?.prerelease).toEqual([])
  })

  it('无法解析时返回 null 而不是抛错', () => {
    expect(parseVersion('release-2024')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('按 major/minor/patch 逐段比较', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })

  it('正式版高于同号预发布版', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
  })

  it('预发布标识按 semver 规则排序', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta.1')).toBeGreaterThan(0)
    // 数字标识符优先级低于字母标识符
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('无法解析的版本视为最小，不会被当成更新', () => {
    expect(compareVersions('nonsense', '1.0.0')).toBeLessThan(0)
    expect(isNewerVersion('nonsense', '0.1.0')).toBe(false)
  })
})

describe('isNewerVersion', () => {
  it('只有严格更高才算更新', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false)
    expect(isNewerVersion('v0.1.1', '0.1.0')).toBe(true)
  })
})

describe('normalizeVersion', () => {
  it('去掉 v 前缀并补全段数', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeVersion('1.2')).toBe('1.2.0')
    expect(normalizeVersion('v2.0.0-rc.1')).toBe('2.0.0-rc.1')
  })

  it('无法解析时原样返回', () => {
    expect(normalizeVersion('nightly')).toBe('nightly')
  })
})
