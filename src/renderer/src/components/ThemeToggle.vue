<script setup lang="ts" vapor>
/** 主题切换按钮：图标随当前主题变化，点击位置作为揭示动画的圆心 */
const { isDark, toggle } = useTheme()
</script>

<template>
  <button
    class="toggle"
    type="button"
    :aria-label="isDark ? '切换到亮色主题' : '切换到暗色主题'"
    @click="toggle"
  >
    <span class="icon" :class="isDark ? 'i-mdi-weather-sunny' : 'i-mdi-weather-night'" />
  </button>
</template>

<style scoped lang="scss">
.toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition:
    color 0.2s,
    background-color 0.2s;
}

/* 悬停反馈用控件填充色，避免与标题栏其它图标按钮不一致 */
.toggle:hover {
  color: var(--text-1);
  background: var(--ctrl-fill);
}

.icon {
  font-size: 16px;
  transition: transform 0.3s ease;
}

.toggle:hover .icon {
  transform: rotate(20deg);
}
</style>
