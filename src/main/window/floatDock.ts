/**
 * 进度浮窗的几何（纯函数，主进程与单测共用）。
 *
 * 浮窗有三种形态：
 * - 贴边细条（docked）：只露出一条进度条，横竖取决于贴的是哪条边
 * - 展开卡片（expanded）：鼠标靠近细条时展开，显示数据与控制按钮
 * - 自由浮动（floating）：拖离屏幕边缘后的卡片，停在哪里就在哪里，不再吸附
 *
 * 位置全部由"贴边状态或浮动坐标"算出，因此这里只做算术，不碰 Electron。
 */

export type DockEdge = 'left' | 'right' | 'top' | 'bottom'

export interface DockState {
  edge: DockEdge
  /** 沿边的位置：左右边是细条的上边 y，上下边是细条的左边 x（屏幕坐标） */
  offset: number
}

/** 浮窗当前的摆放：贴在某条边上，或自由停在某个坐标 */
export type FloatPlacement =
  { mode: 'docked'; edge: DockEdge; offset: number } | { mode: 'floating'; x: number; y: number }

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/** 贴边细条的厚度（垂直于边） */
export const BAR_THICKNESS = 8
/** 贴边细条的长度（沿着边） */
export const BAR_LENGTH = 132
/** 卡片尺寸：展开与自由浮动共用 */
export const CARD_WIDTH = 236
export const CARD_HEIGHT = 168
/** 卡片与屏幕边缘的间距 */
export const CARD_GAP = 8
/** 沿边停靠时距离工作区两端的留白，避免贴着任务栏或窗口圆角 */
export const EDGE_PADDING = 24
/** 松手时离屏幕边缘多近算"贴边" */
export const SNAP_DISTANCE = 56
/** 悬停判定的外扩像素：指针挨着细条也算靠近 */
export const HOVER_PAD = 8

/** 默认贴在右侧靠上的位置 */
export const DEFAULT_PLACEMENT: FloatPlacement = {
  mode: 'docked',
  edge: 'right',
  offset: EDGE_PADDING
}

/** @description 夹取到区间内（区间非法时以下界为准） */
function clamp(value: number, min: number, max: number): number {
  const upper = Math.max(min, max)
  return Math.min(Math.max(value, min), upper)
}

/** @description 该边是否为左右边（决定细条是竖的还是横的） */
export function isVerticalEdge(edge: DockEdge): boolean {
  return edge === 'left' || edge === 'right'
}

/**
 * @description 某条边上细条可以停靠的 offset 区间
 * @param workArea 显示器工作区
 * @param edge 停靠边
 * @returns [最小 offset, 最大 offset]
 */
export function offsetRange(workArea: WorkArea, edge: DockEdge): [number, number] {
  if (isVerticalEdge(edge)) {
    return [workArea.y + EDGE_PADDING, workArea.y + workArea.height - BAR_LENGTH - EDGE_PADDING]
  }
  return [workArea.x + EDGE_PADDING, workArea.x + workArea.width - BAR_LENGTH - EDGE_PADDING]
}

/**
 * @description 把贴边状态夹到合法范围（换显示器、分辨率变化后旧 offset 可能已经出界）
 * @param dock 贴边状态
 * @param workArea 显示器工作区
 * @returns 夹取后的贴边状态
 */
export function clampDock(dock: DockState, workArea: WorkArea): DockState {
  const [min, max] = offsetRange(workArea, dock.edge)
  return { edge: dock.edge, offset: Math.round(clamp(dock.offset, min, max)) }
}

/**
 * @description 把矩形夹进工作区（自由浮动时用）
 * @param bounds 目标矩形
 * @param workArea 显示器工作区
 * @returns 夹取后的矩形
 */
export function clampInto(bounds: Bounds, workArea: WorkArea): Bounds {
  const maxX = workArea.x + workArea.width - bounds.width
  const maxY = workArea.y + workArea.height - bounds.height
  return {
    x: Math.round(clamp(bounds.x, workArea.x, maxX)),
    y: Math.round(clamp(bounds.y, workArea.y, maxY)),
    width: bounds.width,
    height: bounds.height
  }
}

/**
 * @description 贴边细条的窗口位置：紧贴工作区边缘（整条都在屏幕内，便于悬停与点击）
 * @param workArea 显示器工作区
 * @param dock 贴边状态（内部会先夹取）
 * @returns 细条窗口的 bounds
 */
export function barBounds(workArea: WorkArea, dock: DockState): Bounds {
  const safe = clampDock(dock, workArea)
  switch (safe.edge) {
    case 'left':
      return { x: workArea.x, y: safe.offset, width: BAR_THICKNESS, height: BAR_LENGTH }
    case 'right':
      return {
        x: workArea.x + workArea.width - BAR_THICKNESS,
        y: safe.offset,
        width: BAR_THICKNESS,
        height: BAR_LENGTH
      }
    case 'top':
      return { x: safe.offset, y: workArea.y, width: BAR_LENGTH, height: BAR_THICKNESS }
    default:
      return {
        x: safe.offset,
        y: workArea.y + workArea.height - BAR_THICKNESS,
        width: BAR_LENGTH,
        height: BAR_THICKNESS
      }
  }
}

/**
 * @description 卡片窗口的位置：贴边时从细条往屏幕内展开，自由浮动时用保存的坐标
 * @param workArea 显示器工作区
 * @param placement 当前摆放
 * @returns 卡片窗口的 bounds（已夹进工作区）
 */
export function cardBounds(workArea: WorkArea, placement: FloatPlacement): Bounds {
  if (placement.mode === 'floating') {
    return clampInto(
      { x: placement.x, y: placement.y, width: CARD_WIDTH, height: CARD_HEIGHT },
      workArea
    )
  }

  const bar = barBounds(workArea, placement)
  const barCenterX = bar.x + bar.width / 2
  const barCenterY = bar.y + bar.height / 2
  const minX = workArea.x + CARD_GAP
  const minY = workArea.y + CARD_GAP
  const maxX = workArea.x + workArea.width - CARD_WIDTH - CARD_GAP
  const maxY = workArea.y + workArea.height - CARD_HEIGHT - CARD_GAP

  switch (placement.edge) {
    case 'left':
      return clampInto(
        {
          x: bar.x + bar.width + CARD_GAP,
          y: clamp(barCenterY - CARD_HEIGHT / 2, minY, maxY),
          width: CARD_WIDTH,
          height: CARD_HEIGHT
        },
        workArea
      )
    case 'right':
      return clampInto(
        {
          x: bar.x - CARD_GAP - CARD_WIDTH,
          y: clamp(barCenterY - CARD_HEIGHT / 2, minY, maxY),
          width: CARD_WIDTH,
          height: CARD_HEIGHT
        },
        workArea
      )
    case 'top':
      return clampInto(
        {
          x: clamp(barCenterX - CARD_WIDTH / 2, minX, maxX),
          y: bar.y + bar.height + CARD_GAP,
          width: CARD_WIDTH,
          height: CARD_HEIGHT
        },
        workArea
      )
    default:
      return clampInto(
        {
          x: clamp(barCenterX - CARD_WIDTH / 2, minX, maxX),
          y: bar.y - CARD_GAP - CARD_HEIGHT,
          width: CARD_WIDTH,
          height: CARD_HEIGHT
        },
        workArea
      )
  }
}

/**
 * @description 拖放结束后吸附到最近的边；离所有边都超过 `threshold` 时返回 null（保持自由浮动）
 * @param bounds 释放时窗口的位置
 * @param workArea 显示器工作区
 * @param threshold 吸附距离，默认 {@link SNAP_DISTANCE}
 * @returns 吸附后的贴边状态；不吸附时为 null
 */
export function snapDock(
  bounds: Bounds,
  workArea: WorkArea,
  threshold: number = SNAP_DISTANCE
): DockState | null {
  const horizontal = [
    { edge: 'left' as const, gap: bounds.x - workArea.x },
    { edge: 'right' as const, gap: workArea.x + workArea.width - (bounds.x + bounds.width) }
  ].sort((a, b) => a.gap - b.gap)[0]

  const vertical = [
    { edge: 'top' as const, gap: bounds.y - workArea.y },
    { edge: 'bottom' as const, gap: workArea.y + workArea.height - (bounds.y + bounds.height) }
  ].sort((a, b) => a.gap - b.gap)[0]

  // 横向与纵向各取最近的一条，再比一次，避免斜角处同时命中两边
  const nearest = [horizontal, vertical].sort((a, b) => a.gap - b.gap)[0]
  if (!nearest || nearest.gap > threshold) return null

  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const offset = isVerticalEdge(nearest.edge) ? centerY - BAR_LENGTH / 2 : centerX - BAR_LENGTH / 2
  return clampDock({ edge: nearest.edge, offset }, workArea)
}

/**
 * @description 判断指针是否落在细条上（含少量外扩，方便"靠近就展开"）
 * @param bar 细条窗口的位置
 * @param point 屏幕坐标
 * @returns 是否命中
 */
export function hitBar(bar: Bounds, point: { x: number; y: number }): boolean {
  return (
    point.x >= bar.x - HOVER_PAD &&
    point.x < bar.x + bar.width + HOVER_PAD &&
    point.y >= bar.y - HOVER_PAD &&
    point.y < bar.y + bar.height + HOVER_PAD
  )
}

/**
 * @description 判断指针是否落在卡片上（含外扩，留一点宽限）
 * @param card 卡片窗口的位置
 * @param point 屏幕坐标
 * @param pad 外扩像素
 * @returns 是否命中
 */
export function hitCard(card: Bounds, point: { x: number; y: number }, pad = HOVER_PAD): boolean {
  return (
    point.x >= card.x - pad &&
    point.x < card.x + card.width + pad &&
    point.y >= card.y - pad &&
    point.y < card.y + card.height + pad
  )
}
