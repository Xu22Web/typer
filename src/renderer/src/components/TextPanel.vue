<script setup lang="ts" vapor>
import { buildPlan } from '@main/typing/planner/plan'
import { estimateTotalMs } from '@main/typing/scheduling/timing'

/**
 * 文本输入面板：承载内容区与实时预览；开始/暂停/停止等共用操作条仍在 TyperView。
 */
const typing = useTyping()
const settingsStore = useSettings()
const toolScript = useToolScript()

/** 当前生效的设置 */
const settings = settingsStore.settings

/** 文本看起来像 Typer 帧文本时给出提示（错字会破坏帧，需要把错字率设为 0）。 */
const looksLikeFrames = computed(() => typing.text.value.trimStart().startsWith('@TYPER1/'))

/** 实时预览：字符统计 + 预计耗时（与主进程使用同一套纯函数实现） */
const preview = computed(() => {
  if (!settings.value || typing.text.value.length === 0) return null
  const stats = buildPlan(typing.text.value, {
    layout: settings.value.keyboard.layout,
    forceUnicodeForAll: settings.value.keyboard.forceUnicodeForAll
  }).stats

  return { stats, estimated: estimateTotalMs(stats.typed, settings.value.timing) }
})

/** 内容区不能开始的原因 */
const blocker = computed(() => {
  if (typing.unsupported.value) return '当前系统不支持键盘注入（仅支持 Windows）'
  if (typing.text.value.length === 0) return '先在内容区粘贴要输入的文本'
  return ''
})
</script>

<template>
  <section class="card editor">
    <div class="card-head">
      <h2 class="card-title"><span class="icon i-mdi-text-box-outline" /> 内容区</h2>
      <div class="spacer" />
      <template v-if="preview">
        <span class="chip"
          ><strong>{{ preview.stats.chars }}</strong> 字符</span
        >
        <span class="chip"
          >中文 <strong>{{ preview.stats.cjk }}</strong></span
        >
        <span class="chip"
          >动作 <strong>{{ preview.stats.typed }}</strong></span
        >
        <span v-if="preview.stats.layoutFallbacks > 0" class="chip warn">
          布局回退 <strong>{{ preview.stats.layoutFallbacks }}</strong>
        </span>
      </template>
      <ElButton
        size="small"
        text
        :loading="toolScript.loading.value"
        title="把接收脚本全文放进内容区"
        @click="toolScript.insert()"
      >
        <span class="i-mdi-file-code-outline" /> 获取接收脚本
      </ElButton>
    </div>

    <ElInput
      v-model="typing.text.value"
      class="editor-input"
      type="textarea"
      :rows="13"
      resize="none"
      placeholder="把要输入的文本粘贴到这里（支持中文、emoji、需要 Shift 的符号）"
      @keydown.ctrl.enter="typing.start()"
    />

    <p class="editor-foot muted">
      <template v-if="preview">
        按当前设置预计需要
        <strong>{{ Math.round(preview.estimated / 1000) }} 秒</strong>输入完成。
      </template>
      <template v-else>{{ blocker || '等待输入内容…' }}</template>
    </p>

    <p v-if="looksLikeFrames" class="frame-hint">
      <span class="i-mdi-information-outline" />
      看起来是 Typer 帧文本：逐字符输入完全可行（接收端会逐片校验）， 但请把「错字概率」设为
      0，否则错字会破坏该帧、需要重传那一片。
    </p>
  </section>
</template>

<style scoped lang="scss">
.editor {
  gap: 10px;
  /* 内容区要够大（主任务），但也不能把操作条与提示挤出首屏 */
  min-height: 340px;
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
  flex: 1;
}

.editor-foot {
  strong {
    color: var(--text-1);
    font-weight: 600;
  }
}
</style>
