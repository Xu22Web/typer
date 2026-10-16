import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { TransferToolScriptPayload } from '@main/ipc/contracts'
import type {
  ResumeMatch,
  TransferJobSummary,
  TransferPrepareOptions,
  TransferPrepareProgress
} from '@shared/transfer/transfer'
import { CHUNK_PRESETS, TRANSFER_LIMITS } from '@shared/transfer/transfer'

/**
 * 文件传输状态（模块级单例）：准备分片、算发送计划、导入续传状态、开始发送。
 * 哈希与分片都在主进程完成，这里只驱动界面与回填输入项。
 */
export interface TransferPlan {
  indexes: number[]
  ranges: string
  sendBegin: boolean
  sendEnd: boolean
}

/** 当前已准备的文件摘要；null 表示还没有任务 */
const summary = ref<TransferJobSummary | null>(null)
/** 是否正在准备（读取 + 哈希 + 分片） */
const preparing = ref(false)
/** 准备阶段的进度；null 表示不在准备中 */
const prepareProgress = ref<TransferPrepareProgress | null>(null)
/** 接收端带回来的续传匹配结果 */
const resume = ref<ResumeMatch | null>(null)
/** 本次实际要发送的片与范围文本 */
const plan = ref<TransferPlan | null>(null)
/** 用户手填的"只发这些片"区间文本 */
const onlyText = ref('')
/** 从第几片开始发（1 基） */
const fromIndex = ref(0)
/** 最近一次失败原因，空串表示无错误 */
const error = ref('')

/** 是否已订阅主进程的准备进度推送 */
let wired = false

/** @description 首次调用时订阅主进程的准备进度推送 */
function wire(): void {
  if (wired) return
  wired = true
  window.api.transfer.onPrepareProgress((progress: TransferPrepareProgress) => {
    prepareProgress.value = progress
  })
}

/** 接收端还缺哪些片；null 表示"全新传输" */
const resumeMissing = computed<number[] | null>(() => resume.value?.missing ?? null)

/** 是否已有准备好的文件 */
const hasJob = computed(() => summary.value !== null)

/** 是否可以直接开始发送（有文件、不在准备、无错误） */
const ready = computed(() => hasJob.value && !preparing.value && !error.value)

/** 本次实际要发送的片数（点开始前就能看到） */
const sendingCount = computed(() => plan.value?.indexes.length ?? summary.value?.total ?? 0)

/**
 * @description 让主进程读取文件并算出分片表（大文件走流式哈希）
 * @param path 待发送文件的绝对路径
 * @param options 编码、片大小与帧长上限
 * @param reuse 是否复用已有的准备结果（改动编码时用）
 */
async function prepare(
  path: string,
  options: TransferPrepareOptions,
  reuse = false
): Promise<void> {
  wire()
  preparing.value = true
  error.value = ''
  prepareProgress.value = { phase: 'hash', done: 0, total: 0 }
  try {
    const loaded = await window.api.transfer.prepare(path, options, { reuse })
    summary.value = loaded
    // 换了文件或重新准备后，之前的"要发哪些片"就不再有效
    if (!reuse) resume.value = null
    await refreshPlan()
    useTyping().log(
      'info',
      `已准备文件：${loaded.name}（${loaded.size} 字节 → ${loaded.total} 片，${loaded.encoding}）`
    )
  } catch (err) {
    summary.value = null
    error.value = err instanceof Error ? err.message : String(err)
    useTyping().log('error', error.value)
  } finally {
    preparing.value = false
    prepareProgress.value = null
  }
}

/**
 * @description 打开系统文件选择框并准备（用户取消则什么都不做）
 * @param options 编码、片大小与帧长上限
 */
async function pickAndPrepare(options: TransferPrepareOptions): Promise<void> {
  const path = await window.api.transfer.pick()
  if (!path) return
  await prepare(path, options)
}

/** @description 取消正在进行的准备（哈希/分片） */
async function cancelPrepare(): Promise<void> {
  await window.api.transfer.cancelPrepare()
  preparing.value = false
  prepareProgress.value = null
}

/** @description 用当前 only/from 让主进程重算发送计划（纯计算，不产生任何输入） */
async function refreshPlan(): Promise<void> {
  if (!hasJob.value) {
    plan.value = null
    return
  }
  try {
    plan.value = await window.api.transfer.plan({
      only: onlyText.value,
      from: fromIndex.value,
      resumeMissing: resumeMissing.value
    })
    error.value = ''
  } catch (err) {
    plan.value = null
    error.value = err instanceof Error ? err.message : String(err)
  }
}

/**
 * @description 导入接收端带回来的续传状态（resume.json 内容或续传令牌）
 * @param text 接收端输出的续传文本
 */
async function applyResume(text: string): Promise<void> {
  try {
    const matched = await window.api.transfer.resumeState(text)
    resume.value = matched
    // 续传的默认行为：只补缺失的片
    onlyText.value = matched.missing.length > 0 ? compressRanges(matched.missing) : ''
    fromIndex.value = 0
    await refreshPlan()
    for (const warning of matched.warnings) useTyping().log('warn', warning)
    useTyping().log(
      'info',
      matched.missing.length > 0
        ? `续传状态已载入：还缺 ${matched.missing.length} 片（${compressRanges(matched.missing)}）`
        : '续传状态已载入：接收端看起来已经收全，可以直接让它合并校验'
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error.value = message
    useTyping().log('error', message)
  }
}

/** @description 清空续传状态与 only/from，回到"全新传输" */
function clearResume(): void {
  resume.value = null
  onlyText.value = ''
  fromIndex.value = 0
  void refreshPlan()
}

/**
 * @description 把片号压成紧凑区间文本（与主进程同口径，仅用于回填输入框）
 * @param indexes 片号列表（可重复、可乱序）
 * @returns 形如 `1-5,9` 的区间文本
 */
function compressRanges(indexes: number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b)
  const parts: string[] = []
  let start: number | null = null
  let previous: number | null = null
  for (const index of sorted) {
    if (start === null) {
      start = index
      previous = index
      continue
    }
    if (previous !== null && index === previous + 1) {
      previous = index
      continue
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`)
    start = index
    previous = index
  }
  if (start !== null) parts.push(start === previous ? String(start) : `${start}-${previous}`)
  return parts.join(',')
}

/** @description 开始发送：先重算计划，再交给引擎逐帧注入 */
async function start(): Promise<void> {
  if (!hasJob.value) return
  try {
    await refreshPlan()
    const result = await window.api.transfer.start({
      only: onlyText.value,
      from: fromIndex.value,
      resumeMissing: resumeMissing.value
    })
    if (result.plan) plan.value = result.plan
    useTyping().log(
      result.state === 'completed' ? 'info' : 'warn',
      result.error
        ? `文件传输结束：${result.error}`
        : `文件传输结束：${result.state}｜发送 ${result.plan?.ranges ?? ''}｜耗时 ${Math.round(
            result.elapsedMs / 1000
          )}s`
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error.value = message
    useTyping().log('error', message)
  }
}

/** @description 把接收脚本导出到用户选择的位置 */
async function exportTools(): Promise<void> {
  try {
    const destination = await window.api.transfer.exportTools()
    if (destination)
      useTyping().log(
        'info',
        `接收端脚本与 run.bat 已导出到 ${destination}（目标机双击 run.bat 即可）`
      )
  } catch (err) {
    useTyping().log('error', err instanceof Error ? err.message : String(err))
  }
}

/** @description 在文件管理器里打开随包分发的接收脚本目录 */
async function revealTools(): Promise<void> {
  try {
    await window.api.transfer.revealTools()
  } catch (err) {
    useTyping().log('error', err instanceof Error ? err.message : String(err))
  }
}

/**
 * @description 取回随包分发的接收端脚本的路径与全文，失败写入错误日志
 * @returns 脚本路径与全文；调用失败或内容为空时返回 null
 */
async function loadToolScript(): Promise<TransferToolScriptPayload | null> {
  try {
    const script = await window.api.transfer.toolScript()
    if (script.text.length === 0) throw new Error('接收脚本内容为空')
    return script
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useTyping().log('error', `读取接收脚本失败：${message}`)
    return null
  }
}

/**
 * @description 找出与给定字节数匹配的片大小预设
 * @param chunkBytes 片大小（字节）
 * @returns 预设 id；没有匹配项时返回 `custom`
 */
function presetIdFor(chunkBytes: number): string {
  return CHUNK_PRESETS.find((preset) => preset.chunkBytes === chunkBytes)?.id ?? 'custom'
}

/**
 * @description 文件传输读写（模块级单例）：暴露任务摘要、计划与全部操作
 * @returns 传输状态与操作方法
 */
export function useTransfer(): {
  summary: Ref<TransferJobSummary | null>
  preparing: Ref<boolean>
  prepareProgress: Ref<TransferPrepareProgress | null>
  resume: Ref<ResumeMatch | null>
  plan: Ref<TransferPlan | null>
  onlyText: Ref<string>
  fromIndex: Ref<number>
  error: Ref<string>
  hasJob: ComputedRef<boolean>
  ready: ComputedRef<boolean>
  sendingCount: ComputedRef<number>
  resumeMissing: ComputedRef<number[] | null>
  prepare: (path: string, options: TransferPrepareOptions, reuse?: boolean) => Promise<void>
  pickAndPrepare: (options: TransferPrepareOptions) => Promise<void>
  cancelPrepare: () => Promise<void>
  refreshPlan: () => Promise<void>
  applyResume: (text: string) => Promise<void>
  clearResume: () => void
  start: () => Promise<void>
  exportTools: () => Promise<void>
  revealTools: () => Promise<void>
  loadToolScript: () => Promise<TransferToolScriptPayload | null>
  presetIdFor: (chunkBytes: number) => string
  limits: typeof TRANSFER_LIMITS
} {
  return {
    summary,
    preparing,
    prepareProgress,
    resume,
    plan,
    onlyText,
    fromIndex,
    error,
    hasJob,
    ready,
    sendingCount,
    resumeMissing,
    prepare,
    pickAndPrepare,
    cancelPrepare,
    refreshPlan,
    applyResume,
    clearResume,
    start,
    exportTools,
    revealTools,
    loadToolScript,
    presetIdFor,
    limits: TRANSFER_LIMITS
  }
}
