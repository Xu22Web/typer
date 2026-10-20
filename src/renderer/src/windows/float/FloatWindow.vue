<script setup lang="ts" vapor>
import { BAR_THICKNESS, CARD_GAP, cardRect, pillRect } from '@main/window/floatDock'
import { isTerminal, STATE_LABELS } from '@main/typing/engine/states'
import { formatDuration } from '@shared/format/duration'

/**
 * 进度浮窗：主窗口在开始输入时最小化，这里让进度始终可见。
 *
 * - 贴边时只显示一条固定 8×132 的细进度条；窗口本身**始终是卡片尺寸**，运行期永不 resize
 * - 鼠标靠近：细条淡出缩小，卡片从屏幕边缘滑进来（纯 transform，合成层动画）
 * - 拖动卡片离开屏幕边缘：变成自由浮动窗口；拖回边缘再吸附成细条
 */
const typing = useTyping()

/** 只订阅主进程推来的状态与进度 */
typing.initEvents()

/** 主进程推来的浮窗形态与贴边方向 */
const viewState = ref<'docked' | 'expanded' | 'floating'>('docked')
const edge = ref<'left' | 'right' | 'top' | 'bottom'>('right')

/** 细条是否已隐去（展开或自由浮动时） */
const pillHidden = computed(() => viewState.value !== 'docked')

/** 卡片是否已滑出窗口（只有贴边收起时才滑出） */
const cardHidden = computed(() => viewState.value === 'docked')

/**
 * @description 把矩形转成内联样式，保证页面与主进程的 hover 命中用同一套几何
 * @param rect 窗口内矩形
 * @returns 内联样式对象
 */
function toStyle(rect: {
  x: number
  y: number
  width: number
  height: number
}): Record<string, string> {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
}

/** 细条与卡片都是固定像素尺寸：窗口尺寸变化再也不会把它们拉伸成"巨宽" */
const pillStyle = computed(() => toStyle(pillRect(edge.value)))
const cardStyle = computed(() => toStyle(cardRect(edge.value)))

/** 卡片滑出时需要多走的一段（卡片与屏幕边缘之间的间距 + 细条厚度） */
const rootStyle = computed(() => ({ '--edge-travel': `${CARD_GAP + BAR_THICKNESS}px` }))

/** 细条是竖的（贴左右边）还是横的（贴上下边） */
const vertical = computed(() => edge.value === 'left' || edge.value === 'right')

/** 是否自由浮动（只有这时才给"贴边"按钮） */
const floating = computed(() => viewState.value === 'floating')

/** 进度百分比（0–100） */
const percent = computed(() => Math.round((typing.progress.value?.percent ?? 0) * 100))

/** 是否已结束（完成 / 中止 / 出错）：结束后主窗口不再自动召回，由这里提供返回入口 */
const finished = computed(() => isTerminal(typing.state.value))

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
  <div class="float-root" :class="[`edge-${edge}`, { vertical }]" :style="rootStyle">
    <!-- 贴边：一条固定尺寸的进度条 -->
    <div class="pill" :class="{ out: pillHidden }" :style="pillStyle">
      <div
        class="pill-fill"
        :style="{ [vertical ? 'height' : 'width']: fillSize, background: tone }"
      />
    </div>

    <!-- 展开 / 自由浮动：完整卡片，从贴边方向滑入 -->
    <div class="card" :class="{ out: cardHidden, free: floating }" :style="cardStyle">
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
          v-if="finished"
          class="act primary"
          type="button"
          title="收起浮窗并回到主窗口"
          @click.stop="restoreMain()"
        >
          <span class="i-mdi-open-in-app" />
          <span>返回主窗口</span>
        </button>
        <template v-else>
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
        </template>
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

/* 卡片与细条各占自己的固定像素区域，叠在同一个恒定尺寸的窗口里：
   形态切换只改 transform / opacity，不会有布局重排或窗口 resize。
   DOM 不卸载，拖动中的指针捕获也不会因为节点被移除而丢失。 */
.card,
.pill {
  position: absolute;
  box-sizing: border-box;
}

/* ---------- 贴边细条 ---------- */

.pill {
  display: flex;
  /* 进度和轨道之间留出内边距，否则填充贴着边缘，看不出是"条"还是"块" */
  padding: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--card-bg) 82%, transparent);
  box-shadow:
    0 0 0 1px var(--stroke),
    var(--shadow-flyout);
  overflow: hidden;
  transform-origin: center;
  /* 展开时细条立刻淡出；收起时（移除 .out）延迟淡入，等卡片先滑走 */
  transition:
    opacity 90ms linear,
    transform 120ms var(--ease-standard);
  transition-delay: 120ms;
}

.pill.out {
  opacity: 0;
  transform: scale(0.55);
  pointer-events: none;
  transition-delay: 0ms;
}

/* 贴左右边：竖条，进度自下而上生长，贴合"沿边"的观感 */
.float-root.vertical .pill {
  flex-direction: column;
  justify-content: flex-end;
}

/* 贴上下边：横条，进度自左向右生长 */
.float-root:not(.vertical) .pill {
  flex-direction: row;
  justify-content: flex-start;
}

/* 横截面始终是细条自身的厚度，只让长度随进度变化 */
.float-root.vertical .pill-fill {
  width: 100%;
}

.float-root:not(.vertical) .pill-fill {
  height: 100%;
}

.pill-fill {
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
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-lg);
  background: var(--card-bg);
  box-shadow: var(--shadow-flyout);
  cursor: default;
  /* 从贴边方向滑进 / 滑出：窗口尺寸不变，动画只在合成层 */
  transition:
    transform 200ms var(--ease-standard),
    opacity 160ms linear;
}

.card.out {
  opacity: 0;
  pointer-events: none;
}

/* 滑出量 = 自身尺寸 + 细条与边之间的间距，正好完全移出窗口 */
.float-root.edge-right .card.out {
  transform: translateX(calc(100% + var(--edge-travel)));
}

.float-root.edge-left .card.out {
  transform: translateX(calc(-100% - var(--edge-travel)));
}

.float-root.edge-top .card.out {
  transform: translateY(calc(-100% - var(--edge-travel)));
}

.float-root.edge-bottom .card.out {
  transform: translateY(calc(100% + var(--edge-travel)));
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

  &.primary {
    border-color: transparent;
    background: var(--accent);
    color: #fff;

    &:hover {
      background: color-mix(in srgb, var(--accent) 86%, #000);
      border-color: transparent;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .card,
  .pill,
  .pill-fill,
  .fill,
  .ghost-act,
  .act {
    transition: none;
  }
}
</style>
