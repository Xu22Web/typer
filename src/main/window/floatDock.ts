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
/** 卡片与细条之间的间距 */
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

/** 卡片阴影的余量：窗口比卡片大一圈，投影才不会被窗口边界裁掉 */
export const SHADOW_PAD = 12

/**
 * 浮窗窗口的固定尺寸：贴边与自由浮动共用，运行期**永不改变窗口大小**。
 * 沿贴边方向依次排布：细条 → 卡片间距 → 卡片 → 阴影余量。
 * 这样细条/卡片都用固定像素定位，窗口尺寸变化再也不会把进度条拉伸成"巨宽"。
 */
export const FLOAT_WINDOW_WIDTH = SHADOW_PAD + CARD_WIDTH + CARD_GAP + BAR_THICKNESS
export const FLOAT_WINDOW_HEIGHT = SHADOW_PAD + CARD_HEIGHT + CARD_GAP + BAR_THICKNESS

/**
 * @description 卡片在窗口内的矩形（窗口坐标）：贴边侧留出细条与间距，另一轴居中
 * @param edge 贴边方向
 * @returns 卡片矩形（相对窗口左上角）
 */
export function cardRect(edge: DockEdge): Bounds {
  const x =
    edge === 'left'
      ? FLOAT_WINDOW_WIDTH - SHADOW_PAD - CARD_WIDTH
      : edge === 'right'
        ? SHADOW_PAD
        : (FLOAT_WINDOW_WIDTH - CARD_WIDTH) / 2
  const y =
    edge === 'top'
      ? BAR_THICKNESS + CARD_GAP
      : edge === 'bottom'
        ? SHADOW_PAD
        : (FLOAT_WINDOW_HEIGHT - CARD_HEIGHT) / 2
  return { x, y, width: CARD_WIDTH, height: CARD_HEIGHT }
}

/**
 * @description 细条在窗口内的矩形（窗口坐标）：贴着屏幕边缘，沿边居中
 * @param edge 贴边方向
 * @returns 细条矩形（相对窗口左上角）
 */
export function pillRect(edge: DockEdge): Bounds {
  const vertical = isVerticalEdge(edge)
  const x =
    edge === 'left'
      ? 0
      : edge === 'right'
        ? FLOAT_WINDOW_WIDTH - BAR_THICKNESS
        : (FLOAT_WINDOW_WIDTH - BAR_LENGTH) / 2
  const y =
    edge === 'top'
      ? 0
      : edge === 'bottom'
        ? FLOAT_WINDOW_HEIGHT - BAR_THICKNESS
        : (FLOAT_WINDOW_HEIGHT - BAR_LENGTH) / 2
  return {
    x,
    y,
    width: vertical ? BAR_THICKNESS : BAR_LENGTH,
    height: vertical ? BAR_LENGTH : BAR_THICKNESS
  }
}

/**
 * @description 贴边时窗口的位置：窗口贴死屏幕边缘，细条中心与保存的 offset 对齐
 * @param workArea 显示器工作区
 * @param dock 贴边状态（内部会先夹取）
 * @returns 窗口 bounds（已夹进工作区）
 */
export function dockedWindowBounds(workArea: WorkArea, dock: DockState): Bounds {
  const safe = clampDock(dock, workArea)
  const width = FLOAT_WINDOW_WIDTH
  const height = FLOAT_WINDOW_HEIGHT
  if (isVerticalEdge(safe.edge)) {
    const y = safe.offset + BAR_LENGTH / 2 - height / 2
    const x = safe.edge === 'left' ? workArea.x : workArea.x + workArea.width - width
    return clampInto({ x, y, width, height }, workArea)
  }
  const x = safe.offset + BAR_LENGTH / 2 - width / 2
  const y = safe.edge === 'top' ? workArea.y : workArea.y + workArea.height - height
  return clampInto({ x, y, width, height }, workArea)
}

/**
 * @description 自由浮动时窗口的位置：沿用保存的窗口坐标并夹进工作区
 * @param placement 当前摆放（floating 时带坐标）
 * @param workArea 显示器工作区
 * @returns 窗口 bounds
 */
export function floatingWindowBounds(placement: FloatPlacement, workArea: WorkArea): Bounds {
  const x = placement.mode === 'floating' ? placement.x : workArea.x
  const y = placement.mode === 'floating' ? placement.y : workArea.y
  return clampInto({ x, y, width: FLOAT_WINDOW_WIDTH, height: FLOAT_WINDOW_HEIGHT }, workArea)
}

/**
 * @description 按摆放计算窗口矩形：贴边用吸附位置，自由浮动用保存坐标
 * @param workArea 显示器工作区
 * @param placement 当前摆放
 * @returns 窗口 bounds
 */
export function windowBounds(workArea: WorkArea, placement: FloatPlacement): Bounds {
  return placement.mode === 'floating'
    ? floatingWindowBounds(placement, workArea)
    : dockedWindowBounds(workArea, placement)
}

/**
 * @description 细条在屏幕上的矩形：hover 命中判定用，与页面里画出的细条完全一致
 * @param workArea 显示器工作区
 * @param dock 贴边状态
 * @returns 细条 bounds（屏幕坐标）
 */
export function pillBounds(workArea: WorkArea, dock: DockState): Bounds {
  const win = dockedWindowBounds(workArea, dock)
  const pill = pillRect(dock.edge)
  return { x: win.x + pill.x, y: win.y + pill.y, width: pill.width, height: pill.height }
}

/**
 * @description 卡片在屏幕上的矩形：判断指针是否还停在卡片上
 * @param win 窗口 bounds
 * @param edge 贴边方向
 * @returns 卡片 bounds（屏幕坐标）
 */
export function cardScreenBounds(win: Bounds, edge: DockEdge): Bounds {
  const rect = cardRect(edge)
  return { x: win.x + rect.x, y: win.y + rect.y, width: rect.width, height: rect.height }
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
