<script setup lang="ts" vapor>
/**
 * 日志页。
 *
 * 单独成页的原因：日志是"流水"型信息，条数不可控、需要筛选与复制，
 * 放在输入页会把主任务挤掉；放在这里则可以放心地给它整页空间。
 */
const typing = useTyping()

type Filter = 'all' | 'info' | 'warn' | 'error'

const filter = ref<Filter>('all')
const autoScroll = ref(true)
const listEl = ref<HTMLElement | null>(null)

const counts = computed(() => ({
  all: typing.logs.value.length,
  info: typing.logs.value.filter((entry) => entry.level === 'info').length,
  warn: typing.logs.value.filter((entry) => entry.level === 'warn').length,
  error: typing.logs.value.filter((entry) => entry.level === 'error').length
}))

const visible = computed(() =>
  filter.value === 'all'
    ? typing.logs.value
    : typing.logs.value.filter((entry) => entry.level === filter.value)
)

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' }
]

const levelIcon: Record<string, string> = {
  info: 'i-mdi-information-outline',
  warn: 'i-mdi-alert-outline',
  error: 'i-mdi-alert-circle-outline'
}

/** 日志是流水信息，新条目进来后自动滚到底部，除非用户主动关掉了跟随 */
watch(
  () => typing.logs.value.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

async function copyAll(): Promise<void> {
  const text = typing.logs.value
    .map((entry) => `${new Date(entry.at).toLocaleString()}\t${entry.level}\t${entry.message}`)
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('日志已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败：剪贴板不可用')
  }
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <h1>日志</h1>
      <p class="page-desc">
        记录输入任务的开始、进度、中止与错误。日志只包含长度、种子等元信息，
        <strong>不包含输入内容本身</strong>。
      </p>
    </header>

    <section class="card logs">
      <div class="card-head">
        <h2 class="card-title"><span class="icon i-mdi-text-box-search-outline" /> 运行记录</h2>
        <div class="spacer" />

        <ElRadioGroup v-model="filter" size="small">
          <ElRadioButton v-for="item in filters" :key="item.value" :value="item.value">
            {{ item.label }} ({{ counts[item.value] }})
          </ElRadioButton>
        </ElRadioGroup>

        <ElTooltip content="复制全部日志" placement="top">
          <button
            class="icon-btn ghost"
            type="button"
            aria-label="复制全部日志"
            :disabled="typing.logs.value.length === 0"
            @click="copyAll()"
          >
            <span class="i-mdi-content-copy" />
          </button>
        </ElTooltip>

        <ElTooltip content="清空日志" placement="top">
          <button
            class="icon-btn ghost"
            type="button"
            aria-label="清空日志"
            :disabled="typing.logs.value.length === 0"
            @click="typing.clearLogs()"
          >
            <span class="i-mdi-notification-clear-all" />
          </button>
        </ElTooltip>
      </div>

      <ul ref="listEl" class="list" @scroll="autoScroll = false" @click="autoScroll = true">
        <li v-for="(entry, index) in visible" :key="`${entry.at}-${index}`" :class="entry.level">
          <span class="icon" :class="levelIcon[entry.level]" />
          <span class="time mono">{{ new Date(entry.at).toLocaleTimeString() }}</span>
          <span class="message">{{ entry.message }}</span>
        </li>
        <li v-if="visible.length === 0" class="empty">
          {{
            typing.logs.value.length === 0
              ? '暂无日志，开始一次输入后就会出现记录。'
              : '当前筛选条件下没有记录。'
          }}
        </li>
      </ul>

      <p class="foot muted">
        <span class="i-mdi-arrow-down" />
        {{ autoScroll ? '已开启自动滚动（点击列表任意位置重新跟随）' : '已暂停自动滚动' }}
      </p>
    </section>
  </section>
</template>

<style scoped lang="scss">
.logs {
  flex: 1;
  min-height: 0;
}

.list {
  flex: 1;
  min-height: 260px;
  max-height: calc(100vh - 340px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-right: 4px;

  li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
    line-height: 1.6;

    &:hover {
      background: var(--ctrl-fill);
    }

    .icon {
      flex: none;
      font-size: 14px;
      color: var(--text-3);
    }

    .time {
      flex: none;
      color: var(--text-3);
    }

    .message {
      min-width: 0;
      color: var(--text-1);
      word-break: break-all;
    }

    &.warn {
      .icon,
      .message {
        color: var(--warning);
      }
    }

    &.error {
      .icon,
      .message {
        color: var(--danger);
      }
    }

    &.empty {
      justify-content: center;
      padding: 32px 0;
      color: var(--text-3);
    }
  }
}

.foot {
  display: flex;
  align-items: center;
  gap: 6px;
}

:deep(.el-radio-group) {
  .el-radio-button__inner {
    padding: 5px 12px;
    font-size: 12px;
  }
}
</style>
