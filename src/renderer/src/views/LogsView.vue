<script setup lang="ts" vapor>
/**
 * 日志页：整页承载"流水型信息"——条数不可控、需要筛选与复制，放在输入页会挤掉主任务。
 */
const typing = useTyping()

/** 日志级别筛选：全部 / 信息 / 警告 / 错误 */
type Filter = 'all' | 'info' | 'warn' | 'error'

/** 当前选中的筛选级别 */
const filter = ref<Filter>('all')
/** 是否跟随新日志自动滚到底部；用户手动滚动时自动暂停 */
const autoScroll = ref(true)
/** 日志列表容器，用于自动滚动 */
const listEl = ref<HTMLElement | null>(null)

/** 各筛选级别下的条数，用于给筛选按钮加计数 */
const counts = computed(() => ({
  all: typing.logs.value.length,
  info: typing.logs.value.filter((entry) => entry.level === 'info').length,
  warn: typing.logs.value.filter((entry) => entry.level === 'warn').length,
  error: typing.logs.value.filter((entry) => entry.level === 'error').length
}))

/** 当前筛选条件下要显示的条目 */
const visible = computed(() =>
  filter.value === 'all'
    ? typing.logs.value
    : typing.logs.value.filter((entry) => entry.level === filter.value)
)

/** 筛选按钮的定义（顺序即界面顺序） */
const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' }
]

/** 级别到图标的映射 */
const levelIcon: Record<string, string> = {
  info: 'i-mdi-information-outline',
  warn: 'i-mdi-alert-outline',
  error: 'i-mdi-alert-circle-outline'
}

/** @description 新日志进来后自动滚到底部（用户关掉跟随后不再打扰） */
watch(
  () => typing.logs.value.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

/** @description 回到本页时补一次滚动：离开期间攒下的新日志不会再触发上面的 watch */
onActivated(async () => {
  if (!autoScroll.value) return
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
})

/** @description 把当前全部日志（按时间、级别、内容三列）复制到剪贴板 */
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
          <span class="icon text-icon" :class="levelIcon[entry.level]" />
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
    align-items: flex-start;
    gap: 10px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
    line-height: 20px;

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
