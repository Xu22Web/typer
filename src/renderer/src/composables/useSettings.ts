import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { toPlainPayload } from '@main/ipc/plainPayload'
import type { Settings } from '@main/settings/types'

/** 一次设置操作的结果，交给界面决定提示文案与是否关闭抽屉。 */
export interface SettingsActionResult {
  ok: boolean
  error?: string
}

/**
 * 设置状态（模块级单例，多个组件共享同一份）。
 * 设置的合法性由主进程负责（夹取/回退默认值），这里只做展示与提交。
 */
const settings = ref<Settings | null>(null)
const loading = ref(false)
const error = ref('')
let loadPromise: Promise<void> | null = null

async function load(force = false): Promise<void> {
  if (!force && settings.value) return
  if (loadPromise) return loadPromise

  loading.value = true
  error.value = ''
  loadPromise = (async () => {
    try {
      settings.value = await window.api.settings.get()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
      loadPromise = null
    }
  })()

  return loadPromise
}

/**
 * 提交设置补丁。
 *
 * 两点必须注意：
 * 1. 传参前用 `toPlainPayload` 去掉 Vue 响应式 Proxy —— 否则 IPC 的结构化克隆会失败。
 * 2. 返回是否成功，让调用方只在真正成功时才提示"已保存"并关闭抽屉。
 */
async function update(patch: Record<string, unknown>): Promise<SettingsActionResult> {
  error.value = ''
  try {
    settings.value = await window.api.settings.set(toPlainPayload(patch))
    return { ok: true }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return { ok: false, error: error.value }
  }
}

async function reset(): Promise<SettingsActionResult> {
  error.value = ''
  try {
    settings.value = await window.api.settings.reset()
    return { ok: true }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return { ok: false, error: error.value }
  }
}

export function useSettings(): {
  settings: Ref<Settings | null>
  loading: Ref<boolean>
  error: Ref<string>
  ready: ComputedRef<boolean>
  load: (force?: boolean) => Promise<void>
  update: (patch: Record<string, unknown>) => Promise<SettingsActionResult>
  reset: () => Promise<SettingsActionResult>
} {
  return {
    settings,
    loading,
    error,
    ready: computed(() => settings.value !== null),
    load,
    update,
    reset
  }
}
