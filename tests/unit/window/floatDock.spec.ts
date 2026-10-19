import { describe, expect, it } from 'vitest'
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  EDGE_PADDING,
  FLOAT_WINDOW_HEIGHT,
  FLOAT_WINDOW_WIDTH,
  HOVER_PAD,
  SHADOW_PAD,
  SNAP_DISTANCE,
  cardRect,
  cardScreenBounds,
  clampDock,
  clampInto,
  dockedWindowBounds,
  floatingWindowBounds,
  hitBar,
  hitCard,
  isVerticalEdge,
  offsetRange,
  pillBounds,
  pillRect,
  snapDock,
  windowBounds,
  type DockEdge,
  type WorkArea
} from '@main/window/floatDock'

/** 主显示器工作区（1080p + 任务栏） */
const AREA: WorkArea = { x: 0, y: 0, width: 1920, height: 1040 }

/** 副屏在主屏左侧：坐标为负 */
const LEFT_AREA: WorkArea = { x: -1920, y: -200, width: 1920, height: 1080 }

describe('floatDock · 贴边细条', () => {
  it('右侧贴边：细条贴在右边缘、竖向', () => {
    expect(pillBounds(AREA, { edge: 'right', offset: 200 })).toEqual({
      x: AREA.width - BAR_THICKNESS,
      y: 200,
      width: BAR_THICKNESS,
      height: BAR_LENGTH
    })
  })

  it('左侧贴边：细条贴在左边缘', () => {
    expect(pillBounds(AREA, { edge: 'left', offset: 200 })).toEqual({
      x: 0,
      y: 200,
      width: BAR_THICKNESS,
      height: BAR_LENGTH
    })
  })

  it('上下贴边：细条横向、贴在上/下边缘', () => {
    expect(pillBounds(AREA, { edge: 'top', offset: 300 })).toEqual({
      x: 300,
      y: 0,
      width: BAR_LENGTH,
      height: BAR_THICKNESS
    })
    expect(pillBounds(AREA, { edge: 'bottom', offset: 300 })).toEqual({
      x: 300,
      y: AREA.height - BAR_THICKNESS,
      width: BAR_LENGTH,
      height: BAR_THICKNESS
    })
  })

  it('左右边是竖向、上下边是横向', () => {
    expect(isVerticalEdge('left')).toBe(true)
    expect(isVerticalEdge('right')).toBe(true)
    expect(isVerticalEdge('top')).toBe(false)
    expect(isVerticalEdge('bottom')).toBe(false)
  })

  it('沿边位置按工作区夹取，副屏原点也正确', () => {
    expect(offsetRange(AREA, 'right')).toEqual([
      EDGE_PADDING,
      AREA.height - BAR_LENGTH - EDGE_PADDING
    ])
    expect(clampDock({ edge: 'right', offset: -500 }, AREA).offset).toBe(EDGE_PADDING)
    expect(clampDock({ edge: 'bottom', offset: 99_999 }, AREA).offset).toBe(
      AREA.width - BAR_LENGTH - EDGE_PADDING
    )

    expect(pillBounds(LEFT_AREA, { edge: 'left', offset: 0 }).x).toBe(-1920)
    expect(clampDock({ edge: 'left', offset: -99_999 }, LEFT_AREA).offset).toBe(-200 + EDGE_PADDING)
  })
})

describe('floatDock · 固定窗口与卡片布局', () => {
  it('窗口尺寸恒定：四种边、贴边与自由浮动都一样', () => {
    const edges: DockEdge[] = ['left', 'right', 'top', 'bottom']
    for (const edge of edges) {
      const win = windowBounds(AREA, { mode: 'docked', edge, offset: 400 })
      expect(win.width).toBe(FLOAT_WINDOW_WIDTH)
      expect(win.height).toBe(FLOAT_WINDOW_HEIGHT)
    }
    const floating = windowBounds(AREA, { mode: 'floating', x: 400, y: 300 })
    expect(floating.width).toBe(FLOAT_WINDOW_WIDTH)
    expect(floating.height).toBe(FLOAT_WINDOW_HEIGHT)
  })

  it('贴右边：卡片在细条内侧，中间留 CARD_GAP，窗口贴死右边缘', () => {
    const dock = { mode: 'docked' as const, edge: 'right' as const, offset: 400 }
    const win = dockedWindowBounds(AREA, dock)
    const card = cardRect('right')
    const pill = pillRect('right')

    expect(win.x + win.width).toBe(AREA.width)
    expect(card.x).toBeGreaterThanOrEqual(0)
    expect(card.x + card.width + CARD_GAP).toBe(pill.x)
    expect(pill.x + pill.width).toBe(FLOAT_WINDOW_WIDTH)
    expect(card.width).toBe(CARD_WIDTH)
    expect(card.height).toBe(CARD_HEIGHT)
  })

  it('贴左边：卡片与细条左右镜像', () => {
    const card = cardRect('left')
    const pill = pillRect('left')
    expect(pill.x).toBe(0)
    expect(card.x).toBe(CARD_GAP + BAR_THICKNESS)
    expect(card.x + card.width + SHADOW_PAD).toBe(FLOAT_WINDOW_WIDTH)
  })

  it('贴上下边：卡片在细条内侧，窗口贴死上/下边缘', () => {
    const top = windowBounds(AREA, { mode: 'docked', edge: 'top', offset: 900 })
    expect(top.y).toBe(AREA.y)
    const cardTop = cardRect('top')
    expect(cardTop.y).toBe(CARD_GAP + BAR_THICKNESS)

    const bottom = windowBounds(AREA, { mode: 'docked', edge: 'bottom', offset: 900 })
    expect(bottom.y + bottom.height).toBe(AREA.height)
    const cardBottom = cardRect('bottom')
    expect(cardBottom.y + cardBottom.height + CARD_GAP).toBe(pillRect('bottom').y)
  })

  it('靠近屏幕角时窗口整体夹在工作区内', () => {
    const win = dockedWindowBounds(AREA, { edge: 'right', offset: 0 })
    expect(win.y).toBeGreaterThanOrEqual(AREA.y)
    expect(win.y + win.height).toBeLessThanOrEqual(AREA.y + AREA.height)
  })

  it('自由浮动：用保存的坐标并夹进工作区', () => {
    expect(floatingWindowBounds({ mode: 'floating', x: 400, y: 300 }, AREA)).toEqual({
      x: 400,
      y: 300,
      width: FLOAT_WINDOW_WIDTH,
      height: FLOAT_WINDOW_HEIGHT
    })
    const clamped = floatingWindowBounds({ mode: 'floating', x: 5000, y: 5000 }, AREA)
    expect(clamped.x).toBe(AREA.width - FLOAT_WINDOW_WIDTH)
    expect(clamped.y).toBe(AREA.height - FLOAT_WINDOW_HEIGHT)
  })

  it('卡片在屏幕上的矩形 = 窗口位置 + 窗口内偏移', () => {
    const win = dockedWindowBounds(AREA, { edge: 'right', offset: 400 })
    const card = cardScreenBounds(win, 'right')
    const rect = cardRect('right')
    expect(card.x).toBe(win.x + rect.x)
    expect(card.y).toBe(win.y + rect.y)
  })
})

describe('floatDock · 吸附与命中', () => {
  it('贴着左边缘松手：吸附到左边', () => {
    expect(snapDock({ x: 6, y: 300, width: CARD_WIDTH, height: CARD_HEIGHT }, AREA)).toEqual({
      edge: 'left',
      offset: 300 + CARD_HEIGHT / 2 - BAR_LENGTH / 2
    })
  })

  it('贴着下边缘松手：吸附到下边', () => {
    const bounds = {
      x: 400,
      y: AREA.height - CARD_HEIGHT - 4,
      width: CARD_WIDTH,
      height: CARD_HEIGHT
    }
    expect(snapDock(bounds, AREA)?.edge).toBe('bottom')
  })

  it('离边太远：不吸附（保持自由浮动）', () => {
    const center = {
      x: AREA.width / 2 - CARD_WIDTH / 2,
      y: AREA.height / 2 - CARD_HEIGHT / 2,
      width: CARD_WIDTH,
      height: CARD_HEIGHT
    }
    expect(snapDock(center, AREA)).toBeNull()
  })

  it('吸附距离刚好在阈值内生效、阈值外失效', () => {
    const bounds = { x: SNAP_DISTANCE, y: 400, width: CARD_WIDTH, height: CARD_HEIGHT }
    expect(snapDock(bounds, AREA)?.edge).toBe('left')
    expect(snapDock({ ...bounds, x: SNAP_DISTANCE + 1 }, AREA)).toBeNull()
  })

  it('细条与卡片的命中判定都带外扩', () => {
    const bar = pillBounds(AREA, { edge: 'right', offset: 300 })
    expect(hitBar(bar, { x: bar.x + 2, y: bar.y + 10 })).toBe(true)
    expect(hitBar(bar, { x: bar.x - HOVER_PAD - 1, y: bar.y + 10 })).toBe(false)
    expect(hitBar(bar, { x: bar.x + 2, y: bar.y - HOVER_PAD - 1 })).toBe(false)

    const win = floatingWindowBounds({ mode: 'floating', x: 100, y: 100 }, AREA)
    const card = cardScreenBounds(win, 'right')
    expect(hitCard(card, { x: card.x + 5, y: card.y + 5 })).toBe(true)
    expect(hitCard(card, { x: card.x - HOVER_PAD - 1, y: card.y + 5 })).toBe(false)
  })

  it('clampInto 把矩形整体留在工作区内', () => {
    expect(clampInto({ x: -50, y: -50, width: 100, height: 100 }, AREA)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100
    })
  })

  it('四种边都能给出合法 offset 区间', () => {
    const edges: DockEdge[] = ['left', 'right', 'top', 'bottom']
    for (const edge of edges) {
      const [min, max] = offsetRange(AREA, edge)
      expect(max).toBeGreaterThan(min)
    }
  })
})
