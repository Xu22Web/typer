import { describe, expect, it } from 'vitest'
import {
  buildView,
  layoutProgress,
  pickLayout,
  rowWidth,
  type LayoutOptions,
  type ViewInput
} from '../../../tools/recv/progress'
import {
  displayWidth,
  clipText,
  plainText,
  renderBar,
  spinnerFrame
} from '../../../tools/recv/text'
import {
  formatClock,
  formatPercent,
  formatRate,
  formatSize,
  formatSpan
} from '../../../tools/recv/format'

/**
 * 接收端排版层是纯函数，可以脱离终端逐字段断言。
 *
 * 这里最要紧的一条是"任何宽度下每行都不超宽"：终端一旦把行折行，原地重绘就会错位，
 * 用户看到的就是"有时原地刷新、有时一行行往上滚"——旧版正是踩在这里。
 */
const base: ViewInput = {
  now: 42_000,
  startedAt: 0,
  total: 8,
  size: 60_000,
  doneCount: 5,
  failures: 0,
  inFlight: { order: 5, fraction: 0.63 },
  merge: null,
  rate: 14_500,
  lastInputAt: 42_000,
  idleWarnMs: 10_000,
  compressed: true
}

/**
 * @description 生成一份排版选项
 * @param overrides 覆盖项
 * @returns 选项
 */
function options(overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  return {
    columns: 100,
    unicode: true,
    maxRows: 2,
    spinnerIndex: 1,
    mode: 'inline',
    ...overrides
  }
}

describe('接收端排版 · 文本宽度', () => {
  it('中文与全角符号按两格算（旧版按字符数补空格，行会超宽被折行）', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('接收中')).toBe(6)
    expect(displayWidth('，')).toBe(2)
    expect(displayWidth('\u280b')).toBe(1)
  })

  it('裁剪后的可见宽度绝不超过给定宽度', () => {
    const text = '接收中 5/8 片 · 当前片 63% · 已用 00:42 · 剩余 00:01'
    for (let width = 1; width <= displayWidth(text); width++) {
      expect(displayWidth(clipText(text, width))).toBeLessThanOrEqual(width)
    }
  })

  it('进度条按比例填充，且总宽不变', () => {
    expect(renderBar(0, 10, false)).toBe('----------')
    expect(renderBar(1, 10, false)).toBe('##########')
    expect(renderBar(0.5, 10, true)).toBe('█████░░░░░')
    expect(displayWidth(renderBar(0.37, 20, true))).toBe(20)
  })

  it('转圈帧循环且永不越界', () => {
    expect(spinnerFrame(0, false)).toBe('|')
    expect(spinnerFrame(4, false)).toBe('|')
    expect(spinnerFrame(-1, true)).toBeTruthy()
  })
})

describe('接收端排版 · 格式化', () => {
  it('大小 / 速率 / 时长 / 百分比', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(12 * 1024)).toBe('12 KB')
    expect(formatRate(0)).toBe('--')
    expect(formatRate(14_500)).toBe('14 KB/s')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(65_000)).toBe('01:05')
    expect(formatClock(3_930_000)).toBe('1:05:30')
    expect(formatSpan(8_000)).toBe('8 秒')
    expect(formatSpan(200_000)).toBe('3 分 20 秒')
    expect(formatPercent(0.625)).toBe('62.5%')
    expect(formatPercent(1.5)).toBe('100.0%')
  })
})

describe('接收端排版 · 视图折算', () => {
  it('整体进度含“正在收的那一片”的片内进展（进度条连续走，不是一格一跳）', () => {
    const view = buildView(base)
    expect(view.stage).toBe('receiving')
    expect(view.shardsDone).toBe(5)
    expect(view.shardOrdinal).toBe(6)
    expect(view.overall).toBeCloseTo((5 + 0.63) / 8, 5)
    expect(view.bytesDone).toBe(Math.round(60_000 * ((5 + 0.63) / 8)))
    expect(view.etaMs).toBeGreaterThan(0)
  })

  it('已经开始收的片不会重复累加（重放同一片时进度不会超过 100%）', () => {
    const view = buildView({ ...base, doneCount: 6, inFlight: { order: 5, fraction: 0.9 } })
    expect(view.overall).toBeCloseTo(6 / 8, 5)
    expect(view.shardOrdinal).toBeNull()
  })

  it('还没收到开始帧时是等待阶段，不算速率也不算剩余', () => {
    const view = buildView({
      ...base,
      total: null,
      size: null,
      doneCount: 0,
      inFlight: null,
      rate: 0
    })
    expect(view.stage).toBe('waiting')
    expect(view.overall).toBe(0)
    expect(view.etaMs).toBeNull()
    expect(view.elapsedMs).toBe(42_000)
  })

  it('合并阶段按片数报进度，并保留“已收齐”的状态', () => {
    const view = buildView({ ...base, doneCount: 8, inFlight: null, merge: { done: 4, total: 8 } })
    expect(view.stage).toBe('merging')
    expect(view.overall).toBe(0.5)
    expect(view.shardsDone).toBe(8)
    expect(view.compressed).toBe(true)
  })

  it('断流按“最后一次收到字节”判定', () => {
    expect(buildView({ ...base, lastInputAt: 42_000 }).stalled).toBe(false)
    expect(buildView({ ...base, now: 53_000, lastInputAt: 42_000 }).stalled).toBe(true)
  })
})

describe('接收端排版 · 档位与不超宽', () => {
  it('按宽度选档位：宽 / 中 / 单行', () => {
    expect(pickLayout(options({ columns: 120 }))).toBe('wide')
    expect(pickLayout(options({ columns: 80 }))).toBe('medium')
    expect(pickLayout(options({ columns: 80, maxRows: 1 }))).toBe('compact')
    expect(pickLayout(options({ mode: 'plain' }))).toBe('plain')
  })

  it('每个阶段 × 每种宽度：行数不超过上限，且每行都不超宽', () => {
    const views = [
      buildView({ ...base, total: null, size: null, doneCount: 0, inFlight: null, rate: 0 }),
      buildView(base),
      buildView({ ...base, doneCount: 8, inFlight: null }),
      buildView({ ...base, doneCount: 8, inFlight: null, merge: { done: 3, total: 8 } }),
      buildView({ ...base, now: 60_000, lastInputAt: 42_000 })
    ]
    for (const view of views) {
      for (const columns of [24, 40, 52, 60, 76, 92, 100, 160]) {
        for (const maxRows of [1, 2] as const) {
          const rows = layoutProgress(view, options({ columns, maxRows }))
          expect(rows.length).toBeGreaterThan(0)
          expect(rows.length).toBeLessThanOrEqual(maxRows)
          for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('宽档两行：标题行有片数与当前片，进度行有进度条与速率', () => {
    const rows = layoutProgress(buildView(base), options({ columns: 120 }))
    expect(rows).toHaveLength(2)
    const [head, bar] = rows as [(typeof rows)[0], (typeof rows)[0]]
    expect(plainText(head)).toContain('5/8 片')
    expect(plainText(head)).toContain('当前片 63%')
    expect(plainText(head)).toContain('已用')
    expect(plainText(bar)).toContain('70.4%')
    expect(plainText(bar)).toContain('KB/s')
    expect(plainText(bar)).toContain('剩余')
  })

  it('日志模式（plain）只有一行、不带转义序列与转圈', () => {
    const rows = layoutProgress(buildView(base), options({ mode: 'plain' }))
    expect(rows).toHaveLength(1)
    const text = plainText(rows[0] as never)
    expect(text).toContain('接收中')
    expect(text).toContain('5/8 片')
    expect(text).toContain('已用 00:42')
    // eslint-disable-next-line no-control-regex -- 断言日志里没有 ESC 序列
    expect(text).not.toMatch(/\u001b\[/)
    expect(text).not.toContain('|')
  })

  it('单行档在断流时用感叹号顶上转圈（窄终端也要一眼看出不对）', () => {
    const stalled = buildView({ ...base, now: 60_000, lastInputAt: 42_000 })
    const rows = layoutProgress(stalled, options({ columns: 60, maxRows: 1 }))
    expect(plainText(rows[0] as never).startsWith('! ')).toBe(true)
  })

  it('合并阶段有片数与“解压”提示（压缩档才说解压）', () => {
    const merging = buildView({
      ...base,
      doneCount: 8,
      inFlight: null,
      merge: { done: 8, total: 8 }
    })
    const rows = layoutProgress(merging, options({ columns: 120 }))
    const text = rows.map((row) => plainText(row)).join('\n')
    expect(text).toContain('合并校验')
    expect(text).toContain('8/8 片')
    expect(text).toContain('解压并校验 SHA-256')
  })
})
