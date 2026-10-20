import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot, EngineState } from '@main/typing/engine/states'
import { DEFAULT_LAYOUT_ID } from '@main/typing/planner/keymap'
import { stripUnsupported } from '@main/typing/planner/plan'
import { mapPunctuation } from '@main/typing/planner/punctuation'
import { formatDuration } from '@shared/format/duration'

/**
 * 引擎状态（模块级单例）：主进程推来的状态/进度/日志，加上开始·暂停·继续·停止等动作。
 * 日志只在内存里保留最近 50 条。
 */
export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  message: string
  at: number
}

/** 待输入文本（文本模式内容区的内容） */
const text = ref('')
/** 引擎状态：idle / countdown / running / paused / completed / failed */
const state = ref<EngineState>('idle')
/** 最近一次进度快照；null 表示还没开始 */
const progress = ref<ProgressSnapshot | null>(null)
/** 运行日志，最多保留最近 50 条 */
const logs = ref<LogEntry[]>([])
/** 是否正在等待开始/停止请求返回，用于禁用重复操作 */
const busy = ref(false)
/** 目标窗口标题；取不到时退化为进程号或"未检测" */
const targetWindow = ref<string>('未检测')
/** 当前平台是否不受支持（本程序只支持 Windows） */
const unsupported = ref(false)
/** 最近一次结束的摘要文案 */
const lastSummary = ref('')

/** 是否已订阅主进程事件，避免重复绑定 */
let wired = false

/**
 * @description 追加一条日志；超出上限时丢弃最早的
 * @param level 日志级别
 * @param message 日志内容
 */
function pushLog(level: LogEntry['level'], message: string): void {
  logs.value = [...logs.value.slice(-49), { level, message, at: Date.now() }]
}

/** @description 首次调用时订阅主进程的状态、进度与日志推送 */
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

/** @description 重新读取前台窗口，作为待输入的目标 */
async function refreshForeground(): Promise<void> {
  try {
    const info = await window.api.typing.foreground()
    targetWindow.value = info && info.title ? info.title : info ? `pid ${info.pid}` : '未检测'
  } catch {
    targetWindow.value = '未检测'
  }
}

/** @description 首次使用时订阅事件、检查平台支持并读取一次前台窗口 */
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

/** @description 只订阅主进程的状态/进度/日志推送；供进度浮窗这类轻量视图使用（不探测前台窗口、不读应用信息） */
function initEvents(): void {
  wire()
}

/**
 * @description 拉一次当前状态快照。
 * 浮窗是"运行开始后才创建"的窗口，早于它发生的状态推送收不到，不对齐一次就会整段倒计时都显示"待机"。
 */
async function syncStatus(): Promise<void> {
  try {
    const snapshot = await window.api.typing.status()
    state.value = snapshot.state
  } catch {
    // 读不到时保持默认值，不影响后续推送
  }
}

/**
 * @description 开始前把键盘打不出来的字符处理掉：中文 / 全角标点映射成对应的英文标点，
 * 剩下的（汉字、emoji 等）直接忽略。处理结果先告诉用户，确认后才开始（不阻止继续输入）。
 * 内容区原文不动，只影响本次要注入的文本。
 * @returns 实际交给引擎的文本；null 表示用户取消
 */
async function prepareText(): Promise<string | null> {
  const layout = useSettings().settings.value?.keyboard.layout ?? DEFAULT_LAYOUT_ID

  const mapped = mapPunctuation(text.value)
  const { text: usable, dropped } = stripUnsupported(mapped.text, layout)

  // 没有需要处理的字符：不打扰用户
  if (mapped.replaced === 0 && dropped === 0) return text.value

  const lines: string[] = []
  if (mapped.replaced > 0 && dropped > 0) {
    lines.push(
      `这段内容里有 ${mapped.replaced + dropped} 个字符没法直接用键盘敲出来：`,
      `· ${mapped.replaced} 个中文 / 全角标点会映射成对应的英文标点；`,
      `· ${dropped} 个字符没法转换，会直接忽略，不影响其它内容输入。`
    )
  } else if (mapped.replaced > 0) {
    lines.push(
      `这段内容里有 ${mapped.replaced} 个中文 / 全角标点没法直接用键盘敲出来，` +
        '开始后会映射成对应的英文标点。'
    )
  } else {
    lines.push(
      `这段内容里有 ${dropped} 个字符没法直接用键盘敲出来，` +
        '开始后会直接忽略，其它内容照常输入。'
    )
  }
  lines.push('内容区的原文不会被修改，只影响本次要输入的内容。')

  try {
    await ElMessageBox.confirm(lines.join('\n'), '部分字符将转换或忽略', {
      type: 'warning',
      customStyle: { whiteSpace: 'pre-line' } as const,
      confirmButtonText: '继续输入',
      cancelButtonText: '取消'
    })
  } catch {
    return null
  }

  pushLog('warn', `已映射 ${mapped.replaced} 个标点、忽略 ${dropped} 个无法输入的字符`)
  return usable
}

/** @description 把内容区的文本交给引擎开始输入；倒计时与注入节奏都由设置决定 */
async function start(): Promise<void> {
  if (busy.value || unsupported.value || text.value.length === 0) return
  busy.value = true
  try {
    // 有键盘打不出来的字符时先说明会怎么处理（标点映射成英文、其余忽略），确认后才开始
    const pending = await prepareText()
    if (pending === null) return

    pushLog(
      'info',
      `开始：${pending.length} 个字符（倒计时结束后将输入到「${targetWindow.value}」）`
    )
    const summary = await window.api.typing.start(pending)
    lastSummary.value = `状态 ${summary.state}｜${summary.typed}/${summary.total} 个动作｜耗时 ${formatDuration(
      summary.elapsedMs
    )}｜种子 ${summary.seed}`
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

/** @description 暂停输入（保留已输入的进度） */
async function pause(): Promise<void> {
  try {
    const snapshot = await window.api.typing.pause()
    state.value = snapshot.state
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  }
}

/** @description 从暂停处继续输入：主进程会先抬起修饰键并重新走一次开始倒计时 */
async function resume(): Promise<void> {
  try {
    const snapshot = await window.api.typing.resume()
    state.value = snapshot.state
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  }
}

/** @description 中止输入；引擎会先释放按下的修饰键再退出 */
async function stop(): Promise<void> {
  try {
    const snapshot = await window.api.typing.stop('用户在界面中止')
    state.value = snapshot.state
    pushLog('warn', '已请求中止输入')
  } catch (err) {
    pushLog('error', err instanceof Error ? err.message : String(err))
  }
}

/** @description 弹系统文件选择框并把选中的文本文件读进内容区 */
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

/**
 * @description 引擎读写（模块级单例）：暴露文本、状态、进度、日志与全部操作
 * @returns 引擎状态与操作方法
 */
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
  initEvents: () => void
  syncStatus: () => Promise<void>
  start: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  importFile: () => Promise<void>
  refreshForeground: () => Promise<void>
  /** 往运行日志里写一条（供文件传输等其它流程复用同一份日志） */
  log: (level: LogEntry['level'], message: string) => void
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
    initEvents,
    syncStatus,
    start,
    pause,
    resume,
    stop,
    importFile,
    refreshForeground,
    log: pushLog,
    clearLogs: () => {
      logs.value = []
    }
  }
}
