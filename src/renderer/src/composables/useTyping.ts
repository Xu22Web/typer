import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot, EngineState } from '@main/typing/engine/states'

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  message: string
  at: number
}

const text = ref('')
const state = ref<EngineState>('idle')
const progress = ref<ProgressSnapshot | null>(null)
const logs = ref<LogEntry[]>([])
const busy = ref(false)
const targetWindow = ref<string>('未检测')
const unsupported = ref(false)
const lastSummary = ref('')

let wired = false

function pushLog(level: LogEntry['level'], message: string): void {
  logs.value = [...logs.value.slice(-49), { level, message, at: Date.now() }]
}

function wire(): void {
  if (wired) return
  wired = true

  window.api.onState((snapshot: EngineSnapshot) => {
    state.value = snapshot.state
    if (snapshot.message && snapshot.state !== 'running') {
      pushLog(snapshot.state === 'failed' ? 'error' : 'warn', snapshot.message)
    }
  })

  window.api.onProgress((snapshot: ProgressSnapshot) => {
    progress.value = snapshot
  })

  window.api.onLog(({ level, message }) => {
    pushLog(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message)
  })
}

async function refreshForeground(): Promise<void> {
  try {
    const info = await window.api.typing.foreground()
    targetWindow.value = info && info.title ? info.title : info ? `pid ${info.pid}` : '未检测'
  } catch {
    targetWindow.value = '未检测'
  }
}

async function init(): Promise<void> {
  wire()
  try {
    const info = await window.api.getAppInfo()
    unsupported.value = !info.supported
    if (!info.supported) {
      pushLog('error', `当前系统（${info.platform}）不受支持：本程序仅支持 Windows`)
    }
  } catch {
    // 忽略：界面仍可加载
  }
  await refreshForeground()
}

async function start(): Promise<void> {
  if (busy.value || text.value.length === 0) return
  busy.value = true
  pushLog(
    'info',
    `开始：${text.value.length} 个字符（倒计时结束后将输入到「${targetWindow.value}」）`
  )
  try {
    const summary = await window.api.typing.start(text.value)
    lastSummary.value = `状态 ${summary.state}｜${summary.typed}/${summary.total} 个动作｜耗时 ${Math.round(
      summary.elapsedMs / 1000
    )}s｜种子 ${summary.seed}`
    pushLog(
      summary.state === 'completed' ? 'info' : 'warn',
      summary.error ? `结束：${summary.error}` : `结束：${lastSummary.value}`
    )
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = false
    state.value = state.value === 'running' ? 'completed' : state.value
  }
}

async function pause(): Promise<void> {
  try {
    const snapshot = await window.api.typing.pause()
    state.value = snapshot.state
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  }
}

async function resume(): Promise<void> {
  try {
    const snapshot = await window.api.typing.resume()
    state.value = snapshot.state
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  }
}

async function stop(): Promise<void> {
  try {
    const snapshot = await window.api.typing.stop('用户在界面中止')
    state.value = snapshot.state
    pushLog('warn', '已请求中止输入')
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  }
}

async function importFile(): Promise<void> {
  try {
    const path = await window.api.files.pick()
    if (!path) return
    const result = await window.api.files.import(path)
    text.value = result.text
    pushLog(
      'info',
      `已导入 ${result.fileName}（${result.charset}，${result.bytes} 字节，${result.text.length} 字符）`
    )
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  }
}

export function useTyping(): {
  text: Ref<string>
  state: Ref<EngineState>
  progress: Ref<ProgressSnapshot | null>
  logs: Ref<LogEntry[]>
  busy: Ref<boolean>
  targetWindow: Ref<string>
  unsupported: Ref<boolean>
  lastSummary: Ref<string>
  isRunning: ComputedRef<boolean>
  canStart: ComputedRef<boolean>
  init: () => Promise<void>
  start: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  importFile: () => Promise<void>
  refreshForeground: () => Promise<void>
  clearLogs: () => void
} {
  return {
    text,
    state,
    progress,
    logs,
    busy,
    targetWindow,
    unsupported,
    lastSummary,
    isRunning: computed(() => ['countdown', 'running', 'paused'].includes(state.value)),
    canStart: computed(() => !busy.value && text.value.length > 0 && !unsupported.value),
    init,
    start,
    pause,
    resume,
    stop,
    importFile,
    refreshForeground,
    clearLogs: () => {
      logs.value = []
    }
  }
}
