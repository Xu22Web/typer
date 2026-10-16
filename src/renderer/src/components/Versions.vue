<script setup lang="ts" vapor>
const versions = reactive({
  electron: '-',
  chrome: '-',
  node: '-',
  ...window.electron?.process?.versions
})
</script>

<template>
  <ul class="list">
    <li class="item">Electron v{{ versions.electron }}</li>
    <li class="item chrome">Chromium v{{ versions.chrome }}</li>
    <li class="item">Node v{{ versions.node }}</li>
  </ul>
</template>

<style scoped lang="scss">
.list {
  display: flex;
  gap: 10px;
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.item {
  color: var(--text-3);

  & + .item::before {
    content: '·';
    margin-right: 10px;
    color: var(--stroke-hover);
  }
}

@media (max-width: 1400px) {
  .chrome {
    display: none;
  }
}
</style>
