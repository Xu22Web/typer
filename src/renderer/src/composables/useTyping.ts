import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot, EngineState } from '@main/typing/engine/states'
import { DEFAULT_LAYOUT_ID } from '@main/typing/planner/keymap'
import { buildPlan } from '@main/typing/planner/plan'
import { describePunctuation, mapPunctuation } from '@main/typing/planner/punctuation'
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
 * @description 统计"字符 → 次数"表的总次数
 * @param map 字符统计表
 * @returns 总次数
 */
function countChars(map: Record<string, number>): number {
  return Object.values(map).reduce((sum, count) => sum + count, 0)
}

/**
 * @description 把"字符 → 次数"表写成短样例：`中×2 😀×1`（最多 8 种）
 * @param map 字符统计表
 * @returns 单行样例
 */
function samplesOf(map: Record<string, number>): string {
  const entries = Object.entries(map)
  const shown = entries
    .slice(0, 8)
    .map(([char, count]) => `${char}×${count}`)
    .join(' ')
  return entries.length > 8 ? `${shown} …` : shown
}

/**
 * @description 开始前的"无法输入"清单：全角 / 中文标点先按 ASCII 近似映射替换，
 * 仍然没有物理键位的字符（汉字、emoji、`《》` 等）直接拦下；可全部替换时请用户确认映射再继续。
 * 内容区原文不动，只替换本次要注入的文本。
 * @returns 实际交给引擎的文本；null 表示用户取消或存在无法替换的字符
 */
async function prepareText(): Promise<string | null> {
  const source = text.value
  const layout = useSettings().settings.value?.keyboard.layout ?? DEFAULT_LAYOUT_ID

  // 没有无法输入的字符：不打扰用户
  if (countChars(buildPlan(source, { layout }).stats.unsupported) === 0) return source

  const mapped = mapPunctuation(source)
  const leftover = buildPlan(mapped.text, { layout }).stats.unsupported
  const leftoverTotal = countChars(leftover)

  const lines: string[] = []
  if (mapped.replaced > 0) {
    lines.push(
      `有 ${mapped.replaced} 个全角 / 中文标点没有物理键位，将按下面的映射替换后输入：`,
      describePunctuation(mapped.changes, 10),
      '内容区的原文不会被修改，只替换本次要输入的内容。'
    )
  }
  if (leftoverTotal > 0) {
    lines.push(
      `另有 ${leftoverTotal} 个字符没有可用的近似写法：${samplesOf(leftover)}`,
      '这些字符无法通过键盘输入，请先删掉或改成可输入的字符再开始。'
    )
  }

  const options = {
    type: 'warning' as const,
    customStyle: { whiteSpace: 'pre-line' } as const
  }

  // 汉字 / emoji 换不掉，必然会失败：只提示，不启动
  if (leftoverTotal > 0) {
    try {
      await ElMessageBox.alert(lines.join('\n'), '有字符无法输入', {
        ...options,
        confirmButtonText: '知道了'
      })
    } catch {
      // 关闭弹窗同样视为已知晓
    }
    return null
  }

  try {
    await ElMessageBox.confirm(lines.join('\n'), '标点将按映射替换', {
      ...options,
      confirmButtonText: '替换并开始',
      cancelButtonText: '取消'
    })
  } catch {
    return null
  }

  pushLog(
    'warn',
    `已替换 ${mapped.replaced} 个无法直接输入的标点：${describePunctuation(mapped.changes, 6)}`
  )
  return mapped.text
}

/** @description 把内容区的文本交给引擎开始输入；倒计时与注入节奏都由设置决定 */
async function start(): Promise<void> {
  if (busy.value || unsupported.value || text.value.length === 0) return
  busy.value = true
  try {
    // 有无法直接输入的字符时先摆清单：能换的请用户确认，换不了的就别启动
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
