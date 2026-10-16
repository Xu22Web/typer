import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { UpdateCheckResult, UpdateProgress, UpdateState } from '@main/update/types'

/**
 * 更新中心状态（模块级单例，页面与侧边导航共享同一份）。
 * 主进程负责检查/下载/校验/安装，这里只订阅状态与进度、整理成界面可用的判断，并提供动作入口。
 */
const IDLE_STATE: UpdateState = {
  status: 'idle',
  progress: null,
  filePath: null,
  sha256: null,
  verifiedBy: null,
  error: null
}

/** 最近一次检查结果；null 表示尚未查到 */
const check = ref<UpdateCheckResult | null>(null)
/** 主进程推送的更新状态（下载/校验/就绪/失败） */
const state = ref<UpdateState>({ ...IDLE_STATE })
/** 下载进度（高频事件，单独走一个频道） */
const progress = ref<UpdateProgress | null>(null)
/** 是否正在检查更新 */
const checking = ref(false)
/** 最近一次失败原因，空串表示无错误 */
const error = ref('')

/** 是否已订阅主进程事件，避免重复绑定 */
let wired = false

/** @description 首次调用时订阅主进程的状态与进度推送 */
function wire(): void {
  if (wired) return
  wired = true

  window.api.updates.onState((next) => {
    state.value = next
    if (next.status === 'failed' && next.error) error.value = next.error
    if (next.status === 'idle') progress.value = null
  })

  window.api.updates.onProgress((next) => {
    progress.value = next
  })
}

/** @description 主动拉取一次主进程的当前更新状态（例如重新进入页面时） */
async function sync(): Promise<void> {
  try {
    state.value = await window.api.updates.state()
  } catch {
    // 忽略：读不到就保持当前状态
  }
}

/**
 * @description 请求主进程检查更新
 * @param force 是否忽略节流强制检查
 * @returns 检查结果；请求失败时为 null（原因见 error）
 */
async function runCheck(force = false): Promise<UpdateCheckResult | null> {
  checking.value = true
  error.value = ''
  try {
    const result = await window.api.updates.check(force)
    check.value = result
    return result
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return null
  } finally {
    checking.value = false
  }
}

/**
 * @description 更新中心读写：暴露状态、进度与检查/下载/取消/安装动作
 * @returns 更新状态与操作入口
 */
export function useUpdate(): {
  check: Ref<UpdateCheckResult | null>
  state: Ref<UpdateState>
  progress: Ref<UpdateProgress | null>
  checking: Ref<boolean>
  error: Ref<string>
  available: ComputedRef<boolean>
  downloading: ComputedRef<boolean>
  installed: ComputedRef<boolean>
  busy: ComputedRef<boolean>
  currentVersion: ComputedRef<string>
  latestVersion: ComputedRef<string>
  verifiedLabel: ComputedRef<string>
  init: () => Promise<void>
  runCheck: (force?: boolean) => Promise<UpdateCheckResult | null>
  download: () => Promise<void>
  cancel: () => Promise<void>
  install: () => Promise<void>
} {
  wire()

  return {
    check,
    state,
    progress,
    checking,
    error,
    /** 检查结果里确实有更高的版本 */
    available: computed(() => check.value?.status === 'available'),
    downloading: computed(
      () => state.value.status === 'downloading' || state.value.status === 'verifying'
    ),
    /** 已通过完整性校验、可以安装 */
    installed: computed(() => state.value.status === 'ready'),
    busy: computed(() => checking.value || state.value.status === 'downloading'),
    currentVersion: computed(() => check.value?.current ?? ''),
    latestVersion: computed(() => check.value?.latest?.version ?? ''),
    verifiedLabel: computed(() => {
      if (state.value.status !== 'ready') return ''
      if (state.value.verifiedBy === 'manifest') return 'SHA-256 校验通过（发布校验和）'
      if (state.value.verifiedBy === 'api-digest') return 'SHA-256 校验通过（GitHub 摘要）'
      return ''
    }),
    init: async () => {
      wire()
      await sync()
      // 主进程在启动时已经检查过一次（带节流），这里的调用通常直接复用结果
      if (!check.value) await runCheck()
    },
    runCheck,
    download: async () => {
      error.value = ''
      try {
        state.value = await window.api.updates.download()
        if (state.value.status === 'failed' && state.value.error) error.value = state.value.error
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err)
      }
    },
    cancel: async () => {
      state.value = await window.api.updates.cancel()
    },
    install: async () => {
      state.value = await window.api.updates.install()
    }
  }
}
