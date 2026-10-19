<script setup lang="ts" vapor>
import { toPlainPayload } from '@main/ipc/plainPayload'
import type { Settings } from '@main/settings/types'
import { PROFILE_LIMITS } from '@main/typing/scheduling/profile'
import {
  CHUNK_PRESETS,
  TRANSFER_ALPHABET_OPTIONS,
  TRANSFER_LIMITS,
  TRANSFER_MODE_OPTIONS,
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
/** 字符档 / 目标端的可选项（供模板渲染） */
const alphabetOptions = TRANSFER_ALPHABET_OPTIONS
const modeOptions = TRANSFER_MODE_OPTIONS
const typing = useTyping()

/** 主题设置即时生效，不进设置草稿 */
const { isDark, followSystem, setDark, setFollowSystem } = useTheme()

/**
 * @description 阻止锚点链接的默认 hash 跳转：路由是 hash 模式，交给浏览器会把路由切走
 * @param event 锚点链接的点击事件
 */
function onAnchorClick(event: MouseEvent): void {
  event.preventDefault()
}

/** 当前档位的能力表：字符/秒与每批动作数的可选区间随档位变化 */
const profileLimits = computed(() => {
  const profile = draft.value?.injection.profile ?? 'normal'
  return PROFILE_LIMITS[profile]
})

/** 速度模式的可选项：只有极速档才有"不限速" */
const speedModeOptions = computed(() => {
  const options = [
    { label: '字符/秒', value: 'cps' },
    { label: '词/分钟', value: 'wpm' },
    { label: '固定间隔', value: 'interval' }
  ]
  if (draft.value?.injection.profile === 'turbo') {
    options.push({ label: '不限速', value: 'max' })
  }
  return options
})

/**
 * @description 切换注入档位；退回标准档时把"不限速"收回成字符/秒，并把越界的数值夹回区间
 * @param profile 目标档位
 */
function applyProfile(profile: 'normal' | 'turbo'): void {
  if (!draft.value) return
  draft.value.injection.profile = profile
  if (profile !== 'turbo' && draft.value.timing.speedMode === 'max') {
    draft.value.timing.speedMode = 'cps'
  }
  const bounds = PROFILE_LIMITS[profile]
  // 极速档按批下发，批次越大来回越少；切到极速时把过小的批提升到能体现速度的量级
  const target = profile === 'turbo' ? Math.max(128, draft.value.chunkSize) : draft.value.chunkSize
  draft.value.chunkSize = Math.min(bounds.chunkSize[1], Math.max(bounds.chunkSize[0], target))
  draft.value.timing.cps = Math.min(bounds.cps[1], Math.max(bounds.cps[0], draft.value.timing.cps))
}

/** 当前片大小对应的预设（不在预设里则归为"自定义"） */
const presetId = computed(() => {
  const bytes = draft.value?.transfer.chunkBytes ?? 0
  return CHUNK_PRESETS.find((preset) => preset.chunkBytes === bytes)?.id ?? ''
})

/** 当前符号表的说明文案 */
const alphabetHint = computed(() => {
  const value = draft.value?.transfer.alphabet ?? 'ascii32'
  return TRANSFER_ALPHABET_OPTIONS.find((option) => option.value === value)?.description ?? ''
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
    if (destination) ElMessage.success(`已导出到 ${destination}（双击 run.bat 即可运行接收端）`)
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
        按「通用 / 文本输入 / 文件输入」分组：通用对所有输入方式生效，后两组只描述各自输入方式的
        设置。设置保存在
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

    <div class="settings-layout">
      <div class="settings-main">
        <h2 id="cat-common" class="category">通用</h2>

        <section id="g-appearance" class="card group">
          <h2 class="group-title"><span class="icon i-mdi-theme-light-dark" /><span>外观</span></h2>

          <div class="row">
            <div class="label">
              <div>跟随系统</div>
              <small>开启后随 Windows 的亮暗设置自动切换</small>
            </div>
            <ElSwitch :model-value="followSystem" @change="setFollowSystem($event as boolean)" />
          </div>

          <div class="row">
            <div class="label">
              <div>主题色</div>
              <small>亮色或暗色；手动选择后自动停止跟随系统</small>
            </div>
            <ElSegmented
              :model-value="isDark ? 'dark' : 'light'"
              :options="[
                { label: '亮色', value: 'light' },
                { label: '暗色', value: 'dark' }
              ]"
              @change="void setDark(($event as string) === 'dark')"
            />
          </div>
        </section>

        <template v-if="draft">
          <section id="g-start" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-play-circle-outline" /><span>启动与批次</span>
            </h2>

            <div class="row">
              <div class="label">
                <div>倒计时</div>
                <small>点击开始或继续后等待多久才真正输入，留出切换窗口的时间</small>
              </div>
              <ElInputNumber v-model="draft.startDelayMs" :min="0" :max="60000" :step="500" />
              <div class="unit">毫秒</div>
            </div>

            <div class="row">
              <div class="label">
                <div>注入档位</div>
                <small>
                  标准：逐字下发，节奏与停止最灵敏；极速：攒批下发并放开每字符 1ms 下限，
                  实际速度由目标窗口的消化能力决定
                </small>
              </div>
              <ElSegmented
                :model-value="draft.injection.profile"
                :options="[
                  { label: '标准', value: 'normal' },
                  { label: '极速', value: 'turbo' }
                ]"
                @change="applyProfile($event as 'normal' | 'turbo')"
              />
            </div>

            <div class="row">
              <div class="label">
                <div>每批动作数</div>
                <small
                  >值越大下发开销越小；暂停与停止都在「修饰键 + 主键」这个动作组的边界生效，
                  不会把一组拆开（因此最多多打一个字符）</small
                >
              </div>
              <ElInputNumber
                v-model="draft.chunkSize"
                :min="profileLimits.chunkSize[0]"
                :max="profileLimits.chunkSize[1]"
              />
              <div class="unit">个</div>
            </div>
          </section>

          <section id="g-focus" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-target-account" /><span>焦点与热键</span>
            </h2>
            <p class="group-desc">
              输入过程中若前台窗口变了，可能把字打到别的程序上；焦点守护用来兜底。
            </p>

            <div class="row">
              <div class="label"><div>焦点守护</div></div>
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
                <div>紧急停止热键</div>
                <small>全局热键，焦点在别的窗口时也能中断</small>
              </div>
              <ElInput v-model="draft.hotkeys.stop" class="control" />
            </div>
            <div class="row">
              <div class="label"><div>暂停/继续热键</div></div>
              <ElInput v-model="draft.hotkeys.togglePause" class="control" />
            </div>
            <div class="row">
              <div class="label">
                <div>完成后检测粘键</div>
                <small>输入结束自检是否残留按下状态的修饰键</small>
              </div>
              <ElSwitch v-model="draft.verifyStuckKeys" />
            </div>
          </section>

          <section id="g-privacy" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-shield-lock-outline" /><span>隐私</span>
            </h2>

            <div class="row">
              <div class="label">
                <div>保存输入内容到磁盘</div>
                <small>默认关闭：内容只在内存里处理</small>
              </div>
              <ElSwitch v-model="draft.privacy.persistContent" />
            </div>
            <div class="row">
              <div class="label"><div>保存设置到磁盘</div></div>
              <ElSwitch v-model="draft.privacy.persistSettings" />
            </div>
          </section>

          <section id="g-update" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-cloud-download-outline" /><span>更新</span>
            </h2>

            <div class="row">
              <div class="label">
                <div>启动时检查更新</div>
                <small>只访问 GitHub 公开接口读取最新发布，不会上传任何本地信息</small>
              </div>
              <ElSwitch v-model="draft.update.checkOnStartup" />
            </div>
            <p class="group-desc">
              也可以随时在 <RouterLink to="/about">关于</RouterLink> 页手动检查并安装新版本。
            </p>
          </section>

          <h2 id="cat-text" class="category">文本输入</h2>

          <section id="g-pace" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-speedometer" /><span>节奏与随机性</span>
            </h2>
            <p class="group-desc">控制逐字输入的节奏与自然感，让输出不像机器。</p>

            <div class="row">
              <div class="label">
                <div>随机种子</div>
                <small>0 表示每次运行都不同；填固定值可复现同一套节奏</small>
              </div>
              <ElInputNumber v-model="draft.seed" :min="0" :max="4294967295" />
            </div>

            <div class="row">
              <div class="label">
                <div>速度模式</div>
                <small>按字符、按词、直接指定每两个动作之间的间隔，或在极速档下不限速</small>
              </div>
              <ElSegmented v-model="draft.timing.speedMode" :options="speedModeOptions" />
            </div>

            <div v-if="draft.timing.speedMode === 'cps'" class="row">
              <div class="label"><div>字符/秒</div></div>
              <ElSlider
                v-model="draft.timing.cps"
                :min="profileLimits.cps[0]"
                :max="profileLimits.cps[1]"
                :step="0.5"
                class="control"
              />
              <div class="value mono">{{ draft.timing.cps }}</div>
            </div>

            <div v-if="draft.timing.speedMode === 'wpm'" class="row">
              <div class="label"><div>词/分钟</div></div>
              <ElSlider
                v-model="draft.timing.wpm"
                :min="10"
                :max="1000"
                :step="10"
                class="control"
              />
              <div class="value mono">{{ draft.timing.wpm }}</div>
            </div>

            <div v-if="draft.timing.speedMode === 'interval'" class="row">
              <div class="label"><div>固定间隔</div></div>
              <ElInputNumber v-model="draft.timing.baseIntervalMs" :min="1" :max="2000" />
              <div class="unit">毫秒</div>
            </div>

            <div class="row">
              <div class="label">
                <div>抖动幅度</div>
                <small>在基础间隔上附加的随机浮动，让节奏不像机器</small>
              </div>
              <ElSlider v-model="draft.timing.jitterMs" :min="0" :max="500" class="control" />
              <div class="value mono">±{{ draft.timing.jitterMs }}ms</div>
            </div>

            <div class="row">
              <div class="label"><div>抖动分布</div></div>
              <ElSegmented
                v-model="draft.timing.distribution"
                :options="[
                  { label: '正态（更自然）', value: 'gaussian' },
                  { label: '均匀', value: 'uniform' }
                ]"
              />
            </div>
          </section>

          <section id="g-pause" class="card group">
            <h2 class="group-title"><span class="icon i-mdi-timer-sand" /><span>停顿节奏</span></h2>
            <p class="group-desc">让输入在标点、换行处自然停顿，避免"一口气打完"的机械感。</p>

            <div class="row">
              <div class="label"><div>标点后</div></div>
              <ElInputNumber v-model="draft.timing.punctuationPauseMs" :min="0" :max="2000" />
              <div class="unit">毫秒</div>
            </div>
            <div class="row">
              <div class="label"><div>空格后</div></div>
              <ElInputNumber v-model="draft.timing.wordPauseMs" :min="0" :max="1000" />
              <div class="unit">毫秒</div>
            </div>
            <div class="row">
              <div class="label"><div>换行后</div></div>
              <ElInputNumber v-model="draft.timing.newlinePauseMs" :min="0" :max="5000" />
              <div class="unit">毫秒</div>
            </div>
            <div class="row">
              <div class="label"><div>空行后</div></div>
              <ElInputNumber v-model="draft.timing.paragraphPauseMs" :min="0" :max="5000" />
              <div class="unit">毫秒</div>
            </div>
            <div class="row">
              <div class="label">
                <div>周期性休息</div>
                <small>每输入 N 个字符停顿一次；0 表示关闭</small>
              </div>
              <ElInputNumber v-model="draft.timing.burstSize" :min="0" :max="1000" />
              <div class="unit">字符后休息</div>
              <ElInputNumber
                v-model="draft.timing.burstPauseMs"
                :min="0"
                :max="10000"
                :step="100"
              />
              <div class="unit">毫秒</div>
            </div>
          </section>

          <section id="g-typo" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-backspace-outline" /><span>错字与纠正</span>
            </h2>
            <p class="group-desc">按概率打错再退格纠正，让输入过程更像真人；设为 0 即完全无误。</p>

            <div class="row">
              <div class="label"><div>错字概率</div></div>
              <ElSlider
                v-model="draft.typo.rate"
                :min="0"
                :max="0.2"
                :step="0.005"
                class="control"
              />
              <div class="value mono">{{ (draft.typo.rate * 100).toFixed(1) }}%</div>
            </div>
            <div class="row">
              <div class="label"><div>错字方式</div></div>
              <ElSelect v-model="draft.typo.style" class="control">
                <ElOption label="相邻键位" value="adjacent" />
                <ElOption label="形近字" value="lookalike" />
                <ElOption label="相邻字符颠倒" value="transpose" />
              </ElSelect>
            </div>
            <div class="row">
              <div class="label">
                <div>自动纠正</div>
                <small>开启后会补上退格与正确字符</small>
              </div>
              <ElSwitch v-model="draft.typo.correction" active-value="auto" inactive-value="none" />
            </div>
          </section>

          <section id="g-keyboard" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-keyboard-settings-outline" /><span>键盘布局</span>
            </h2>
            <p class="group-desc">
              真实按键由<strong>目标窗口的布局</strong>解释；布局里没有收录的字符会在开始前报错。
            </p>

            <div class="row">
              <div class="label"><div>目标窗口布局</div></div>
              <ElSelect v-model="draft.keyboard.layout" class="control">
                <ElOption label="English (US)" value="us" />
                <ElOption label="English (UK)" value="uk" />
                <ElOption label="Deutsch" value="de" />
                <ElOption label="Français" value="fr" />
                <ElOption label="Español" value="es" />
              </ElSelect>
            </div>
          </section>

          <section id="g-import" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-file-import-outline" /><span>文本导入</span>
            </h2>
            <p class="group-desc">
              「导入文本」把磁盘上的文件装进输入框时使用的编码。它只影响读文件时的解码：
              中文等没有物理键位的字符依然无法输入，会在开始前被列出来。
            </p>

            <div class="row">
              <div class="label"><div>导入文件编码</div></div>
              <ElSelect v-model="draft.files.importCharset" class="control">
                <ElOption label="自动识别" value="auto" />
                <ElOption label="UTF-8" value="utf8" />
                <ElOption label="UTF-16 LE" value="utf16le" />
                <ElOption label="GBK / GB18030" value="gbk" />
              </ElSelect>
            </div>
          </section>

          <h2 id="cat-file" class="category">文件输入</h2>

          <section id="g-transfer" class="card group">
            <h2 class="group-title">
              <span class="icon i-mdi-file-arrow-up-down-outline" /><span>文件传输</span>
            </h2>
            <p class="group-desc">
              把文件切成"每片一行"的帧逐片输入。接收端逐片校验、支持断点续传，合并后再校验整文件哈希；
              字符档决定"一个字符能带多少比特"，压缩决定"要带多少字节"。远程桌面只转发真实键盘事件，
              因此默认用零 Shift 的 5 位档。
            </p>

            <div class="row">
              <div class="label">
                <div>字符档</div>
                <small>{{ alphabetHint }}</small>
              </div>
              <ElSelect v-model="draft.transfer.alphabet" class="control">
                <ElOption
                  v-for="option in alphabetOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </ElSelect>
            </div>

            <div class="row">
              <div class="label">
                <div>压缩</div>
                <small>
                  自动：先采样试压，几乎压不动（已压缩的图片/视频/ZIP）就直接发原字节，省掉准备时间；
                  强制压缩适合"确定能压但样本没体现出来"的情况
                </small>
              </div>
              <ElSegmented
                v-model="draft.transfer.compression"
                :options="[
                  { label: '自动', value: 'auto' },
                  { label: '压缩', value: 'br' },
                  { label: '不压缩', value: 'none' }
                ]"
              />
            </div>

            <div class="row">
              <div class="label">
                <div>压缩等级</div>
                <small>Brotli 质量：9 是速度与压缩率的平衡点；10~11 更小但准备时间成倍增长</small>
              </div>
              <ElInputNumber
                v-model="draft.transfer.quality"
                :min="limits.quality[0]"
                :max="limits.quality[1]"
              />
            </div>

            <div class="row">
              <div class="label">
                <div>目标端</div>
                <small
                  >决定换行方式：终端用 CR
                  报文（最快、关回显）、编辑器用真回车、单行框不加换行</small
                >
              </div>
              <ElSelect v-model="draft.transfer.mode" class="control">
                <ElOption
                  v-for="mode in modeOptions"
                  :key="mode.value"
                  :label="mode.label"
                  :value="mode.value"
                />
              </ElSelect>
            </div>

            <div class="row">
              <div class="label">
                <div>传输节奏</div>
                <small>
                  稳健：逐字符 + 1ms 间隔（最不容易丢）；快速：逐字符无停顿；极速：零间隔，
                  由压力阀按目标端消化能力自适应。三档都逐动作投递，极速只是不再等那 1ms
                </small>
              </div>
              <ElSegmented
                v-model="draft.transfer.paceMode"
                :options="[
                  { label: '稳健', value: 'safe' },
                  { label: '快速', value: 'fast' },
                  { label: '极速', value: 'turbo' }
                ]"
              />
            </div>

            <div class="row">
              <div class="label">
                <div>片大小</div>
                <small>每片线上字节数；片越大帧越长，重传成本也越高</small>
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
                <div>单帧字符上限</div>
                <small>超出会拒绝开始：终端与剪贴板都会截断过长的行</small>
              </div>
              <ElInputNumber
                v-model="draft.transfer.maxFrameChars"
                :min="limits.maxFrameChars[0]"
                :max="limits.maxFrameChars[1]"
                :step="1024"
              />
            </div>

            <div class="row">
              <div class="label">
                <div>片间断顿</div>
                <small>给接收端落盘与回显留时间；极速节奏档下固定为 0，这里只对稳健档生效</small>
              </div>
              <ElInputNumber
                v-model="draft.transfer.interFrameDelayMs"
                :min="limits.interFrameDelayMs[0]"
                :max="limits.interFrameDelayMs[1]"
                :step="50"
              />
            </div>

            <div class="row">
              <div class="label">
                <div>接收脚本</div>
                <small>零依赖（Node ≥ 16）；导出后双击同目录 run.bat 即可运行</small>
              </div>
              <div class="tools-actions">
                <ElButton size="small" @click="exportTools">
                  <span class="i-mdi-export-variant" /><span>导出脚本</span>
                </ElButton>
                <ElButton size="small" text @click="revealTools">
                  <span class="i-mdi-folder-open-outline" /><span>打开目录</span>
                </ElButton>
              </div>
            </div>
          </section>
        </template>
      </div>

      <!--
        目录锚点：父级是分类标题，子级是各设置组（层级与页面标题一致）。
        子链接必须放在 sub-link 插槽里——默认插槽是"替换标题文字"的，
        放进去会变成 <a> 嵌套 <a>，点击还会冒泡回父级、跳到分类标题。
      -->
      <ElAnchor
        class="settings-anchor"
        container="main.main"
        :offset="16"
        :bound="64"
        select-scroll-top
        direction="vertical"
        type="default"
        @click="onAnchorClick"
      >
        <ElAnchorLink href="#cat-common" title="通用">
          <template #sub-link>
            <ElAnchorLink href="#g-appearance" title="外观" />
            <ElAnchorLink href="#g-start" title="启动与批次" />
            <ElAnchorLink href="#g-focus" title="焦点与热键" />
            <ElAnchorLink href="#g-privacy" title="隐私" />
            <ElAnchorLink href="#g-update" title="更新" />
          </template>
        </ElAnchorLink>
        <ElAnchorLink href="#cat-text" title="文本输入">
          <template #sub-link>
            <ElAnchorLink href="#g-pace" title="节奏与随机性" />
            <ElAnchorLink href="#g-pause" title="停顿节奏" />
            <ElAnchorLink href="#g-typo" title="错字与纠正" />
            <ElAnchorLink href="#g-keyboard" title="键盘布局" />
            <ElAnchorLink href="#g-import" title="文本导入" />
          </template>
        </ElAnchorLink>
        <ElAnchorLink href="#cat-file" title="文件输入">
          <template #sub-link>
            <ElAnchorLink href="#g-transfer" title="文件传输" />
          </template>
        </ElAnchorLink>
      </ElAnchor>
    </div>

    <!-- 保存条：粘在底部，改动状态一目了然 -->
    <div class="savebar">
      <div v-if="saveError" class="error">
        <div class="i-mdi-alert-circle-outline" />
        <div>{{ saveError }}</div>
      </div>
      <div v-else-if="dirty" class="hint">
        <div class="i-mdi-circle-medium" />
        <div>有未保存的改动</div>
      </div>
      <div v-else class="hint muted"><div>所有改动已保存</div></div>

      <div class="spacer" />

      <ElButton :loading="restoring" @click="restoreDefaults()"><span>恢复默认</span></ElButton>
      <ElButton :disabled="!dirty || saving" @click="discard()"><span>放弃改动</span></ElButton>
      <ElButton type="primary" :disabled="!dirty" :loading="saving" @click="save()"
        ><span>保存</span></ElButton
      >
    </div>
  </section>
</template>

<style scoped lang="scss">
.tools-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 分类标题：同一输入方式的设置卡片归在同一个分类下 */
.category {
  margin: 20px 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);

  &:first-of-type {
    margin-top: 4px;
  }
}

/* 两栏：设置主体 + 右侧锚点目录；窄窗口收起目录 */
.settings-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 148px;
  gap: 24px;
}

/* 目录锚点：吸顶跟随滚动，链接高亮即当前所在分组 */
.settings-anchor {
  position: sticky;
  top: 12px;
  align-self: start;
  max-height: calc(100vh - var(--titlebar-h) - var(--statusbar-h) - 80px);
  overflow-y: auto;
  padding: 2px 0;

  /* 缩进自己按层级做：EP 的 padding-indent 只作用于整份清单，父子两级区分不出来 */
  --el-anchor-padding-indent: 0px;
  --el-anchor-bg-color: transparent;
  --el-anchor-font-size: 12.5px;
  --el-anchor-line-height: 20px;
  --el-anchor-color: var(--text-3);
  --el-anchor-active-color: var(--accent);
  --el-anchor-marker-bg-color: var(--accent);
  /* EP 的 hover 规则读的是全局 --el-hover-color，本项目没引它的全量变量，这里补上 */
  --el-hover-color: var(--text-1);

  /* 整条目录的轨道线，激活项的小竖条压在上面 */
  &::before {
    content: '';
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 0;
    width: 1px;
    background: var(--stroke-strong);
  }

  :deep(.el-anchor__list) {
    padding-left: 0;
  }

  /* 目录项是点击目标而不是正文链接：去掉全局 a:hover 的下划线，改用底色反馈 */
  :deep(.el-anchor__link) {
    display: block;
    padding: 4px 6px 4px 14px;
    border-radius: var(--radius-sm);
    text-decoration: none;
    transition:
      color var(--dur-fast) var(--ease-standard),
      background-color var(--dur-fast) var(--ease-standard);

    &:hover,
    &:focus {
      background: var(--ctrl-fill-hover);
      text-decoration: none;
    }
  }

  /* 一级：分类标题，字重和亮度都高于组名 */
  :deep(> .el-anchor__list > .el-anchor__item > .el-anchor__link) {
    font-weight: 600;
    color: var(--text-2);

    &:not(.is-active):hover,
    &:not(.is-active):focus {
      color: var(--text-1);
    }

    &.is-active {
      color: var(--accent);
    }
  }

  /* 二级：设置组名，缩进一格、常规字重（嵌套清单挂在 __item 下，不是 __list 下） */
  :deep(
    > .el-anchor__list > .el-anchor__item > .el-anchor__list > .el-anchor__item > .el-anchor__link
  ) {
    padding-left: 26px;
    font-weight: 400;
    color: var(--text-3);

    &:not(.is-active):hover,
    &:not(.is-active):focus {
      color: var(--text-1);
    }

    &.is-active {
      color: var(--accent);
    }
  }

  /* 分类之间留白，让两级的归属关系看得出来 */
  :deep(> .el-anchor__list > .el-anchor__item + .el-anchor__item) {
    margin-top: 6px;
  }

  :deep(.el-anchor__marker) {
    width: 3px;
    height: 14px;
    border-radius: 2px;
  }
}

@media (max-width: 1020px) {
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .settings-anchor {
    display: none;
  }
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

  div {
    font-size: 13px;
    color: var(--text-1);
  }

  small {
    font-size: 12px;
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
  display: flex;
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
