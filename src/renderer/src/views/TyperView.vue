<script setup lang="ts" vapor>
/**
 * 输入页：只承载"准备内容 → 开始输入"这一条主线，日志在「日志」页、节奏与隐私在「设置」页。
 */
const typing = useTyping()
const transfer = useTransfer()
const settingsStore = useSettings()
const toolScript = useToolScript()

/** 输入页有两种模式：逐字符输入文本，或把文件切成帧逐片发送 */
const mode = ref<'text' | 'file'>('text')

/** 当前生效的设置 */
const settings = settingsStore.settings

/** @description 进入页面时加载设置并初始化引擎（订阅事件、读前台窗口） */
onMounted(async () => {
  await settingsStore.load()
  await typing.init()
})

/** 是否已识别到前台窗口（用于决定要不要提示"切到目标窗口"） */
const detected = computed(() => typing.targetWindow.value !== '未检测')

/** 最新一条日志，用于在输入页提示"刚刚发生了什么" */
const latestLog = computed(() => typing.logs.value.at(-1) ?? null)

/** 页头说明：两种模式各一句话（窄窗口会被省略号截断，鼠标悬停看全文） */
const pageDesc = computed(() =>
  mode.value === 'text'
    ? '把要输入的内容粘贴到内容区，点开始，然后在倒计时内切换到目标窗口。中文、emoji 与需要 Shift 组合的符号都能正确输入。'
    : '选择一个文件，Typer 会把它切成"每片一行"的帧逐片输入；接收端逐片校验、支持断点续传，合并后再校验整文件哈希。'
)

/** 开始按钮文案：文件模式显示要发多少片，倒计时非 0 时补上"几秒后" */
const startLabel = computed(() => {
  const delay = settings.value?.startDelayMs ?? 0
  const suffix = delay > 0 ? `（${Math.round(delay / 1000)} 秒后）` : ''
  if (mode.value === 'file') {
    const count = transfer.sendingCount.value
    return count > 0 ? `发送 ${count} 片${suffix}` : `开始发送${suffix}`
  }
  return delay > 0 ? `开始输入（${Math.round(delay / 1000)} 秒后）` : '开始输入'
})

/** 是否正忙：文件模式看准备进度，文本模式看引擎请求是否在途 */
const busy = computed(() => (mode.value === 'file' ? transfer.preparing.value : typing.busy.value))

/** 当前是否允许开始 */
const canStart = computed(() => {
  if (typing.isRunning.value || typing.unsupported.value || busy.value) return false
  if (mode.value === 'file') {
    return transfer.hasJob.value && transfer.error.value.length === 0
  }
  return typing.canStart.value
})

/** @description 按当前模式开始输入或发送；不可开始时直接返回 */
function start(): void {
  if (!canStart.value) return
  void (mode.value === 'file' ? transfer.start() : typing.start())
}

/** @description 从文件面板插入接收脚本：先切回文本模式，再走与文本面板相同的确认与替换 */
async function insertToolScriptFromFile(): Promise<void> {
  mode.value = 'text'
  await toolScript.insert()
}
</script>

<template>
  <section class="page input-page">
    <header class="page-header">
      <div class="header-row">
        <h1>输入</h1>
        <div id="tour-mode-switch" class="mode-switch" role="tablist" aria-label="输入模式">
          <button
            class="mode-option"
            type="button"
            role="tab"
            :aria-selected="mode === 'text'"
            :class="{ active: mode === 'text' }"
            :disabled="typing.isRunning.value"
            @click="mode = 'text'"
          >
            <span class="i-mdi-text-box-outline" /><span>文本</span>
          </button>
          <button
            class="mode-option"
            type="button"
            role="tab"
            :aria-selected="mode === 'file'"
            :class="{ active: mode === 'file' }"
            :disabled="typing.isRunning.value"
            @click="mode = 'file'"
          >
            <span class="i-mdi-file-arrow-up-down-outline" /><span>文件</span>
          </button>
        </div>

        <div class="spacer" />
        <!-- 窄窗口：目标窗口降级成胶囊（宽窗口在右侧卡片里显示完整信息） -->
        <TargetChip class="compact-only" />
      </div>
      <p class="page-desc" :title="pageDesc">{{ pageDesc }}</p>
    </header>

    <ElAlert
      v-if="typing.unsupported.value"
      type="error"
      :closable="false"
      show-icon
      title="当前系统不受支持"
      description="键盘注入目前仅支持 Windows。界面可以打开，但无法真正输入。"
    />

    <div class="workspace">
      <!--
        主任务：文本模式是内容区，文件模式是文件面板。
        KeepAlive 让两者切换时保留各自的页内状态（文件面板的预览/续传展开与输入、文本面板的滚动）。
      -->
      <KeepAlive>
        <FilePanel v-if="mode === 'file'" @insert-script="insertToolScriptFromFile" />
        <TextPanel v-else />
      </KeepAlive>

      <!-- 次要信息：目标窗口 + 运行状态 + 提示（窄窗口收进页头的胶囊与状态条） -->
      <aside class="side-column">
        <section class="card target">
          <div class="card-head">
            <h2 class="card-title"><span class="icon i-mdi-target" /><span>目标窗口</span></h2>
            <div class="spacer" />
            <button
              id="tour-target-refresh-wide"
              class="icon-btn ghost"
              type="button"
              title="重新检测目标窗口"
              aria-label="重新检测目标窗口"
              @click="typing.refreshForeground()"
            >
              <span class="i-mdi-refresh" />
            </button>
          </div>

          <div class="target-name">
            <div class="dot" :class="{ ok: detected }" />
            <div class="ellipsis" :title="typing.targetWindow.value">
              {{ typing.targetWindow.value }}
            </div>
          </div>
          <p class="card-desc">开始前先点一下目标程序的输入位置，输入就会落在这里。</p>
        </section>

        <RunStatusPanel />

        <section class="card hint-card">
          <div class="notice-head">
            <div class="icon i-mdi-lightbulb-on-outline" />
            <div>开始后请勿移动鼠标或切换窗口</div>
          </div>
          <p class="card-desc">
            <span
              >随时可按
              <code>{{ settings?.hotkeys.stop ?? 'Ctrl+Alt+X' }}</code> 紧急停止，内容区里按
              <code>Ctrl+Enter</code> 也能开始。目标程序若开着中文输入法，建议先切到英文。</span
            >
          </p>
          <div v-if="latestLog" class="latest-log mono">
            <div class="i-mdi-history" />
            <div>{{ new Date(latestLog.at).toLocaleTimeString() }} · {{ latestLog.message }}</div>
          </div>
        </section>
      </aside>
    </div>

    <RunStatusStrip class="compact-only" />

    <!-- 主操作条：常驻页面底部（只有主面板内部滚动），开始是唯一的主按钮 -->
    <section class="card action-bar">
      <div class="secondary">
        <ElButton
          v-if="mode === 'text'"
          :disabled="typing.isRunning.value"
          @click="typing.importFile()"
        >
          <span class="i-mdi-file-import-outline" /><span>导入文本</span>
        </ElButton>
        <RouterLink class="link-btn" to="/settings">
          <div class="i-mdi-tune-vertical" />
          <div>调整设置</div>
        </RouterLink>
        <ElButton
          v-if="typing.state.value === 'paused'"
          type="primary"
          plain
          @click="typing.resume()"
        >
          <span class="i-mdi-play" /><span>继续</span>
        </ElButton>
        <ElButton v-else :disabled="!typing.isRunning.value" @click="typing.pause()">
          <span class="i-mdi-pause" /><span>暂停</span>
        </ElButton>
        <ElButton
          id="tour-stop"
          type="danger"
          plain
          :disabled="!typing.isRunning.value"
          @click="typing.stop()"
        >
          <span class="i-mdi-stop" /><span>停止</span>
        </ElButton>
        <RouterLink class="link-btn" to="/logs">
          <div class="i-mdi-text-box-search-outline" />
          <div>运行日志</div>
        </RouterLink>
      </div>

      <div id="tour-start" class="primary">
        <ElButton
          type="primary"
          size="large"
          :disabled="!canStart"
          :loading="busy"
          @click="start()"
        >
          <span :class="mode === 'file' ? 'i-mdi-file-arrow-up-down-outline' : 'i-mdi-keyboard'" />
          <span>{{ startLabel }}</span>
        </ElButton>
      </div>
    </section>
  </section>
</template>

<style scoped lang="scss">
/*
 * 输入页占满内容区高度：页头与操作条常驻，只有主面板内部滚动。
 * 高度 = 视口 − 标题栏 − 状态栏 − 内容区上下内边距（--content-pad-y，与 .content 的 padding 同步）。
 */
.input-page {
  height: calc(100vh - var(--titlebar-h) - var(--statusbar-h) - var(--content-pad-y));
  min-height: 420px;
  gap: 12px;
}

.workspace {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 12px;
}

/* 窄窗口不显示右列与页头胶囊，改由状态条承担同样的信息 */
.compact-only {
  display: none;
}

.side-column {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex: none;
  min-height: 0;
  gap: 12px;
  overflow-y: auto;
}

@media (max-width: 1239px) {
  .side-column {
    display: none;
  }

  .compact-only {
    display: flex;
  }
}

/* 矮窗口：说明文字让位给内容与操作条 */
@media (max-height: 700px) {
  .page-desc {
    display: none;
  }
}

/* 说明文字只占一行：内容用 title 也能看到，竖向空间留给主面板 */
.page-desc {
  overflow: hidden;
  max-width: 100%;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 窄窗口隐藏与侧边导航重复的入口，操作条保持一行 */
@media (max-width: 960px) {
  .action-bar .link-btn {
    display: none;
  }
}

.header-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
}

.mode-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: none;
  border-radius: calc(var(--radius-md) - 2px);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    cursor: progress;
  }

  &.active {
    background: var(--card-bg);
    color: var(--text-1);
    font-weight: 600;
    box-shadow: var(--shadow-card);
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
  flex: none;
  /* 两端对齐：次要操作（含运行控制）成组贴左，主按钮单独贴右 */
  justify-content: space-between;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;

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
  display: flex;
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

.hint-card {
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
</style>
