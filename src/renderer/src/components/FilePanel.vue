<script setup lang="ts" vapor>
import {
  CHUNK_PRESETS,
  FRAME_HEAD_REDUNDANCY,
  TRANSFER_ALPHABET_OPTIONS,
  TRANSFER_MODE_OPTIONS,
  durationTone,
  formatBytes,
  type TransferAlphabet,
  type TransferCompression,
  type TransferTargetMode
} from '@shared/transfer/transfer'
import { formatDuration } from '@shared/format/duration'
import { PACE_CHARS_PER_SECOND, estimateTransferMs } from '@shared/transfer/estimate'
import { PACE_LABELS, finishClock, suggestSpeedUp } from '@shared/transfer/speedup'
import { effectiveFrameGapMs, type TransferPace } from '@main/typing/scheduling/profile'

/**
 * 文件输入面板：把选中的文件切成"每片一行"的帧并按需补发/续传。
 * 面板只负责文件摘要、Hex 预览与续传重传，节奏与其它参数都在「设置」页。
 */
const transfer = useTransfer()
const typing = useTyping()
const settingsStore = useSettings()
const toolScript = useToolScript()

/** 请求父组件把接收脚本插入文本输入；切换模式由 TyperView 负责 */
const emit = defineEmits<{ insertScript: [] }>()

/** 当前生效的设置（符号表、压缩、片大小都从这里读） */
const settings = settingsStore.settings

/** 传给主进程的准备参数；设置尚未加载时用与 schema 一致的默认值 */
const options = computed(() => ({
  alphabet: (settings.value?.transfer.alphabet ?? 'ascii32') as TransferAlphabet,
  compression: (settings.value?.transfer.compression ?? 'auto') as TransferCompression,
  quality: settings.value?.transfer.quality ?? 9,
  mode: (settings.value?.transfer.mode ?? 'term') as TransferTargetMode,
  chunkBytes: settings.value?.transfer.chunkBytes ?? 16384,
  maxFrameChars: settings.value?.transfer.maxFrameChars ?? 65536
}))

/** 已准备的文件摘要 */
const summary = transfer.summary
/** 是否正在准备（哈希/压缩/分片） */
const preparing = transfer.preparing

/** 最近一次实测的每秒字符数（没有实测时用档位默认值） */
const measuredCps = ref<number | null>(null)

// 换了文件就丢掉上次的实测速度：换台机器 / 换个目标端，旧速度只会把预估带偏
watch(
  () => summary.value?.job,
  () => {
    measuredCps.value = null
  }
)

// 运行中直接用引擎报的真实速率刷新预估：链路到底多快，只有跑起来才知道
watch(
  () => typing.progress.value?.aps,
  (aps) => {
    if (!typing.isRunning.value || !aps || aps <= 0) return
    measuredCps.value = Math.round(aps)
  }
)

/** 预计耗时：帧逐字符下发，耗时 = 字符数 ÷ 每秒字符数（帧头重复与片间停顿与引擎同源） */
const estimate = computed(() => {
  const job = summary.value
  const current = settings.value
  if (!job || !current) return null
  return estimateTransferMs(job, {
    interFrameDelayMs: effectiveFrameGapMs(
      current.transfer.paceMode,
      current.transfer.interFrameDelayMs
    ),
    headCopies: FRAME_HEAD_REDUNDANCY,
    charsPerSecond:
      measuredCps.value ?? PACE_CHARS_PER_SECOND[current.transfer.paceMode] ?? undefined
  })
})

/** 预计耗时（毫秒） */
const estimatedMs = computed(() => estimate.value?.ms ?? 0)

/** 耗时长短对应的提示色 */
const tone = computed(() => durationTone(estimatedMs.value))

/**
 * 某个节奏档在"当前链路"上的表现：有实测速率时所有档位都用实测值（链路快慢与档位无关），
 * 片间停顿仍按档位算——那才是换档真正要省下的时间。
 * @param pace 节奏档
 * @returns 每秒字符数与片间停顿
 */
function paceProfile(pace: TransferPace): { charsPerSecond: number; gapMs: number } {
  const current = settings.value
  return {
    charsPerSecond: measuredCps.value ?? PACE_CHARS_PER_SECOND[pace] ?? PACE_CHARS_PER_SECOND.safe,
    gapMs: effectiveFrameGapMs(pace, current?.transfer.interFrameDelayMs ?? 0)
  }
}

/**
 * 还能省多少：枚举“换节奏档 / 换片大小”后的耗时，只在确实省得多时才给建议。
 * 比原来的“1 小时 / 2 小时预算”有用：预算只回答能不能达标，这个直接给出下一步动作。
 */
const speedUp = computed(() => {
  const job = summary.value
  const current = settings.value
  if (!job || !current) return null
  return suggestSpeedUp(job, {
    current: {
      paceMode: current.transfer.paceMode,
      chunkBytes: job.chunkBytes,
      maxFrameChars: job.maxFrameChars
    },
    profileFor: paceProfile
  })
})

/** 当前节奏档与片大小的中文名（“已是推荐配置”时直接显示） */
const paceLabel = computed(() => PACE_LABELS[settings.value?.transfer.paceMode ?? 'safe'])
const chunkLabel = computed(
  () =>
    CHUNK_PRESETS.find((preset) => preset.chunkBytes === summary.value?.chunkBytes)?.label ??
    '自定义'
)

/** 20 秒一跳的时钟：把“预计耗时”算成真实时刻，不要每次重算都读 Date.now() */
const nowTick = ref(Date.now())
const clockTimer = window.setInterval(() => {
  nowTick.value = Date.now()
}, 20_000)
onBeforeUnmount(() => window.clearInterval(clockTimer))

/** 预计打完的时刻；超过一天就不说“几点”了 */
const finishAt = computed(() => finishClock(estimatedMs.value, nowTick.value))

/** @description 一键采用提速建议：写回设置，并按新参数重新准备 */
async function applySpeedUp(): Promise<void> {
  const suggestion = speedUp.value
  const job = summary.value
  if (!suggestion || !job) return
  const next = suggestion.next
  await settingsStore.update({
    transfer: {
      paceMode: next.paceMode,
      chunkBytes: next.chunkBytes,
      maxFrameChars: next.maxFrameChars
    }
  })
  await transfer.prepare(
    job.path,
    { ...options.value, chunkBytes: next.chunkBytes, maxFrameChars: next.maxFrameChars },
    true
  )
  ElMessage.success(`已按建议调整：${suggestion.title}`)
}

/** 大数字加千分位，读数更快（27,657 比 27657 好认） */
function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** 当前符号表的完整选项（用于标签与提示文案） */
const alphabetOption = computed(() =>
  TRANSFER_ALPHABET_OPTIONS.find((option) => option.value === options.value.alphabet)!
)

/**
 * 可选符号表：Base47 用到 `- . / ' [ ] \`` 这些键，编辑器会把它们自动更正或自动闭合，
 * 所以只在终端模式下才给选。
 */
const alphabetChoices = computed(() =>
  TRANSFER_ALPHABET_OPTIONS.filter(
    (option) => !option.terminalsOnly || options.value.mode === 'term'
  )
)

/** 当前片大小对应的预设 id */
const chunkPreset = computed(() => transfer.presetIdFor(options.value.chunkBytes))

/** 准备阶段的进度文案 */
const preparePhaseLabel = computed(() => {
  const phase = transfer.prepareProgress.value?.phase
  if (phase === 'plan') return '建立分片表'
  if (phase === 'compress') return '整文件压缩'
  return '校验用哈希'
})

/** 压缩生效时的实际压缩比（用于确认提速确实生效） */
const compressionHint = computed(() => {
  const job = summary.value
  if (!job || job.compression !== 'br' || job.size === 0) return null
  return Math.round((job.wireBytes / job.size) * 100)
})

/** 片数过多时的提示阈值：片越多，接收端建目录、合并与续传报告越慢 */
const manyParts = computed(() => (summary.value?.total ?? 0) > 5000)

/** 是否展开 Hex 预览（默认折叠） */
const showPreview = ref(false)
/** 是否展开续传/重传区（默认折叠） */
const showResume = ref(false)

/** @description 打开文件选择框并准备分片 */
async function pick(): Promise<void> {
  await transfer.pickAndPrepare(options.value)
}

/**
 * @description 切换符号表并立即按新档重新准备（沿用同一文件）
 * @param alphabet 目标符号表
 */
async function changeAlphabet(alphabet: TransferAlphabet): Promise<void> {
  await settingsStore.update({ transfer: { alphabet } })
  if (summary.value)
    await transfer.prepare(summary.value.path, { ...options.value, alphabet }, true)
}

/**
 * @description 切换"编辑器/单行输入框"模式（换行方式随之改变）
 * @param mode 目标端模式
 */
async function changeMode(mode: TransferTargetMode): Promise<void> {
  const fallback = mode !== 'term' && Boolean(alphabetOption.value.terminalsOnly)
  if (fallback) {
    ElMessage.info('Base47 档只能在终端使用：编辑器会自动更正符号，已切回 ASCII 5 位档')
  }
  const alphabet: TransferAlphabet = fallback ? 'ascii32' : options.value.alphabet
  await settingsStore.update({ transfer: fallback ? { mode, alphabet } : { mode } })
  if (summary.value)
    await transfer.prepare(summary.value.path, { ...options.value, mode, alphabet }, true)
}

/**
 * @description 切换片大小预设（片大小与帧长上限必须配套修改），并重新准备
 * @param id 预设 id
 */
async function changePreset(id: string): Promise<void> {
  const preset = CHUNK_PRESETS.find((item) => item.id === id)
  if (!preset) return
  const next = { chunkBytes: preset.chunkBytes, maxFrameChars: preset.maxFrameChars }
  await settingsStore.update({ transfer: next })
  if (summary.value) await transfer.prepare(summary.value.path, { ...options.value, ...next }, true)
}

/** 用户粘贴进来的续传状态文本 */
const resumeInput = ref('')

/** 解析结果 / 错误那一行：解析成功后要把它滚进视野（小窗口里它常在折叠线以下） */
const resumeStatusEl = ref<HTMLElement | null>(null)

/** 续传输入框的防抖句柄：粘上就自动解析，不必再点按钮 */
let resumeTimer: number | undefined

/**
 * @description 输入框变化：空则回到“全新传输”，否则防抖后自动解析。
 *
 * 接收端出错时打印的是一整段（`#FAIL` / `#MISS` / `@T2R …` / 说明），所以不做“只能粘令牌”的限制，
 * 整段粘进来交给主进程去认。
 */
function onResumeInput(): void {
  window.clearTimeout(resumeTimer)
  const text = resumeInput.value
  if (text.trim().length === 0) {
    transfer.clearResume()
    return
  }
  resumeTimer = window.setTimeout(async () => {
    await transfer.applyResume(text)
    // 粘完就应该能直接看到结果：状态行在输入框下面，小窗口里很容易落在折叠线以外
    await nextTick()
    resumeStatusEl.value?.scrollIntoView({ block: 'nearest' })
  }, 350)
}

/** @description 清空输入框与已载入的续传状态 */
function clearResumeAll(): void {
  window.clearTimeout(resumeTimer)
  resumeInput.value = ''
  transfer.clearResume()
}

/** 已载入的续传信息（拼成一行人话） */
const resumeInfo = computed(() => {
  const matched = transfer.resume.value
  if (!matched) return null
  const state = matched.state
  const sourceLabel =
    state.source === 'token' ? '续传令牌' : state.source === 'report' ? '续传报告' : '#MISS 片号'
  return {
    sourceLabel,
    job: state.job.length > 0 ? state.job : '未标注任务',
    total: state.total >= 0 ? state.total : null,
    missingCount: matched.missing.length,
    missingText: rangeText(matched.missing)
  }
})

/** 折叠头右侧的徽标：有缺片 / 已收全 / 解析失败 / 无（无则只显示弱化的提示文字） */
const resumeBadge = computed<{ tone: string; text: string } | null>(() => {
  const matched = transfer.resume.value
  if (matched) {
    return matched.missing.length > 0
      ? { tone: 'warn', text: `缺 ${matched.missing.length} 片` }
      : { tone: 'accent', text: '已收全' }
  }
  if (transfer.resumeError.value) return { tone: 'bad', text: '未识别' }
  return null
})

/**
 * @description 把片号压成紧凑区间文本（仅用于展示）
 * @param indexes 已排序片号
 * @returns 形如 `3,5,7-9`
 */
function rangeText(indexes: readonly number[]): string {
  if (indexes.length === 0) return '无'
  const parts: string[] = []
  let start = indexes[0] as number
  let prev = start
  for (let index = 1; index < indexes.length; index++) {
    const value = indexes[index] as number
    if (value === prev + 1) {
      prev = value
      continue
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`)
    start = value
    prev = value
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`)
  return parts.join(',')
}

/** @description 只发当前缺失的片（续传最常见的一步） */
async function sendMissingOnly(): Promise<void> {
  const missing = transfer.resumeMissing.value
  if (!missing || missing.length === 0) return
  transfer.onlyText.value = [...missing].sort((a, b) => a - b).join(',')
  await transfer.refreshPlan()
}

/**
 * @description 把接收脚本当普通文件发送（用于更新目标机上已有的接收端）。
 *
 * 文本模式的节奏是"给人看的"（默认 6 字符/秒），24 KB 的脚本要打一个多小时；
 * 走文件传输 + ASCII 6 位档 + 压缩，同样的脚本只要几千个字符，几十秒就能打完。
 * 用 ASCII 档是因为脚本本身是纯 ASCII，且不必依赖目标端代码页。
 * 注意：这条路径需要目标机上**已经**有能跑的接收端；首次仍然要先把脚本打进去。
 */
async function sendScriptAsFile(): Promise<void> {
  const script = await transfer.loadToolScript()
  if (!script) return
  await transfer.prepare(script.path, {
    alphabet: 'ascii64',
    compression: 'br',
    quality: 9,
    mode: 'term',
    chunkBytes: 16384,
    maxFrameChars: 65536
  })
  ElMessage.success('已按「ASCII 6 位 + 压缩」准备接收脚本：点「开始输入」即可打进目标机')
}

/** Hex 预览行（由主进程截取） */
const previewRows = computed(() => summary.value?.preview ?? [])
</script>

<template>
  <section class="card file-panel">
    <div class="card-head">
      <h2 class="card-title">
        <span class="icon i-mdi-file-arrow-up-down-outline" /><span>文件输入</span>
      </h2>
      <div class="spacer" />
      <div v-if="summary" class="chip">{{ summary.total }} 片</div>
      <div v-if="summary" class="chip">每片 {{ formatBytes(summary.chunkBytes) }}</div>
      <div v-if="summary" class="chip">{{ alphabetOption.label }}</div>
      <div v-if="compressionHint !== null" class="chip">压缩到 {{ compressionHint }}%</div>
    </div>

    <div class="panel-body">
      <!-- 未选择文件：只给一个明确的入口与必要的解释 -->
      <div v-if="!summary" class="empty">
        <p class="empty-title">选择一个文件，Typer 会把它逐片"打"到目标窗口</p>
        <p class="empty-desc">
          文件会被切成每片一行的纯文本帧，逐片校验、支持断点续传，接收端合并后再校验整文件哈希。
        </p>
        <ElButton type="primary" :loading="preparing" @click="pick">
          <span class="i-mdi-file-search-outline" /><span>选择文件</span>
        </ElButton>
      </div>

      <template v-else>
        <!-- 摘要：要发多少、要多久，是这个页面最重要的信息 -->
        <div class="summary">
          <div class="summary-name">
            <div class="i-mdi-file-outline" />
            <div class="ellipsis" :title="summary.path">{{ summary.name }}</div>
            <div class="muted">{{ formatBytes(summary.size) }}</div>
          </div>
          <dl class="summary-grid">
            <div class="summary-item">
              <dt>分片</dt>
              <dd>
                <span class="figure">{{ summary.total }}</span>
                <span class="unit">片</span>
              </dd>
              <div class="detail">末片 {{ formatBytes(summary.tailBytes) }}</div>
            </div>
            <div class="summary-item">
              <dt>最长帧</dt>
              <dd>
                <span class="figure">{{ formatCount(summary.peakFrameChars) }}</span>
                <span class="unit">字符</span>
              </dd>
              <div class="detail">上限 {{ formatCount(summary.maxFrameChars) }}</div>
            </div>
            <div class="summary-item">
              <dt>需输入</dt>
              <dd>
                <span class="figure">{{ formatCount(summary.frameChars) }}</span>
                <span class="unit">字符</span>
              </dd>
              <div class="detail">{{ formatCount(summary.typedActions) }} 次按键</div>
            </div>
            <div class="summary-item">
              <dt>线上字节</dt>
              <dd>
                <span class="figure">{{ formatBytes(summary.wireBytes) }}</span>
              </dd>
              <div class="detail" :title="summary.compressionNote">
                {{ summary.compression === 'br' ? `Brotli q${summary.quality}` : '原样' }} · 源
                {{ formatBytes(summary.size) }}
              </div>
            </div>
            <div class="summary-item">
              <dt>预计耗时</dt>
              <dd :class="`tone-${tone}`">
                <span class="figure">{{ formatDuration(estimatedMs) }}</span>
              </dd>
              <div class="detail">{{ formatCount(estimate?.charsPerSecond ?? 0) }} 字符/秒</div>
            </div>
          </dl>
          <div class="speed-row">
            <div v-if="speedUp" class="speed-advice">
              <span class="icon i-mdi-lightning-bolt text-icon warn-icon" />
              <span class="speed-text">
                {{ speedUp.title }}：约少 {{ formatDuration(speedUp.savedMs) }}
                <span class="muted">（-{{ Math.round(speedUp.savedRatio * 100) }}%）</span>
              </span>
              <ElButton size="small" type="primary" link @click="applySpeedUp">一键采用</ElButton>
            </div>
            <div v-else class="speed-advice">
              <span class="icon i-mdi-check-circle-outline text-icon ok-icon" />
              <span class="speed-text muted"
                >已是推荐配置（{{ paceLabel }} · {{ chunkLabel }}）</span
              >
            </div>
            <span
              v-if="finishAt"
              class="speed-eta"
              :title="`${summary.kindLabel} · ${summary.compressionNote}`"
            >
              预计 {{ finishAt }} 打完
            </span>
            <span v-else class="speed-eta" :title="summary.compressionNote">
              {{ summary.kindLabel }}
            </span>
          </div>
          <div class="summary-sha" :title="summary.sha256">
            <span class="sha-label">SHA-256</span>
            <span class="mono ellipsis">{{ summary.sha256 }}</span>
          </div>
        </div>

        <!--
          续传与重传：出错后唯一要做的事。放在摘要下面（不再压在滚动区末尾），
          默认折叠但标题常驻，需要时展开。
        -->
        <div class="resume">
          <button class="resume-head" type="button" @click="showResume = !showResume">
            <span class="i-mdi-history" />
            <span>续传与重传</span>
            <span v-if="resumeBadge" class="chip compact" :class="resumeBadge.tone">
              {{ resumeBadge.text }}
            </span>
            <span v-else class="resume-state">断点续传（可选）</span>
            <span class="spacer" />
            <span :class="showResume ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" />
          </button>

          <div v-if="showResume" class="resume-body">
            <p class="hint muted">
              把接收端打印的那一段整段粘进来就行（<code class="mono">@T2R …</code> /
              <code class="mono">#MISS …</code> / <code class="mono">resume.json</code>
              都认），粘上即生效，不再需要点按钮。
            </p>

            <ElInput
              v-model="resumeInput"
              type="textarea"
              :rows="2"
              resize="none"
              placeholder="粘贴接收端输出（整段也行）"
              @input="onResumeInput"
            />

            <div v-if="resumeInfo" ref="resumeStatusEl" class="notice-line resume-status">
              <span class="i-mdi-check-circle-outline text-icon ok-icon" />
              <span class="resume-status-text">
                任务 <code class="mono">{{ resumeInfo.job }}</code> · 共
                {{ resumeInfo.total ?? '?' }} 片 · 缺 {{ resumeInfo.missingCount }} 片（{{
                  resumeInfo.missingText
                }}）· 来自{{ resumeInfo.sourceLabel }}
              </span>
            </div>
            <div v-else-if="transfer.resumeError.value" class="notice-line tone-warn">
              <span class="i-mdi-alert-circle-outline text-icon" />
              <span class="resume-status-text">{{ transfer.resumeError.value }}</span>
            </div>

            <div class="resume-actions">
              <ElButton
                size="small"
                :disabled="!transfer.resumeMissing.value?.length"
                @click="sendMissingOnly"
              >
                <span class="i-mdi-playlist-check" /><span>填入缺失片号</span>
              </ElButton>
              <ElButton
                size="small"
                text
                :disabled="!transfer.resume.value && resumeInput.length === 0"
                @click="clearResumeAll"
              >
                <span>清除续传状态</span>
              </ElButton>
            </div>

            <div class="resume-plan">
              <label class="control">
                <span class="control-label">只发指定片</span>
                <ElInput
                  v-model="transfer.onlyText.value"
                  size="small"
                  placeholder="如 3,5,12-20；分隔符用英文逗号 / 分号 / 空格"
                  @change="transfer.refreshPlan()"
                />
              </label>
              <label class="control narrow">
                <span class="control-label">起始片号</span>
                <ElInputNumber
                  v-model="transfer.fromIndex.value"
                  size="small"
                  :min="0"
                  :max="Math.max(0, summary.total)"
                  controls-position="right"
                  @change="transfer.refreshPlan()"
                />
              </label>
            </div>

            <div class="plan-line">
              <div class="i-mdi-information-outline text-icon" />
              <div class="plan-text">
                本次将发送 <strong>{{ transfer.plan.value?.ranges ?? '全部' }}</strong> 共
                {{ transfer.sendingCount.value }} 片<template v-if="transfer.plan.value?.sendBegin"
                  >，先发开始帧</template
                ><template v-if="transfer.plan.value?.sendEnd">，发完通知接收端合并校验</template
                ><template v-else>，不发结束帧（接收端仍缺片）</template>。
              </div>
            </div>
          </div>
        </div>

        <div v-if="tone !== 'ok'" class="notice-line" :class="`tone-${tone}`">
          <div class="i-mdi-alert-outline text-icon" />
          <div class="notice-text">
            <template v-if="tone === 'danger'">
              预计需要 {{ formatDuration(estimatedMs) }}。提速手段按效果排序：先确认字符档（5 位档零
              Shift，6 位档字符更少但需要
              Shift）、开启压缩、换更大的片（减少帧头）、把节奏换成「极速」。
              文件本身几乎不可压缩时，键入方式达不到 1 小时，只能拆分发送或改用其它通道。
            </template>
            <template v-else>
              预计需要 {{ formatDuration(estimatedMs) }}，请确认目标窗口在倒计时结束前处于就绪状态。
            </template>
          </div>
        </div>

        <div v-if="manyParts" class="notice-line tone-warn">
          <div class="i-mdi-alert-outline text-icon" />
          <div class="notice-text">
            共 {{ summary?.total }} 片：片越碎，接收端分片落盘、合并与续传报告都越慢。
            把「片大小」换成「大文件」预设可以显著减少片数。
          </div>
        </div>

        <!-- 参数：只放与"这次发什么"直接相关的两项 -->
        <div class="controls">
          <label class="control" :title="alphabetOption.description">
            <span class="control-label">字符档</span>
            <ElSelect
              :model-value="options.alphabet"
              size="small"
              :disabled="typing.isRunning.value"
              @change="changeAlphabet($event as TransferAlphabet)"
            >
              <ElOption
                v-for="option in alphabetChoices"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </ElSelect>
          </label>

          <label class="control" title="目标端决定换行方式：终端与编辑器用真回车，单行框不加换行">
            <span class="control-label">目标端</span>
            <ElSelect
              :model-value="options.mode"
              size="small"
              :disabled="typing.isRunning.value"
              @change="changeMode($event as TransferTargetMode)"
            >
              <ElOption
                v-for="mode in TRANSFER_MODE_OPTIONS"
                :key="mode.value"
                :label="mode.label"
                :value="mode.value"
              />
            </ElSelect>
          </label>

          <label class="control">
            <span class="control-label">片大小</span>
            <ElSelect
              :model-value="chunkPreset"
              size="small"
              :disabled="typing.isRunning.value"
              @change="changePreset($event as string)"
            >
              <ElOption
                v-for="preset in CHUNK_PRESETS"
                :key="preset.id"
                :label="`${preset.label} · ${formatBytes(preset.chunkBytes)}`"
                :value="preset.id"
              />
              <ElOption v-if="chunkPreset === 'custom'" label="自定义（设置页）" value="custom" />
            </ElSelect>
          </label>

          <ElButton
            class="control-btn"
            size="small"
            :disabled="typing.isRunning.value || preparing"
            @click="pick"
          >
            <span class="i-mdi-file-swap-outline" /><span>换一个文件</span>
          </ElButton>
          <ElButton class="control-btn" size="small" text @click="showPreview = !showPreview">
            <span :class="showPreview ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" />
            {{ showPreview ? '收起预览' : '查看 Hex' }}
          </ElButton>
        </div>

        <p class="hint muted encoding-hint" :title="alphabetOption.description">
          {{ alphabetOption.description }}
        </p>

        <HexPreview v-if="showPreview" :rows="previewRows" />
      </template>

      <ElProgress
        v-if="preparing"
        class="prepare-progress"
        :percentage="
          transfer.prepareProgress.value && transfer.prepareProgress.value.total > 0
            ? Math.round(
                (transfer.prepareProgress.value.done / transfer.prepareProgress.value.total) * 100
              )
            : 0
        "
        :stroke-width="4"
      />
      <p v-if="preparing" class="hint muted">
        正在准备文件（{{ preparePhaseLabel }}）…
        <ElButton size="small" text @click="transfer.cancelPrepare()">取消</ElButton>
      </p>

      <ElAlert
        v-if="transfer.error.value"
        class="panel-error"
        type="error"
        :closable="false"
        show-icon
        :title="transfer.error.value"
      />
    </div>

    <!-- 脚本：目标机需要的东西，一键取走（未选文件时也要能取，目标机往往先缺脚本） -->
    <div class="tools">
      <div class="tools-text muted">
        <div class="icon i-mdi-console-line text-icon" />
        <div>
          目标端运行 <code class="mono">typer-recv.mjs</code> 或双击
          <code class="mono">run.bat</code>；零依赖，Node ≥ 14
        </div>
      </div>
      <div class="tools-actions">
        <ElButton
          size="small"
          text
          :loading="toolScript.loading.value"
          @click="emit('insertScript')"
        >
          <span class="i-mdi-content-paste" /><span>插入接收脚本到文本输入</span>
        </ElButton>
        <ElButton
          size="small"
          text
          :disabled="typing.isRunning.value || preparing"
          title="目标机已有接收端时，用文件传输更新脚本（ASCII 6 位 + 压缩，几十秒）；首次仍须先把脚本打进终端"
          @click="sendScriptAsFile"
        >
          <span class="i-mdi-rocket-launch-outline" /><span>以文件方式发送脚本</span>
        </ElButton>
        <ElButton size="small" text @click="transfer.exportTools()">
          <span class="i-mdi-export-variant" /><span>导出脚本</span>
        </ElButton>
        <ElButton size="small" text @click="transfer.revealTools()">
          <span class="i-mdi-folder-open-outline" /><span>打开目录</span>
        </ElButton>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.file-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 唯一滚动区：卡片头部常驻，其余内容在卡片内部滚动 */
.panel-body {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  /*
   * 这一栏全是纵向信息，不需要横向滚动：一旦有东西越界（负边距、长串不可断词）
   * 浏览器就会生出横向滚动条，既难看又会把内容挤窄。这里直接封死这个方向。
   */
  overflow-x: hidden;
  /* 预留滚动条位置：内容变高/变矮时列宽不会跳 10px（Fluent 的“不跳动”） */
  scrollbar-gutter: stable;
  /* 给滚动条留出位置，避免内容贴边 */
  padding-right: 4px;

  > * {
    flex: none;
  }
}

.empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 16px;
  text-align: center;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
}

.empty-desc {
  max-width: 460px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.summary-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

/* 整文件哈希：一行带过，不再单独占一张卡片 */
.summary-sha {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);

  .sha-label {
    flex: none;
    letter-spacing: 0.02em;
  }

  .mono {
    font-size: 11px;
    color: var(--text-2);
  }
}

.summary-grid {
  display: grid;
  /* 最小列宽按窗口最窄时的可用宽度定，四张卡片始终排一行；放不下才换行 */
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 8px;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);

  dt {
    font-size: 11px;
    color: var(--text-3);
  }

  dd {
    display: flex;
    align-items: baseline;
    gap: 4px;
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  /* 主数值：一眼能读到的那个数 */
  .figure {
    font-size: 18px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  /* 单位与主数值同一行、但明显次要 */
  .unit {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-2);
  }

  /* 补充说明另起一行，不再和主数值挤在一起 */
  .detail {
    font-size: 11px;
    line-height: 1.35;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
}

/*
 * 提速行：左侧“还能省多少（或已是推荐配置）”，右侧“预计几点打完”。
 * 窄窗口先压缩右侧时刻，再整体换行，避免把面板撑出横向滚动条。
 */
.speed-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
  font-size: 12px;
}

.speed-advice {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.speed-text {
  min-width: 0;
  line-height: 1.6;
}

.speed-eta {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ok-icon {
  color: var(--accent);
}

.warn-icon {
  color: var(--warning);
}

.tone-ok {
  color: var(--text-1);
}

.tone-warn {
  color: var(--warning);
}

.tone-danger {
  color: var(--danger);
}

.notice-line,
.plan-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
}

.notice-line {
  padding: 8px 10px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
}

.controls,
.resume-plan {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 10px;
}

.control {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 160px;

  &.narrow {
    min-width: 120px;
  }
}

.control-label {
  font-size: 11px;
  color: var(--text-3);
}

.hint {
  font-size: 12px;
  line-height: 1.7;
}

/* 编码说明：宽窗口一行读完，窄窗口裁成一行（悬停看全文），避免换行把面板撑出滚动条 */
.encoding-hint {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 矮窗口隐藏编码说明（说明同时挂在「编码」标签的 title 上） */
@media (max-height: 699px) {
  .encoding-hint {
    display: none;
  }
}

.resume {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.resume-head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 不要再往外“借”负边距：溢出的 6px 会直接在滚动容器里长出一条横向滚动条 */
  margin: 0;
  padding: 6px 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);

  &:hover {
    background: var(--ctrl-fill);
  }

  &:active {
    background: var(--ctrl-fill-pressed);
  }

  &:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
}

/* 没有状态时只放一行弱化提示：不抢眼，但能看出这里有东西可展开 */
.resume-state {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}

/* 解析结果 / 解析失败都复用全局的 .notice-line（同一边距与描边，不再自带一套盒子） */
.resume-status-text {
  min-width: 0;
  word-break: break-word;
}

.resume-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.resume-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--stroke);
  font-size: 12px;
}

/* 说明文字占住剩余宽度、按需换行（不给省略号：这条提示要能完整看到） */
.tools-text {
  display: flex;
  align-items: flex-start;
  flex: 1 1 16rem;
  min-width: 0;
  gap: 6px;
  line-height: 1.7;
}

/* 宽度不够时整组按钮换到下一行，仍贴右 */
.tools-actions {
  display: flex;
  flex-wrap: wrap;
  margin-left: auto;
  gap: 4px;
}

.prepare-progress {
  margin-top: 4px;
}

.panel-error {
  margin-top: 4px;
}
</style>
