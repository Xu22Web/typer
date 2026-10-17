<script setup lang="ts" vapor>
/**
 * 全局倒计时遮罩：放在应用外壳而不是输入页，倒计时期间切到别的页面也照样出现，且随时可取消。
 */
const typing = useTyping()
const { settings } = useSettings()

/** 只在倒计时阶段显示遮罩 */
const visible = computed(() => typing.state.value === 'countdown')

/** 剩余秒数（向上取整，0 表示马上开始） */
const seconds = computed(() =>
  Math.max(0, Math.ceil((typing.progress.value?.countdownRemainingMs ?? 0) / 1000))
)

/** 进度环：用 conic-gradient 画，不需要额外 SVG 节点 */
const ring = computed(() => {
  const total = settings.value?.startDelayMs ?? 0
  const remaining = typing.progress.value?.countdownRemainingMs ?? 0
  const ratio = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0
  return `conic-gradient(var(--accent) ${ratio * 360}deg, var(--ctrl-fill) 0deg)`
})
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="overlay">
      <div class="progress-ring" :style="{ backgroundImage: ring }">
        <div class="inner">
          <div class="count mono">{{ seconds }}</div>
          <div class="unit">秒后开始</div>
        </div>
      </div>

      <div class="title">请切换到目标窗口</div>
      <div class="target">
        <div class="i-mdi-target" />
        <div>{{ typing.targetWindow.value }}</div>
      </div>

      <ElButton type="danger" plain @click="typing.stop()">
        <span class="i-mdi-close" /><span>取消输入</span>
      </ElButton>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
.overlay {
  position: fixed;
  top: var(--titlebar-h);
  right: 0;
  bottom: var(--statusbar-h);
  left: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(20px);
}

.progress-ring {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 200px;
  height: 200px;
  border-radius: 999px;
  transition: background-image 0.25s linear;
}

.inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 182px;
  height: 182px;
  border-radius: 999px;
  background: var(--card-bg);
  box-shadow: var(--shadow-card);
}

.count {
  font-size: 72px;
  font-weight: 700;
  line-height: 1.05;
  color: var(--accent);
}

.unit {
  font-size: 12px;
  color: var(--text-2);
}

.title {
  margin-top: 8px;
  font-size: 16px;
  font-weight: 600;
}

.target {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
