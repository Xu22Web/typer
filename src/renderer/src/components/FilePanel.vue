<script setup lang="ts" vapor>
import {
  CHUNK_PRESETS,
  TRANSFER_ALPHABET_OPTIONS,
  TRANSFER_MODE_OPTIONS,
  durationTone,
  formatBytes,
  type TransferAlphabet,
  type TransferCompression,
  type TransferTargetMode
} from '@shared/transfer/transfer'
import { formatDuration } from '@shared/format/duration'
import { PACE_CHARS_PER_SECOND, estimateTransferMs, meetsBudget } from '@shared/transfer/estimate'

/**
 * 文件输入面板：把选中的文件切成"每片一行"的帧并按需补发/续传。
 * 面板只负责文件摘要、十六进制预览与续传重传，节奏与其它参数都在「设置」页。
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

// 运行中直接用引擎报的真实速率刷新预估：链路到底多快，只有跑起来才知道
watch(
  () => typing.progress.value?.aps,
  (aps) => {
    if (!typing.isRunning.value || !aps || aps <= 0) return
    measuredCps.value = Math.round(aps)
  }
)

/** 预计耗时：帧逐字符下发，耗时 = 字符数 ÷ 每秒字符数 */
const estimate = computed(() => {
  const job = summary.value
  const current = settings.value
  if (!job || !current) return null
  return estimateTransferMs(job, {
    interFrameDelayMs: current.transfer.interFrameDelayMs,
    charsPerSecond:
      measuredCps.value ?? PACE_CHARS_PER_SECOND[current.transfer.paceMode] ?? undefined
  })
})

/** 预计耗时（毫秒） */
const estimatedMs = computed(() => estimate.value?.ms ?? 0)

/** 耗时长短对应的提示色 */
const tone = computed(() => durationTone(estimatedMs.value))

/** 与 1 小时 / 2 小时预算的对比：把"能不能达标"直接说清楚 */
const budgets = computed(() => [
  { minutes: 60, label: '1 小时', ...meetsBudget(estimatedMs.value, 60) },
  { minutes: 120, label: '2 小时', ...meetsBudget(estimatedMs.value, 120) }
])

/** 大数字加千分位，读数更快（27,657 比 27657 好认） */
function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** 当前符号表的完整选项（用于标签与提示文案） */
const alphabetOption = computed(() =>
  TRANSFER_ALPHABET_OPTIONS.find((option) => option.value === options.value.alphabet)!
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

/** 是否展开十六进制预览（默认折叠） */
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
  await settingsStore.update({ transfer: { mode } })
  if (summary.value) await transfer.prepare(summary.value.path, { ...options.value, mode }, true)
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

/** @description 用输入框里的续传文本载入接收端状态 */
async function loadResume(): Promise<void> {
  if (resumeInput.value.trim().length === 0) return
  await transfer.applyResume(resumeInput.value)
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

/** 十六进制预览行（由主进程截取） */
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
          <div class="budget-row">
            <span class="budget-caption">耗时预算</span>
            <div class="budget-list">
              <span
                v-for="budget in budgets"
                :key="budget.minutes"
                class="chip budget-chip"
                :class="budget.ok ? 'accent' : 'warn'"
                :title="
                  budget.ok
                    ? `预计可以在 ${budget.label}内打完`
                    : `预计超出 ${budget.label}预算 ${budget.ratio.toFixed(1)} 倍`
                "
              >
                <span class="dot" :class="budget.ok ? 'ok' : 'warn'" />
                <span class="budget-name">{{ budget.label }}</span>
                <strong>{{ budget.ok ? '可达' : `超 ${budget.ratio.toFixed(1)} 倍` }}</strong>
              </span>
            </div>
            <span class="budget-note" :title="`${summary.kind} · ${summary.compressionNote}`">
              {{ summary.kind }} · {{ summary.compressionNote }}
            </span>
          </div>
          <div class="summary-sha" :title="summary.sha256">
            <span class="sha-label">SHA-256</span>
            <span class="mono ellipsis">{{ summary.sha256 }}</span>
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
                v-for="option in TRANSFER_ALPHABET_OPTIONS"
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
            {{ showPreview ? '收起预览' : '查看十六进制' }}
          </ElButton>
        </div>

        <p class="hint muted encoding-hint" :title="alphabetOption.description">
          {{ alphabetOption.description }}
        </p>

        <HexPreview v-if="showPreview" :rows="previewRows" />

        <!-- 续传与重传：出错之后唯一需要做的事 -->
        <div class="resume">
          <button class="resume-head" type="button" @click="showResume = !showResume">
            <span class="i-mdi-history" />
            <span>续传与重传</span>
            <span class="spacer" />
            <span v-if="transfer.resume.value" class="chip warn">
              缺 {{ transfer.resume.value.missing.length }} 片
            </span>
            <span :class="showResume ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" />
          </button>

          <div v-if="showResume" class="resume-body">
            <p class="hint muted">
              把接收端打印的续传令牌（<code class="mono">@T2R …</code>）粘进来，Typer
              就只补缺失的片。
            </p>

            <ElInput
              v-model="resumeInput"
              type="textarea"
              :rows="3"
              resize="none"
              placeholder="粘贴续传令牌（@T2R …）"
            />

            <div class="resume-actions">
              <ElButton
                size="small"
                :disabled="resumeInput.trim().length === 0"
                @click="loadResume"
              >
                <span class="i-mdi-content-paste" /><span>载入续传状态</span>
              </ElButton>
              <ElButton
                size="small"
                text
                :disabled="!transfer.resume.value"
                @click="transfer.clearResume()"
              >
                <span>清除</span>
              </ElButton>
            </div>

            <div class="resume-plan">
              <label class="control">
                <span class="control-label">只发指定片</span>
                <ElInput
                  v-model="transfer.onlyText.value"
                  size="small"
                  placeholder="如 3,5,12-20；留空表示从「起始片号」开始全发"
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
              <ElButton
                size="small"
                :disabled="!transfer.resumeMissing.value?.length"
                @click="sendMissingOnly"
              >
                <span class="i-mdi-playlist-check" /><span>填入缺失片</span>
              </ElButton>
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
          <code class="mono">run.bat</code>；零依赖，Node ≥ 16
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
 * 预算行：左侧小标题 + 状态徽章 + 右侧压缩摘要。
 * 窄窗口先压缩摘要（省略号 + title 兜底），再整体换行，避免把面板撑出横向滚动条。
 */
.budget-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}

.budget-caption {
  flex: none;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0.02em;
}

.budget-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

/* 徽章比普通 chip 更紧凑：状态点负责颜色，文字保持 11px */
.budget-chip {
  gap: 6px;
  min-height: 24px;
  padding: 0 9px;
  font-size: 11px;

  .budget-name {
    color: inherit;
    opacity: 0.86;
  }

  strong {
    font-variant-numeric: tabular-nums;
  }
}

.budget-note {
  min-width: 0;
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  margin-top: auto;
}

.resume-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
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
