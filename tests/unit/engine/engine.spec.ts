import { describe, expect, it } from 'vitest'
import { MockKeyboardDriver } from '@main/typing/drivers/MockKeyboardDriver'
import { LAYOUTS } from '@main/typing/planner/keymap'
import { TypingEngine, type EngineSettings } from '@main/typing/engine/TypingEngine'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot, EngineState } from '@main/typing/engine/states'
import type { HostItem } from '@main/typing/drivers/protocol'
import type { TimingSettings } from '@main/typing/scheduling/timing'
import { createVirtualClock, type VirtualClock } from '../../helpers/virtualClock'

const timing: TimingSettings = {
  speedMode: 'interval',
  cps: 10,
  wpm: 120,
  baseIntervalMs: 10,
  jitterMs: 0,
  distribution: 'uniform',
  wordPauseMs: 0,
  punctuationPauseMs: 0,
  newlinePauseMs: 0,
  paragraphPauseMs: 0,
  burstSize: 0,
  burstPauseMs: 0
}

/**
 * @description 构造引擎设置，未指定的字段取默认值
 * @param overrides 需要覆盖的设置项
 * @returns 完整的引擎设置
 */
function engineSettings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return {
    startDelayMs: 0,
    chunkSize: 8,
    layout: 'us',
    focusGuard: 'off',
    seed: 42,
    verifyStuckKeys: false,
    timing,
    typo: { rate: 0, style: 'adjacent', correction: 'auto' },
    ...overrides
  }
}

interface Harness {
  engine: TypingEngine
  driver: MockKeyboardDriver
  clock: VirtualClock
  states: EngineState[]
  progress: ProgressSnapshot[]
  logs: string[]
}

/**
 * @description 组装引擎夹具：可注入驱动与虚拟时钟，并记录状态、进度与日志
 * @param options 需要注入的驱动或时钟
 * @returns 测试用的引擎夹具
 */
function createHarness(
  options: {
    driver?: MockKeyboardDriver
    clock?: VirtualClock
  } = {}
): Harness {
  const driver = options.driver ?? new MockKeyboardDriver()
  const clock = options.clock ?? createVirtualClock()
  const states: EngineState[] = []
  const progress: ProgressSnapshot[] = []
  const logs: string[] = []

  const engine = new TypingEngine({
    driver,
    sleep: clock.sleep,
    now: clock.now,
    onState: (snapshot: EngineSnapshot) => states.push(snapshot.state),
    onProgress: (snapshot) => progress.push(snapshot),
    onLog: (_level, message) => logs.push(message),
    progressIntervalMs: 0
  })

  return { engine, driver, clock, states, progress, logs }
}

/**
 * @description 由键位表建立 "vk+修饰键" → 字符 的反查表
 * @returns 用于还原按键输出的映射
 */
function buildUsReverseMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const [char, key] of Object.entries(LAYOUTS.us.charMap)) {
    const signature = `${key.vk}+${[...key.modifiers].sort().join(',')}`
    map.set(signature, char)
  }
  return map
}

const US_REVERSE = buildUsReverseMap()

/**
 * @description 把下发事件还原成目标窗口里出现的文本，并应用退格，校验净效果
 * @param items 引擎下发的宿主指令
 * @returns 还原后的文本
 */
function applyBackspaces(items: HostItem[]): string {
  let output = ''
  for (const item of items) {
    if (item.t === 'wait') continue
    const signature = `${item.vk}+${[...item.mods].sort().join(',')}`
    if (item.vk === 0x08 && item.mods.length === 0) {
      output = Array.from(output).slice(0, -1).join('')
      continue
    }
    output += US_REVERSE.get(signature) ?? `[vk:${item.vk}]`
  }
  return output
}

describe('TypingEngine 正常流程', () => {
  it('按顺序下发全部动作，并在结束时释放修饰键', async () => {
    const h = createHarness()
    const result = await h.engine.start('Hi!', engineSettings())

    expect(result.state).toBe('completed')
    expect(h.driver.releaseAllCalls).toBe(1)
    expect(h.driver.items.length).toBeGreaterThan(0)

    expect(h.driver.items.map((item) => (item.t === 'key' ? item.vk : -1))).toEqual([
      0x48, 0x49, 0x31
    ])
    expect(h.driver.items[0]).toEqual({ t: 'key', vk: 0x48, mods: ['shift'], delay: 10 })
    expect(h.driver.items[2]).toEqual({ t: 'key', vk: 0x31, mods: ['shift'], delay: 10 })
  })

  it('空文本立即完成，且不启动宿主', async () => {
    const h = createHarness()
    const result = await h.engine.start('', engineSettings())
    expect(result.state).toBe('completed')
    expect(result.total).toBe(0)
    expect(h.driver.started).toHaveLength(0)
    expect(h.driver.batches).toHaveLength(0)
  })

  it('按 chunkSize 分批下发', async () => {
    const h = createHarness()
    await h.engine.start('abcdefghij', engineSettings({ chunkSize: 4 }))
    expect(h.driver.batches.map((batch) => batch.length)).toEqual([4, 4, 2])
  })

  it('大文本不会被一次性构建（分批次数与 chunkSize 一致）', async () => {
    const h = createHarness()
    const text = 'a'.repeat(1000)
    const result = await h.engine.start(text, engineSettings({ chunkSize: 8 }))
    expect(result.total).toBe(1000)
    expect(h.driver.batches).toHaveLength(Math.ceil(1000 / 8))
  })

  it('状态迁移：countdown → running → completed', async () => {
    const h = createHarness()
    await h.engine.start('abc', engineSettings({ startDelayMs: 500 }))
    expect(h.states[0]).toBe('countdown')
    expect(h.states).toContain('running')
    expect(h.states[h.states.length - 1]).toBe('completed')
  })

  it('开始后重复 start 会被拒绝（不会出现两条输入流）', async () => {
    const h = createHarness()
    const pending = h.engine.start(
      'a'.repeat(50),
      engineSettings({ chunkSize: 1, startDelayMs: 0 })
    )
    await expect(h.engine.start('b', engineSettings())).rejects.toThrow('已有输入任务')
    h.engine.abort('测试结束')
    await pending
  })
})

describe('TypingEngine 中止与暂停', () => {
  it('倒计时期间中止：不下发任何动作，但会释放修饰键', async () => {
    const clock = createVirtualClock({
      beforeResolve: () => {
        h.engine.abort('倒计时取消')
      }
    })
    const h = createHarness({ clock })
    const result = await h.engine.start('abc', engineSettings({ startDelayMs: 5000 }))

    expect(result.state).toBe('aborted')
    expect(h.driver.batches).toHaveLength(0)
    expect(h.driver.started).toHaveLength(0)
    expect(h.driver.releaseAllCalls).toBe(1)
  })

  it('输入中途中止：在 chunk 边界停止，state 为 aborted', async () => {
    let sent = 0
    const driver = new MockKeyboardDriver({
      onSend: () => {
        sent += 1
        if (sent === 2) engineHarness.engine.abort('用户紧急停止')
      }
    })
    const engineHarness = createHarness({ driver })

    const result = await engineHarness.engine.start(
      'a'.repeat(40),
      engineSettings({ chunkSize: 4 })
    )
    expect(result.state).toBe('aborted')
    // 第 2 批结束后立即中止，因此只会有 2 批
    expect(driver.batches).toHaveLength(2)
    expect(driver.releaseAllCalls).toBe(1)
    // 中止要立刻通知宿主打断正在跑的那一批，不能等它自然打完
    expect(driver.cancelCalls).toBe(1)
  })

  it('暂停 → 继续：动作不丢失也不重复，且继续时重新倒计时', async () => {
    let batches = 0
    const driver = new MockKeyboardDriver({
      onSend: () => {
        batches += 1
        if (batches === 1) h.engine.pause()
      }
    })
    const h = createHarness({ driver })
    const pending = h.engine.start('abcdefgh', engineSettings({ chunkSize: 2 }))

    // 暂停在批次边界生效：等引擎真正切到 paused 再继续
    for (let i = 0; i < 200 && !h.states.includes('paused'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(h.states).toContain('paused')
    // 进入暂停前先抬起了修饰键（不能把 Shift 一直按在目标窗口上）
    expect(h.driver.releaseAllCalls).toBeGreaterThanOrEqual(1)

    h.engine.resume()
    const result = await pending

    expect(result.state).toBe('completed')
    expect(h.driver.items).toHaveLength(8)
    expect(result.typed).toBe(8)
    // 倒计时出现两次：首次开始一次，继续时再一次（用户要求"点继续也要有准备时间"）
    expect(h.states.filter((state) => state === 'countdown')).toHaveLength(2)
    // 暂停后一定是先回到倒计时，而不是直接 running
    expect(h.states[h.states.indexOf('paused') + 1]).toBe('countdown')
  })

  it('暂停状态下中止：唤醒等待并结束为 aborted', async () => {
    let batches = 0
    const driver = new MockKeyboardDriver({
      onSend: () => {
        batches += 1
        if (batches === 1) h.engine.pause()
      }
    })
    const h = createHarness({ driver })
    const pending = h.engine.start('abcdefgh', engineSettings({ chunkSize: 2 }))
    // 等引擎进入 paused（driver.send 之后会走到 chunk 边界）
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.engine.abort('暂停中停止')
    const result = await pending
    expect(result.state).toBe('aborted')
    // 1 次在进入暂停时抬起，1 次在收尾兜底
    expect(h.driver.releaseAllCalls).toBe(2)
  })
})

describe('TypingEngine 错误处理', () => {
  it('驱动报错时状态为 failed，并且仍然释放修饰键', async () => {
    const driver = new MockKeyboardDriver({ failing: true })
    const h = createHarness({ driver })
    const result = await h.engine.start('abc', engineSettings())

    expect(result.state).toBe('failed')
    expect(result.error).toBeInstanceOf(Error)
    expect(h.driver.releaseAllCalls).toBe(1)
    expect(h.logs.some((line) => line.includes('输入失败'))).toBe(true)
  })

  it('完成后自检粘键（verifyStuckKeys）', async () => {
    // 驱动真的报告有键按着：引擎必须把它写进告警，而不是无论怎样都不报
    const driver = new MockKeyboardDriver({ stuckKeys: [0x10] })
    const h = createHarness({ driver })
    await h.engine.start('abc', engineSettings({ verifyStuckKeys: true }))
    expect(h.logs.some((line) => line.includes('按下状态'))).toBe(true)
    expect(h.logs.some((line) => line.includes('0x10'))).toBe(true)
    expect(h.driver.releaseAllCalls).toBe(1)
  })

  it('没有粘键时自检不产生告警', async () => {
    const h = createHarness()
    await h.engine.start('abc', engineSettings({ verifyStuckKeys: true }))
    expect(h.logs.some((line) => line.includes('按下状态'))).toBe(false)
  })

  it('跳过不可输入字符时会记日志', async () => {
    const h = createHarness()
    await h.engine.start('a\u0000b', engineSettings())
    expect(h.logs.some((line) => line.includes('已跳过不可输入字符'))).toBe(true)
  })
})

describe('TypingEngine 进度', () => {
  it('进度单调不减，最终 typed === total', async () => {
    const h = createHarness()
    const result = await h.engine.start('a'.repeat(20), engineSettings({ chunkSize: 3 }))

    expect(result.typed).toBe(result.total)
    expect(result.total).toBe(20)

    const percents = h.progress.map((snapshot) => snapshot.percent)
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!)
    }
    expect(percents[percents.length - 1]).toBe(1)
  })

  it('倒计时阶段会上报剩余毫秒', async () => {
    const h = createHarness()
    await h.engine.start('abc', engineSettings({ startDelayMs: 250 }))
    const countdown = h.progress.filter((snapshot) => snapshot.stage === 'countdown')
    expect(countdown.length).toBeGreaterThan(0)
    expect(countdown[0]!.countdownRemainingMs).toBeGreaterThan(0)
  })

  it('总动作数与带错字的计划一致（计数与产出使用同种子）', async () => {
    const h = createHarness()
    const result = await h.engine.start(
      'hello world',
      engineSettings({ chunkSize: 3, typo: { rate: 0.5, style: 'adjacent', correction: 'auto' } })
    )
    expect(result.typed).toBe(result.total)
    expect(h.driver.items).toHaveLength(result.total)
    expect(applyBackspaces(h.driver.items)).toBe('hello world')
  })
})

describe('TypingEngine 逐字符输入', () => {
  it('可打印 ASCII 全部逐字符下发，不整段跳过', async () => {
    const h = createHarness()
    const result = await h.engine.start('hello world', engineSettings())
    expect(result.state).toBe('completed')
    expect(result.typed).toBe(result.total)
    expect(h.driver.batches.length).toBeGreaterThan(0)
    expect(h.driver.items.length).toBe(result.total)
  })

  it('含中文等无物理键位的字符时直接失败，不静默丢内容', async () => {
    const h = createHarness()
    const result = await h.engine.start('中文内容', engineSettings())
    expect(result.state).toBe('failed')
    expect(result.error?.message).toContain('物理键位')
    expect(h.driver.items).toHaveLength(0)
  })
})

describe('TypingEngine 极速档', () => {
  it('把相邻动作攒成一批下发，延迟之和不变', async () => {
    const h = createHarness()
    const result = await h.engine.start(
      'abcdefgh',
      engineSettings({
        profile: 'turbo',
        chunkSize: 8,
        timing: { ...timing, baseIntervalMs: 1 }
      })
    )

    expect(result.state).toBe('completed')
    expect(h.driver.items).toHaveLength(8)
    // 8ms 的计划间隔小于 16ms 攒批窗口 → 8 个动作合成一批
    expect(h.driver.batches).toHaveLength(1)
    expect(h.driver.batches[0]).toHaveLength(8)
    const delays = (h.driver.batches[0] ?? []).map((item) =>
      item.t === 'wait' ? item.ms : item.delay
    )
    expect(delays[0]).toBe(8)
    expect(delays.slice(1).every((ms) => ms === 0)).toBe(true)
  })

  it('极速档每次下发至少凑够 32 个动作（减少目标端被唤醒的次数）', async () => {
    const h = createHarness()
    const result = await h.engine.start(
      'a'.repeat(70),
      engineSettings({
        profile: 'turbo',
        chunkSize: 512,
        timing: { ...timing, baseIntervalMs: 1 }
      })
    )

    expect(result.state).toBe('completed')
    const items = h.driver.items
    expect(items).toHaveLength(70)
    const breaks = items
      .map((item) => (item.t === 'wait' ? item.ms : item.delay))
      .filter((ms) => ms > 0)
    // 70ms 总间隔 → 每 32 个动作断一次：32 / 32 / 6
    expect(breaks).toEqual([32, 32, 6])
  })

  it('焦点查询搭车：首批之后不再单独查前台窗口', async () => {
    const driver = new MockKeyboardDriver({
      foreground: { hwnd: 1, pid: 100, title: '目标窗口' },
      piggybackForeground: true
    })
    const h = createHarness({ driver })
    const result = await h.engine.start(
      'abcdef',
      engineSettings({ chunkSize: 2, focusGuard: 'warn' })
    )

    expect(result.state).toBe('completed')
    expect(driver.batches.length).toBeGreaterThanOrEqual(3)
    // 1 次倒计时前捕获 + 1 次首批前补查；后续批次都用搭车快照
    expect(driver.foregroundCalls).toBe(2)
  })
})

describe('TypingEngine 焦点守护', () => {
  it('strict 模式：前台窗口变化时中止', async () => {
    const driver = new MockKeyboardDriver({
      foreground: { hwnd: 1, pid: 100, title: '目标窗口' },
      foregroundQueue: [{ hwnd: 2, pid: 200, title: '别的窗口' }]
    })
    const h = createHarness({ driver })
    const result = await h.engine.start(
      'a'.repeat(20),
      engineSettings({ chunkSize: 4, focusGuard: 'strict' })
    )

    expect(result.state).toBe('aborted')
    expect(h.driver.batches).toHaveLength(0)
    expect(h.driver.releaseAllCalls).toBe(1)
  })

  it('warn 模式：窗口变化时只提示，仍然完成输入', async () => {
    const driver = new MockKeyboardDriver({
      foreground: { hwnd: 1, pid: 100, title: '目标窗口' },
      foregroundQueue: [{ hwnd: 2, pid: 200, title: '别的窗口' }]
    })
    const h = createHarness({ driver })
    const result = await h.engine.start(
      'abcd',
      engineSettings({ chunkSize: 2, focusGuard: 'warn' })
    )

    expect(result.state).toBe('completed')
    expect(h.driver.items).toHaveLength(4)
    expect(h.logs.some((line) => line.includes('前台窗口已变化'))).toBe(true)
  })

  it('off 模式：完全不查询前台窗口', async () => {
    const driver = new MockKeyboardDriver()
    const h = createHarness({ driver })
    let calls = 0
    const original = driver.foreground.bind(driver)
    driver.foreground = async () => {
      calls += 1
      return original()
    }
    await h.engine.start('abc', engineSettings({ focusGuard: 'off' }))
    expect(calls).toBe(0)
  })
})

describe('时间统计（只算真正在输入的时间）', () => {
  it('倒计时不计入已用时', async () => {
    const clock = createVirtualClock()
    // 每下发一批模拟"敲了 10ms"
    const driver = new MockKeyboardDriver({ onSend: () => clock.advance(10) })
    const h = createHarness({ driver, clock })

    const result = await h.engine.start('abc', engineSettings({ startDelayMs: 500 }))

    // 墙钟走了 510ms（500ms 倒计时 + 10ms 输入），已用时应只有 10ms
    expect(result.elapsedMs).toBe(10)
    expect(h.progress[h.progress.length - 1]?.elapsedMs).toBe(10)
  })

  it('暂停时长不计入已用时，恢复后的速度与剩余时间不会被暂停拖偏', async () => {
    let batches = 0
    const clock = createVirtualClock()
    const driver = new MockKeyboardDriver({
      onSend: () => {
        batches += 1
        clock.advance(20)
        if (batches === 1) h.engine.pause()
      }
    })
    const h = createHarness({ driver, clock })
    const pending = h.engine.start('abcdefgh', engineSettings({ chunkSize: 2, startDelayMs: 100 }))

    // 暂停在批次边界生效：等引擎真正切到 paused
    for (let i = 0; i < 200 && !h.states.includes('paused'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(h.states).toContain('paused')
    clock.advance(60_000)
    h.engine.resume()
    const result = await pending

    expect(result.state).toBe('completed')
    expect(result.typed).toBe(8)
    // 4 批 × 20ms = 80ms；两次 100ms 倒计时与 60s 暂停都不算
    expect(result.elapsedMs).toBe(80)
  })
})

describe('修饰键时序与最小间隔', () => {
  it('把修饰键按下/抬起延迟透传给驱动（远程桌面里 Shift 被丢弃时靠它兜底）', async () => {
    const h = createHarness()
    await h.engine.start('a!', engineSettings({ modifierLeadMs: 40, modifierTailMs: 25 }))

    expect(h.driver.sendOptions.length).toBeGreaterThan(0)
    expect(h.driver.sendOptions.every((options) => options.modLeadMs === 40)).toBe(true)
    expect(h.driver.sendOptions.every((options) => options.modTailMs === 25)).toBe(true)
  })

  it('没有设置修饰键延迟时不下发这两个字段（由宿主用自己的默认值 15 / 10）', async () => {
    const h = createHarness()
    await h.engine.start('a', engineSettings())

    expect(h.driver.sendOptions.every((options) => options.modLeadMs === undefined)).toBe(true)
    expect(h.driver.sendOptions.every((options) => options.modTailMs === undefined)).toBe(true)
  })

  it('最小间隔：用户下限会把每字符间隔抬到该值', async () => {
    const fast = { ...timing, baseIntervalMs: 1 }

    const plain = createHarness()
    await plain.engine.start('a', engineSettings({ timing: fast }))
    expect(plain.driver.items[0]).toEqual({ t: 'key', vk: 0x41, mods: [], delay: 1 })

    const raised = createHarness()
    await raised.engine.start('a', engineSettings({ timing: fast, minDelayMs: 8 }))
    expect(raised.driver.items[0]).toEqual({ t: 'key', vk: 0x41, mods: [], delay: 8 })
  })

  it('换行方式与行首归位只作用于文本输入，并按动作数计入进度总数', async () => {
    const h = createHarness()
    const result = await h.engine.start(
      'a\nb',
      engineSettings({ newlineKey: 'shift-enter', lineStart: 'home-select' })
    )

    expect(result.state).toBe('completed')
    // 3 个字符 + 1 次换行 + Home + Shift+End
    expect(result.total).toBe(5)
    expect(result.typed).toBe(5)
    expect(h.driver.items.map((item) => (item.t === 'key' ? item.vk : -1))).toEqual([
      0x41, 0x0d, 0x24, 0x23, 0x42
    ])
    // 换行必须是 Shift+Enter（在表单里 Enter 会直接提交）
    expect(h.driver.items[1]).toMatchObject({ t: 'key', vk: 0x0d, mods: ['shift'] })
  })
})
