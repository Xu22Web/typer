<script setup lang="ts" vapor>
import { buildPlan, stripUnsupported } from '@main/typing/planner/plan'
import { mapPunctuation } from '@main/typing/planner/punctuation'
import { estimateTypingMs } from '@main/typing/scheduling/estimate'
import { formatDuration } from '@shared/format/duration'

/**
 * 文本输入面板：承载内容区与实时预览；开始/暂停/停止等共用操作条仍在 TyperView。
 */
const typing = useTyping()
const settingsStore = useSettings()

/** 当前生效的设置 */
const settings = settingsStore.settings

/** 文本看起来像 Typer 帧文本时给出提示（错字会破坏帧，需要把错字率设为 0）。 */
const looksLikeFrames = computed(() => typing.text.value.trimStart().startsWith('@TYPER1/'))

/** 开始前会怎么处理键盘打不出来的字符：中文标点映射成英文标点，其余直接忽略 */
const prepared = computed(() => {
  const mapped = mapPunctuation(typing.text.value)
  const { text: usable, dropped } = stripUnsupported(mapped.text, settings.value?.keyboard.layout)
  return { mapped: mapped.replaced, ignored: dropped, text: usable }
})

/** 实时预览：字符统计 + 预计耗时（按实际会输入的文本，与引擎同一套规划 + 节奏算法） */
const preview = computed(() => {
  const current = settings.value
  if (!current || typing.text.value.length === 0) return null
  const target = prepared.value.text
  const planOptions = {
    layout: current.keyboard.layout,
    newline: current.text.newlineKey,
    lineStart: current.text.lineStart
  }
  const stats = buildPlan(target, planOptions).stats
  // 与运行时同口径：错字与纠正、标点/空格/换行停顿、抖动、行首归位与最小间隔都算进去
  const estimate = estimateTypingMs(target, {
    timing: current.timing,
    layout: current.keyboard.layout,
    profile: current.injection.profile,
    minDelayMs: current.injection.minDelayMs,
    newline: current.text.newlineKey,
    lineStart: current.text.lineStart,
    typo: current.typo
  })

  return { stats, estimated: estimate.ms }
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
</script>

<template>
  <section class="card editor">
    <div class="card-head">
      <h2 class="card-title"><span class="icon i-mdi-text-box-outline" /><span>内容区</span></h2>
      <div class="spacer" />
      <template v-if="preview">
        <div class="chip">
          <div>
            <strong>{{ preview.stats.chars }}</strong> 字符
          </div>
        </div>
        <div v-if="mappedCount > 0" class="chip" title="中文 / 全角标点会映射成对应的英文标点">
          <div>
            转英文 <strong>{{ mappedCount }}</strong> 个标点
          </div>
        </div>
        <div
          v-if="ignoredCount > 0"
          class="chip warn"
          title="这些字符没有对应的键盘按键，开始时会跳过"
        >
          <div>
            忽略 <strong>{{ ignoredCount }}</strong> 个
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

    <ElInput
      id="tour-text-input"
      v-model="typing.text.value"
      class="editor-input"
      type="textarea"
      :rows="13"
      resize="none"
      placeholder="把要输入的文本粘贴到这里（支持可打印 ASCII；全角标点会在开始时提示按映射替换）"
      @keydown.ctrl.enter="typing.start()"
    />

    <p class="editor-foot muted">
      <span v-if="preview && unlimited">不限速：实际耗时由目标窗口的输入处理速度决定。</span>
      <span v-else-if="preview"
        >按当前设置预计需要
        <strong>{{ formatDuration(preview.estimated) }}</strong> 输入完成。</span
      >
      <span v-else>{{ blocker || '等待输入内容…' }}</span>
    </p>

    <div v-if="looksLikeFrames" class="frame-hint">
      <div class="i-mdi-information-outline text-icon" />
      <div>
        看起来是 Typer 帧文本：逐字符输入完全可行（接收端会逐片校验）， 但请把「错字概率」设为
        0，否则错字会破坏该帧、需要重传那一片。
      </div>
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
}

.frame-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}

.editor-input {
  display: flex;
  flex: 1;
  min-height: 0;

  /* Element Plus 的 textarea 由 rows 定高：改为撑满容器，滚动交给 textarea 自己 */
  :deep(.el-textarea__inner) {
    flex: 1;
    min-height: 0;
    height: 100%;
  }
}

.editor-foot {
  strong {
    color: var(--text-1);
    font-weight: 600;
  }
}
</style>
