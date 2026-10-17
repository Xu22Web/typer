<script setup lang="ts" vapor>
/**
 * 更新中心：检查 → 下载 → 校验 → 安装，同一时刻只突出一个主按钮，
 * 并如实展示完整性校验的来源与摘要。
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

/** 更新说明（release notes）是否展开 */
const notesVisible = ref(false)

/** 发布日期文案；缺失或解析失败时为空串 */
const published = computed(() => {
  const raw = result.value?.latest?.publishedAt
  if (!raw) return ''
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
})

/** 安装包体积文案 */
const sizeLabel = computed(() => {
  const bytes = result.value?.latest?.asset?.size ?? 0
  if (bytes <= 0) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})

/** 下载进度百分比（0–100） */
const progressPercent = computed(() => Math.round((progress.value?.percent ?? 0) * 100))

/** 已下载 / 总大小文案 */
const transferred = computed(() => {
  const received = progress.value?.received ?? 0
  const total = progress.value?.total ?? 0
  const mb = (value: number): string => (value / 1024 / 1024).toFixed(1)
  return total > 0 ? `${mb(received)} / ${mb(total)} MB` : `${mb(received)} MB`
})

/** 下载速度文案（不足 1 MB/s 时用 KB/s） */
const speedLabel = computed(() => {
  const speed = progress.value?.bytesPerSecond ?? 0
  if (speed <= 0) return ''
  return speed >= 1024 * 1024
    ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
    : `${Math.round(speed / 1024)} KB/s`
})

/** SHA-256 摘要的缩写形式（首 12 位 + 末 8 位） */
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

/** 状态色标：失败 bad、就绪或有新版本 ok、其余不着色 */
const tone = computed(() => {
  if (state.value.status === 'failed' || check.value?.status === 'error') return 'bad'
  if (state.value.status === 'ready' || available.value) return 'ok'
  return ''
})

/** @description 进入页面时若还没有检查结果就补一次检查（外壳可能已经查过） */
onMounted(() => {
  if (!check.value && !checking.value) void runCheck()
})

/** @description 手动强制检查更新，并按结果给出提示 */
async function checkNow(): Promise<void> {
  const result = await runCheck(true)
  if (result?.status === 'up-to-date') ElMessage.success('已是最新版本')
  else if (result?.status === 'error') ElMessage.error(result.message ?? '检查更新失败')
}

/** @description 用系统浏览器打开发布页（手动下载的兜底路径） */
function openDownloadPage(): void {
  const url = result.value?.latest?.pageUrl
  if (url) void window.api.openExternal(url)
}
</script>

<template>
  <section class="card update">
    <div class="card-head">
      <h2 class="card-title">
        <span class="icon i-mdi-cloud-download-outline" /><span>版本与更新</span>
      </h2>
      <div class="spacer" />
      <div class="chip" :class="{ accent: available }">
        <div class="dot" :class="tone" />
        <div>
          当前 <strong>{{ currentVersion || '—' }}</strong>
          <template v-if="latestVersion && available">
            → 最新 <strong>{{ latestVersion }}</strong>
          </template>
        </div>
      </div>
    </div>

    <p class="status">
      <span>{{ statusText }}</span>
      <span v-if="published" class="muted">（{{ published }} 发布）</span>
    </p>

    <!-- 下载进度 -->
    <div v-if="downloading || state.status === 'verifying'" class="progress">
      <ElProgress :percentage="progressPercent" :show-text="false" :stroke-width="6" />
      <div class="progress-meta mono">
        <div>{{ transferred }}</div>
        <div v-if="speedLabel">· {{ speedLabel }}</div>
        <div class="spacer" />
        <div>{{ progressPercent }}%</div>
      </div>
    </div>

    <!-- 校验结果 -->
    <div v-if="state.status === 'ready' || state.status === 'unverified'" class="verify">
      <div
        class="chip"
        :class="{ accent: state.status === 'ready', warn: state.status === 'unverified' }"
      >
        <div
          :class="state.status === 'ready' ? 'i-mdi-shield-check' : 'i-mdi-shield-alert-outline'"
        />
        <div>
          {{ state.status === 'ready' ? verifiedLabel || 'SHA-256 校验通过' : '未提供校验和' }}
        </div>
      </div>
      <code v-if="digestShort" class="digest" :title="state.sha256 ?? ''"
        >SHA-256 {{ digestShort }}</code
      >
    </div>

    <div v-if="error" class="error">
      <div class="i-mdi-alert-circle-outline" />
      <div>{{ error }}</div>
    </div>

    <!-- 发布说明 -->
    <template v-if="available && result?.latest?.notes">
      <div class="notes-head">
        <button class="notes-toggle" type="button" @click="notesVisible = !notesVisible">
          <span :class="notesVisible ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" /><span
            >更新内容</span
          >
        </button>
        <div v-if="sizeLabel" class="muted">安装包 {{ sizeLabel }}</div>
      </div>
      <pre v-if="notesVisible" class="notes">{{ result.latest.notes }}</pre>
    </template>

    <div class="actions">
      <ElButton :loading="checking" :disabled="busy" @click="checkNow()">
        <span class="i-mdi-refresh" /><span>检查更新</span>
      </ElButton>

      <template v-if="downloading">
        <ElButton type="danger" plain @click="cancel()">
          <span class="i-mdi-close" /><span>取消下载</span>
        </ElButton>
      </template>

      <template v-else-if="state.status === 'ready'">
        <ElButton type="primary" @click="install()">
          <span class="i-mdi-download" /><span>安装并重启</span>
        </ElButton>
      </template>

      <template v-else-if="available">
        <ElButton type="primary" :disabled="!result?.latest?.asset" @click="download()">
          <span class="i-mdi-download" /><span>下载更新</span>
        </ElButton>
        <ElButton v-if="!result?.latest?.asset" type="primary" plain @click="openDownloadPage()">
          <span class="i-mdi-open-in-new" /><span>前往发布页</span>
        </ElButton>
      </template>

      <template v-else-if="state.status === 'unverified'">
        <ElButton type="primary" plain @click="openDownloadPage()">
          <span class="i-mdi-open-in-new" /><span>手动前往发布页</span>
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
  display: flex;
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
