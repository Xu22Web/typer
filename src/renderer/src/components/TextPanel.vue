<script setup lang="ts" vapor>
import { stripUnsupported } from '@main/typing/planner/plan'
import { mapPunctuation } from '@main/typing/planner/punctuation'
import { estimateTypingMs } from '@main/typing/scheduling/estimate'
import { formatDuration } from '@shared/format/duration'
import { TEXT_IMPORT_MAX_BYTES, TEXT_INPUT_LIMIT } from '@shared/text/import'
import { formatBytes } from '@shared/transfer/transfer'
import TextEditor from './TextEditor.vue'

/**
 * 文本输入面板：承载内容区与实时预览；开始/暂停/停止等共用操作条仍在 TyperView。
 */
const typing = useTyping()
const settingsStore = useSettings()

/** 内容区字数：按原文计（与上限、导入截断同一口径） */
const charCount = computed(() => typing.text.value.length)

/** 是否已达字数上限（到顶后编辑器不再接受输入） */
const atLimit = computed(() => charCount.value >= TEXT_INPUT_LIMIT)

/** 字数提示文案：`1,234 / 80,000` */
const countLabel = computed(
  () => `${charCount.value.toLocaleString()} / ${TEXT_INPUT_LIMIT.toLocaleString()}`
)

/**
 * 统计与预估要扫全文（标点映射 + 不可输入字符 + 动作规划 + 耗时估算），
 * 大文本里逐键重算会明显抢主线程：改为停下来 200ms 后再算一次。
 */
const STATS_DEBOUNCE_MS = 200
/** 耗时估算的采样长度：超过这个长度只算开头一部分再等比外推 */
const ESTIMATE_SAMPLE_CHARS = 2_000
const debouncedText = ref(typing.text.value)
let statsTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => typing.text.value,
  (value) => {
    if (statsTimer !== null) clearTimeout(statsTimer)
    statsTimer = setTimeout(() => {
      statsTimer = null
      debouncedText.value = value
    }, STATS_DEBOUNCE_MS)
  }
)

onBeforeUnmount(() => {
  if (statsTimer !== null) clearTimeout(statsTimer)
})

/** 当前生效的设置 */
const settings = settingsStore.settings

/** 文本看起来像 Typer 帧文本时给出提示（错字会破坏帧，需要把错字率设为 0）。 */
const looksLikeFrames = computed(() => typing.text.value.trimStart().startsWith('@TYPER1/'))

/** 开始前会怎么处理键盘打不出来的字符：中文标点映射成英文标点，其余直接忽略 */
const prepared = computed(() => {
  const mapped = mapPunctuation(debouncedText.value)
  const { text: usable, dropped } = stripUnsupported(mapped.text, settings.value?.keyboard.layout)
  return { mapped: mapped.replaced, ignored: dropped, text: usable }
})

/** 实时预览：预计耗时（按实际会输入的文本，与引擎同一套节奏算法） */
const preview = computed(() => {
  const current = settings.value
  if (!current || debouncedText.value.length === 0) return null
  const target = prepared.value.text
  const estimateOptions = {
    timing: current.timing,
    layout: current.keyboard.layout,
    profile: current.injection.profile,
    minDelayMs: current.injection.minDelayMs,
    newline: current.text.newlineKey,
    lineStart: current.text.lineStart,
    typo: current.typo
  }
  // 全文逐字规划在几万字符时会让停顿后卡一下（而且统计结果没人用）：
  // 只按前缀采样，再按字符数等比外推
  const sample =
    target.length > ESTIMATE_SAMPLE_CHARS ? target.slice(0, ESTIMATE_SAMPLE_CHARS) : target
  const estimate = estimateTypingMs(sample, estimateOptions)
  const estimated =
    sample.length === target.length
      ? estimate.ms
      : Math.round((estimate.ms / sample.length) * target.length)
  return { estimated }
})

/** 是否处于"不限速"模式（没有可靠的耗时估算） */
const unlimited = computed(() => settings.value?.timing.speedMode === 'max')

/** 将映射成英文标点的字符数 */
const mappedCount = computed(() => prepared.value.mapped)

/** 将被忽略的字符数（没有对应的键盘按键） */
const ignoredCount = computed(() => prepared.value.ignored)

/** 内容区不能开始的原因 */
const blocker = computed(() => {
  if (typing.unsupported.value) return '当前系统不支持键盘注入（仅支持 Windows）'
  if (typing.text.value.length === 0) return '先在内容区粘贴要输入的文本'
  return ''
})

/** @description 清空内容区 */
function clear(): void {
  typing.text.value = ''
}

// ---------------------------------------------------------------------------
// 拖入导入：与文件页一致（层数计数防抖 + 铺满面板的虚线覆盖层）
// ---------------------------------------------------------------------------

/**
 * 拖入导入：与文件页共用拖拽机制（计数、阻止默认行为、单文件解析），
 * 但导入会覆盖内容区，所以多文件直接拒绝，不像发送文件那样取第一个。
 * 读取、二进制判定、体积/字数上限与覆盖确认都在 `useTyping.importText` 里。
 */
const { dragDepth, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop({
  canAccept: () => !typing.isRunning.value && !typing.busy.value && !typing.importing.value,
  messages: {
    reject: '正在输入中，请先停止当前任务再导入',
    multiple: '一次只能导入一个文件，请分开拖入',
    noPath: '无法读取拖入文件的位置，请改用「导入文本」'
  },
  // 体积是硬门槛：超过就不读盘了，直接劝去文件模式
  checkFile: (file) =>
    file.size > TEXT_IMPORT_MAX_BYTES
      ? `「${file.name}」有 ${formatBytes(file.size)}，超过文本模式可导入的上限 ${formatBytes(
          TEXT_IMPORT_MAX_BYTES
        )}：请改用「文件」模式发送`
      : null,
  onFile: async (path) => {
    await typing.importText(path)
  }
})
</script>

<template>
  <section
    class="card editor"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="card-head">
      <h2 class="card-title"><span class="icon i-mdi-text-box-outline" /><span>内容区</span></h2>
      <div class="spacer" />
      <div
        class="chip mono"
        :class="{ bad: atLimit }"
        :title="
          atLimit
            ? `已达上限 ${TEXT_INPUT_LIMIT.toLocaleString()} 字符：更长的内容请改用「文件」模式发送`
            : '内容区字数 / 上限'
        "
      >
        <div>{{ countLabel }}</div>
      </div>
      <template v-if="preview">
        <div v-if="mappedCount > 0" class="chip" title="中文 / 全角标点会映射成对应的英文标点">
          <div>
            转英文 <span class="em">{{ mappedCount }}</span> 个标点
          </div>
        </div>
        <div
          v-if="ignoredCount > 0"
          class="chip warn"
          title="这些字符没有对应的键盘按键，开始时会跳过；如需完整保留，可用操作条的「转文件发送」"
        >
          <div>
            忽略 <span class="em">{{ ignoredCount }}</span> 个
          </div>
        </div>
      </template>
      <ElButton
        size="small"
        text
        :disabled="typing.text.value.length === 0"
        title="清空内容区"
        @click="clear()"
      >
        <span class="i-mdi-eraser" /><span>清空</span>
      </ElButton>
    </div>

    <div id="tour-text-input" class="editor-host">
      <TextEditor
        v-model="typing.text.value"
        :max-length="TEXT_INPUT_LIMIT"
        placeholder="把要输入的文本粘贴到这里，或直接把 .txt / .md / .json / .csv 等文本文件拖进来"
        @start="typing.start()"
      />
    </div>

    <p class="editor-foot muted">
      <span v-if="preview && unlimited">不限速：实际耗时由目标窗口的输入处理速度决定。</span>
      <span v-else-if="preview"
        >按当前设置预计需要
        <span class="em">{{ formatDuration(preview.estimated) }}</span> 输入完成。</span
      >
      <span v-else>{{ blocker || '等待输入内容…' }}</span>
    </p>

    <div v-if="looksLikeFrames" class="frame-hint">
      <div class="i-mdi-information-outline text-icon" />
      <div>
        看起来是 Typer 帧文本：逐字符输入可行（接收端逐片校验），但需将
        <span class="em">「错字概率」设为 0</span>，否则错字会使该片 CRC 校验失败并触发重传。
      </div>
    </div>

    <!-- 拖入提示：只做视觉反馈，不拦指针（drop 由面板接收） -->
    <div v-if="dragDepth > 0" class="drop-overlay">
      <div class="i-mdi-tray-arrow-down drop-overlay-icon" />
      <div class="drop-overlay-title">松开导入文本</div>
      <div class="drop-overlay-desc">一次一个文件；内容区已有内容时会先确认是否替换</div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.editor {
  gap: 10px;
  /* 填满工作区：内容区随窗口一起长高，操作条因此能常驻视口 */
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* 拖入覆盖层按面板定位 */
  position: relative;
}

.frame-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}

.editor-host {
  display: flex;
  flex: 1;
  min-height: 0;
}

/*
 * 拖入提示：铺满面板的虚线框，与文件页保持同一套观感。
 * pointer-events: none 让 drop 事件继续落在面板上；底色用卡片色叠一点强调色，
 * 跟随主题（写死深色会在亮色主题下变成一块黑板），且必须不透明——半透明会和下层正文叠在一起。
 */
.drop-overlay {
  position: absolute;
  inset: 8px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 2px dashed var(--accent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 5%, var(--card-bg));
  color: var(--accent);
  pointer-events: none;
}

.drop-overlay-icon {
  font-size: 30px;
}

.drop-overlay-title {
  font-size: 14px;
  font-weight: 600;
}

.drop-overlay-desc {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
}

.editor-foot {
  .em {
    color: var(--text-1);
    font-weight: 600;
  }
}
</style>
