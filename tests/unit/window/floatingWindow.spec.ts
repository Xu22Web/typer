import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bounds } from '@main/window/floatDock'

/** 假窗口状态（Electron 的 BrowserWindow 在单测里不可用，这里记录关键调用） */
const fake = {
  bounds: { x: 0, y: 0, width: 0, height: 0 } as Bounds,
  ignoreCalls: [] as Array<{ ignore: boolean; options?: { forward?: boolean } }>,
  visible: false,
  destroyed: false,
  readyToShow: null as null | (() => void),
  didFinishLoad: null as null | (() => void),
  cursor: { x: 0, y: 0 }
}

/** @description 把假窗口状态恢复到初始值 */
function resetFake(): void {
  fake.bounds = { x: 0, y: 0, width: 0, height: 0 }
  fake.ignoreCalls = []
  fake.visible = false
  fake.destroyed = false
  fake.readyToShow = null
  fake.didFinishLoad = null
  fake.cursor = { x: 0, y: 0 }
}

/** 主显示器工作区 */
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 }

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      on: (event: string, listener: () => void): void => {
        if (event === 'did-finish-load') fake.didFinishLoad = listener
      }
    }

    constructor(options: Record<string, number>) {
      fake.bounds = {
        x: options.x as number,
        y: options.y as number,
        width: options.width as number,
        height: options.height as number
      }
    }

    getBounds(): Bounds {
      return { ...fake.bounds }
    }
    setBounds(next: Bounds): void {
      fake.bounds = { ...next }
    }
    setPosition(x: number, y: number): void {
      fake.bounds = { ...fake.bounds, x, y }
    }
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
      fake.ignoreCalls.push({ ignore, options })
    }
    on(): void {
      /* 忽略事件绑定 */
    }
    once(event: string, listener: () => void): void {
      if (event === 'ready-to-show') fake.readyToShow = listener
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return fake.destroyed
    }
    isMinimized(): boolean {
      return false
    }
    restore(): void {
      /* 控制器不会最小化浮窗 */
    }
    isVisible(): boolean {
      return fake.visible
    }
    showInactive(): void {
      fake.visible = true
    }
    hide(): void {
      fake.visible = false
    }
    destroy(): void {
      fake.destroyed = true
      fake.visible = false
    }
    setAlwaysOnTop(): void {
      /* 置顶状态无需断言 */
    }
    setMenuBarVisibility(): void {
      /* 无菜单栏 */
    }
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
    getDisplayMatching: () => ({ workArea: WORK_AREA }),
    getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
    getCursorScreenPoint: () => fake.cursor
  }
}))

const { createFloatingWindow } = await import('@main/window/floatingWindow')
const { DEFAULT_PLACEMENT, barBounds, cardBounds, CARD_WIDTH, CARD_HEIGHT } =
  await import('@main/window/floatDock')

type FloatController = Awaited<ReturnType<typeof createFloatingWindow>>

/** @description 造一个浮窗控制器并记录回调 */
function create(initialPlacement = DEFAULT_PLACEMENT): {
  controller: FloatController
  states: Array<{ state: string; edge: string }>
  placements: Array<{ mode: string; x?: number; y?: number; edge?: string; offset?: number }>
} {
  const states: Array<{ state: string; edge: string }> = []
  const placements: Array<{
    mode: string
    x?: number
    y?: number
    edge?: string
    offset?: number
  }> = []
  const controller = createFloatingWindow({
    preloadPath: 'C:\\app\\preload.js',
    pageUrl: 'file:///app/float.html',
    initialPlacement,
    onState: (payload) => states.push(payload),
    onPlacementChange: (placement) => placements.push(placement as never)
  })
  return { controller, states, placements }
}

describe('浮窗控制器 · 贴边细条与卡片', () => {
  beforeEach(() => {
    resetFake()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('show 时贴成细条并允许点击穿透', () => {
    const { controller, states } = create()
    controller.show()

    expect(fake.bounds).toEqual(barBounds(WORK_AREA, { edge: 'right', offset: 24 }))
    expect(states.at(-1)).toEqual({ state: 'docked', edge: 'right' })
    expect(fake.ignoreCalls.at(-1)).toEqual({ ignore: true, options: { forward: true } })

    fake.readyToShow?.()
    expect(controller.isVisible()).toBe(true)
    controller.dispose()
  })

  it('页面加载完成后补发当前形态，避免首帧按错误方向画细条', () => {
    const { controller, states } = create({ mode: 'docked', edge: 'top', offset: 400 })
    controller.show()
    const seen = states.length

    // 页面脚本挂好监听之前发出的消息会丢，加载完成时必须再补一次
    fake.didFinishLoad?.()
    expect(states.length).toBe(seen + 1)
    expect(states.at(-1)).toEqual({ state: 'docked', edge: 'top' })
    controller.dispose()
  })

  it('指针靠近细条展开成卡片，离开后收回细条', async () => {
    const { controller, states } = create()
    controller.show()
    const bar = barBounds(WORK_AREA, { edge: 'right', offset: 24 })

    fake.cursor = { x: bar.x - 2, y: bar.y + 20 }
    await vi.advanceTimersByTimeAsync(120)
    expect(states.at(-1)?.state).toBe('expanded')
    expect(fake.ignoreCalls.at(-1)?.ignore).toBe(false)

    await vi.advanceTimersByTimeAsync(300)
    expect(fake.bounds).toEqual(
      cardBounds(WORK_AREA, { mode: 'docked', edge: 'right', offset: 24 })
    )

    fake.cursor = { x: 10, y: 10 }
    await vi.advanceTimersByTimeAsync(400)
    expect(states.at(-1)?.state).toBe('docked')

    // 收起动画由页面播放，结束后回执；主进程收到回执才收回细条尺寸
    controller.collapseDone()
    expect(fake.bounds).toEqual(barBounds(WORK_AREA, { edge: 'right', offset: 24 }))
    expect(fake.ignoreCalls.at(-1)).toEqual({ ignore: true, options: { forward: true } })
    controller.dispose()
  })

  it('页面收起回执缺席时，兜底超时也会收回细条', async () => {
    const { controller, states } = create()
    controller.show()
    const bar = barBounds(WORK_AREA, { edge: 'right', offset: 24 })

    fake.cursor = { x: bar.x - 2, y: bar.y + 20 }
    await vi.advanceTimersByTimeAsync(120)
    fake.cursor = { x: 10, y: 10 }
    await vi.advanceTimersByTimeAsync(400)
    expect(states.at(-1)?.state).toBe('docked')
    expect(fake.bounds).toEqual(
      cardBounds(WORK_AREA, { mode: 'docked', edge: 'right', offset: 24 })
    )

    // 回执一直不来（页面异常 / 减弱动效丢事件）：兜底计时器到点后强制收回
    await vi.advanceTimersByTimeAsync(700)
    expect(fake.bounds).toEqual(barBounds(WORK_AREA, { edge: 'right', offset: 24 }))
    controller.dispose()
  })

  it('指针停在细条上时不会误判为"离开卡片"', async () => {
    const { controller, states } = create()
    controller.show()
    const bar = barBounds(WORK_AREA, { edge: 'right', offset: 24 })

    fake.cursor = { x: bar.x - 2, y: bar.y + 20 }
    await vi.advanceTimersByTimeAsync(600)
    expect(states.at(-1)?.state).toBe('expanded')
    controller.dispose()
  })

  it('拖动离开边缘后自由浮动：不吸附，并记住坐标', async () => {
    const { controller, states, placements } = create()
    controller.show()
    const bar = barBounds(WORK_AREA, { edge: 'right', offset: 24 })

    // 先把卡片展开（拖动只发生在卡片上）
    fake.cursor = { x: bar.x - 2, y: bar.y + 20 }
    await vi.advanceTimersByTimeAsync(400)
    expect(states.at(-1)?.state).toBe('expanded')

    controller.dragBy(-400, 200)
    expect(states.at(-1)?.state).toBe('floating')
    const moved = { ...fake.bounds }

    controller.drop()
    expect(states.at(-1)?.state).toBe('floating')
    expect(fake.bounds).toEqual(moved)
    expect(placements.at(-1)).toEqual({ mode: 'floating', x: moved.x, y: moved.y })
    expect(moved.width).toBe(CARD_WIDTH)
    expect(moved.height).toBe(CARD_HEIGHT)
    controller.dispose()
  })

  it('拖到屏幕边缘松手：吸附成细条并记住贴边位置', async () => {
    const { controller, states, placements } = create()
    controller.show()

    controller.dragBy(-5000, 400)
    expect(states.at(-1)?.state).toBe('floating')
    controller.drop()

    expect(states.at(-1)?.state).toBe('docked')
    expect(placements.at(-1)?.mode).toBe('docked')
    await vi.advanceTimersByTimeAsync(400)
    // 拖到最左边 → 吸成左边的竖条
    expect(fake.bounds.width).toBe(8)
    expect(fake.bounds.height).toBe(132)
    expect(fake.bounds.x).toBe(0)
    controller.dispose()
  })

  it('自由浮动时不会被"指针离开"自动收起', async () => {
    const { controller, states } = create({ mode: 'floating', x: 300, y: 300 })
    controller.show()
    expect(states.at(-1)?.state).toBe('floating')

    fake.cursor = { x: 5, y: 5 }
    await vi.advanceTimersByTimeAsync(1200)
    expect(states.at(-1)?.state).toBe('floating')
    expect(controller.state()).toBe('floating')
    controller.dispose()
  })

  it('dock 无条件吸到最近的边', async () => {
    const { controller, states } = create({ mode: 'floating', x: 600, y: 500 })
    controller.show()
    controller.dock()
    expect(states.at(-1)?.state).toBe('docked')
    await vi.advanceTimersByTimeAsync(400)
    // 这个位置离底边最近 → 变成横向细条贴在底边
    expect(fake.bounds.height).toBe(8)
    expect(fake.bounds.y).toBe(WORK_AREA.height - 8)
    controller.dispose()
  })

  it('拖动过程中不会被指针轮询打断', async () => {
    const { controller, states } = create()
    controller.show()
    controller.dragBy(0, 0)
    controller.dragBy(-200, 100)
    const moved = { ...fake.bounds }

    fake.cursor = { x: 5, y: 5 }
    await vi.advanceTimersByTimeAsync(800)
    expect(fake.bounds).toEqual(moved)
    expect(states.at(-1)?.state).toBe('floating')
    controller.dispose()
  })

  it('hide 后不可见；dispose 销毁窗口', () => {
    const { controller } = create()
    controller.show()
    controller.hide()
    expect(controller.isVisible()).toBe(false)

    controller.dispose()
    expect(fake.destroyed).toBe(true)
  })
})
