<script setup lang="ts" vapor>
import { buildPlan } from '@main/typing/planner/plan'
import { estimateTotalMs } from '@main/typing/scheduling/timing'

/**
 * 输入页：只承载"准备内容 → 开始输入"这一条主线。
 *
 * 刻意不在这里堆日志与全部设置：日志在「日志」页，节奏与隐私在「设置」页；
 * 这里保留一条最新日志与两个快捷入口，保证主任务不被淹没。
 */
const typing = useTyping()
const settingsStore = useSettings()

const settings = settingsStore.settings

onMounted(async () => {
  await settingsStore.load()
  await typing.init()
})

/** 实时预览：字符统计 + 预计耗时（与主进程使用同一套纯函数实现） */
const preview = computed(() => {
  if (!settings.value || typing.text.value.length === 0) return null
  const stats = buildPlan(typing.text.value, {
    layout: settings.value.keyboard.layout,
    forceUnicodeForAll: settings.value.keyboard.forceUnicodeForAll
  }).stats

  return { stats, estimated: estimateTotalMs(stats.typed, settings.value.timing) }
})

const detected = computed(() => typing.targetWindow.value !== '未检测')

const latestLog = computed(() => typing.logs.value.at(-1) ?? null)

/** 开始前的引导语：把"为什么现在不能开始"讲清楚 */
const blocker = computed(() => {
  if (typing.unsupported.value) return '当前系统不支持键盘注入（仅支持 Windows）'
  if (typing.text.value.length === 0) return '先在内容区粘贴要输入的文本'
  return ''
})

const startLabel = computed(() => {
  const delay = settings.value?.startDelayMs ?? 0
  return delay > 0 ? `开始输入（${Math.round(delay / 1000)} 秒后）` : '开始输入'
})
</script>

<template>
  <section class="page">
    <header class="page-header">
      <h1>输入</h1>
      <p class="page-desc">
        把要输入的内容粘贴到内容区，点开始，然后在倒计时内切换到目标窗口。 中文、emoji 与需要 Shift
        组合的符号都能正确输入。
      </p>
    </header>

    <ElAlert
      v-if="typing.unsupported.value"
      type="error"
      :closable="false"
      show-icon
      title="当前系统不受支持"
      description="键盘注入目前仅支持 Windows。界面可以打开，但无法真正输入。"
    />

    <div class="input-layout">
      <!-- 主任务：内容区 -->
      <section class="card editor">
        <div class="card-head">
          <h2 class="card-title"><span class="icon i-mdi-text-box-outline" /> 内容区</h2>
          <div class="spacer" />
          <template v-if="preview">
            <span class="chip"
              ><strong>{{ preview.stats.chars }}</strong> 字符</span
            >
            <span class="chip"
              >中文 <strong>{{ preview.stats.cjk }}</strong></span
            >
            <span class="chip"
              >动作 <strong>{{ preview.stats.typed }}</strong></span
            >
            <span v-if="preview.stats.layoutFallbacks > 0" class="chip warn">
              布局回退 <strong>{{ preview.stats.layoutFallbacks }}</strong>
            </span>
          </template>
        </div>

        <ElInput
          v-model="typing.text.value"
          class="editor-input"
          type="textarea"
          :rows="13"
          resize="none"
          placeholder="把要输入的文本粘贴到这里（支持中文、emoji、需要 Shift 的符号）"
          @keydown.ctrl.enter="typing.start()"
        />

        <p class="editor-foot muted">
          <template v-if="preview">
            按当前设置预计需要
            <strong>{{ Math.round(preview.estimated / 1000) }} 秒</strong>输入完成。
          </template>
          <template v-else>{{ blocker || '等待输入内容…' }}</template>
        </p>
      </section>

      <!-- 次要信息：目标窗口 + 运行状态 -->
      <aside class="side-column">
        <section class="card target">
          <div class="card-head">
            <h2 class="card-title"><span class="icon i-mdi-target" /> 目标窗口</h2>
            <div class="spacer" />
            <button
              class="icon-btn ghost"
              type="button"
              title="重新检测目标窗口"
              aria-label="重新检测目标窗口"
              @click="typing.refreshForeground()"
            >
              <span class="i-mdi-refresh" />
            </button>
          </div>

          <p class="target-name">
            <span class="dot" :class="{ ok: detected }" />
            <span class="ellipsis" :title="typing.targetWindow.value">
              {{ typing.targetWindow.value }}
            </span>
          </p>
          <p class="card-desc">开始前先点一下目标程序的输入位置，输入就会落在这里。</p>
        </section>

        <RunStatusPanel />
      </aside>
    </div>

    <!-- 主操作条：开始是唯一的主按钮，其余按危险/次要分组 -->
    <section class="card action-bar">
      <div class="secondary">
        <ElButton :disabled="typing.isRunning.value" @click="typing.importFile()">
          <span class="i-mdi-file-import-outline" /> 导入文本
        </ElButton>
        <RouterLink class="link-btn" to="/settings">
          <span class="i-mdi-tune-vertical" /> 调整设置
        </RouterLink>
        <ElButton
          v-if="typing.state.value === 'paused'"
          type="primary"
          plain
          @click="typing.resume()"
        >
          <span class="i-mdi-play" /> 继续
        </ElButton>
        <ElButton v-else :disabled="!typing.isRunning.value" @click="typing.pause()">
          <span class="i-mdi-pause" /> 暂停
        </ElButton>
        <ElButton type="danger" plain :disabled="!typing.isRunning.value" @click="typing.stop()">
          <span class="i-mdi-stop" /> 停止
        </ElButton>
      </div>

      <div class="primary">
        <ElButton
          type="primary"
          size="large"
          :disabled="!typing.canStart.value"
          :loading="typing.busy.value"
          @click="typing.start()"
        >
          <span class="i-mdi-keyboard" /> {{ startLabel }}
        </ElButton>
      </div>
    </section>

    <section class="card notice">
      <div class="notice-head">
        <span class="icon i-mdi-lightbulb-on-outline" />
        <span>开始后请勿移动鼠标或切换窗口</span>
        <div class="spacer" />
        <RouterLink class="link-btn" to="/logs">查看运行日志</RouterLink>
      </div>
      <p class="card-desc">
        随时可按
        <code>{{ settings?.hotkeys.stop ?? 'Ctrl+Alt+X' }}</code>
        紧急停止，内容区里按 <code>Ctrl+Enter</code> 也能开始。
        目标程序若开着中文输入法，建议先切到英文。
      </p>
      <p v-if="latestLog" class="latest-log mono">
        <span class="i-mdi-history" />
        {{ new Date(latestLog.at).toLocaleTimeString() }} · {{ latestLog.message }}
      </p>
    </section>
  </section>
</template>

<style scoped lang="scss">
.input-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
  gap: 16px;
  /* 两列等高：左列是主任务（内容区），通常更高，右列拉伸对齐它的底边 */
  align-items: stretch;
}

.editor {
  gap: 10px;
  /* 内容区要够大（主任务），但也不能把操作条与提示挤出首屏 */
  min-height: 340px;
}

.editor-input {
  flex: 1;
}

.editor-foot {
  strong {
    color: var(--text-1);
    font-weight: 600;
  }
}

.side-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 16px;

  /* 目标窗口是固定内容，多出来的高度给运行状态，右列因此与左列等高；
     多出的高度用 space-between 摊到各行之间，避免卡片底部出现一块空档 */
  > :last-child {
    flex: 1;
    justify-content: space-between;
  }
}

.target-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.action-bar {
  /* 两端对齐：次要操作（含运行控制）成组贴左，主按钮单独贴右 */
  justify-content: space-between;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;

  .secondary,
  .primary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  /* 换行时主按钮仍保持靠右，不会被推到下一行的开头 */
  .primary {
    margin-left: auto;
  }

  /*
   * 操作条只有两级尺寸：次要控件 32px、主按钮 40px。
   * Element Plus 的按钮与 RouterLink 是两种元素，默认度量并不一致
   * （按钮 32px/14px 字，链接 36.8px/13px 字），不显式对齐就会出现
   * "同一排按钮高矮不一"的错位。
   */
  :deep(.el-button:not(.el-button--large)),
  .link-btn {
    height: 32px;
    padding: 0 12px;
    font-size: 13px;
  }

  :deep(.el-button--large) {
    height: 40px;
    padding: 0 20px;
    font-size: 14px;
    font-weight: 600;
  }

  @media (max-width: 780px) {
    flex-wrap: wrap;
  }
}

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-1);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--ctrl-fill);
    border-color: var(--stroke);
    text-decoration: none;
  }
}

.notice {
  gap: 8px;

  .notice-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;

    .icon {
      color: var(--accent);
      font-size: 16px;
    }
  }

  .latest-log {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: 12px;
    color: var(--text-3);
    word-break: break-all;
  }
}

@media (max-width: 980px) {
  .input-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
