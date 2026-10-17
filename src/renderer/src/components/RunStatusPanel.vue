<script setup lang="ts" vapor>
import { STATE_LABELS } from '@main/typing/engine/states'
import { formatDuration } from '@shared/format/duration'

/**
 * 运行状态面板：只放输入过程中会看的数据——状态、整体进度、动作计数、速度与剩余时间。
 */
const typing = useTyping()

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

/** 平均速度（动作/秒），保留一位小数 */
const speed = computed(() => (typing.progress.value?.aps ?? 0).toFixed(1))

/** 预计剩余时间文案；没有进度时为破折号 */
const eta = computed(() => {
  const remaining = typing.progress.value?.remainingMs ?? 0
  if (remaining <= 0) return '—'
  return formatDuration(remaining)
})

/** 已用时间 */
const elapsed = computed(() => formatDuration(typing.progress.value?.elapsedMs ?? 0))

/** 摘要网格：速度 / 预计剩余 / 已用时 */
const stats = computed(() => [
  { label: '速度', value: `${speed.value}/秒` },
  { label: '预计剩余', value: eta.value },
  { label: '已用时', value: elapsed.value }
])

/** 文件传输任务的"片"进度；文本任务没有这个维度（为 null） */
const frames = computed(() => typing.progress.value?.frames ?? null)
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2 class="card-title">
        <span class="icon i-mdi-chart-timeline-variant" /><span>运行状态</span>
      </h2>
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

    <div class="count mono">
      <div>{{ typing.progress.value?.typed ?? 0 }} / {{ typing.progress.value?.total ?? 0 }}</div>
      <div class="muted">个动作</div>
    </div>

    <dl class="stats">
      <div v-for="item in stats" :key="item.label" class="stat">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.value }}</dd>
      </div>
    </dl>

    <!-- 文件传输：多显示一行"片"进度（逐片发送时它比动作数更有意义） -->
    <div v-if="frames" class="frame-progress mono">
      <div class="i-mdi-file-arrow-up-down-outline" />
      <div>
        片 {{ frames.done }} / {{ frames.total }}（最近 #{{ frames.lastIndex
        }}<template v-if="frames.failed > 0"> ，失败 {{ frames.failed }}</template
        >）
      </div>
    </div>

    <div v-if="typing.lastSummary.value" class="summary">{{ typing.lastSummary.value }}</div>
  </section>
</template>

<style scoped lang="scss">
.count {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-1);
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;

  /* 右列被左列拉高时，多出来的空间摊到各行之间，而不是堆在卡片底部 */
  justify-content: space-between;
}

.stat {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  min-height: 52px;
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

.frame-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
</style>
