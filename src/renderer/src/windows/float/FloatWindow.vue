<script setup lang="ts" vapor>
import { BAR_THICKNESS } from '@main/window/floatDock'
import { STATE_LABELS } from '@main/typing/engine/states'
import { formatDuration } from '@shared/format/duration'

/**
 * 进度浮窗：主窗口在开始输入时最小化，这里让进度始终可见。
 *
 * - 贴边时只有一条细进度条（横竖随贴的边），不含任何其它内容
 * - 鼠标靠近细条：主进程把窗口一步切成卡片尺寸，页面里从细条截面"长"出完整卡片
 *   （尺寸动画在合成层完成，逐帧 setBounds 透明窗口会卡顿）
 * - 拖动卡片离开屏幕边缘：变成自由浮动窗口，停在哪里就在哪里；再拖到边缘才重新吸附
 */
const typing = useTyping()

/** 只订阅主进程推来的状态与进度 */
typing.initEvents()

/** 主进程推来的浮窗形态与贴边方向 */
const viewState = ref<'docked' | 'expanded' | 'floating'>('docked')
const edge = ref<'left' | 'right' | 'top' | 'bottom'>('right')

/** 页面揭示动画时长（毫秒），与 CSS 过渡一致；收起回执与主进程兜底超时都按它算 */
const REVEAL_MS = 200

/**
 * 卡片是否裁剪成"细条截面"：展开动画的起点、收起动画的终点。
 * 尺寸不变、只动 clip-path，动画全程留在合成层
 */
const clipped = ref(false)

/** 是否禁用裁剪过渡：展开前要"无过渡"地瞬移到起点，避免先向反方向收一下 */
const clipInstant = ref(false)

/** 系统是否要求减弱动效（减弱时直接切换，不播动画） */
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * @description 形态切换时驱动揭示动画：展开从细条截面放开，收起裁回截面后回执主进程
 * @param next 新形态
 * @param prev 旧形态
 */
watch(viewState, (next, prev) => {
  if (next === 'expanded') {
    // 先无过渡地瞬移到细条截面，双 rAF 确保起点已提交，再放开过渡长成卡片
    clipInstant.value = true
    clipped.value = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clipInstant.value = false
        clipped.value = false
      })
    )
  } else if (prev === 'expanded' && next === 'docked') {
    // 裁回细条截面（与透明度淡出同时进行），动画结束后通知主进程收回窗口尺寸
    clipped.value = true
    const wait = reducedMotion ? 30 : REVEAL_MS + 40
    setTimeout(() => void window.api.float.collapseDone(), wait)
  }
})

/** 细条是竖的（贴左右边）还是横的（贴上下边） */
const vertical = computed(() => edge.value === 'left' || edge.value === 'right')

/** 是否显示卡片（展开或自由浮动） */
const showCard = computed(() => viewState.value !== 'docked')

/** 是否自由浮动（只有这时才给"贴边"按钮） */
const floating = computed(() => viewState.value === 'floating')

/** 进度百分比（0–100） */
const percent = computed(() => Math.round((typing.progress.value?.percent ?? 0) * 100))

/** 是否处于倒计时（此时中心数字显示剩余秒数） */
const counting = computed(() => typing.state.value === 'countdown')

/** 是否已暂停 */
const paused = computed(() => typing.state.value === 'paused')

/** 本次倒计时总时长，用于把倒计时折算成进度 */
const startDelayMs = ref(0)

/** 已用时间 */
const elapsed = computed(() => formatDuration(typing.progress.value?.elapsedMs ?? 0))

/** 预计剩余时间；没有可用数据时为破折号 */
const remaining = computed(() => {
  const value = typing.progress.value?.remainingMs ?? 0
  return value > 0 ? formatDuration(value) : '—'
})

/** 已输入 / 总数：文件传输时用"片"，文本用"动作"；总数未知时不显示 0/0 */
const counter = computed(() => {
  const frames = typing.progress.value?.frames
  if (frames) return `片 ${frames.done}/${frames.total}`
  const total = typing.progress.value?.total ?? 0
  return total > 0 ? `${typing.progress.value?.typed ?? 0}/${total}` : '—'
})

/** 进度比例（0–1）：倒计时阶段按倒计时比例填充，输入阶段用完成比例 */
const ratio = computed(() => {
  if (!counting.value) return Math.min(1, Math.max(0, typing.progress.value?.percent ?? 0))
  const total = startDelayMs.value
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, 1 - (typing.progress.value?.countdownRemainingMs ?? 0) / total))
})

/** 进度条填充比例（CSS 百分比） */
const fillSize = computed(() => `${(ratio.value * 100).toFixed(2)}%`)

/** 卡片中央的大号数字：倒计时显示剩余秒数，输入中显示百分比 */
const headline = computed(() =>
  counting.value
    ? Math.max(0, Math.ceil((typing.progress.value?.countdownRemainingMs ?? 0) / 1000))
    : percent.value
)

/** 进度色：暂停用警示色，失败用危险色，其余用强调色 */
const tone = computed(() => {
  if (typing.state.value === 'failed') return 'var(--danger)'
  if (paused.value) return 'var(--warning)'
  return 'var(--accent)'
})

/** @description 召回并聚焦主窗口 */
function restoreMain(): void {
  void window.api.window.focusMain()
}

/** @description 暂停 / 继续 */
function togglePause(): void {
  void (paused.value ? typing.resume() : typing.pause())
}

/** @description 中止输入 */
function stop(): void {
  void typing.stop()
}

/** @description 吸回最近的屏幕边缘 */
function dockToEdge(): void {
  void window.api.float.dock()
}

let dragStart: { x: number; y: number; moved: boolean } | null = null

/**
 * @description 开始拖动卡片：按住标题栏移动窗口
 * @param event 指针事件
 */
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  dragStart = { x: event.screenX, y: event.screenY, moved: false }
}

/**
 * @description 拖动中：把指针增量交给主进程移动窗口；超过阈值才算拖动
 * @param event 指针事件
 */
function onPointerMove(event: PointerEvent): void {
  if (!dragStart) return
  const dx = event.screenX - dragStart.x
  const dy = event.screenY - dragStart.y
  if (!dragStart.moved && Math.abs(dx) + Math.abs(dy) < 4) return

  dragStart.moved = true
  dragStart.x = event.screenX
  dragStart.y = event.screenY
  void window.api.float.drag(dx, dy)
}

/** @description 结束拖动：靠近边缘会被吸成细条，否则自由停在那里 */
function onPointerUp(event: PointerEvent): void {
  const start = dragStart
  dragStart = null
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }
  if (!start?.moved) return
  void window.api.float.drop()
}

onMounted(async () => {
  window.api.float.onState((payload) => {
    viewState.value = payload.state
    edge.value = payload.edge
  })
  // 浮窗是在运行开始后才创建的，对齐一次当前状态，否则整段倒计时都会显示"待机"
  void typing.syncStatus()
  try {
    startDelayMs.value = (await window.api.settings.get()).startDelayMs
  } catch {
    // 读不到设置不影响进度显示，退化为空环
  }
})
</script>

<template>
  <div
    class="float-root"
    :class="[`edge-${edge}`, { vertical }]"
    :style="{ '--bar-px': `${BAR_THICKNESS}px` }"
  >
    <!-- 贴边：只有一条进度条 -->
    <div class="bar" :class="{ hidden: showCard }">
      <div
        class="bar-fill"
        :style="{ [vertical ? 'height' : 'width']: fillSize, background: tone }"
      />
    </div>

    <!-- 展开 / 自由浮动：完整卡片 -->
    <div
      class="card"
      :class="{ hidden: !showCard, free: floating, clipped, 'clip-instant': clipInstant }"
    >
      <header
        class="card-head"
        title="按住可拖动；拖到屏幕边缘会自动吸附"
        @pointerdown.stop="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
      >
        <span class="grip i-mdi-drag" />
        <span class="state">{{ STATE_LABELS[typing.state.value] }}</span>
        <div class="spacer" />
        <button
          v-if="floating"
          class="ghost-act"
          type="button"
          title="吸附到最近的屏幕边缘"
          @click.stop="dockToEdge()"
        >
          <span class="i-mdi-pin-outline" />
        </button>
        <button class="ghost-act" type="button" title="回到主窗口" @click.stop="restoreMain()">
          <span class="i-mdi-open-in-app" />
        </button>
      </header>

      <div class="progress">
        <div class="value">
          <span class="num mono">{{ headline }}</span
          ><span v-if="!counting" class="unit">%</span>
        </div>
        <div class="track">
          <div class="fill" :style="{ width: fillSize, background: tone }" />
        </div>
      </div>

      <div class="meta">
        <div class="meta-item">
          <span class="i-mdi-counter" /><span class="mono">{{ counter }}</span>
        </div>
        <div class="meta-item">
          <span class="i-mdi-timer-outline" /><span class="mono">{{ elapsed }}</span>
        </div>
        <div class="meta-item">
          <span class="i-mdi-timer-sand" /><span class="mono">{{ remaining }}</span>
        </div>
      </div>

      <div class="actions">
        <button
          class="act"
          type="button"
          :title="paused ? '继续输入' : '暂停输入'"
          @click.stop="togglePause()"
        >
          <span :class="paused ? 'i-mdi-play' : 'i-mdi-pause'" />
          <span>{{ paused ? '继续' : '暂停' }}</span>
        </button>
        <button class="act danger" type="button" title="停止输入" @click.stop="stop()">
          <span class="i-mdi-stop" />
          <span>停止</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.float-root {
  box-sizing: border-box;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: transparent;
  cursor: default;
}

/* 卡片与细条叠在同一个窗口里：切换形态时只改不透明度与裁剪，
   DOM 不卸载，拖动中的指针捕获才不会因为节点被移除而丢失。 */
.card,
.bar {
  position: absolute;
  inset: 0;
}

.card {
  clip-path: inset(0);
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    clip-path 200ms var(--ease-standard);
}

.hidden {
  opacity: 0;
  pointer-events: none;
}

/* 揭示动画的起点 / 终点：裁剪到贴边细条的截面，
   卡片沿贴边方向"长出来 / 缩回去"（合成层动画，窗口尺寸不动） */
.float-root.edge-right .card.clipped {
  clip-path: inset(0 0 0 calc(100% - var(--bar-px)));
}

.float-root.edge-left .card.clipped {
  clip-path: inset(0 calc(100% - var(--bar-px)) 0 0);
}

.float-root.edge-top .card.clipped {
  clip-path: inset(0 0 calc(100% - var(--bar-px)) 0);
}

.float-root.edge-bottom .card.clipped {
  clip-path: inset(calc(100% - var(--bar-px)) 0 0 0);
}

/* 展开前瞬移到起点用：跳过 clip-path 过渡 */
.card.clip-instant {
  transition: none;
}

/* ---------- 贴边细条 ---------- */

.bar {
  display: flex;
  box-sizing: border-box;
  /* 进度和轨道之间留出内边距，否则填充贴着边缘，看不出是"条"还是"块" */
  padding: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--card-bg) 82%, transparent);
  box-shadow:
    0 0 0 1px var(--stroke),
    var(--shadow-flyout);
  overflow: hidden;
}

/* 贴左右边：竖条，进度自下而上生长，贴合"沿边"的观感 */
.float-root.vertical .bar {
  flex-direction: column;
  justify-content: flex-end;
}

/* 贴上下边：横条，进度自左向右生长 */
.float-root:not(.vertical) .bar {
  flex-direction: row;
  justify-content: flex-start;
}

/* 横截面始终占满轨道内侧，只让长度随进度变化 */
.float-root.vertical .bar-fill {
  width: 100%;
}

.float-root:not(.vertical) .bar-fill {
  height: 100%;
}

.bar-fill {
  flex: none;
  border-radius: 999px;
  transition:
    height 0.2s linear,
    width 0.2s linear,
    background-color 0.2s linear;
}

/* ---------- 卡片 ---------- */

.card {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-lg);
  background: var(--card-bg);
  box-shadow: var(--shadow-flyout);
  cursor: default;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  color: var(--text-2);
  font-size: 12px;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }

  .grip {
    font-size: 14px;
    color: var(--text-3);
  }

  .state {
    font-weight: 600;
    color: var(--text-1);
  }
}

.ghost-act {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);

  &:hover {
    background: var(--ctrl-fill-hover);
    color: var(--text-1);
  }
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.value {
  display: flex;
  align-items: baseline;
  gap: 2px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;

  .num {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.1;
  }

  .unit {
    font-size: 13px;
    font-weight: 600;
  }
}

.track {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: var(--ctrl-fill);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 999px;
  transition:
    width 0.2s linear,
    background-color 0.2s linear;
}

.meta {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-2);
  font-size: 11.5px;
  white-space: nowrap;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;

  span:first-child {
    font-size: 13px;
    color: var(--text-3);
  }
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}

.act {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--stroke-strong);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
  color: var(--text-1);
  font-size: 12.5px;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);

  &:hover {
    background: var(--ctrl-fill-hover);
    border-color: var(--stroke-hover);
  }

  &.danger {
    border-color: var(--danger-border);
    background: var(--danger-soft);
    color: var(--danger);

    &:hover {
      background: color-mix(in srgb, var(--danger) 22%, transparent);
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .card,
  .bar,
  .bar-fill,
  .fill,
  .ghost-act,
  .act {
    transition: none;
  }
}
</style>
