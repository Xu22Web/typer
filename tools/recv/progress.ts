/**
 * 进度视图：把"接收端状态"折算成一组**可直接排版**的字段，再按终端宽度选排版。
 *
 * 全部是纯函数（不读时钟、不写终端），因此：
 *   · 排版规则可以被单元测试逐字段断言（含"整行绝不超过终端宽度"这条硬约束）；
 *   · 采集状态与呈现方式解耦——换排版、换字段都不用碰接收逻辑。
 */
import { formatClock, formatPercent, formatRate, formatSize } from './format'
import { renderBar, spinnerFrame, type Segment, clipSegments, displayWidth } from './text'

/** 四个阶段：等待开始帧 / 收片中 / 等待补片 / 合并校验 */
export type Stage = 'waiting' | 'receiving' | 'awaiting' | 'merging'

/** 采集到的原始状态（由接收端在每次刷新时喂进来） */
export interface ViewInput {
  /** 当前时刻 */
  now: number
  /** 进程启动时刻 */
  startedAt: number
  /** 总片数（还没收到开始帧时为 null） */
  total: number | null
  /** 原始文件字节数（还不知道时为 null） */
  size: number | null
  /** 已通过校验的片数 */
  doneCount: number
  /** 失败（待重传）的片数 */
  failures: number
  /** 正在收的那一片：片号（0 基）与已收比例 */
  inFlight: { order: number; fraction: number } | null
  /** 合并进度（不在合并阶段时为 null） */
  merge: { done: number; total: number } | null
  /** 最近一段时间的收片速率（字节/秒），未知传 0 */
  rate: number
  /** 最后一次收到字节的时刻（判断"上游还活着吗"） */
  lastInputAt: number
  /** 多久没有输入就算断流（毫秒） */
  idleWarnMs: number
  /** 是否整文件压缩（合并阶段要给"解压中"而不是"校验中"） */
  compressed: boolean
  /** 续传：开始时目录里已有的片数（> 0 表示本轮是补发） */
  resumedChunks?: number
  /** 本轮新收下并通过校验的片数（与 `doneCount` 相减就是本次进度） */
  sessionDone?: number
  /** 已收到结束帧但还缺片：正在等补发，不能合并 */
  awaitingResume?: boolean
  /** 缺失片号的紧凑文本（已截断，等待补片时显示） */
  missingText?: string
}

/** 排版的输入：所有字段都已经折算好，布局函数不再做算术 */
export interface ProgressView {
  stage: Stage
  /** 整体进度（含正在收的那一片的片内进展，进度条因此是连续走的） */
  overall: number
  shardsDone: number
  shardsTotal: number
  /** 正在收第几片（1 基，给人看）；不在收片时为 null */
  shardOrdinal: number | null
  /** 当前片的片内比例；不在收片时为 null */
  shardFraction: number | null
  bytesDone: number
  bytesTotal: number
  rate: number
  /** 预计剩余毫秒；算不出来时为 null */
  etaMs: number | null
  elapsedMs: number
  /** 距最后一次收到字节过了多久 */
  idleMs: number
  failures: number
  /** 断流（超过 idleWarnMs 没有输入） */
  stalled: boolean
  /** 全部片已通过校验（正在等合并） */
  allReceived: boolean
  /** 合并阶段是否在解压 */
  compressed: boolean
  /** 续传模式：进度条字符与前缀都要区分，一眼能看出这是补发 */
  resumeMode: boolean
  /** 本轮已收片数 / 本轮目标片数（整任务减去已有片） */
  sessionDone: number
  sessionTotal: number
  /** 缺失片号文本（没有缺失时为空串） */
  missingText: string
  /** 正在等待补发（收到结束帧但缺片） */
  awaiting: boolean
}

/**
 * @description 把采集状态折算成排版字段
 * @param input 采集状态
 * @returns 排版视图
 */
export function buildView(input: ViewInput): ProgressView {
  const elapsedMs = Math.max(0, input.now - input.startedAt)
  const idleMs = Math.max(0, input.now - Math.max(input.lastInputAt, input.startedAt))
  const stalled = idleMs >= input.idleWarnMs

  // 续传：目录里已有的片算「之前就完成了」，本轮只关心剩下的
  const resumedChunks = Math.max(0, input.resumedChunks ?? 0)
  const resumeMode = resumedChunks > 0
  const sessionDone = Math.max(0, input.sessionDone ?? 0)
  const sessionTotal = Math.max(sessionDone, (input.total ?? 0) - resumedChunks)
  const missingText = input.missingText ?? ''
  const awaiting = input.awaitingResume === true && !input.merge

  if (input.merge) {
    const mergeTotal = Math.max(0, input.merge.total)
    const mergeDone = Math.max(0, Math.min(mergeTotal, input.merge.done))
    const overall = mergeTotal === 0 ? 1 : mergeDone / mergeTotal
    const bytesTotal = input.size ?? 0
    return {
      stage: 'merging',
      overall,
      shardsDone: input.doneCount,
      shardsTotal: input.total ?? mergeTotal,
      shardOrdinal: null,
      shardFraction: null,
      bytesDone: Math.round(bytesTotal * overall),
      bytesTotal,
      rate: 0,
      etaMs: null,
      elapsedMs,
      idleMs,
      failures: input.failures,
      stalled: false,
      allReceived: true,
      compressed: input.compressed,
      resumeMode,
      sessionDone,
      sessionTotal,
      missingText,
      awaiting: false
    }
  }

  if (input.total === null) {
    return {
      stage: 'waiting',
      overall: 0,
      shardsDone: 0,
      shardsTotal: 0,
      shardOrdinal: null,
      shardFraction: null,
      bytesDone: 0,
      bytesTotal: 0,
      rate: 0,
      etaMs: null,
      elapsedMs,
      idleMs,
      failures: 0,
      stalled,
      allReceived: false,
      compressed: input.compressed,
      resumeMode: false,
      sessionDone: 0,
      sessionTotal: 0,
      missingText: '',
      awaiting: false
    }
  }

  const total = Math.max(1, input.total)
  const doneCount = Math.max(0, Math.min(total, input.doneCount))
  // 正在收的那一片如果已经算进 done（重放/幂等路径），就不要再叠加，否则进度会超过 100%
  const inFlight =
    input.inFlight && input.inFlight.order < total && !isDoneAlready(input, input.inFlight.order)
      ? { order: input.inFlight.order, fraction: Math.max(0, Math.min(1, input.inFlight.fraction)) }
      : null
  const received = doneCount + (inFlight ? inFlight.fraction : 0)
  const overall = Math.max(0, Math.min(1, received / total))
  const bytesTotal = input.size ?? 0
  const bytesDone = Math.round(bytesTotal * overall)
  const remainingBytes = Math.max(0, bytesTotal - bytesDone)
  // 断流后旧的速率样本必须失效：否则「剩余时间」会定格在一个不再变化的数字上
  const rate = stalled ? 0 : input.rate > 0 ? input.rate : 0
  const etaMs = rate > 0 && remainingBytes > 0 ? (remainingBytes / rate) * 1000 : null

  return {
    stage: awaiting ? 'awaiting' : 'receiving',
    overall,
    shardsDone: doneCount,
    shardsTotal: total,
    shardOrdinal: inFlight ? inFlight.order + 1 : null,
    shardFraction: inFlight ? inFlight.fraction : null,
    bytesDone,
    bytesTotal,
    rate,
    etaMs,
    elapsedMs,
    idleMs,
    failures: input.failures,
    stalled,
    allReceived: doneCount >= total,
    compressed: input.compressed,
    resumeMode,
    sessionDone,
    sessionTotal,
    missingText,
    awaiting
  }
}

/**
 * @description 这一片是不是已经算完成了。
 *
 * `doneCount` 只是计数，接口里拿不到集合；这里用"正在收的片号是否小于已完成数"做保守判断：
 * 顺序接收时（绝大多数情况）足以避免重复累加，乱序重放时最多少算一点点，不会超过 100%。
 * @param input 采集状态
 * @param order 片号（0 基）
 * @returns 是否已完成
 */
function isDoneAlready(input: ViewInput, order: number): boolean {
  return input.doneCount > 0 && order < input.doneCount
}

/** 排版档位：宽（两行）/ 中（两行窄字段）/ 紧凑（一行）/ 纯文本一行（写日志） */
export type LayoutKind = 'wide' | 'medium' | 'compact' | 'plain'

/** 排版选项 */
export interface LayoutOptions {
  /** 终端列数（未知时用 80） */
  columns: number
  /** 最多几行（不支持光标上移的终端只能一行） */
  maxRows: 1 | 2
  /** 动画帧序号 */
  spinnerIndex: number
  /** `plain` 输出不带任何转义、也不做裁剪（日志要留全字段）；`inline` 按宽度裁剪 */
  mode: 'plain' | 'inline'
}

/** 一行里字段之间的分隔符 */
const SEP = '  '

/**
 * @description 选排版档位
 * @param options 排版选项
 * @returns 档位
 */
export function pickLayout(options: LayoutOptions): LayoutKind {
  if (options.mode === 'plain') return 'plain'
  if (options.maxRows < 2) return 'compact'
  return options.columns >= 92 ? 'wide' : 'medium'
}

/**
 * @description 生成进度行（每行都已裁到终端宽度以内）
 * @param view 排版视图
 * @param options 排版选项
 * @returns 每行的片段数组
 */
export function layoutProgress(view: ProgressView, options: LayoutOptions): Segment[][] {
  const kind = pickLayout(options)
  const rows = buildRows(view, options, kind)
  if (kind === 'plain') return rows
  const limit = Math.max(16, options.columns - 1)
  return rows.map((row) => clipSegments(row, limit))
}

/**
 * @description 各档位的实际拼装
 * @param view 排版视图
 * @param options 排版选项
 * @param kind 档位
 * @returns 每行片段
 */
function buildRows(view: ProgressView, options: LayoutOptions, kind: LayoutKind): Segment[][] {
  const barWidth = barWidthFor(kind, options.columns)
  if (view.stage === 'waiting') return waitingRows(view, options, kind)

  const prefix = statusSegments(view, options)
  // 进度条固定用方块字符；续传的区分交给前缀文字与「本次/整体」字段
  const bar = renderBar(view.overall, barWidth)
  const percent = formatPercent(view.overall, kind === 'compact' ? 0 : 1)
  const size = `${formatSize(view.bytesDone)}/${formatSize(view.bytesTotal)}`
  // 片数：续传时同时给出「本轮」与「整体」，两头的数字因此都能对上
  const shardsText = view.resumeMode
    ? `本次 ${view.sessionDone}/${view.sessionTotal} 片 · 整体 ${view.shardsDone}/${view.shardsTotal} 片`
    : `${view.shardsDone}/${view.shardsTotal} 片`

  if (view.stage === 'awaiting') return awaitingRows(view, kind, prefix)

  if (view.stage === 'merging') {
    const tail: Segment = {
      text: view.compressed ? '解压并校验 SHA-256' : '校验 SHA-256',
      style: 'dim'
    }
    if (kind === 'compact') {
      return [
        [
          ...prefix,
          { text: ` ${bar} ` },
          { text: percent, style: 'bold' },
          { text: ` ${view.shardsDone}/${view.shardsTotal} 片 ` },
          tail
        ]
      ]
    }
    if (kind === 'plain') {
      return [
        [
          ...prefix,
          { text: `  [${bar}]  ` },
          { text: percent, style: 'bold' },
          { text: `${SEP}${view.shardsDone}/${view.shardsTotal} 片` },
          { text: SEP },
          tail,
          { text: `${SEP}已用 ${formatClock(view.elapsedMs)}`, style: 'dim' }
        ]
      ]
    }
    return [
      [
        ...prefix,
        { text: `${SEP}${view.shardsDone}/${view.shardsTotal} 片` },
        { text: ` · 已用 ${formatClock(view.elapsedMs)}`, style: 'dim' }
      ],
      [
        { text: bar, style: 'accent' },
        { text: `  ${percent}`, style: 'bold' },
        { text: `${SEP}${size}` },
        { text: SEP },
        tail
      ]
    ]
  }

  const current: Segment | null =
    view.shardOrdinal !== null && view.shardFraction !== null && !view.allReceived
      ? { text: `当前片 ${formatPercent(view.shardFraction, 0)}`, style: 'dim' }
      : null
  const eta: Segment | null =
    view.etaMs !== null
      ? { text: `剩余 ${formatClock(view.etaMs)}` }
      : view.allReceived
        ? { text: '已收齐，准备合并', style: 'dim' }
        : view.stalled
          ? { text: '剩余 —', style: 'dim' }
          : view.shardsDone === 0 && view.shardOrdinal === null
            ? { text: '等待首片', style: 'dim' }
            : null
  const rate: Segment | null = view.rate > 0 ? { text: formatRate(view.rate) } : null
  const failed: Segment | null =
    view.failures > 0 ? { text: `失败 ${view.failures} 片`, style: 'err' } : null
  const progressFields: Segment[] = [
    { text: shardsText },
    ...(current ? [current] : []),
    ...(rate ? [rate] : []),
    ...(eta ? [eta] : []),
    ...(failed ? [failed] : [])
  ]

  if (kind === 'compact') {
    // 窄终端只有一行：用一个字表示状态——断流时直接把转圈换成感叹号，比什么都显眼
    const spin: Segment = {
      text: view.stalled ? '! ' : `${spinnerFrame(options.spinnerIndex)} `,
      style: view.stalled ? 'warn' : 'accent'
    }
    return [
      [
        spin,
        { text: bar, style: 'accent' },
        { text: ` ${percent}`, style: 'bold' },
        ...progressFields.map((segment) => ({ text: ` ${segment.text}`, style: segment.style }))
      ]
    ]
  }

  const currentSize = `${formatSize(view.bytesDone)}/${formatSize(view.bytesTotal)}`
  if (kind === 'plain') {
    return [
      [
        ...prefix,
        { text: `  [${bar}]  ` },
        { text: percent, style: 'bold' },
        { text: `${SEP}${shardsText}` },
        ...(current ? [{ text: `${SEP}${current.text}`, style: 'dim' as const }] : []),
        { text: `${SEP}${currentSize}` },
        ...(rate ? [{ text: `${SEP}${rate.text}` }] : []),
        ...(eta ? [{ text: `${SEP}${eta.text}`, style: eta.style }] : []),
        ...(failed ? [{ text: `${SEP}${failed.text}`, style: 'err' as const }] : []),
        { text: `${SEP}已用 ${formatClock(view.elapsedMs)}`, style: 'dim' }
      ]
    ]
  }

  if (kind === 'medium') {
    return [
      [
        ...prefix,
        { text: `${SEP}${shardsText}` },
        ...(current ? [{ text: ` · ${current.text}`, style: 'dim' as const }] : [])
      ],
      [
        { text: bar, style: 'accent' },
        { text: `  ${percent}`, style: 'bold' },
        { text: `${SEP}${currentSize}` },
        ...(rate ? [{ text: `${SEP}${rate.text}` }] : []),
        ...(eta ? [{ text: `${SEP}${eta.text}`, style: eta.style }] : []),
        ...(failed ? [{ text: `${SEP}${failed.text}`, style: 'err' as const }] : [])
      ]
    ]
  }

  return [
    [
      ...prefix,
      { text: `${SEP}${shardsText}` },
      ...(current ? [{ text: ` · ${current.text}`, style: 'dim' as const }] : []),
      { text: ` · 已用 ${formatClock(view.elapsedMs)}`, style: 'dim' },
      ...(failed ? [{ text: ` · ${failed.text}`, style: 'err' as const }] : [])
    ],
    [
      { text: bar, style: 'accent' },
      { text: `  ${percent}`, style: 'bold' },
      { text: `${SEP}${currentSize}` },
      ...(rate ? [{ text: `${SEP}${rate.text}` }] : []),
      ...(eta ? [{ text: `${SEP}${eta.text}`, style: eta.style }] : [])
    ]
  ]
}

/**
 * @description 等待阶段的排版：只报"等了多久"和一句该干什么
 * @param view 排版视图
 * @param options 排版选项
 * @param kind 档位
 * @returns 每行片段
 */
function waitingRows(view: ProgressView, options: LayoutOptions, kind: LayoutKind): Segment[][] {
  const prefix = statusSegments(view, options)
  const waited = { text: `已等 ${formatClock(view.elapsedMs)}`, style: 'dim' as const }
  if (kind === 'compact') return [[...prefix, { text: ' · ' }, waited]]
  if (kind === 'plain') {
    return [
      [
        ...prefix,
        { text: SEP },
        waited,
        { text: `${SEP}在 Typer 里点「发送」后开始；本窗口要保持在前台`, style: 'dim' }
      ]
    ]
  }
  return [
    [...prefix, { text: ` · ` }, waited],
    [
      {
        text: '在 Typer 里点「发送」后开始收片；本窗口请保持在前台',
        style: 'dim'
      }
    ]
  ]
}

/**
 * @description 等待补片的排版：此处不画进度条（没有新数据在动），而是把「缺多少、缺哪几片、
 * 已经等了多久」放在一行里——用户不用回头翻日志就知道现在卡在哪。
 * @param view 排版视图
 * @param kind 档位
 * @param prefix 状态前缀（已含断流提示）
 * @returns 每行片段
 */
function awaitingRows(view: ProgressView, kind: LayoutKind, prefix: Segment[]): Segment[][] {
  const missing = view.missingText.length > 0 ? `缺 ${view.missingText}` : '缺片'
  const shardsText = view.resumeMode
    ? `本次 ${view.sessionDone}/${view.sessionTotal} 片 · 整体 ${view.shardsDone}/${view.shardsTotal} 片`
    : `${view.shardsDone}/${view.shardsTotal} 片`
  if (kind === 'compact') {
    return [[...prefix, { text: ` ${shardsText} · ${missing}` }]]
  }
  if (kind === 'plain') {
    return [
      [
        ...prefix,
        { text: `${SEP}${shardsText}` },
        { text: `${SEP}${missing}` },
        { text: `${SEP}等待补发，收齐后自动合并`, style: 'dim' }
      ]
    ]
  }
  return [
    [...prefix, { text: `${SEP}${shardsText}` }, { text: ` · ${missing}`, style: 'warn' }],
    [
      {
        text: '在 Typer 里粘贴 @T2R 令牌只补缺失片；收齐后会自动合并校验',
        style: 'dim'
      }
    ]
  ]
}

/**
 * @description 状态前缀：转圈 + 阶段名（断流时整段变黄，并在后面写明没有输入多久）
 * @param view 排版视图
 * @param options 排版选项
 * @returns 片段
 */
function statusSegments(view: ProgressView, options: LayoutOptions): Segment[] {
  const label =
    view.stage === 'waiting'
      ? '等待开始帧'
      : view.stage === 'merging'
        ? '合并校验'
        : view.stage === 'awaiting'
          ? '等待补片'
          : view.resumeMode
            ? '续传中'
            : '接收中'
  const style = view.stalled ? 'warn' : 'accent'
  // 写日志（重定向到文件 / 管道）时不画转圈：它会变成一行一个的垃圾字符
  const head = options.mode === 'plain' ? label : `${spinnerFrame(options.spinnerIndex)} ${label}`
  const out: Segment[] = [{ text: head, style }]
  if (view.stalled) out.push({ text: `（无输入 ${formatClock(view.idleMs)}）`, style: 'warn' })
  return out
}

/**
 * @description 进度条宽度：宽档多给一点，窄终端按剩余空间收缩
 * @param kind 档位
 * @param columns 终端列数
 * @returns 格数
 */
function barWidthFor(kind: LayoutKind, columns: number): number {
  if (kind === 'plain') return 20
  if (kind === 'compact') return Math.max(8, Math.min(16, columns - 44))
  if (kind === 'medium') return Math.max(10, Math.min(28, columns - 44))
  return Math.max(14, Math.min(34, columns - 68))
}

/**
 * @description 给纯文本行估值（测试与自检用：断言"这行放得下"）
 * @param row 一行片段
 * @returns 可见格数
 */
export function rowWidth(row: readonly Segment[]): number {
  return row.reduce((sum, segment) => sum + displayWidth(segment.text), 0)
}
