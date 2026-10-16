<script setup lang="ts" vapor>
const { isDark, toggle } = useTheme()
</script>

<template>
  <button
    class="toggle"
    type="button"
    :aria-label="isDark ? '切换到亮色主题' : '切换到暗色主题'"
    @click="toggle"
  >
    <span class="icon text-lg" :class="isDark ? 'i-mdi-weather-sunny' : 'i-mdi-weather-night'" />
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

.toggle:hover {
  color: var(--text-1);
  background: var(--surface-hover);
}

.icon {
  transition: transform 0.3s ease;
}

.toggle:hover .icon {
  transform: rotate(20deg);
}
</style>
