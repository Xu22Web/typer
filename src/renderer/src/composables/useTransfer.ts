import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type {
  ResumeMatch,
  TransferJobSummary,
  TransferPrepareOptions,
  TransferPrepareProgress
} from '@shared/transfer/transfer'
import { CHUNK_PRESETS, TRANSFER_LIMITS } from '@shared/transfer/transfer'

/** 发送计划（主进程算出来的，界面只展示）。 */
export interface TransferPlan {
  indexes: number[]
  ranges: string
  sendBegin: boolean
  sendEnd: boolean
}

const summary = ref<TransferJobSummary | null>(null)
const preparing = ref(false)
const prepareProgress = ref<TransferPrepareProgress | null>(null)
const resume = ref<ResumeMatch | null>(null)
const plan = ref<TransferPlan | null>(null)
const onlyText = ref('')
const fromIndex = ref(0)
const error = ref('')

let wired = false

function wire(): void {
  if (wired) return
  wired = true
  window.api.transfer.onPrepareProgress((progress: TransferPrepareProgress) => {
    prepareProgress.value = progress
  })
}

/** 接收端还缺哪些片；null 表示"全新传输"。 */
const resumeMissing = computed<number[] | null>(() => resume.value?.missing ?? null)

const hasJob = computed(() => summary.value !== null)

const ready = computed(() => hasJob.value && !preparing.value && !error.value)

/** 本次实际要发送的片数（点开始前就能看到）。 */
const sendingCount = computed(() => plan.value?.indexes.length ?? summary.value?.total ?? 0)

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

/** 打开文件选择框并准备（用户取消则什么都不做）。 */
async function pickAndPrepare(options: TransferPrepareOptions): Promise<void> {
  const path = await window.api.transfer.pick()
  if (!path) return
  await prepare(path, options)
}

async function cancelPrepare(): Promise<void> {
  await window.api.transfer.cancelPrepare()
  preparing.value = false
  prepareProgress.value = null
}

/** 用当前 only/from 让主进程算一次计划（纯计算，不产生输入）。 */
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

/** 导入接收端带回来的续传状态（resume.json 内容或续传令牌）。 */
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

function clearResume(): void {
  resume.value = null
  onlyText.value = ''
  fromIndex.value = 0
  void refreshPlan()
}

/** 紧凑区间文本（与主进程同口径，仅用于界面回填输入框）。 */
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

/** 开始输入（倒计时、暂停/停止等仍走引擎的统一路径）。 */
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

async function exportTools(): Promise<void> {
  try {
    const destination = await window.api.transfer.exportTools()
    if (destination) useTyping().log('info', `接收脚本已导出到 ${destination}`)
  } catch (err) {
    useTyping().log('error', err instanceof Error ? err.message : String(err))
  }
}

async function revealTools(): Promise<void> {
  try {
    await window.api.transfer.revealTools()
  } catch (err) {
    useTyping().log('error', err instanceof Error ? err.message : String(err))
  }
}

/** 片大小预设（与设置页共用同一份定义）。 */
function presetIdFor(chunkBytes: number): string {
  return CHUNK_PRESETS.find((preset) => preset.chunkBytes === chunkBytes)?.id ?? 'custom'
}

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
    presetIdFor,
    limits: TRANSFER_LIMITS
  }
}
