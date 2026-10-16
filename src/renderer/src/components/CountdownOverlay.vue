<script setup lang="ts" vapor>
/**
 * 全局倒计时遮罩。
 *
 * 放在应用外壳而不是输入页：倒计时期间用户可能已经切到别的页面查看设置，
 * 遮罩必须照样出现（而且要能取消），否则"什么时候开始打字"就失去了提示。
 */
const typing = useTyping()
const { settings } = useSettings()

const visible = computed(() => typing.state.value === 'countdown')

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
          <span class="count mono">{{ seconds }}</span>
          <span class="unit">秒后开始</span>
        </div>
      </div>

      <p class="title">请切换到目标窗口</p>
      <p class="target">
        <span class="i-mdi-target" />
        {{ typing.targetWindow.value }}
      </p>

      <ElButton type="danger" plain @click="typing.stop()">
        <span class="i-mdi-close" /> 取消输入
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
  display: inline-flex;
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
