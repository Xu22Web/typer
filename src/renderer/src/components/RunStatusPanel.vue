<script setup lang="ts" vapor>
import { STATE_LABELS } from '@main/typing/engine/states'

/**
 * 运行状态面板。
 *
 * 只放"输入过程中会看的数据"：状态、整体进度、动作计数、速度与剩余时间。
 * 目标窗口、日志、设置都不在这里——它们要么属于别的卡片，要么属于别的页面。
 */
const typing = useTyping()

const percent = computed(() => Math.round((typing.progress.value?.percent ?? 0) * 100))

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

const speed = computed(() => (typing.progress.value?.aps ?? 0).toFixed(1))

const eta = computed(() => {
  const remaining = typing.progress.value?.remainingMs ?? 0
  if (remaining <= 0) return '—'
  const seconds = Math.round(remaining / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
})

const elapsed = computed(() => Math.round((typing.progress.value?.elapsedMs ?? 0) / 1000))

const stats = computed(() => [
  { label: '速度', value: `${speed.value}/秒` },
  { label: '预计剩余', value: eta.value },
  { label: '已用时', value: `${elapsed.value} 秒` }
])
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2 class="card-title"><span class="icon i-mdi-chart-timeline-variant" /> 运行状态</h2>
      <div class="spacer" />
      <ElTag :type="tone" effect="plain" size="small">{{ STATE_LABELS[typing.state.value] }}</ElTag>
    </div>

    <ElProgress
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

    <p class="count mono">
      {{ typing.progress.value?.typed ?? 0 }} / {{ typing.progress.value?.total ?? 0 }}
      <span class="muted">个动作</span>
    </p>

    <dl class="stats">
      <div v-for="item in stats" :key="item.label" class="stat">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.value }}</dd>
      </div>
    </dl>

    <p v-if="typing.lastSummary.value" class="summary">{{ typing.lastSummary.value }}</p>
  </section>
</template>

<style scoped lang="scss">
.count {
  font-size: 13px;
  color: var(--text-1);
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 10px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);

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

.summary {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  word-break: break-all;
}
</style>
