<script setup lang="ts" vapor>
import type { HexPreviewRow } from '@shared/transfer/transfer'

/**
 * 十六进制预览：偏移 + hex + ASCII。
 *
 * 只展示文件开头若干行（由主进程截取），目的是让用户确认"选对文件了"，
 * 而不是在这里做大文件查看器——那样既慢又没必要。
 */
defineProps<{ rows: HexPreviewRow[] }>()
</script>

<template>
  <div class="hex mono">
    <div v-for="row in rows" :key="row.offset" class="hex-row">
      <span class="hex-offset">{{ row.offset.toString(16).padStart(8, '0') }}</span>
      <span class="hex-bytes">{{ row.hex }}</span>
      <span class="hex-ascii">{{ row.ascii }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.hex {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 10px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
  font-size: 11px;
  line-height: 1.6;
  overflow-x: auto;
}

.hex-row {
  display: flex;
  gap: 12px;
  white-space: pre;
}

.hex-offset {
  color: var(--text-3);
  user-select: none;
}

.hex-bytes {
  color: var(--text-1);
}

.hex-ascii {
  color: var(--text-2);
}
</style>
