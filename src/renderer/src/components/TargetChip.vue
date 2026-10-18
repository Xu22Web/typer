<script setup lang="ts" vapor>
/**
 * 目标窗口的紧凑指示：窄窗口时顶替右下角的目标窗口卡片，
 * 只显示"打在哪个窗口上"这一件最重要的事，附带重新检测。
 */
const typing = useTyping()

/** 是否已识别到前台窗口 */
const detected = computed(() => typing.targetWindow.value !== '未检测')
</script>

<template>
  <div class="target-chip" :class="{ ok: detected }" :title="typing.targetWindow.value">
    <div class="dot" />
    <div class="i-mdi-target name-icon" />
    <div class="name ellipsis">{{ typing.targetWindow.value }}</div>
    <button
      id="tour-target-refresh-chip"
      class="icon-btn ghost"
      type="button"
      title="重新检测目标窗口"
      aria-label="重新检测目标窗口"
      @click="typing.refreshForeground()"
    >
      <span class="i-mdi-refresh" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.target-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  height: 32px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--stroke);
  border-radius: 999px;
  background: var(--ctrl-fill);
  color: var(--text-2);
  font-size: 12px;

  &.ok {
    color: var(--text-1);
  }

  .dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: 999px;
    background: var(--text-3);
  }

  &.ok .dot {
    background: var(--accent);
  }

  .name-icon {
    flex: none;
    font-size: 14px;
    color: var(--text-3);
  }

  .name {
    min-width: 0;
  }

  :deep(.icon-btn) {
    width: 24px;
    height: 24px;
    font-size: 13px;
  }
}
</style>
