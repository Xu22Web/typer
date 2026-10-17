import { buildPlan, countTypedActions, iterateActions, type PlanOptions } from '../planner/plan'
import { describeSkipped } from '../planner/text'
import type { KeyboardDriver } from '../drivers/KeyboardDriver'
import type { HostForegroundData, HostTypeData, ScheduledAction } from '../drivers/protocol'
import { toHostItems } from '../drivers/protocol'
import { createRng, resolveSeed, type Rng } from '../scheduling/rng'
import {
  PROFILE_LIMITS,
  TRANSFER_PACE_LIMITS,
  textBatchWindowMs,
  type InjectionProfile,
  type TransferPace
} from '../scheduling/profile'
import {
  baseIntervalMsFor,
  coalesceDelays,
  FRAME_MODE_TIMING,
  TimingScheduler,
  type TimingSettings
} from '../scheduling/timing'
import type { TypoCorrection, TypoOptions, TypoStyle } from '../scheduling/typo'
import { FocusGuard, type FocusGuardMode, type FocusSnapshot } from '../focus/focusGuard'
import { computeProgress, type ProgressFrames, type ProgressSnapshot } from './progress'
import { isBusy, type EngineSnapshot, type EngineState } from './states'

/**
 * 一次输入任务的来源。
 *
 * `text` 是现有路径：把文本按字符规划成动作（含错字、停顿等全部拟人特性）；
 * `frames` 是文件传输路径：逐"帧"发送（每片一行）、不使用错字（打错会破坏数据），
 * 并支持只发送一部分片（续传 / 定点重传）。
 */
export type TypingRequest =
  | { kind: 'text'; text: string }
  | {
      kind: 'frames'
      jobId: string
      /** 任务总片数（用于日志与进度文案） */
      total: number
      /** 本次要发送的片号（升序；可以是全量、缺失片或指定片） */
      indexes: number[]
      /** 渲染某一帧（返回不含换行的单行文本） */
      render: (index: number) => Promise<string> | string
      /** 某一帧的字符数（用于进度总量与耗时预估，不触发磁盘读取） */
      charsOf: (index: number) => number
      /** 开始帧：接收端据此建立任务；续传时可省略 */
      begin?: () => string
      /** 结束帧：通知接收端可以合并校验；只发部分片时应省略 */
      end?: () => string
      /** 每帧发送结果回调（成功/失败原因） */
      onFrame?: (index: number, ok: boolean, error?: string) => void
    }

/** 引擎需要的设置子集（由设置层派生，测试可直接构造）。 */
export interface EngineSettings {
  startDelayMs: number
  chunkSize: number
  layout: string
  forceUnicodeForAll: boolean
  focusGuard: FocusGuardMode
  seed: number
  /** 完成后自检是否有按键粘住 */
  verifyStuckKeys: boolean
  /** 注入档位：normal 逐字（默认），turbo 攒批 + 零下限 */
  profile?: InjectionProfile
  /** 文件传输节奏档：safe 每字符 1ms（默认），fast 交给压力阀 */
  transferPace?: TransferPace
  /** 文件传输：片与片之间的额外停顿（给接收端落盘/回显留时间） */
  interFrameDelayMs?: number
  timing: TimingSettings
  typo: {
    rate: number
    style: TypoStyle
    correction: TypoCorrection
  }
}

export interface EngineDeps {
  driver: KeyboardDriver
  /** 可取消的等待：`shouldContinue()` 返回 false 时应尽快结束等待 */
  sleep: (ms: number, shouldContinue: () => boolean) => Promise<void>
  now: () => number
  /** 随机源工厂：保证"计数"与"产出"两次遍历得到相同结果 */
  createRng?: (seed: number) => Rng
  onState?: (snapshot: EngineSnapshot) => void
  onProgress?: (snapshot: ProgressSnapshot) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 进度事件节流（毫秒），默认 100 */
  progressIntervalMs?: number
}

export interface RunResult {
  state: 'completed' | 'aborted' | 'failed'
  typed: number
  total: number
  elapsedMs: number
  /** 实际使用的种子（便于复现节奏） */
  seed: number
  error?: Error
}

/** 倒计时每片最长 100ms，保证中止响应足够快。 */
const COUNTDOWN_TICK_MS = 100

/** 宿主因目标端消化不过来而额外等待超过这个时长（毫秒）时提醒一次 */
const PRESSURE_WARN_MS = 300

/** 单批至少下发多少个动作（极速档按实测速率调整批次大小时的兜底） */
const MIN_ACTIONS_PER_REQUEST = 32

/**
 * 极速档每次 `SendInput` 至少攒多少个动作。
 * 目标端"被唤醒一次"的固定开销通常远大于逐字符开销：同一个目标下，每 8 个字符下发一次
 * 只有约 76 字符/秒，每 128 个字符下发一次能到约 370 字符/秒。32 是节奏抖动与吞吐的折中。
 */
const TURBO_MIN_GROUP = 32

/**
 * 输入引擎：倒计时 → 分块下发动作 → 暂停/继续/中止。
 *
 * 驱动、时钟与随机源全部注入，因此可以用假时钟 + Mock 驱动做确定性测试；以 chunk 为单位下发，
 * chunk 之间检查暂停/中止，使"紧急停止"延迟不超过一个 chunk；任何结束路径（完成/中止/异常）
 * 都会 `releaseAll`，避免修饰键粘住。
 */
export class TypingEngine {
  private readonly driver: KeyboardDriver
  private stateValue: EngineState = 'idle'
  private typedCount = 0
  private totalCount = 0
  private startedAt = 0
  private lastProgressAt = 0
  private countdownRemainingMs = 0
  private aborted = false
  private abortReason = ''
  private paused = false
  private resumeWaiters: Array<() => void> = []
  private running = false
  private disposed = false
  private baseIntervalMs = 60
  /** 文件传输任务的片进度（文本任务为 null） */
  private frames: ProgressFrames | null = null
  /** 本次运行是否已提醒过"目标端消化不过来" */
  private pressureWarned = false
  /** 上一批注入结束时宿主看到的前台窗口：焦点守护用它替代额外的往返查询 */
  private lastForeground: HostForegroundData | null = null
  /** 单个请求的动作数（极速档按实测速率调整，保证暂停/停止的粒度） */
  private actionsPerRequest = 0

  /**
   * @description 保存注入的依赖（驱动、时钟、随机源与回调）
   * @param deps 引擎依赖
   */
  constructor(private readonly deps: EngineDeps) {
    this.driver = deps.driver
  }

  /** @description 当前引擎状态 */
  get state(): EngineState {
    return this.stateValue
  }

  /** @description 供 UI 渲染的状态快照（含已输入数与倒计时剩余） */
  get snapshot(): EngineSnapshot {
    return {
      state: this.stateValue,
      typed: this.typedCount,
      total: this.totalCount,
      countdownRemainingMs: this.countdownRemainingMs
    }
  }

  /** @description 是否正在执行一次输入（含倒计时与暂停） */
  get isRunning(): boolean {
    return this.running
  }

  /**
   * @description 开始一次输入；重复调用会被拒绝（不会产生两条并行输入流）
   * @param request 任务来源，字符串等价于文本任务
   * @param settings 引擎设置子集
   * @returns 本次运行的结果（终态、计数、耗时与所用种子）
   */
  async start(request: TypingRequest | string, settings: EngineSettings): Promise<RunResult> {
    if (this.disposed) throw new Error('引擎已释放')
    if (isBusy(this.stateValue)) {
      throw new Error('已有输入任务正在进行，请先停止')
    }

    // 兼容原有调用方：字符串等价于文本任务
    const task: TypingRequest =
      typeof request === 'string' ? { kind: 'text', text: request } : request

    this.aborted = false
    this.abortReason = ''
    this.paused = false
    this.resumeWaiters = []
    this.typedCount = 0
    this.totalCount = 0
    this.countdownRemainingMs = 0
    this.pressureWarned = false
    this.lastForeground = null
    this.actionsPerRequest = Math.max(1, settings.chunkSize)
    this.frames =
      task.kind === 'frames'
        ? { done: 0, total: task.indexes.length, lastIndex: -1, failed: 0 }
        : null
    this.baseIntervalMs = Math.max(1, baseIntervalMsFor(settings.timing))
    this.running = true

    const seed = resolveSeed(settings.seed)
    const rngFactory = this.deps.createRng ?? createRng

    let error: Error | undefined
    let outcome: RunResult['state'] = 'completed'

    try {
      outcome = await this.runOnce(task, settings, seed, rngFactory)
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught))
      outcome = 'failed'
      this.deps.onLog?.('error', `输入失败：${error.message}`)
    } finally {
      // 任何路径都必须释放修饰键，避免"粘键"
      try {
        await this.driver.releaseAll()
      } catch (releaseError) {
        this.deps.onLog?.(
          'warn',
          `释放修饰键失败：${
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          }`
        )
      }

      this.running = false
      if (error) this.setState('failed', error.message)
      else if (outcome === 'aborted') this.setState('aborted', this.abortReason || '已中止')
      else this.setState('completed')
      this.emitProgress(true)
    }

    return {
      state: outcome,
      typed: this.typedCount,
      total: this.totalCount,
      elapsedMs: Math.max(0, this.deps.now() - this.startedAt),
      seed,
      error
    }
  }

  /**
   * @description 执行一次完整任务：倒计时 → 记录目标窗口 → 分派到文本或文件传输路径
   * @param task 任务定义
   * @param settings 引擎设置子集
   * @param seed 本次使用的随机种子
   * @param rngFactory 随机源工厂；"计数"与"产出"两次遍历必须各自新建同种子的实例
   * @returns 本次运行的终态
   */
  private async runOnce(
    task: TypingRequest,
    settings: EngineSettings,
    seed: number,
    rngFactory: (seed: number) => Rng
  ): Promise<RunResult['state']> {
    // 1) 倒计时
    this.setState('countdown')
    this.startedAt = this.deps.now()
    const deadline = this.startedAt + Math.max(0, settings.startDelayMs)
    while (this.deps.now() < deadline) {
      if (this.aborted) return 'aborted'
      const remaining = deadline - this.deps.now()
      this.countdownRemainingMs = remaining
      this.emitProgress(true)
      await this.deps.sleep(
        Math.min(COUNTDOWN_TICK_MS, Math.max(1, remaining)),
        () => !this.aborted
      )
    }
    this.countdownRemainingMs = 0

    // 2) 记录目标窗口（焦点守护）
    const guard = new FocusGuard(settings.focusGuard, this.driver)
    const expectedFocus = await guard.capture()

    // 3) 分派：文件传输（逐帧）与文本输入是两条独立路径，互不影响
    if (task.kind === 'frames') {
      return this.runFrameJob(task, settings, seed, rngFactory, guard, expectedFocus)
    }
    return this.runTextJob(task.text, settings, seed, rngFactory, guard, expectedFocus)
  }

  /**
   * @description 文本任务：统计动作总数 → 空文本短路 → 逐块下发真实按键
   * @param text 待输入文本
   * @param settings 引擎设置子集
   * @param seed 本次使用的随机种子
   * @param rngFactory 随机源工厂
   * @param guard 焦点守护
   * @param expectedFocus 倒计时前记录的目标窗口
   * @returns 本次运行的终态
   */
  private async runTextJob(
    text: string,
    settings: EngineSettings,
    seed: number,
    rngFactory: (seed: number) => Rng,
    guard: FocusGuard,
    expectedFocus: FocusSnapshot | null
  ): Promise<RunResult['state']> {
    const planBase: PlanOptions = {
      layout: settings.layout,
      forceUnicodeForAll: settings.forceUnicodeForAll
    }

    // 统计动作总数：与产出使用"同种子、同起点"的独立随机源，保证总数准确
    const typoOptions: TypoOptions = {
      rate: settings.typo.rate,
      style: settings.typo.style,
      correction: settings.typo.correction,
      rng: rngFactory(seed)
    }
    this.totalCount = countTypedActions(text, { ...planBase, typo: typoOptions })

    const preview = buildPlan(text, planBase)
    if (Object.keys(preview.stats.skipped).length > 0) {
      this.deps.onLog?.('warn', `已跳过不可输入字符：${describeSkipped(preview.stats.skipped)}`)
    }

    if (this.aborted) return 'aborted'

    // 4) 空文本：直接完成，不启动宿主
    if (this.totalCount === 0) {
      this.emitProgress(true)
      return 'completed'
    }

    this.setState('running')

    // 5) 逐块输入
    await this.driver.start()

    const profile = settings.profile ?? 'normal'
    const limits = PROFILE_LIMITS[profile]
    const scheduler = new TimingScheduler(settings.timing, rngFactory(seed), limits.minDelayMs)
    const actions = iterateActions(text, {
      ...planBase,
      typo: { ...typoOptions, rng: rngFactory(seed) }
    })

    const maxChunk = Math.max(1, settings.chunkSize)
    // 攒批窗口：极速档按间隔自适应，标准档只在接近人速上限时合并两个相邻动作
    const batchWindow = textBatchWindowMs(profile, baseIntervalMsFor(settings.timing))
    let chunk: ScheduledAction[] = []
    /** 本批累计的计划时长：与动作数一起限制单个请求的大小 */
    let chunkMs = 0

    /**
     * @description 下发当前累积的一批动作（必要时先等待暂停结束并复核焦点）
     * @returns 是否成功下发；false 表示已中止
     */
    const flush = async (): Promise<boolean> => {
      if (chunk.length === 0) return true
      if (this.aborted) return false

      if (this.paused) {
        this.setState('paused')
        await this.waitWhilePaused()
        if (this.aborted) return false
        this.setState('running')
      }

      const verdict = await this.checkFocus(guard, expectedFocus)
      if (verdict.changed) {
        this.deps.onLog?.('warn', verdict.warning ?? '前台窗口已变化')
        if (verdict.blocked) {
          this.abortReason = verdict.warning ?? '前台窗口已变化'
          return false
        }
      }

      const pending = chunk
      chunk = []
      chunkMs = 0
      const startedAt = this.deps.now()
      const outgoing =
        batchWindow > 0
          ? coalesceDelays(pending, batchWindow, profile === 'turbo' ? TURBO_MIN_GROUP : 1)
          : pending
      const result = await this.driver.send(toHostItems(outgoing))
      this.lastForeground = result.foreground ?? null
      // 被中止打断的批次只注入了一部分，别把它算进进度
      if (result.cancelled) return false
      this.typedCount += pending.length
      this.noteHostPressure(result)
      this.emitProgress(false)
      this.retuneActionsPerRequest(
        pending.length,
        this.deps.now() - startedAt,
        maxChunk,
        limits.batchBudgetMs
      )
      return true
    }

    for (const action of actions) {
      if (this.aborted) return 'aborted'
      const delayMs = scheduler.delayFor(action)
      chunk.push({ action, delayMs })
      chunkMs += delayMs
      const overTime = limits.batchBudgetMs > 0 && chunkMs >= limits.batchBudgetMs
      if (chunk.length >= this.actionsPerRequest || overTime) {
        const ok = await flush()
        if (!ok) return 'aborted'
      }
    }

    if (!(await flush())) return 'aborted'

    if (settings.verifyStuckKeys) await this.probeStuckKeys()

    this.emitProgress(true)
    return 'completed'
  }

  /**
   * @description 文件传输任务：逐帧发送（每片一行），**逐字符真实按键**；不打错字（错字会直接破坏数据），
   * 一片下发完毕再发下一片且片间可加停顿（让接收端总在完整的一行上做校验）。
   * 帧内节奏使用确定性节奏 {@link FRAME_MODE_TIMING}，因此帧模式不读取 `settings.timing`、
   * 不读取 `settings.typo`，也不使用随机源（随机化只会拖慢传输并让失败不可复现）；
   * 片间断顿只发生在片与片之间，稳健档由 `settings.interFrameDelayMs` 控制，极速档不留停顿。
   * @param task 文件传输任务
   * @param settings 引擎设置子集
   * @param seed 本次使用的随机种子
   * @param rngFactory 随机源工厂；帧模式不使用随机性，仅为保持签名一致而接收
   * @param guard 焦点守护
   * @param expectedFocus 倒计时前记录的目标窗口
   * @returns 本次运行的终态
   */
  private async runFrameJob(
    task: Extract<TypingRequest, { kind: 'frames' }>,
    settings: EngineSettings,
    seed: number,
    rngFactory: (seed: number) => Rng,
    guard: FocusGuard,
    expectedFocus: FocusSnapshot | null
  ): Promise<RunResult['state']> {
    const planBase: PlanOptions = {
      layout: settings.layout,
      // 帧是数据：必须与目标窗口的布局、输入法状态无关。目标端若开着中文输入法（中文态），
      // 真实按键会被候选窗吞掉（连回车都可能被当成"提交候选"），数据直接丢失且不报错。
      // 因此正文走 Unicode 报文、换行也走 Unicode CR 报文（见 resolveChar）。
      forceUnicodeForAll: true,
      lineEnding: 'cr'
    }
    const beginText = task.begin?.()
    const endText = task.end?.()

    // 总量：开始帧 + 每片（帧字符 + 行尾）+ 结束帧，全部由 charsOf 提供，无需读文件
    let total = 0
    if (beginText) total += beginText.length + 1
    for (const index of task.indexes) total += Math.max(0, task.charsOf(index)) + 1
    if (endText) total += endText.length + 1
    this.totalCount = total

    if (this.aborted) return 'aborted'

    this.emitProgress(true)
    this.setState('running')

    await this.driver.start()

    const pace = TRANSFER_PACE_LIMITS[settings.transferPace ?? 'safe']
    const scheduler = new TimingScheduler(FRAME_MODE_TIMING, rngFactory(seed), pace.minDelayMs)
    const interFrameDelay =
      pace.frameGapMs ?? Math.max(0, Math.round(settings.interFrameDelayMs ?? 0))

    /**
     * @description 按节奏下发一段文本（不带行尾换行）。
     *
     * 帧是**数据**：丢一个字符整片就废了，因此这里每个字符单独一次 `SendInput`（`perItem`），
     * 由宿主在两个字符之间等待。实测（真实终端接收端，27,657 字符）：逐字符投递 + 1ms 间隔零丢失；
     * 一次投递多个字符或零延迟快投则会静默丢字符。
     * @param text 要输入的文本
     * @returns 是否全部下发完成；false 表示已中止
     */
    const sendText = async (text: string): Promise<boolean> => {
      // 帧一律走"逐字符 + 宿主侧等待"的路径：帧是数据，丢一个字符整片就作废，
      // 因此不使用"零延迟攒批直投"的快路径（实测真实终端下它会静默丢字符）。
      const items = toHostItems(
        coalesceDelays(
          Array.from(iterateActions(text, { ...planBase, typo: null }), (action) => ({
            action,
            delayMs: scheduler.delayFor(action)
          })),
          pace.batchWindowMs
        )
      )

      for (let offset = 0; offset < items.length; offset += pace.batchActions) {
        // 中止只在下发之间生效：子批大小决定了"紧急停止"的延迟上限
        if (this.aborted) return false
        const batch = items.slice(offset, offset + pace.batchActions)
        const result = await this.driver.send(batch, { perItem: true })
        this.lastForeground = result.foreground ?? null
        this.noteHostPressure(result)
        if (result.cancelled) return false
        this.typedCount += batch.length
        this.emitProgress(false)
      }

      return true
    }

    /**
     * @description 发送一整帧（帧内容 + 行尾换行，逐字符按键）
     * @param text 帧内容（不含行尾换行）
     * @returns 是否发送完成；false 表示已中止
     */
    const sendFrame = async (text: string): Promise<boolean> => {
      const completed = await sendText(`${text}\n`)
      this.emitProgress(false)
      return completed
    }

    /**
     * @description 复核前台窗口；窗口变化时记录警告，strict 模式下中止
     * @returns 是否继续发送
     */
    const verifyFocus = async (): Promise<boolean> => {
      const verdict = await this.checkFocus(guard, expectedFocus)
      if (!verdict.changed) return true
      this.deps.onLog?.('warn', verdict.warning ?? '前台窗口已变化')
      if (verdict.blocked) {
        this.abortReason = verdict.warning ?? '前台窗口已变化'
        return false
      }
      return true
    }

    try {
      if (beginText) {
        if (!(await verifyFocus())) return 'aborted'
        if (!(await sendFrame(beginText))) return 'aborted'
      }

      let sent = 0
      for (const index of task.indexes) {
        if (this.aborted) return 'aborted'

        // 暂停：在片与片之间等待（不会把半行留在目标窗口里）
        if (this.paused) {
          this.setState('paused')
          await this.waitWhilePaused()
          if (this.aborted) return 'aborted'
          this.setState('running')
        }

        if (!(await verifyFocus())) return 'aborted'

        let text: string
        try {
          text = String(await task.render(index))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.markFrameFailed(index, message)
          task.onFrame?.(index, false, message)
          continue
        }

        if (!(await sendFrame(text))) return 'aborted'

        sent += 1
        this.markFrameDone(index)
        task.onFrame?.(index, true)

        if (sent < task.indexes.length && interFrameDelay > 0) {
          await this.deps.sleep(interFrameDelay, () => !this.aborted)
        }
      }

      if (endText) {
        if (!(await verifyFocus())) return 'aborted'
        if (!(await sendFrame(endText))) return 'aborted'
      }

      if (settings.verifyStuckKeys) await this.probeStuckKeys()

      this.emitProgress(true)
      return 'completed'
    } finally {
      // 中止/失败也要保证修饰键被释放
      await this.driver.releaseAll().catch(() => undefined)
    }
  }

  /**
   * @description 记下一片发送成功并刷新进度
   * @param index 片号
   */
  private markFrameDone(index: number): void {
    if (!this.frames) return
    this.frames = {
      done: this.frames.done + 1,
      total: this.frames.total,
      lastIndex: index,
      failed: this.frames.failed
    }
    this.emitProgress(false)
  }

  /**
   * @description 记下一片发送失败、写日志并刷新进度
   * @param index 片号
   * @param message 失败原因
   */
  private markFrameFailed(index: number, message: string): void {
    if (this.frames) {
      this.frames = { ...this.frames, lastIndex: index, failed: this.frames.failed + 1 }
    }
    this.deps.onLog?.('error', `第 ${index} 片发送失败：${message}`)
    this.emitProgress(false)
  }

  /**
   * @description 复核前台窗口：优先用上一批注入搭车带回的快照（省掉一次往返），
   * 没有快照时（例如批次尚未发生）再单独查询
   * @param guard 焦点守护
   * @param expected 倒计时前记录的目标窗口
   * @returns 焦点判定
   */
  private async checkFocus(
    guard: FocusGuard,
    expected: FocusSnapshot | null
  ): Promise<{ changed: boolean; blocked: boolean; warning?: string }> {
    const piggyback = guard.judge(this.lastForeground, expected)
    if (piggyback) return piggyback
    return guard.verify(expected)
  }

  /**
   * @description 按实测速率调整单个请求的动作数：让每个请求的计划时长不超过档位预算，
   * 这样批次再大，暂停与停止的粒度也不会退化成秒级
   * @param sent 上一批的动作数
   * @param elapsedMs 上一批从下达到返回的实际耗时
   * @param maxChunk 设置允许的动作数上限
   */
  private retuneActionsPerRequest(
    sent: number,
    elapsedMs: number,
    maxChunk: number,
    budgetMs: number
  ): void {
    if (sent <= 0 || elapsedMs <= 0 || budgetMs <= 0) {
      this.actionsPerRequest = maxChunk
      return
    }
    const perActionMs = Math.max(0.05, elapsedMs / sent)
    const next = Math.round(budgetMs / perActionMs)
    this.actionsPerRequest = Math.min(maxChunk, Math.max(MIN_ACTIONS_PER_REQUEST, next))
  }

  /**
   * @description 目标端消化不过来时提醒一次：宿主会把被拖住的时长补进等待（自适应降速），
   * 这件事值得让用户知道——总耗时基本不变，但机器不会再一直卡着
   * @param result 宿主返回的注入统计
   */
  private noteHostPressure(result: HostTypeData): void {
    if (this.pressureWarned) return
    const valveMs = result.valveMs ?? 0
    if (valveMs < PRESSURE_WARN_MS) return
    this.pressureWarned = true
    this.deps.onLog?.(
      'warn',
      `目标端消化输入的速度跟不上，已自动放慢注入（本批补等 ${Math.round(valveMs)}ms）：` +
        '这样输入队列不会一直排满，整机不会被拖卡；总耗时基本不变'
    )
  }

  /** @description 完成后自检是否有按键粘住，仅记录警告 */
  private async probeStuckKeys(): Promise<void> {
    try {
      const probe = await this.driver.probe()
      if (probe.stuckKeys.length > 0) {
        this.deps.onLog?.(
          'warn',
          `检测到仍有按键处于按下状态：${probe.stuckKeys
            .map((vk) => `0x${vk.toString(16)}`)
            .join(', ')}`
        )
      }
    } catch {
      // 探测失败不影响完成状态
    }
  }

  /** @description 请求暂停；仅在输入中生效 */
  pause(): void {
    if (this.stateValue !== 'running') return
    this.paused = true
    this.setState('paused')
  }

  /** @description 继续输入并唤醒正在等待的批次 */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    const waiters = this.resumeWaiters
    this.resumeWaiters = []
    for (const waiter of waiters) waiter()
  }

  /**
   * @description 中止输入（倒计时、输入中、暂停中均可调用）
   * @param reason 记录到状态快照里的中止原因
   */
  abort(reason = '用户中止'): void {
    if (!isBusy(this.stateValue)) return
    this.aborted = true
    this.abortReason = reason
    // 先掐断宿主手里正在跑的那一批：否则要等它把整批打完才会看到中止标志
    this.driver.cancel?.()
    // 唤醒暂停中的等待，让循环尽快退出
    this.resume()
  }

  /** @description 中止当前任务并释放驱动 */
  async dispose(): Promise<void> {
    this.abort('引擎释放')
    this.disposed = true
    await this.driver.dispose()
  }

  /**
   * @description 读取当前前台窗口（供 UI 显示"将输入到哪个窗口"）
   * @returns 前台窗口的 hwnd / pid / 标题
   */
  async foreground(): Promise<HostForegroundData> {
    return this.driver.foreground()
  }

  /** @description 挂起当前批次，直到 resume 被调用 */
  private waitWhilePaused(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve)
    })
  }

  /**
   * @description 更新状态并通知订阅者
   * @param state 新状态
   * @param message 附加说明（中止/失败原因）
   */
  private setState(state: EngineState, message?: string): void {
    this.stateValue = state
    this.deps.onState?.(message ? { ...this.snapshot, message } : this.snapshot)
  }

  /**
   * @description 按节流间隔上报进度；终态或关键节点可强制上报
   * @param force 是否忽略节流立即上报
   */
  private emitProgress(force: boolean): void {
    if (!this.deps.onProgress) return
    const now = this.deps.now()
    const interval = this.deps.progressIntervalMs ?? 100
    if (!force && now - this.lastProgressAt < interval) return
    this.lastProgressAt = now

    this.deps.onProgress(
      computeProgress({
        typed: this.typedCount,
        total: this.totalCount,
        elapsedMs: now - this.startedAt,
        baseIntervalMs: this.baseIntervalMs,
        stage: this.stateValue === 'countdown' ? 'countdown' : 'typing',
        countdownRemainingMs: this.countdownRemainingMs,
        frames: this.frames ?? undefined
      })
    )
  }
}
