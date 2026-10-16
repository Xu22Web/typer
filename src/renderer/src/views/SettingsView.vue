<script setup lang="ts" vapor>
import { toPlainPayload } from '@main/ipc/plainPayload'
import type { Settings } from '@main/settings/types'
import {
  CHUNK_PRESETS,
  TRANSFER_ENCODING_OPTIONS,
  TRANSFER_LIMITS,
  formatBytes
} from '@shared/transfer/transfer'

/**
 * 设置页：按组分区编辑草稿并显式保存（有改动才启用保存按钮，失败保留草稿并给出原因，
 * 保存成功用主进程归一化后的值回填，保证界面与生效值一致）。
 */
const { settings, error, load, update, reset } = useSettings()

/** 编辑中的设置草稿；null 表示设置尚未加载 */
const draft = ref<Settings | null>(null)
/** 是否正在提交保存 */
const saving = ref(false)
/** 保存失败的原因，空串表示无错误 */
const saveError = ref('')
/** 是否正在恢复默认设置 */
const restoring = ref(false)

/** 片大小与帧长上限的边界值（与主进程共用同一份定义） */
const limits = TRANSFER_LIMITS
const typing = useTyping()

/** 当前片大小对应的预设（不在预设里则归为"自定义"） */
const presetId = computed(() => {
  const bytes = draft.value?.transfer.chunkBytes ?? 0
  return CHUNK_PRESETS.find((preset) => preset.chunkBytes === bytes)?.id ?? ''
})

/** 当前编码的说明文案 */
const encodingHint = computed(() => {
  const value = draft.value?.transfer.encoding ?? 'hex'
  return TRANSFER_ENCODING_OPTIONS.find((option) => option.value === value)?.description ?? ''
})

/**
 * @description 应用片大小预设；预设同时决定片大小与帧长上限（两者必须配套）
 * @param id 预设 id
 */
function applyChunkPreset(id: string): void {
  const preset = CHUNK_PRESETS.find((item) => item.id === id)
  if (!preset || !draft.value) return
  draft.value.transfer.chunkBytes = preset.chunkBytes
  draft.value.transfer.maxFrameChars = preset.maxFrameChars
}

/** @description 把接收脚本导出到用户选择的位置 */
async function exportTools(): Promise<void> {
  try {
    const destination = await window.api.transfer.exportTools()
    if (destination) ElMessage.success(`已导出到 ${destination}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

/** @description 在文件管理器里打开随包分发的接收脚本目录 */
async function revealTools(): Promise<void> {
  try {
    await window.api.transfer.revealTools()
  } catch (err) {
    typing.log('error', err instanceof Error ? err.message : String(err))
    ElMessage.error('找不到脚本目录：可能是安装包缺少 resources/tools')
  }
}

/**
 * 草稿最近一次与设置对齐时的内容快照。
 * 用它（而不是实时设置）判断"用户改过没有"：设置可能被别处改掉（文件面板会直接更新 transfer），
 * 拿草稿跟实时设置比会把外部改动误判成"用户有未保存改动"。
 */
const syncedDraft = ref('')

/** @description 把草稿与当前设置对齐（挂载、保存后、放弃改动、恢复默认、被缓存后回到前台） */
function syncDraft(): void {
  const next = settings.value ? structuredClone(toPlainPayload(settings.value)) : null
  draft.value = next
  syncedDraft.value = next ? JSON.stringify(toPlainPayload(next)) : ''
}

/** 用户是否改过草稿；有改动才允许保存/放弃 */
const dirty = computed(() => {
  if (!draft.value) return false
  return JSON.stringify(toPlainPayload(draft.value)) !== syncedDraft.value
})

/** @description 首次进入时读取设置并把草稿对齐到最新值 */
onMounted(async () => {
  await load()
  syncDraft()
})

/** @description 页面被缓存后回到前台：无改动则跟上别处对设置的改动，有改动则原样保留 */
onActivated(() => {
  if (dirty.value) return
  syncDraft()
})

/**
 * @description 给主进程返回的失败原因补上统一前缀（避免重复拼接）
 * @param message 主进程给出的原因
 * @returns 可直接展示的错误文案
 */
function describeFailure(message: string | undefined): string {
  const text = (message ?? '').trim() || '未知原因'
  return text.includes('设置保存失败') ? text : `设置保存失败：${text}`
}

/** @description 提交草稿；失败时保留草稿并提示原因，成功后按主进程归一化的值回填 */
async function save(): Promise<void> {
  if (!draft.value) return
  saving.value = true
  saveError.value = ''
  try {
    const result = await update(toPlainPayload(draft.value))
    if (!result.ok) {
      saveError.value = describeFailure(result.error)
      ElMessage.error(saveError.value)
      return
    }
    if (settings.value) syncDraft()
    ElMessage.success('设置已保存')
  } finally {
    saving.value = false
  }
}

/** @description 放弃未保存的改动，草稿回到当前设置 */
function discard(): void {
  syncDraft()
  saveError.value = ''
}

/** @description 恢复默认设置并用主进程归一化后的值重建草稿 */
async function restoreDefaults(): Promise<void> {
  restoring.value = true
  saveError.value = ''
  try {
    const result = await reset()
    if (!result.ok) {
      saveError.value = describeFailure(result.error)
      ElMessage.error(saveError.value)
      return
    }
    syncDraft()
    ElMessage.success('已恢复默认设置')
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <h1>设置</h1>
      <p class="page-desc">
        调整输入节奏、随机性与焦点行为。设置保存在
        <code>%APPDATA%\Typer\settings.json</code>，写入是原子的，损坏时会自动回退默认值。
      </p>
    </header>

    <ElAlert
      v-if="error"
      type="error"
      :closable="false"
      show-icon
      title="设置读取失败"
      :description="error"
    />

    <template v-if="draft">
      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-play-circle-outline" /> 启动与模式</h2>

        <div class="row">
          <div class="label">
            <span>倒计时</span>
            <small>点击开始后等待多久才真正输入，留出切换窗口的时间</small>
          </div>
          <ElInputNumber v-model="draft.startDelayMs" :min="0" :max="60000" :step="500" />
          <span class="unit">毫秒</span>
        </div>

        <div class="row">
          <div class="label">
            <span>输入方式</span>
            <small>逐字模拟按键最接近真人；超长文本与不认 Unicode 的程序可用粘贴</small>
          </div>
          <ElSelect v-model="draft.insertMode" class="control">
            <ElOption label="逐字模拟按键" value="keystroke" />
            <ElOption label="剪贴板粘贴" value="paste" />
            <ElOption label="自动（长文本用粘贴）" value="auto" />
          </ElSelect>
        </div>

        <div v-if="draft.insertMode !== 'keystroke'" class="row">
          <div class="label">
            <span>自动粘贴阈值</span>
            <small>自动模式下，超过该字符数就改用粘贴</small>
          </div>
          <ElInputNumber v-model="draft.autoPasteThreshold" :min="100" :max="100000" :step="100" />
          <span class="unit">字符</span>
        </div>

        <div class="row">
          <div class="label">
            <span>每批动作数</span>
            <small>值越小，紧急停止的响应越快，但下发开销略增</small>
          </div>
          <ElInputNumber v-model="draft.chunkSize" :min="1" :max="64" />
          <span class="unit">个</span>
        </div>

        <div class="row">
          <div class="label">
            <span>随机种子</span>
            <small>0 表示每次运行都不同；填固定值可复现同一套节奏</small>
          </div>
          <ElInputNumber v-model="draft.seed" :min="0" :max="4294967295" />
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-speedometer" /> 速度与随机性</h2>

        <div class="row">
          <div class="label">
            <span>速度模式</span>
            <small>按字符、按词，或直接指定每两个动作之间的间隔</small>
          </div>
          <ElSegmented
            v-model="draft.timing.speedMode"
            :options="[
              { label: '字符/秒', value: 'cps' },
              { label: '词/分钟', value: 'wpm' },
              { label: '固定间隔', value: 'interval' }
            ]"
          />
        </div>

        <div v-if="draft.timing.speedMode === 'cps'" class="row">
          <div class="label"><span>字符/秒</span></div>
          <ElSlider v-model="draft.timing.cps" :min="0.5" :max="50" :step="0.5" class="control" />
          <span class="value mono">{{ draft.timing.cps }}</span>
        </div>

        <div v-if="draft.timing.speedMode === 'wpm'" class="row">
          <div class="label"><span>词/分钟</span></div>
          <ElSlider v-model="draft.timing.wpm" :min="10" :max="1000" :step="10" class="control" />
          <span class="value mono">{{ draft.timing.wpm }}</span>
        </div>

        <div v-if="draft.timing.speedMode === 'interval'" class="row">
          <div class="label"><span>固定间隔</span></div>
          <ElInputNumber v-model="draft.timing.baseIntervalMs" :min="1" :max="2000" />
          <span class="unit">毫秒</span>
        </div>

        <div class="row">
          <div class="label">
            <span>抖动幅度</span>
            <small>在基础间隔上附加的随机浮动，让节奏不像机器</small>
          </div>
          <ElSlider v-model="draft.timing.jitterMs" :min="0" :max="500" class="control" />
          <span class="value mono">±{{ draft.timing.jitterMs }}ms</span>
        </div>

        <div class="row">
          <div class="label"><span>抖动分布</span></div>
          <ElSegmented
            v-model="draft.timing.distribution"
            :options="[
              { label: '正态（更自然）', value: 'gaussian' },
              { label: '均匀', value: 'uniform' }
            ]"
          />
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-timer-sand" /> 停顿节奏</h2>
        <p class="group-desc">让输入在标点、换行处自然停顿，避免"一口气打完"的机械感。</p>

        <div class="row">
          <div class="label"><span>标点后</span></div>
          <ElInputNumber v-model="draft.timing.punctuationPauseMs" :min="0" :max="2000" />
          <span class="unit">毫秒</span>
        </div>
        <div class="row">
          <div class="label"><span>空格后</span></div>
          <ElInputNumber v-model="draft.timing.wordPauseMs" :min="0" :max="1000" />
          <span class="unit">毫秒</span>
        </div>
        <div class="row">
          <div class="label"><span>换行后</span></div>
          <ElInputNumber v-model="draft.timing.newlinePauseMs" :min="0" :max="5000" />
          <span class="unit">毫秒</span>
        </div>
        <div class="row">
          <div class="label"><span>空行后</span></div>
          <ElInputNumber v-model="draft.timing.paragraphPauseMs" :min="0" :max="5000" />
          <span class="unit">毫秒</span>
        </div>
        <div class="row">
          <div class="label">
            <span>周期性休息</span>
            <small>每输入 N 个字符停顿一次；0 表示关闭</small>
          </div>
          <ElInputNumber v-model="draft.timing.burstSize" :min="0" :max="1000" />
          <span class="unit">字符后休息</span>
          <ElInputNumber v-model="draft.timing.burstPauseMs" :min="0" :max="10000" :step="100" />
          <span class="unit">毫秒</span>
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-backspace-outline" /> 错字与纠正</h2>
        <p class="group-desc">按概率打错再退格纠正，让输入过程更像真人；设为 0 即完全无误。</p>

        <div class="row">
          <div class="label"><span>错字概率</span></div>
          <ElSlider v-model="draft.typo.rate" :min="0" :max="0.2" :step="0.005" class="control" />
          <span class="value mono">{{ (draft.typo.rate * 100).toFixed(1) }}%</span>
        </div>
        <div class="row">
          <div class="label"><span>错字方式</span></div>
          <ElSelect v-model="draft.typo.style" class="control">
            <ElOption label="相邻键位" value="adjacent" />
            <ElOption label="形近字" value="lookalike" />
            <ElOption label="相邻字符颠倒" value="transpose" />
          </ElSelect>
        </div>
        <div class="row">
          <div class="label">
            <span>自动纠正</span>
            <small>开启后会补上退格与正确字符</small>
          </div>
          <ElSwitch v-model="draft.typo.correction" active-value="auto" inactive-value="none" />
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-keyboard-settings-outline" /> 键盘布局</h2>
        <p class="group-desc">
          真实按键由<strong>目标窗口的布局</strong>解释。不确定目标布局时，直接开"全部用 Unicode
          注入"最稳。
        </p>

        <div class="row">
          <div class="label"><span>目标窗口布局</span></div>
          <ElSelect v-model="draft.keyboard.layout" class="control">
            <ElOption label="English (US)" value="us" />
            <ElOption label="English (UK)" value="uk" />
            <ElOption label="Deutsch" value="de" />
            <ElOption label="Français" value="fr" />
            <ElOption label="Español" value="es" />
          </ElSelect>
        </div>
        <div class="row">
          <div class="label">
            <span>全部用 Unicode 注入</span>
            <small>与布局无关，绕过物理键位映射</small>
          </div>
          <ElSwitch v-model="draft.keyboard.forceUnicodeForAll" />
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-target-account" /> 焦点与热键</h2>
        <p class="group-desc">
          输入过程中若前台窗口变了，可能把字打到别的程序上；焦点守护用来兜底。
        </p>

        <div class="row">
          <div class="label"><span>焦点守护</span></div>
          <ElSegmented
            v-model="draft.focusGuard"
            :options="[
              { label: '关闭', value: 'off' },
              { label: '仅提示', value: 'warn' },
              { label: '严格（变化即中止）', value: 'strict' }
            ]"
          />
        </div>
        <div class="row">
          <div class="label">
            <span>紧急停止热键</span>
            <small>全局热键，焦点在别的窗口时也能中断</small>
          </div>
          <ElInput v-model="draft.hotkeys.stop" class="control" />
        </div>
        <div class="row">
          <div class="label"><span>暂停/继续热键</span></div>
          <ElInput v-model="draft.hotkeys.togglePause" class="control" />
        </div>
        <div class="row">
          <div class="label">
            <span>完成后检测粘键</span>
            <small>输入结束自检是否残留按下状态的修饰键</small>
          </div>
          <ElSwitch v-model="draft.verifyStuckKeys" />
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-shield-lock-outline" /> 隐私与剪贴板</h2>

        <div class="row">
          <div class="label">
            <span>保存输入内容到磁盘</span>
            <small>默认关闭：内容只在内存里处理</small>
          </div>
          <ElSwitch v-model="draft.privacy.persistContent" />
        </div>
        <div class="row">
          <div class="label"><span>保存设置到磁盘</span></div>
          <ElSwitch v-model="draft.privacy.persistSettings" />
        </div>
        <div class="row">
          <div class="label">
            <span>粘贴后恢复剪贴板</span>
            <small>粘贴模式会临时改写剪贴板，结束后还原原内容</small>
          </div>
          <ElSwitch v-model="draft.clipboard.restore" />
        </div>
        <div class="row">
          <div class="label"><span>导入文件编码</span></div>
          <ElSelect v-model="draft.clipboard.importCharset" class="control">
            <ElOption label="自动识别" value="auto" />
            <ElOption label="UTF-8" value="utf8" />
            <ElOption label="UTF-16 LE" value="utf16le" />
            <ElOption label="GBK / GB18030" value="gbk" />
          </ElSelect>
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-file-arrow-up-down-outline" /> 文件传输</h2>
        <p class="group-desc">
          把文件切成"每片一行"的帧逐片输入。接收端逐片校验、支持断点续传，合并后再校验整文件哈希；
          编码与片大小决定"能不能顺利穿过目标终端"。
        </p>

        <div class="row">
          <div class="label">
            <span>默认编码</span>
            <small>{{ encodingHint }}</small>
          </div>
          <ElSelect v-model="draft.transfer.encoding" class="control">
            <ElOption
              v-for="option in TRANSFER_ENCODING_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </ElSelect>
        </div>

        <div class="row">
          <div class="label">
            <span>片大小</span>
            <small>每片原始字节数；hex 编码下帧长约 2 倍字节数</small>
          </div>
          <ElSelect
            :model-value="presetId"
            class="control"
            @change="applyChunkPreset($event as string)"
          >
            <ElOption
              v-for="preset in CHUNK_PRESETS"
              :key="preset.id"
              :label="`${preset.label} · ${formatBytes(preset.chunkBytes)}`"
              :value="preset.id"
            />
          </ElSelect>
        </div>

        <div class="row">
          <div class="label">
            <span>单帧字符上限</span>
            <small>超出会拒绝开始：终端与剪贴板都会截断过长的行</small>
          </div>
          <ElInputNumber
            v-model="draft.transfer.maxFrameChars"
            class="control"
            :min="limits.maxFrameChars[0]"
            :max="limits.maxFrameChars[1]"
            :step="1024"
          />
        </div>

        <div class="row">
          <div class="label">
            <span>片间断顿</span>
            <small>给接收端落盘与回显留时间；越小越快，但更容易丢字符</small>
          </div>
          <ElInputNumber
            v-model="draft.transfer.interFrameDelayMs"
            class="control"
            :min="limits.interFrameDelayMs[0]"
            :max="limits.interFrameDelayMs[1]"
            :step="50"
          />
        </div>

        <div class="row">
          <div class="label">
            <span>粘贴整帧含换行</span>
            <small>开启时一行帧一次粘贴即完成（少一次按键）</small>
          </div>
          <ElSwitch v-model="draft.transfer.pasteFrameIncludesNewline" />
        </div>

        <div class="row">
          <div class="label">
            <span>接收脚本</span>
            <small>零依赖（Node ≥ 18），导出到目标机直接运行</small>
          </div>
          <div class="tools-actions">
            <ElButton size="small" @click="exportTools">
              <span class="i-mdi-export-variant" /> 导出脚本
            </ElButton>
            <ElButton size="small" text @click="revealTools">
              <span class="i-mdi-folder-open-outline" /> 打开目录
            </ElButton>
          </div>
        </div>
      </section>

      <section class="card group">
        <h2 class="group-title"><span class="icon i-mdi-cloud-download-outline" /> 更新</h2>

        <div class="row">
          <div class="label">
            <span>启动时检查更新</span>
            <small>只访问 GitHub 公开接口读取最新发布，不会上传任何本地信息</small>
          </div>
          <ElSwitch v-model="draft.update.checkOnStartup" />
        </div>
        <p class="group-desc">
          也可以随时在 <RouterLink to="/about">关于</RouterLink> 页手动检查并安装新版本。
        </p>
      </section>
    </template>

    <!-- 保存条：粘在底部，改动状态一目了然 -->
    <div class="savebar">
      <span v-if="saveError" class="error">
        <span class="i-mdi-alert-circle-outline" />
        {{ saveError }}
      </span>
      <span v-else-if="dirty" class="hint">
        <span class="i-mdi-circle-medium" />
        有未保存的改动
      </span>
      <span v-else class="hint muted">所有改动已保存</span>

      <div class="spacer" />

      <ElButton :loading="restoring" @click="restoreDefaults()">恢复默认</ElButton>
      <ElButton :disabled="!dirty || saving" @click="discard()">放弃改动</ElButton>
      <ElButton type="primary" :disabled="!dirty" :loading="saving" @click="save()">保存</ElButton>
    </div>
  </section>
</template>

<style scoped lang="scss">
.tools-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.group {
  gap: 4px;

  & + .group {
    margin-top: 4px;
  }
}

.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;

  .icon {
    font-size: 17px;
    color: var(--accent);
  }
}

.group-desc {
  margin-bottom: 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);

  strong {
    font-weight: 600;
    color: var(--text-1);
  }
}

/* Fluent 的设置行：左侧标题 + 说明，右侧控件 */
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 0;
  min-height: 56px;

  & + .row {
    border-top: 1px solid var(--stroke);
  }
}

.label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;

  span {
    font-size: 13px;
    color: var(--text-1);
  }

  small {
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-3);
  }
}

.control {
  flex: 0 1 320px;
  min-width: 200px;
}

.unit {
  flex: none;
  font-size: 12px;
  color: var(--text-3);
}

.value {
  flex: none;
  width: 64px;
  font-size: 12px;
  color: var(--text-2);
  text-align: right;
}

/* 保存条吸底：设置页很长，操作不能不看到 */
.savebar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px -24px -28px;
  padding: 14px 24px;
  border-top: 1px solid var(--stroke);
  background: var(--acrylic);
  backdrop-filter: blur(30px) saturate(140%);
}

.hint,
.error {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.hint {
  color: var(--accent);
}

.error {
  color: var(--danger);
  word-break: break-all;
}

@media (max-width: 860px) {
  .row {
    flex-wrap: wrap;

    .label {
      flex-basis: 100%;
    }
  }

  .control {
    flex: 1 1 auto;
  }
}
</style>
