<script setup lang="ts" vapor>
import { toPlainPayload } from '@main/ipc/plainPayload'
import type { Settings } from '@main/settings/types'

/**
 * 设置页。
 *
 * 从抽屉改成整页：设置项有七组、几十个字段，抽屉里只能来回滚动，
 * 整页可以按组分区、给每个开关写清"它到底影响什么"，也才放得下保存条。
 *
 * 交互约定：
 *  - 编辑草稿，显式保存；有改动才启用保存按钮，离开时不会被静默丢弃
 *  - 保存失败**保留草稿**并显示原因（不假装成功）
 *  - 保存成功用主进程归一化后的值回填（越界值会被夹取，界面与生效值保持一致）
 */
const { settings, error, load, update, reset } = useSettings()

const draft = ref<Settings | null>(null)
const saving = ref(false)
const saveError = ref('')
const restoring = ref(false)

const dirty = computed(() => {
  if (!draft.value || !settings.value) return false
  return JSON.stringify(toPlainPayload(draft.value)) !== JSON.stringify(settings.value)
})

onMounted(async () => {
  await load()
  draft.value = settings.value ? structuredClone(toPlainPayload(settings.value)) : null
})

/** 主进程给出的原因通常已带"设置保存失败"前缀，这里避免重复拼接。 */
function describeFailure(message: string | undefined): string {
  const text = (message ?? '').trim() || '未知原因'
  return text.includes('设置保存失败') ? text : `设置保存失败：${text}`
}

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
    if (settings.value) draft.value = structuredClone(toPlainPayload(settings.value))
    ElMessage.success('设置已保存')
  } finally {
    saving.value = false
  }
}

function discard(): void {
  draft.value = settings.value ? structuredClone(toPlainPayload(settings.value)) : null
  saveError.value = ''
}

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
    draft.value = settings.value ? structuredClone(toPlainPayload(settings.value)) : null
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
