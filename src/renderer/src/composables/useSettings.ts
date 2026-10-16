import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { toPlainPayload } from '@main/ipc/plainPayload'
import type { Settings } from '@main/settings/types'

/** 一次设置操作的结果，交给界面决定提示文案。 */
export interface SettingsActionResult {
  ok: boolean
  error?: string
}

/** 设置状态（模块级单例，多个组件共享同一份）；合法性由主进程负责，这里只做展示与提交 */
const settings = ref<Settings | null>(null)
/** 是否正在从主进程读取设置 */
const loading = ref(false)
/** 最近一次读取或提交失败的原因，空串表示无错误 */
const error = ref('')
/** 进行中的加载请求；重复调用复用它，避免并发拉取 */
let loadPromise: Promise<void> | null = null

/**
 * @description 读取设置；已有缓存时直接返回
 * @param force 是否忽略缓存强制重新读取
 */
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
 * @description 提交设置补丁；传参前用 `toPlainPayload` 去掉 Vue 响应式 Proxy，
 * 否则 IPC 的结构化克隆会失败
 * @param patch 需要写入的设置补丁
 * @returns 是否成功，以及失败原因（成功时才有权提示"已保存"）
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

/**
 * @description 恢复默认设置（由主进程归一化后回填）
 * @returns 是否成功，以及失败原因
 */
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

/**
 * @description 设置读写（模块级单例）：暴露当前设置与加载/提交/重置操作
 * @returns 设置状态与操作方法
 */
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
