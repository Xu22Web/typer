<script setup lang="ts" vapor>
/**
 * 更新中心。
 *
 * 交互按"一件事只有一个主按钮"来排：
 *   可用新版本 → 下载更新（主）
 *   下载中     → 取消（次）
 *   已通过校验 → 安装并重启（主）
 * 状态文案始终说明"现在处于哪一步、下一步会发生什么"，
 * 并且把完整性校验结果明明白白地展示出来（包括校验来源与摘要前缀）。
 */
const {
  check,
  state,
  progress,
  checking,
  error,
  available,
  downloading,
  busy,
  check: result,
  latestVersion,
  currentVersion,
  verifiedLabel,
  runCheck,
  download,
  cancel,
  install
} = useUpdate()

const notesVisible = ref(false)

const published = computed(() => {
  const raw = result.value?.latest?.publishedAt
  if (!raw) return ''
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
})

const sizeLabel = computed(() => {
  const bytes = result.value?.latest?.asset?.size ?? 0
  if (bytes <= 0) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})

const progressPercent = computed(() => Math.round((progress.value?.percent ?? 0) * 100))

const transferred = computed(() => {
  const received = progress.value?.received ?? 0
  const total = progress.value?.total ?? 0
  const mb = (value: number): string => (value / 1024 / 1024).toFixed(1)
  return total > 0 ? `${mb(received)} / ${mb(total)} MB` : `${mb(received)} MB`
})

const speedLabel = computed(() => {
  const speed = progress.value?.bytesPerSecond ?? 0
  if (speed <= 0) return ''
  return speed >= 1024 * 1024
    ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
    : `${Math.round(speed / 1024)} KB/s`
})

const digestShort = computed(() => {
  const digest = state.value.sha256
  return digest ? `${digest.slice(0, 12)}…${digest.slice(-8)}` : ''
})

/** 一句话说明当前状态，避免用户猜"现在该干什么" */
const statusText = computed(() => {
  if (checking.value) return '正在检查 GitHub 上的最新发布…'
  if (state.value.status === 'downloading') return '正在下载安装包…'
  if (state.value.status === 'verifying') return '下载完成，正在计算 SHA-256 并比对校验和…'
  if (state.value.status === 'ready') return '安装包已下载并通过完整性校验，可以安装。'
  if (state.value.status === 'unverified') {
    return '下载完成，但这次发布没有提供校验和，出于安全考虑不会自动安装。'
  }
  if (!check.value) return '尚未检查更新。'
  if (check.value.status === 'available') {
    return `有新版本 ${latestVersion.value} 可用（当前 ${currentVersion.value}）。`
  }
  if (check.value.status === 'up-to-date') return `已是最新版本（${currentVersion.value}）。`
  if (check.value.status === 'unsupported') return check.value.message ?? '当前环境不支持自动更新。'
  return check.value.message ?? '检查更新失败。'
})

const tone = computed(() => {
  if (state.value.status === 'failed' || check.value?.status === 'error') return 'bad'
  if (state.value.status === 'ready' || available.value) return 'ok'
  return ''
})

onMounted(() => {
  // 外壳已经触发过一次检查，这里只负责把结果反映到页面上
  if (!check.value && !checking.value) void runCheck()
})

async function checkNow(): Promise<void> {
  const result = await runCheck(true)
  if (result?.status === 'up-to-date') ElMessage.success('已是最新版本')
  else if (result?.status === 'error') ElMessage.error(result.message ?? '检查更新失败')
}

function openDownloadPage(): void {
  const url = result.value?.latest?.pageUrl
  if (url) void window.api.openExternal(url)
}
</script>

<template>
  <section class="card update">
    <div class="card-head">
      <h2 class="card-title"><span class="icon i-mdi-cloud-download-outline" /> 版本与更新</h2>
      <div class="spacer" />
      <span class="chip" :class="{ accent: available }">
        <span class="dot" :class="tone" />
        当前 <strong>{{ currentVersion || '—' }}</strong>
        <template v-if="latestVersion && available">
          → 最新 <strong>{{ latestVersion }}</strong>
        </template>
      </span>
    </div>

    <p class="status">
      {{ statusText }}
      <span v-if="published" class="muted">（{{ published }} 发布）</span>
    </p>

    <!-- 下载进度 -->
    <div v-if="downloading || state.status === 'verifying'" class="progress">
      <ElProgress :percentage="progressPercent" :show-text="false" :stroke-width="6" />
      <div class="progress-meta mono">
        <span>{{ transferred }}</span>
        <span v-if="speedLabel">· {{ speedLabel }}</span>
        <span class="spacer" />
        <span>{{ progressPercent }}%</span>
      </div>
    </div>

    <!-- 校验结果 -->
    <div v-if="state.status === 'ready' || state.status === 'unverified'" class="verify">
      <span
        class="chip"
        :class="{ accent: state.status === 'ready', warn: state.status === 'unverified' }"
      >
        <span
          :class="state.status === 'ready' ? 'i-mdi-shield-check' : 'i-mdi-shield-alert-outline'"
        />
        {{ state.status === 'ready' ? verifiedLabel || 'SHA-256 校验通过' : '未提供校验和' }}
      </span>
      <code v-if="digestShort" class="digest" :title="state.sha256 ?? ''"
        >SHA-256 {{ digestShort }}</code
      >
    </div>

    <p v-if="error" class="error">
      <span class="i-mdi-alert-circle-outline" />
      {{ error }}
    </p>

    <!-- 发布说明 -->
    <template v-if="available && result?.latest?.notes">
      <div class="notes-head">
        <button class="notes-toggle" type="button" @click="notesVisible = !notesVisible">
          <span :class="notesVisible ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" />
          更新内容
        </button>
        <span v-if="sizeLabel" class="muted">安装包 {{ sizeLabel }}</span>
      </div>
      <pre v-if="notesVisible" class="notes">{{ result.latest.notes }}</pre>
    </template>

    <div class="actions">
      <ElButton :loading="checking" :disabled="busy" @click="checkNow()">
        <span class="i-mdi-refresh" /> 检查更新
      </ElButton>

      <template v-if="downloading">
        <ElButton type="danger" plain @click="cancel()">
          <span class="i-mdi-close" /> 取消下载
        </ElButton>
      </template>

      <template v-else-if="state.status === 'ready'">
        <ElButton type="primary" @click="install()">
          <span class="i-mdi-download" /> 安装并重启
        </ElButton>
      </template>

      <template v-else-if="available">
        <ElButton type="primary" :disabled="!result?.latest?.asset" @click="download()">
          <span class="mdi:download" /><span class="i-mdi-cloud-download-outline" /> 下载更新
        </ElButton>
        <ElButton v-if="!result?.latest?.asset" type="primary" plain @click="openDownloadPage()">
          <span class="i-mdi-open-in-new" /> 前往发布页
        </ElButton>
      </template>

      <template v-else-if="state.status === 'unverified'">
        <ElButton type="primary" plain @click="openDownloadPage()">
          <span class="i-mdi-open-in-new" /> 手动前往发布页
        </ElButton>
      </template>
    </div>

    <p class="hint muted">
      下载后会计算安装包的 SHA-256 并与发布校验和比对；校验不通过会删除文件并拒绝安装。
      安装前会退出本程序，由安装向导完成替换。
    </p>
  </section>
</template>

<style scoped lang="scss">
.update {
  gap: 10px;
}

.status {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.verify {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.digest {
  font-size: 11.5px;
  color: var(--text-2);
}

.error {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--danger);
  word-break: break-all;
}

.notes-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.notes-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;

  &:hover {
    color: var(--text-1);
  }
}

.notes {
  max-height: 220px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
  font-family: var(--font-sans);
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hint {
  line-height: 1.7;
}
</style>
