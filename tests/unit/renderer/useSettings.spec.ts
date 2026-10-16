import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { DEFAULT_SETTINGS } from '@main/settings/schema'
import type { Settings } from '@main/settings/types'
import { useSettings } from '@renderer/composables/useSettings'

interface ApiStub {
  set: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

function installWindowApi(): ApiStub {
  const set = vi.fn(async () => DEFAULT_SETTINGS)
  const get = vi.fn(async () => DEFAULT_SETTINGS)
  const reset = vi.fn(async () => DEFAULT_SETTINGS)

  ;(globalThis as unknown as { window: unknown }).window = {
    api: { settings: { set, get, reset } }
  }

  return { set, get, reset }
}

describe('useSettings.update', () => {
  let api: ApiStub

  beforeEach(() => {
    api = installWindowApi()
  })

  it('提交前去掉响应式 Proxy，载荷可被结构化克隆', async () => {
    const { update } = useSettings()
    const patch = reactive<Settings>(structuredClone(DEFAULT_SETTINGS))
    patch.startDelayMs = 1234

    const result = await update(patch as unknown as Record<string, unknown>)

    expect(result.ok).toBe(true)
    expect(api.set).toHaveBeenCalledTimes(1)
    const payload = api.set.mock.calls[0]?.[0]
    expect(() => structuredClone(payload)).not.toThrow()
    expect((payload as Settings).startDelayMs).toBe(1234)
  })

  it('成功时把主进程返回的归一化结果写回状态', async () => {
    const normalized = { ...DEFAULT_SETTINGS, startDelayMs: 60_000 }
    api.set.mockResolvedValueOnce(normalized)

    const store = useSettings()
    const result = await store.update({ startDelayMs: 999_999 })

    expect(result.ok).toBe(true)
    expect(store.settings.value?.startDelayMs).toBe(60_000)
    expect(store.error.value).toBe('')
  })

  it('失败时返回 ok: false 与原因，且不留下错误的设置状态', async () => {
    api.set.mockRejectedValueOnce(new Error('An object could not be cloned.'))

    const store = useSettings()
    const before = store.settings.value
    const result = await store.update({ startDelayMs: 1 })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('could not be cloned')
    expect(store.error.value).toContain('could not be cloned')
    expect(store.settings.value).toBe(before)
  })

  it('reset 同样返回结果并在失败时给出原因', async () => {
    api.reset.mockRejectedValueOnce(new Error('磁盘不可写'))

    const store = useSettings()
    const failed = await store.reset()
    expect(failed.ok).toBe(false)
    expect(failed.error).toBe('磁盘不可写')

    const ok = await store.reset()
    expect(ok.ok).toBe(true)
    expect(store.error.value).toBe('')
  })

  it('load 之后 ready 为 true，并可拿到设置', async () => {
    const store = useSettings()
    await store.load(true)
    expect(store.ready.value).toBe(true)
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS)
  })
})
