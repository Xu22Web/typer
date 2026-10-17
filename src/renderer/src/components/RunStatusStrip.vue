<script setup lang="ts" vapor>
import { STATE_LABELS } from '@main/typing/engine/states'
import { formatDuration } from '@shared/format/duration'

/**
 * 运行状态条：窄窗口里顶替「运行状态」卡片的一行摘要。
 * 只保留跑步时要瞟一眼的数字，其余细节留给宽窗口的卡片。
 */
const typing = useTyping()
const settingsStore = useSettings()

/** 当前生效的设置（只用到紧急停止热键） */
const settings = settingsStore.settings

/** 进度百分比（0–100） */
const percent = computed(() => Math.round((typing.progress.value?.percent ?? 0) * 100))

/** 状态标签色：进行中 success、暂停 warning、失败 danger、其余 info */
const tone = computed(() => {
  switch (typing.state.value) {
    case 'running':
    case 'countdown':
      return 'success'
    case 'paused':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'info'
  }
})

/** 已用时间 */
const elapsed = computed(() => formatDuration(typing.progress.value?.elapsedMs ?? 0))

/** 预计剩余时间；没有进度时为破折号 */
const remaining = computed(() => {
  const value = typing.progress.value?.remainingMs ?? 0
  return value > 0 ? formatDuration(value) : '—'
})

/** 文本任务的"动作"数；文件传输时另外显示"片"进度 */
const frames = computed(() => typing.progress.value?.frames ?? null)

/** 计数文案：文件传输看片，文本看动作；还没开始计时（总数未知）时不显示 0/0 */
const counter = computed(() => {
  if (frames.value) return `片 ${frames.value.done}/${frames.value.total}`
  const typed = typing.progress.value?.typed ?? 0
  const total = typing.progress.value?.total ?? 0
  return total > 0 ? `${typed}/${total}` : '—'
})
</script>

<template>
  <section class="status-strip card">
    <ElTag :type="tone" effect="plain" size="small">{{ STATE_LABELS[typing.state.value] }}</ElTag>
    <ElProgress
      class="bar"
      :percentage="percent"
      :stroke-width="6"
      :show-text="false"
      :status="
        typing.state.value === 'failed'
          ? 'exception'
          : typing.state.value === 'completed'
            ? 'success'
            : undefined
      "
    />
    <div class="mono percent">{{ percent }}%</div>
    <div class="chip mono">
      <div>{{ counter }}</div>
    </div>
    <div class="chip mono">
      <div class="i-mdi-timer-outline" />
      <div>{{ elapsed }}</div>
    </div>
    <div class="chip mono">
      <div class="i-mdi-timer-sand" />
      <div>{{ remaining }}</div>
    </div>
    <div class="spacer" />
    <div class="hint muted">
      按 <code>{{ settings?.hotkeys.stop ?? 'Ctrl+Alt+X' }}</code> 紧急停止
    </div>
  </section>
</template>

<style scoped lang="scss">
.status-strip {
  flex: none;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px;

  .bar {
    flex: 1;
    min-width: 80px;
    max-width: 260px;
  }

  .percent {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-1);
  }

  .chip {
    min-height: 22px;
    padding: 0 8px;
    font-size: 11px;
  }

  .hint {
    font-size: 11px;
    white-space: nowrap;
  }
}

@media (max-width: 1000px) {
  .status-strip .hint {
    display: none;
  }
}
</style>
