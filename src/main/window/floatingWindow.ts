import { BrowserWindow, screen } from 'electron'

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DEFAULT_PLACEMENT,
  HOVER_PAD,
  SNAP_DISTANCE,
  barBounds,
  cardBounds,
  clampInto,
  hitBar,
  hitCard,
  snapDock,
  type Bounds,
  type DockEdge,
  type FloatPlacement,
  type WorkArea
} from './floatDock'

/**
 * 运行期进度浮窗。
 *
 * - 贴边时只留一条细进度条（横竖随贴的边），鼠标靠近才展开成卡片
 * - 卡片可以拖走：拖到屏幕边缘附近松手会吸附回细条；拖到中间松手就自由停在那里，
 *   之后不再自动吸附，直到再次被拖到边缘（或点卡片上的"贴边"按钮）
 * - 贴边时窗口对鼠标透明（点击穿透），因此"靠近/离开"由主进程轮询指针位置判定
 */

/** 浮窗形态（渲染进程据此决定画细条还是卡片） */
export type FloatViewState = 'docked' | 'expanded' | 'floating'

export interface FloatStatePayload {
  state: FloatViewState
  /** 贴边方向（自由浮动时保留上一次贴的边，仅用于方向性样式） */
  edge: DockEdge
}

export interface FloatingWindowOptions {
  /** 渲染进程 preload 的绝对路径 */
  preloadPath: string
  /** 浮窗页面 URL（开发模式是 dev server 地址，打包后是 float.html 的 file:// URL） */
  pageUrl: string
  /** 上次的摆放（来自设置） */
  initialPlacement?: FloatPlacement
  /** 摆放变化（吸附或自由浮动落定后）——由主进程写回设置 */
  onPlacementChange?: (placement: FloatPlacement) => void
  /** 形态变化——由主进程广播给渲染进程 */
  onState?: (payload: FloatStatePayload) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface FloatingWindowController {
  /** 显示浮窗（首次调用时创建），不激活、不抢焦点 */
  show: () => void
  /** 隐藏浮窗（保留实例以便下次快速显示） */
  hide: () => void
  /** 是否正在显示 */
  isVisible: () => boolean
  /** 展开成卡片（鼠标靠近细条时自动调用） */
  expand: () => void
  /** 收回成细条 */
  collapse: () => void
  /** 页面收缩动画结束的回执：把窗口收回细条尺寸（主进程另有兜底超时） */
  collapseDone: () => void
  /** 拖动位移（渲染进程上报增量，单位 DIP）；拖离边缘后即为自由浮动 */
  dragBy: (dx: number, dy: number) => void
  /** 拖动落定：靠近边缘则吸附成细条，否则保持自由浮动 */
  drop: () => void
  /** 立刻吸附到最近的边（卡片上的"贴边"按钮） */
  dock: () => void
  /** 当前形态 */
  state: () => FloatViewState
  /** 当前摆放 */
  placement: () => FloatPlacement
  /** 渲染进程是否可以让窗口接收鼠标（贴边时默认点击穿透） */
  setInteractive: (interactive: boolean) => void
  /** 销毁窗口并释放资源 */
  dispose: () => void
}

/** 展开 / 收起动画时长（毫秒），与浮窗页面 CSS 的 clip-path 过渡保持一致 */
const REVEAL_MS = 200
/** 收起兜底超时：页面动画结束回执没到（页面异常 / 减弱动效）时强制收回细条 */
const COLLAPSE_FALLBACK_MS = REVEAL_MS + 420
/** 吸附动画时长（毫秒） */
const SNAP_MS = 160
/** 补间帧间隔：约 60fps */
const FRAME_MS = 16
/** 鼠标靠近检测的轮询间隔 */
const HOVER_POLL_MS = 80
/** 指针离开卡片多久后收起（留一点宽限，避免斜穿角落时闪烁） */
const LEAVE_GRACE_MS = 260
/** 拖动时至少留在屏幕内的像素，避免把窗口拖丢 */
const DRAG_KEEP_VISIBLE = 24

/** @description 缓出曲线，收尾更柔和（Win11 的 FastOutSlowIn 观感） */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

/** @description 夹取到区间 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** @description 把摆放状态夹进工作区（换显示器后旧坐标可能已经出界） */
function normalizePlacement(placement: FloatPlacement, area: WorkArea): FloatPlacement {
  if (placement.mode === 'floating') {
    const safe = clampInto(
      { x: placement.x, y: placement.y, width: CARD_WIDTH, height: CARD_HEIGHT },
      area
    )
    return { mode: 'floating', x: safe.x, y: safe.y }
  }
  return placement
}

/**
 * @description 创建进度浮窗控制器
 * @param options preload/页面路径、初始摆放与回调
 * @returns 浮窗控制器
 */
export function createFloatingWindow(options: FloatingWindowOptions): FloatingWindowController {
  let window: BrowserWindow | null = null
  let visible = false
  /** 页面是否已可绘制：首帧之前不显示，避免闪出一个空白卡片 */
  let ready = false
  let placement: FloatPlacement = options.initialPlacement ?? DEFAULT_PLACEMENT
  let state: FloatViewState = placement.mode === 'floating' ? 'floating' : 'docked'
  /** 渲染进程请求的"强制可交互"（默认贴边时点击穿透） */
  let forceInteractive = false
  /** 动画令牌：新的动画让旧的补间立刻失效 */
  let animationToken = 0
  /** 指针离开卡片的时刻；0 表示此刻还在卡片内 */
  let leftAt = 0
  let watcher: ReturnType<typeof setInterval> | null = null
  /** 是否正在拖动（拖动中不跑"靠近展开 / 离开收起"） */
  let dragActive = false
  /** 拖动落定后指针就在窗口上，此时不该立刻再展开 */
  let armed = true

  /** @description 当前窗口所在的显示器工作区（窗口还没建时用主显示器） */
  const workArea = (): WorkArea => {
    const bounds = window && !window.isDestroyed() ? window.getBounds() : null
    const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
    return display.workArea
  }

  /** @description 贴边时让窗口对鼠标透明（转发 mousemove 也无害，主进程另有轮询判定） */
  const applyClickThrough = (): void => {
    if (!window || window.isDestroyed()) return
    const through = state === 'docked' && !forceInteractive
    window.setIgnoreMouseEvents(through, through ? { forward: true } : undefined)
  }

  /** @description 把形态变化通知渲染进程（并同步点击穿透） */
  const emitState = (): void => {
    applyClickThrough()
    const edge: DockEdge = placement.mode === 'docked' ? placement.edge : lastEdge()
    options.onState?.({ state, edge })
  }

  /** 上一次贴过（或当前贴着）的边：自由浮动时也要知道细条方向 */
  let lastDockEdge: DockEdge = placement.mode === 'docked' ? placement.edge : 'right'
  const lastEdge = (): DockEdge => {
    if (placement.mode === 'docked') lastDockEdge = placement.edge
    return lastDockEdge
  }

  /** @description 改变形态（不触发动画） */
  const setState = (next: FloatViewState): void => {
    if (state === next) return
    state = next
    emitState()
  }

  /**
   * @description 把窗口从当前位置补间到目标矩形
   * @param target 目标 bounds
   * @param durationMs 时长；<= 0 表示立即到位
   */
  const animateTo = (target: Bounds, durationMs: number): void => {
    const win = window
    if (!win || win.isDestroyed()) return

    animationToken += 1
    const token = animationToken
    if (durationMs <= 0) {
      win.setBounds(target)
      return
    }

    const from = win.getBounds()
    const startedAt = Date.now()
    const step = (): void => {
      if (token !== animationToken) return
      if (!window || window.isDestroyed()) return
      const t = Math.min(1, (Date.now() - startedAt) / durationMs)
      const eased = easeOutCubic(t)
      window.setBounds({
        x: Math.round(from.x + (target.x - from.x) * eased),
        y: Math.round(from.y + (target.y - from.y) * eased),
        width: Math.round(from.width + (target.width - from.width) * eased),
        height: Math.round(from.height + (target.height - from.height) * eased)
      })
      if (t < 1) setTimeout(step, FRAME_MS)
    }
    step()
  }

  /** @description 展开成卡片：窗口尺寸一步到位，揭示动画由页面在合成层完成 */
  const doExpand = (): void => {
    if (!window || window.isDestroyed() || state === 'expanded') return
    if (state === 'floating' || placement.mode !== 'docked') return
    clearCollapseTimer()
    setState('expanded')
    // 逐帧 setBounds 透明窗口会触发同步 DWM 重组，观感卡顿；这里只切一次
    animationToken += 1
    window.setBounds(cardBounds(workArea(), placement))
  }

  /** 等待页面收缩动画回执的兜底计时器 */
  let collapseTimer: ReturnType<typeof setTimeout> | null = null

  /** @description 清掉收起兜底计时器 */
  const clearCollapseTimer = (): void => {
    if (!collapseTimer) return
    clearTimeout(collapseTimer)
    collapseTimer = null
  }

  /**
   * @description 收起动画的终点：把窗口收回细条尺寸并恢复点击穿透。
   * 由页面动画结束回执触发；计时器兜底也会走到这里，因此要做状态守卫
   */
  const finishCollapse = (): void => {
    clearCollapseTimer()
    if (!window || window.isDestroyed() || !visible) return
    if (state !== 'docked' || placement.mode !== 'docked') return
    animationToken += 1
    window.setBounds(barBounds(workArea(), placement))
    forceInteractive = false
    applyClickThrough()
  }

  /** @description 收回到细条：先把形态切成 docked（页面随之播放收缩动画），动画结束后再收尺寸 */
  const doCollapse = (): void => {
    if (!window || window.isDestroyed() || state !== 'expanded') return
    if (placement.mode !== 'docked') return
    setState('docked')
    clearCollapseTimer()
    collapseTimer = setTimeout(finishCollapse, COLLAPSE_FALLBACK_MS)
  }

  /** @description 进入自由浮动：先切成卡片尺寸，再按当前窗口位置记录坐标 */
  const enterFloating = (): void => {
    if (!window || window.isDestroyed()) return
    if (placement.mode === 'floating') {
      setState('floating')
      return
    }
    const target = cardBounds(workArea(), placement)
    animationToken += 1
    window.setBounds(target)
    placement = { mode: 'floating', x: target.x, y: target.y }
    setState('floating')
    options.onPlacementChange?.(placement)
  }

  /**
   * @description 轮询指针位置驱动展开 / 收起。
   * 贴边时窗口对鼠标是透明的，渲染进程收不到可靠的 hover，因此统一在主进程判定。
   */
  const watchCursor = (): void => {
    if (watcher) return
    watcher = setInterval(() => {
      if (!visible || !window || window.isDestroyed()) return
      if (dragActive) {
        leftAt = 0
        return
      }

      const point = screen.getCursorScreenPoint()
      const area = workArea()

      if (state === 'docked') {
        leftAt = 0
        if (placement.mode !== 'docked') return
        if (!hitBar(barBounds(area, placement), point)) {
          armed = true
          return
        }
        if (armed) doExpand()
        return
      }

      if (state !== 'expanded') return

      // 展开后指针可能还停在细条上（卡片贴在细条旁边），这不算"离开"
      if (hitCard(window.getBounds(), point, HOVER_PAD)) {
        leftAt = 0
        return
      }
      if (placement.mode === 'docked' && hitBar(barBounds(area, placement), point)) {
        leftAt = 0
        return
      }
      const now = Date.now()
      if (leftAt === 0) {
        leftAt = now
        return
      }
      if (now - leftAt >= LEAVE_GRACE_MS) {
        leftAt = 0
        doCollapse()
      }
    }, HOVER_POLL_MS)
  }

  /** @description 停止轮询 */
  const stopWatching = (): void => {
    if (!watcher) return
    clearInterval(watcher)
    watcher = null
    leftAt = 0
  }

  /** @description 创建浮窗实例（只创建一次，结束时只隐藏不销毁） */
  const build = (): BrowserWindow => {
    const initial =
      placement.mode === 'floating'
        ? cardBounds(workArea(), placement)
        : barBounds(workArea(), placement)

    const created = new BrowserWindow({
      ...initial,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 不抢焦点：点击浮窗不会把焦点从目标窗口带走（Windows 上仍能收到鼠标消息）
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Typer 进度',
      webPreferences: {
        preload: options.preloadPath,
        sandbox: false
      }
    })

    created.setAlwaysOnTop(true, 'floating')
    created.setMenuBarVisibility(false)

    created.once('ready-to-show', () => {
      ready = true
      if (visible && !created.isDestroyed()) created.showInactive()
    })

    // 页面脚本装好监听之前发出的形态消息会丢，加载完成后再补一次当前状态，
    // 否则首帧会按默认方向画细条（横竖与实际贴边方向不符）
    created.webContents.on('did-finish-load', () => {
      if (!created.isDestroyed()) emitState()
    })

    created.on('closed', () => {
      if (window === created) {
        window = null
        visible = false
        ready = false
      }
    })

    void created.loadURL(options.pageUrl)

    return created
  }

  return {
    show: () => {
      visible = true
      clearCollapseTimer()
      try {
        if (!window || window.isDestroyed()) window = build()
        if (window.isMinimized()) window.restore()

        const area = workArea()
        placement = normalizePlacement(placement, area)
        forceInteractive = false
        dragActive = false
        armed = true
        animationToken += 1

        if (placement.mode === 'floating') {
          state = 'floating'
          window.setBounds(cardBounds(area, placement))
        } else {
          state = 'docked'
          window.setBounds(barBounds(area, placement))
        }

        emitState()
        if (ready && !window.isVisible()) window.showInactive()
        watchCursor()
      } catch (error) {
        options.onLog?.(
          'warn',
          `进度浮窗显示失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    hide: () => {
      visible = false
      clearCollapseTimer()
      animationToken += 1
      state = placement.mode === 'floating' ? 'floating' : 'docked'
      forceInteractive = false
      dragActive = false
      stopWatching()
      if (window && !window.isDestroyed()) window.hide()
    },
    isVisible: () => visible && !!window && !window.isDestroyed() && window.isVisible(),
    expand: () => {
      doExpand()
    },
    collapse: () => {
      doCollapse()
    },
    collapseDone: () => {
      finishCollapse()
    },
    dragBy: (dx: number, dy: number) => {
      if (!window || window.isDestroyed()) return
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return

      if (!dragActive) {
        dragActive = true
        animationToken += 1
        enterFloating()
      }

      const current = window.getBounds()
      const nextX = current.x + Math.round(clamp(dx, -4000, 4000))
      const nextY = current.y + Math.round(clamp(dy, -4000, 4000))
      const area = screen.getDisplayNearestPoint({
        x: nextX + Math.round(current.width / 2),
        y: nextY + Math.round(current.height / 2)
      }).workArea

      const x = Math.round(
        clamp(
          nextX,
          area.x - current.width + DRAG_KEEP_VISIBLE,
          area.x + area.width - DRAG_KEEP_VISIBLE
        )
      )
      const y = Math.round(
        clamp(
          nextY,
          area.y - current.height + DRAG_KEEP_VISIBLE,
          area.y + area.height - DRAG_KEEP_VISIBLE
        )
      )
      window.setPosition(x, y)
      placement = { mode: 'floating', x, y }
    },
    drop: () => {
      if (!window || window.isDestroyed()) return
      dragActive = false
      const area = workArea()
      const released = window.getBounds()
      const docked = snapDock(released, area, SNAP_DISTANCE)

      if (docked) {
        placement = { mode: 'docked', ...docked }
        armed = false
        setState('docked')
        animateTo(barBounds(area, placement), SNAP_MS)
        setTimeout(() => {
          if (state !== 'docked') return
          forceInteractive = false
          applyClickThrough()
        }, SNAP_MS + 20)
      } else {
        const safe = clampInto(released, area)
        placement = { mode: 'floating', x: safe.x, y: safe.y }
        window.setBounds(safe)
        setState('floating')
      }

      options.onPlacementChange?.(placement)
    },
    dock: () => {
      if (!window || window.isDestroyed()) return
      const area = workArea()
      const released = window.getBounds()
      // 手动"贴边"：无条件吸到最近的一条边
      const docked = snapDock(released, area, Number.POSITIVE_INFINITY)
      if (!docked) return
      placement = { mode: 'docked', ...docked }
      dragActive = false
      armed = false
      setState('docked')
      animateTo(barBounds(area, placement), SNAP_MS)
      options.onPlacementChange?.(placement)
      setTimeout(() => {
        if (state !== 'docked') return
        forceInteractive = false
        applyClickThrough()
      }, SNAP_MS + 20)
    },
    state: () => state,
    placement: () => placement,
    setInteractive: (next: boolean) => {
      if (forceInteractive === next) return
      forceInteractive = next
      applyClickThrough()
    },
    dispose: () => {
      visible = false
      ready = false
      clearCollapseTimer()
      animationToken += 1
      dragActive = false
      stopWatching()
      const target = window
      window = null
      if (target && !target.isDestroyed()) target.destroy()
    }
  }
}
