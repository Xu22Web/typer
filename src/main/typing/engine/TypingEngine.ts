import { buildPlan, countTypedActions, iterateActions, type PlanOptions } from '../planner/plan'
import { describeSkipped } from '../planner/text'
import type { KeyboardDriver } from '../drivers/KeyboardDriver'
import type { HostForegroundData, ScheduledAction } from '../drivers/protocol'
import { toHostItems } from '../drivers/protocol'
import { createRng, resolveSeed, type Rng } from '../scheduling/rng'
import { baseIntervalMsFor, TimingScheduler, type TimingSettings } from '../scheduling/timing'
import type { TypoCorrection, TypoOptions, TypoStyle } from '../scheduling/typo'
import { FocusGuard, type FocusGuardMode } from '../focus/focusGuard'
import { computeProgress, type ProgressSnapshot } from './progress'
import { isBusy, type EngineSnapshot, type EngineState } from './states'

export type InsertMode = 'keystroke' | 'paste' | 'auto'

/** 引擎需要的设置子集（由设置层派生，测试可直接构造）。 */
export interface EngineSettings {
  startDelayMs: number
  insertMode: InsertMode
  autoPasteThreshold: number
  chunkSize: number
  layout: string
  forceUnicodeForAll: boolean
  focusGuard: FocusGuardMode
  seed: number
  /** 完成后自检是否有按键粘住 */
  verifyStuckKeys: boolean
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

/**
 * 输入引擎：倒计时 → 分块下发动作 → 暂停/继续/中止。
 *
 * 设计要点：
 * - 驱动、时钟、随机源全部注入，因此可以用假时钟 + Mock 驱动做确定性测试
 * - 以 chunk 为单位下发，chunk 之间检查暂停/中止，"紧急停止"延迟 ≤ 一个 chunk
 * - 任何结束路径（完成/中止/异常）都会 `releaseAll`，避免修饰键粘住
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

  constructor(private readonly deps: EngineDeps) {
    this.driver = deps.driver
  }

  get state(): EngineState {
    return this.stateValue
  }

  get snapshot(): EngineSnapshot {
    return {
      state: this.stateValue,
      typed: this.typedCount,
      total: this.totalCount,
      countdownRemainingMs: this.countdownRemainingMs
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 开始一次输入。重复调用会被拒绝（不会产生两条并行输入流）。 */
  async start(text: string, settings: EngineSettings): Promise<RunResult> {
    if (this.disposed) throw new Error('引擎已释放')
    if (isBusy(this.stateValue)) {
      throw new Error('已有输入任务正在进行，请先停止')
    }

    this.aborted = false
    this.abortReason = ''
    this.paused = false
    this.resumeWaiters = []
    this.typedCount = 0
    this.totalCount = 0
    this.countdownRemainingMs = 0
    this.baseIntervalMs = Math.max(1, baseIntervalMsFor(settings.timing))
    this.running = true

    const seed = resolveSeed(settings.seed)
    const rngFactory = this.deps.createRng ?? createRng

    let error: Error | undefined
    let outcome: RunResult['state'] = 'completed'

    try {
      outcome = await this.runOnce(text, settings, seed, rngFactory)
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

  private async runOnce(
    text: string,
    settings: EngineSettings,
    seed: number,
    rngFactory: (seed: number) => Rng
  ): Promise<RunResult['state']> {
    const planBase: PlanOptions = {
      layout: settings.layout,
      forceUnicodeForAll: settings.forceUnicodeForAll
    }

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

    // 3) 统计动作总数：与产出使用"同种子、同起点"的独立随机源，保证总数准确
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

    // 5) 粘贴模式
    const usePaste =
      settings.insertMode === 'paste' ||
      (settings.insertMode === 'auto' && this.totalCount > Math.max(1, settings.autoPasteThreshold))

    if (usePaste) {
      await this.driver.start()
      const verdict = await guard.verify(expectedFocus)
      if (verdict.blocked) {
        this.abortReason = verdict.warning ?? '前台窗口已变化'
        return 'aborted'
      }
      await this.driver.paste(text)
      this.typedCount = this.totalCount
      this.emitProgress(true)
      this.deps.onLog?.('info', '已通过剪贴板粘贴完成输入')
      return 'completed'
    }

    // 6) 逐块输入
    await this.driver.start()

    const scheduler = new TimingScheduler(settings.timing, rngFactory(seed))
    const actions = iterateActions(text, {
      ...planBase,
      typo: { ...typoOptions, rng: rngFactory(seed) }
    })

    const chunkSize = Math.max(1, settings.chunkSize)
    let chunk: ScheduledAction[] = []

    const flush = async (): Promise<boolean> => {
      if (chunk.length === 0) return true
      if (this.aborted) return false

      if (this.paused) {
        this.setState('paused')
        await this.waitWhilePaused()
        if (this.aborted) return false
        this.setState('running')
      }

      const verdict = await guard.verify(expectedFocus)
      if (verdict.changed) {
        this.deps.onLog?.('warn', verdict.warning ?? '前台窗口已变化')
        if (verdict.blocked) {
          this.abortReason = verdict.warning ?? '前台窗口已变化'
          return false
        }
      }

      const pending = chunk
      chunk = []
      await this.driver.send(toHostItems(pending))
      this.typedCount += pending.length
      this.emitProgress(false)
      return true
    }

    for (const action of actions) {
      if (this.aborted) return 'aborted'
      chunk.push({ action, delayMs: scheduler.delayFor(action) })
      if (chunk.length >= chunkSize) {
        const ok = await flush()
        if (!ok) return 'aborted'
      }
    }

    if (!(await flush())) return 'aborted'

    if (settings.verifyStuckKeys) {
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

    this.emitProgress(true)
    return 'completed'
  }

  pause(): void {
    if (this.stateValue !== 'running') return
    this.paused = true
    this.setState('paused')
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    const waiters = this.resumeWaiters
    this.resumeWaiters = []
    for (const waiter of waiters) waiter()
  }

  /** 中止输入（倒计时、输入中、暂停中均可调用）。 */
  abort(reason = '用户中止'): void {
    if (!isBusy(this.stateValue)) return
    this.aborted = true
    this.abortReason = reason
    // 唤醒暂停中的等待，让循环尽快退出
    this.resume()
  }

  async dispose(): Promise<void> {
    this.abort('引擎释放')
    this.disposed = true
    await this.driver.dispose()
  }

  /** 读取当前前台窗口（供 UI 显示"将输入到哪个窗口"）。 */
  async foreground(): Promise<HostForegroundData> {
    return this.driver.foreground()
  }

  private waitWhilePaused(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve)
    })
  }

  private setState(state: EngineState, message?: string): void {
    this.stateValue = state
    this.deps.onState?.(message ? { ...this.snapshot, message } : this.snapshot)
  }

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
        countdownRemainingMs: this.countdownRemainingMs
      })
    )
  }
}
