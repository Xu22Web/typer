<script setup lang="ts" vapor>
import {
  CHUNK_PRESETS,
  TRANSFER_ENCODING_OPTIONS,
  durationTone,
  formatBytes,
  formatDuration,
  type TransferEncoding
} from '@shared/transfer/transfer'
import { estimateTransferMs } from '@shared/transfer/estimate'
import { baseIntervalMsFor, estimateTotalMs } from '@main/typing/scheduling/timing'

/**
 * 文件输入面板。
 *
 * 主任务只有一个：把选中的文件切成"每片一行"的帧，按需要补发/续传。
 * 因此这里只保留三块内容——文件与摘要（要发多少、要多久）、十六进制预览（确认选对文件了）、
 * 续传与重传（出错之后怎么办）；节奏与其它参数都在「设置」页。
 */
const transfer = useTransfer()
const typing = useTyping()
const settingsStore = useSettings()

const settings = settingsStore.settings

const options = computed(() => ({
  encoding: (settings.value?.transfer.encoding ?? 'hex') as TransferEncoding,
  chunkBytes: settings.value?.transfer.chunkBytes ?? 1024,
  maxFrameChars: settings.value?.transfer.maxFrameChars ?? 4096
}))

const summary = transfer.summary
const preparing = transfer.preparing

/** 预计耗时：按实际注入方式估算（长帧会走粘贴，和逐字符按键完全不是一个量级）。 */
const estimate = computed(() => {
  const job = summary.value
  const current = settings.value
  if (!job || !current) return null
  return estimateTransferMs(job, {
    insertMode: current.insertMode,
    autoPasteThreshold: current.autoPasteThreshold,
    interFrameDelayMs: current.transfer.interFrameDelayMs,
    baseIntervalMs: baseIntervalMsFor(current.timing),
    newlinePauseMs: current.timing.newlinePauseMs
  })
})

const estimatedMs = computed(() => estimate.value?.ms ?? 0)

/** 纯按键模式下的耗时（用于"改用剪贴板"的建议文案，让对比有数字）。 */
const keystrokeMs = computed(() => {
  const job = summary.value
  const timing = settings.value?.timing
  if (!job || !timing) return 0
  return estimateTotalMs(job.typedActions, timing)
})

const tone = computed(() => durationTone(estimatedMs.value))

const encodingOption = computed(() =>
  TRANSFER_ENCODING_OPTIONS.find((option) => option.value === options.value.encoding)!
)

const chunkPreset = computed(() => transfer.presetIdFor(options.value.chunkBytes))

/** 十六进制预览默认展开，信息密度低但"确认选对文件"很依赖它。 */
const showPreview = ref(false)
const showResume = ref(false)

async function pick(): Promise<void> {
  await transfer.pickAndPrepare(options.value)
}

async function changeEncoding(encoding: TransferEncoding): Promise<void> {
  await settingsStore.update({ transfer: { encoding } })
  if (summary.value)
    await transfer.prepare(summary.value.path, { ...options.value, encoding }, true)
}

async function changePreset(id: string): Promise<void> {
  const preset = CHUNK_PRESETS.find((item) => item.id === id)
  if (!preset) return
  const next = { chunkBytes: preset.chunkBytes, maxFrameChars: preset.maxFrameChars }
  await settingsStore.update({ transfer: next })
  if (summary.value) await transfer.prepare(summary.value.path, { ...options.value, ...next }, true)
}

const resumeInput = ref('')

async function loadResume(): Promise<void> {
  if (resumeInput.value.trim().length === 0) return
  await transfer.applyResume(resumeInput.value)
}

async function pickResumeFile(): Promise<void> {
  const path = await window.api.files.pick()
  if (!path) return
  try {
    const imported = await window.api.files.import(path, 'utf8')
    resumeInput.value = imported.text
    await transfer.applyResume(imported.text)
  } catch (err) {
    typing.log('error', err instanceof Error ? err.message : String(err))
  }
}

/** 只发当前缺失片（续传最常见的一步）。 */
async function sendMissingOnly(): Promise<void> {
  const missing = transfer.resumeMissing.value
  if (!missing || missing.length === 0) return
  transfer.onlyText.value = [...missing].sort((a, b) => a - b).join(',')
  await transfer.refreshPlan()
}

const previewRows = computed(() => summary.value?.preview ?? [])
</script>

<template>
  <section class="card file-panel">
    <div class="card-head">
      <h2 class="card-title"><span class="icon i-mdi-file-arrow-up-down-outline" /> 文件输入</h2>
      <div class="spacer" />
      <span v-if="summary" class="chip">{{ summary.total }} 片</span>
      <span v-if="summary" class="chip">每片 {{ formatBytes(summary.chunkBytes) }}</span>
      <span v-if="summary" class="chip">{{ encodingOption.label }}</span>
    </div>

    <!-- 未选择文件：只给一个明确的入口与必要的解释 -->
    <div v-if="!summary" class="empty">
      <p class="empty-title">选择一个文件，Typer 会把它逐片"打"到目标窗口</p>
      <p class="empty-desc">
        文件会被切成每片一行的纯文本帧，接收端逐片校验、支持断点续传，合并后再校验整文件哈希。
        目标端运行 <code class="mono">tools/typer-recv.mjs</code> 接收即可（见「脚本」）。
      </p>
      <ElButton type="primary" :loading="preparing" @click="pick">
        <span class="i-mdi-file-search-outline" /> 选择文件
      </ElButton>
    </div>

    <template v-else>
      <!-- 摘要：要发多少、要多久，是这个页面最重要的信息 -->
      <div class="summary">
        <div class="summary-name">
          <span class="i-mdi-file-outline" />
          <span class="ellipsis" :title="summary.path">{{ summary.name }}</span>
          <span class="muted">{{ formatBytes(summary.size) }}</span>
        </div>
        <dl class="summary-grid">
          <div class="summary-item">
            <dt>分片</dt>
            <dd>{{ summary.total }} 片 · 末片 {{ formatBytes(summary.tailBytes) }}</dd>
          </div>
          <div class="summary-item">
            <dt>最长帧</dt>
            <dd>{{ summary.peakFrameChars }} / {{ summary.maxFrameChars }} 字符</dd>
          </div>
          <div class="summary-item">
            <dt>需输入</dt>
            <dd>{{ summary.frameChars }} 字符 · {{ summary.typedActions }} 个动作</dd>
          </div>
          <div class="summary-item">
            <dt>预计耗时</dt>
            <dd :class="`tone-${tone}`">
              {{ formatDuration(estimatedMs) }}
              <span class="muted"
                >· {{ estimate?.mode === 'paste' ? '剪贴板粘贴' : '逐字符按键' }}</span
              >
            </dd>
          </div>
          <div class="summary-item wide">
            <dt>整文件 SHA-256</dt>
            <dd class="mono ellipsis" :title="summary.sha256">{{ summary.sha256 }}</dd>
          </div>
        </dl>
      </div>

      <p v-if="tone !== 'ok'" class="notice-line" :class="`tone-${tone}`">
        <span class="i-mdi-alert-outline" />
        <template v-if="tone === 'danger'">
          按当前节奏预计需要 {{ formatDuration(estimatedMs) }}（逐字符按键约
          {{ formatDuration(keystrokeMs) }}）。建议改用剪贴板粘贴、把片大小调大，或降低输入速率。
        </template>
        <template v-else>
          预计需要 {{ formatDuration(estimatedMs) }}，请确认目标窗口在倒计时结束前处于就绪状态。
        </template>
      </p>

      <!-- 参数：只放与"这次发什么"直接相关的两项 -->
      <div class="controls">
        <label class="control">
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
          <span class="i-mdi-file-swap-outline" /> 换一个文件
        </ElButton>
        <ElButton class="control-btn" size="small" text @click="showPreview = !showPreview">
          <span :class="showPreview ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" />
          {{ showPreview ? '收起预览' : '查看十六进制' }}
        </ElButton>
      </div>

      <p class="hint muted">{{ encodingOption.description }}</p>

      <HexPreview v-if="showPreview" :rows="previewRows" />

      <!-- 续传与重传：出错之后唯一需要做的事 -->
      <div class="resume">
        <button class="resume-head" type="button" @click="showResume = !showResume">
          <span class="i-mdi-history" />
          <span>续传与重传</span>
          <div class="spacer" />
          <span v-if="transfer.resume.value" class="chip warn">
            缺 {{ transfer.resume.value.missing.length }} 片
          </span>
          <span :class="showResume ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" />
        </button>

        <div v-if="showResume" class="resume-body">
          <p class="hint muted">
            把接收端打印的续传令牌（<code class="mono">@TYPER1/R …</code>）或它的
            <code class="mono">resume.json</code> 内容粘进来，Typer 就只补缺失的片。
          </p>

          <ElInput
            v-model="resumeInput"
            type="textarea"
            :rows="3"
            resize="none"
            placeholder="粘贴续传令牌或 resume.json 内容"
          />

          <div class="resume-actions">
            <ElButton size="small" :disabled="resumeInput.trim().length === 0" @click="loadResume">
              <span class="i-mdi-content-paste" /> 载入续传状态
            </ElButton>
            <ElButton size="small" text @click="pickResumeFile">
              <span class="i-mdi-file-search-outline" /> 从 resume.json 读取
            </ElButton>
            <ElButton
              size="small"
              text
              :disabled="!transfer.resume.value"
              @click="transfer.clearResume()"
            >
              清除
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
              <span class="i-mdi-playlist-check" /> 填入缺失片
            </ElButton>
          </div>

          <p class="plan-line">
            <span class="i-mdi-information-outline" />
            本次将发送 <strong>{{ transfer.plan.value?.ranges ?? '全部' }}</strong> 共
            {{ transfer.sendingCount.value }} 片<template v-if="transfer.plan.value?.sendBegin">
              ，先发开始帧</template
            ><template v-if="transfer.plan.value?.sendEnd">，发完通知接收端合并校验</template
            ><template v-else>，不发结束帧（接收端仍缺片）</template>。
          </p>
        </div>
      </div>

      <!-- 脚本：目标机需要的东西，一键取走 -->
      <div class="tools">
        <span class="icon i-mdi-console-line" />
        <span class="tools-text muted">
          目标端运行
          <code class="mono">node typer-recv.mjs -o 输出文件</code> 接收；脚本零依赖（Node ≥ 18）
        </span>
        <div class="spacer" />
        <ElButton size="small" text @click="transfer.exportTools()">
          <span class="i-mdi-export-variant" /> 导出脚本
        </ElButton>
        <ElButton size="small" text @click="transfer.revealTools()">
          <span class="i-mdi-folder-open-outline" /> 打开目录
        </ElButton>
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
      正在读取并计算整文件哈希（
      {{ transfer.prepareProgress.value?.phase === 'plan' ? '建立分片表' : '校验用哈希' }}）…
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
  </section>
</template>

<style scoped lang="scss">
.file-panel {
  min-height: 340px;
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
  gap: 10px;
}

.summary-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.summary-grid {
  display: grid;
  /* 窄一点，尽量排成两行（行数少 → 左列更矮 → 与右列更接近） */
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);

  &.wide {
    grid-column: 1 / -1;
  }

  dt {
    font-size: 11px;
    color: var(--text-3);
  }

  dd {
    font-size: 13px;
    font-weight: 600;
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
  gap: 10px;
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

.resume {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--stroke);
}

.resume-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
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
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--stroke);
  font-size: 12px;
}

.tools-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prepare-progress {
  margin-top: 4px;
}

.panel-error {
  margin-top: 4px;
}
</style>
