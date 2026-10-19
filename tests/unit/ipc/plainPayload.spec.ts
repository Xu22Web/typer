import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import { DEFAULT_SETTINGS } from '@main/settings/schema'
import type { Settings } from '@main/settings/types'
import { toPlainPayload } from '@main/ipc/plainPayload'

/**
 * @description 用结构化克隆模拟 Electron IPC 的序列化，作为"能否跨进程"的判据
 * @param value 待检验的值
 * @returns 能通过结构化克隆时为 true
 */
function canCrossIpc(value: unknown): boolean {
  try {
    structuredClone(value)
    return true
  } catch {
    return false
  }
}

describe('toPlainPayload', () => {
  it('Vue 的 reactive 代理无法直接跨 IPC，净化后可以（本次设置保存失败的根因）', () => {
    const source = reactive({ startDelayMs: 1500, timing: { cps: 12 } })

    // 先确认问题真实存在：不净化就会被结构化克隆拒绝
    expect(canCrossIpc(source)).toBe(false)

    const plain = toPlainPayload(source)
    expect(canCrossIpc(plain)).toBe(true)
    expect(plain).toEqual({ startDelayMs: 1500, timing: { cps: 12 } })
  })

  it('ref 包裹的对象同样会被净化（嵌套字段也是代理）', () => {
    const draft = ref({ timing: { cps: 6 }, typo: { rate: 0.02 } })
    expect(canCrossIpc({ ...draft.value })).toBe(false)

    const plain = toPlainPayload(draft.value)
    expect(canCrossIpc(plain)).toBe(true)
    expect(plain).toEqual({ timing: { cps: 6 }, typo: { rate: 0.02 } })
  })

  it('任意 Proxy 都会被展开（不依赖 Vue）', () => {
    const proxy = new Proxy({ startDelayMs: 1 }, {})
    expect(canCrossIpc(proxy)).toBe(false)
    expect(canCrossIpc(toPlainPayload(proxy))).toBe(true)
  })

  it('深层嵌套对象与数组都被复制成纯值，且不保留响应式引用', () => {
    const source = reactive({
      level1: { level2: { level3: { cps: 9, list: [1, 2, { inner: true }] } } }
    })

    const plain = toPlainPayload(source)
    expect(canCrossIpc(plain)).toBe(true)
    expect(plain.level1.level2.level3).toEqual({ cps: 9, list: [1, 2, { inner: true }] })

    // 修改原对象不影响副本（真正的深拷贝）
    source.level1.level2.level3.cps = 99
    expect(plain.level1.level2.level3.cps).toBe(9)
  })

  it('不修改原对象，也不带出 Vue 内部标记', () => {
    const source = reactive({ startDelayMs: 1 })
    const snapshot = JSON.stringify(source)

    const plain = toPlainPayload(source)
    expect(JSON.stringify(source)).toBe(snapshot)
    expect(Object.keys(plain)).toEqual(['startDelayMs'])
    expect(Object.getOwnPropertySymbols(plain)).toEqual([])
  })

  it('保留各值类型：字符串 / 数字 / 布尔 / null / 数组 / Date', () => {
    const when = new Date('2026-01-02T03:04:05.000Z')
    const plain = toPlainPayload({
      text: '内容',
      count: 0,
      zeroFloat: 0.5,
      flag: false,
      nothing: null,
      list: ['a', 1, true],
      when
    })

    expect(plain).toEqual({
      text: '内容',
      count: 0,
      zeroFloat: 0.5,
      flag: false,
      nothing: null,
      list: ['a', 1, true],
      when
    })
    expect(plain.when).toBeInstanceOf(Date)
    expect(canCrossIpc(plain)).toBe(true)
  })

  it('Map / Set 逐项复制且可跨 IPC', () => {
    const plain = toPlainPayload({
      map: new Map<string, { n: number }>([['a', reactive({ n: 1 })]]),
      set: new Set([1, 2])
    })

    expect(canCrossIpc(plain)).toBe(true)
    expect([...plain.map.entries()]).toEqual([['a', { n: 1 }]])
    expect([...plain.set]).toEqual([1, 2])
  })

  it('丢弃函数字段（无法克隆），其它字段保留', () => {
    const plain = toPlainPayload({ a: 1, fn: () => 1, b: 2 })
    expect(plain).toEqual({ a: 1, b: 2 })
    expect(canCrossIpc(plain)).toBe(true)
  })

  it('循环引用不会导致无限递归', () => {
    const source: Record<string, unknown> = { name: 'root' }
    source.self = source
    const plain = toPlainPayload(source)

    expect(plain.name).toBe('root')
    expect(plain.self).toBe(plain)
  })

  it('原始值原样返回', () => {
    expect(toPlainPayload('text')).toBe('text')
    expect(toPlainPayload(42)).toBe(42)
    expect(toPlainPayload(true)).toBe(true)
    expect(toPlainPayload(null)).toBe(null)
    expect(toPlainPayload(undefined)).toBe(undefined)
  })

  it('真实的设置对象（含全部嵌套分组）净化后可跨 IPC 且内容不变', () => {
    // 直接以默认设置为基准：字段增删会由 typecheck:test 当场抓出，
    // 不再手写一份容易过期的结构（旧版本这里还留着已删除的 forceUnicodeForAll / transfer.encoding）
    const settings = reactive(structuredClone(DEFAULT_SETTINGS) as Settings)

    const plain = toPlainPayload(settings)
    expect(canCrossIpc(plain)).toBe(true)
    expect(plain).toEqual(JSON.parse(JSON.stringify(settings)) as typeof plain)
    // 抽查几个嵌套分组确实被带上（含后加的 injection / update / floating）
    const result = plain as Settings
    expect(result.injection.profile).toBe(DEFAULT_SETTINGS.injection.profile)
    expect(result.floating.mode).toBe(DEFAULT_SETTINGS.floating.mode)
    expect(result.transfer.alphabet).toBe(DEFAULT_SETTINGS.transfer.alphabet)
    expect(result.update.checkOnStartup).toBe(DEFAULT_SETTINGS.update.checkOnStartup)
  })
})
