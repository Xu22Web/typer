<script setup lang="ts" vapor>
import { STATE_LABELS } from '@main/typing/engine/states'

/**
 * 底部状态栏。
 *
 * 把"引擎在做什么"放在窗口最底部常驻：这样即使用户切到日志页、设置页，
 * 也不会失去对输入任务的感知（这比把状态塞进输入页更不容易漏看）。
 */
const typing = useTyping()

const percent = computed(() => Math.round((typing.progress.value?.percent ?? 0) * 100))

const tone = computed(() => {
  switch (typing.state.value) {
    case 'running':
    case 'countdown':
      return 'ok'
    case 'paused':
      return 'warn'
    case 'failed':
      return 'bad'
    default:
      return ''
  }
})

const running = computed(() => typing.isRunning.value)
</script>

<template>
  <footer class="statusbar">
    <span class="state">
      <span class="dot" :class="tone" />
      {{ STATE_LABELS[typing.state.value] }}
      <template v-if="running">
        <span class="sep">·</span>
        <span class="mono">{{ percent }}%</span>
      </template>
    </span>

    <span v-if="running" class="target ellipsis" :title="typing.targetWindow.value">
      输入到 {{ typing.targetWindow.value }}
    </span>

    <div class="spacer" />

    <span class="privacy">
      <span class="i-mdi-shield-check-outline" />
      内容仅在本机处理，默认不落盘
    </span>
    <span class="sep hide-narrow">·</span>
    <Versions class="hide-narrow" />
  </footer>
</template>

<style scoped lang="scss">
.statusbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--statusbar-h);
  padding: 0 14px;
  border-top: 1px solid var(--stroke);
  background: var(--acrylic);
  backdrop-filter: blur(30px) saturate(140%);
  font-size: 12px;
  color: var(--text-2);
  flex: none;
  overflow: hidden;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  white-space: nowrap;
}

.target {
  max-width: 280px;
  min-width: 0;
  color: var(--text-3);
}

.privacy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  white-space: nowrap;
}

.sep {
  flex: none;
  color: var(--text-3);
}

/* 版本号是"顺带看一眼"的信息，窗口不够宽时优先让位给状态与目标窗口 */
@media (max-width: 1180px) {
  .hide-narrow {
    display: none;
  }
}

@media (max-width: 860px) {
  .target {
    display: none;
  }
}
</style>
