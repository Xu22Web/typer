<script setup lang="ts" vapor>
import {
  CHUNK_PRESETS,
  TRANSFER_ENCODING_OPTIONS,
  durationTone,
  formatBytes,
  type TransferEncoding
} from '@shared/transfer/transfer'
import { formatDuration } from '@shared/format/duration'
import { estimateTransferMs } from '@shared/transfer/estimate'

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

/** 当前生效的设置（编码、片大小、帧长上限都从这里读） */
const settings = settingsStore.settings

/** 传给主进程的准备参数；设置尚未加载时用与 schema 一致的默认值 */
const options = computed(() => ({
  encoding: (settings.value?.transfer.encoding ?? 'gzb64') as TransferEncoding,
  chunkBytes: settings.value?.transfer.chunkBytes ?? 8192,
  maxFrameChars: settings.value?.transfer.maxFrameChars ?? 16384
}))

/** 已准备的文件摘要 */
const summary = transfer.summary
/** 是否正在准备（哈希/分片） */
const preparing = transfer.preparing

/** 预计耗时：帧一律逐字符按键下发，按帧字符与片间断顿估算（极速档用实测的更短间隔） */
const estimate = computed(() => {
  const job = summary.value
  const current = settings.value
  if (!job || !current) return null
  return estimateTransferMs(job, {
    interFrameDelayMs: current.transfer.interFrameDelayMs,
    keystrokeIntervalMs: current.transfer.paceMode === 'fast' ? 1.5 : undefined
  })
})

/** 预计耗时（毫秒） */
const estimatedMs = computed(() => estimate.value?.ms ?? 0)

/** 耗时长短对应的提示色 */
const tone = computed(() => durationTone(estimatedMs.value))

/** 大数字加千分位，读数更快（27,657 比 27657 好认） */
function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** 当前编码的完整选项（用于标签与提示文案） */
const encodingOption = computed(() =>
  TRANSFER_ENCODING_OPTIONS.find((option) => option.value === options.value.encoding)!
)

/** 当前片大小对应的预设 id */
const chunkPreset = computed(() => transfer.presetIdFor(options.value.chunkBytes))

/** 准备阶段的进度文案 */
const preparePhaseLabel = computed(() => {
  const phase = transfer.prepareProgress.value?.phase
  if (phase === 'plan') return '建立分片表'
  if (phase === 'compress') return '计算压缩后大小'
  return '校验用哈希'
})

/** 压缩编码生效时的实际压缩比（用于确认提速确实生效） */
const compressionHint = computed(() => {
  const job = summary.value
  if (!job || job.encoding !== 'gzb64' || job.size === 0) return null
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
 * @description 切换编码并立即按新编码重新准备（沿用同一文件）
 * @param encoding 目标编码
 */
async function changeEncoding(encoding: TransferEncoding): Promise<void> {
  await settingsStore.update({ transfer: { encoding } })
  if (summary.value)
    await transfer.prepare(summary.value.path, { ...options.value, encoding }, true)
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
      <div v-if="summary" class="chip">{{ encodingOption.label }}</div>
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
              <dt>预计耗时</dt>
              <dd :class="`tone-${tone}`">
                <span class="figure">{{ formatDuration(estimatedMs) }}</span>
              </dd>
              <div v-if="summary.total > 1" class="detail">
                含 {{ formatCount(summary.total - 1) }} 次片间停顿
              </div>
            </div>
          </dl>
          <div class="summary-sha" :title="summary.sha256">
            <span class="sha-label">SHA-256</span>
            <span class="mono ellipsis">{{ summary.sha256 }}</span>
          </div>
        </div>

        <div v-if="tone !== 'ok'" class="notice-line" :class="`tone-${tone}`">
          <div class="i-mdi-alert-outline text-icon" />
          <div class="notice-text">
            <template v-if="tone === 'danger'">
              预计需要 {{ formatDuration(estimatedMs) }}。文件传输逐字符键入整帧，提速手段只有：
              换更紧凑的编码、把「片大小」调小以缩短单帧、或分几次发送。
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
          <label class="control" :title="encodingOption.description">
            <span class="control-label">编码</span>
            <ElSelect
              :model-value="options.encoding"
              size="small"
              :disabled="typing.isRunning.value"
              @change="changeEncoding($event as TransferEncoding)"
            >
              <ElOption
                v-for="option in TRANSFER_ENCODING_OPTIONS"
                :key="option.value"
                :label="option.label"
                :value="option.value"
                :disabled="option.textOnly && !summary.looksUtf8"
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

        <p class="hint muted encoding-hint" :title="encodingOption.description">
          {{ encodingOption.description }}
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
              把接收端打印的续传令牌（<code class="mono">@TYPER1/R …</code>）粘进来，Typer
              就只补缺失的片。
            </p>

            <ElInput
              v-model="resumeInput"
              type="textarea"
              :rows="3"
              resize="none"
              placeholder="粘贴续传令牌（@TYPER1/R …）"
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
