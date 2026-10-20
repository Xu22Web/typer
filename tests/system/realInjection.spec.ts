import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeSpawnAdapter } from '@main/typing/drivers/spawn'
import { WindowsSendInputDriver } from '@main/typing/drivers/WindowsSendInputDriver'
import type { HostItem } from '@main/typing/drivers/protocol'
import { buildPlan } from '@main/typing/planner/plan'
import {
  HOST_SCRIPT,
  classifyDelivery,
  launchTargetWindow,
  waitFor,
  type TargetWindow
} from './helpers/system'

/**
 * 真实键盘注入测试（opt-in，TYPIST_E2E=1）：唯一会**真的往一个窗口打字**
 * 的用例，因此必须先确认目标窗口就是前台窗口，否则立即跳过——绝不能把按键打到用户其它窗口上。
 * 目标是一个自建的 WinForms 窗口（把收到的字符写回文件），断言即文本比较。
 *
 * “注入能不能送到”是环境属性：同一份托管 runner 前几次能送进去（用例真跑），某次会话
 * 没有可用的交互式输入桌面、或者打字途中焦点被别的进程抢走时，只能送到一部分。
 * 因此交付结果分三类：完整到达（通过）、只到达一个合法前缀含 0 个字符（环境限制，
 * CI 跳过、本地报错）、字符内容不对（真正的注入回归，必须红）。
 */
const enabled = process.env.TYPIST_E2E === '1'
const describeE2E = enabled ? describe : describe.skip

/** @description 样例：ASCII + Shift 组合符号（远程桌面只能转发真实键盘事件） */
const SAMPLE_TEXT = 'Hello !@# ABC xyz 0123456789'

describeE2E('真实注入（需要前台焦点）', () => {
  let target: TargetWindow
  let driver: WindowsSendInputDriver
  let focused = false

  /**
   * @description 在限定时间内等待目标窗口成为前台窗口
   * @returns 是否已获得前台焦点
   */
  const ensureFocus = async (): Promise<boolean> => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const foreground = await driver.foreground()
        if (foreground.pid === target.pid) return true
      } catch {
        // 宿主可能还在启动，继续重试
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  }

  /**
   * @description 等目标窗口把字符流打完；超时也返回已收到的部分，交给调用方区分
   * "没跑完"（环境）与"打错了"（回归）
   * @returns 目标窗口当前收到的字符
   */
  const collectDelivered = async (): Promise<string> => {
    const settle = async (
      predicate: () => boolean,
      timeoutMs: number,
      description: string
    ): Promise<void> => {
      try {
        await waitFor(predicate, { timeoutMs, description })
      } catch {
        // 超时由调用方按"收到了多少"判定，不在这里抛
      }
    }

    // 先等第一个字符，避免环境不支持时空等十几秒；再等完整字符流落盘
    await settle(() => target.readKeys().length > 0, 5_000, '目标窗口收到第一个字符')
    await settle(() => target.readKeys() === SAMPLE_TEXT, 10_000, '目标窗口收到完整字符流')
    return target.readKeys()
  }

  beforeAll(async () => {
    target = await launchTargetWindow({ timeoutSeconds: 120 })
    await waitFor(() => target.readyState().length > 0, {
      timeoutMs: 30_000,
      description: '目标窗口完成初始化'
    })

    driver = new WindowsSendInputDriver({
      spawn: nodeSpawnAdapter,
      hostScriptPath: HOST_SCRIPT
    })
    await driver.start()

    focused = await ensureFocus()
    if (!focused) {
      console.warn(
        '⚠️ 目标窗口未获得前台焦点，真实注入用例将跳过（避免影响用户当前窗口）。' +
          '请让测试窗口获得焦点后重跑 pnpm test:system。'
      )
    }
  }, 120_000)

  afterAll(async () => {
    try {
      await driver?.dispose()
    } catch {
      // 忽略
    }
    target?.stop()
  })

  it('把含 Shift 符号的文本真实输入到目标窗口', async (ctx) => {
    if (!focused) return ctx.skip()

    const plan = buildPlan(SAMPLE_TEXT)
    const items: HostItem[] = plan.actions.map((action) => {
      if (action.kind === 'key') {
        return { t: 'key', vk: action.vk, mods: action.modifiers, delay: 25 }
      }
      return { t: 'wait', ms: action.ms }
    })

    const result = await driver.send(items)
    expect(result.injected).toBe(result.requested)

    // 完整字符流落盘才算成功；只到一部分且内容对得上 → 环境问题（没跑完），
    // 内容对不上 → 真正的回归，交给下面的断言把 diff 打出来
    const delivered = await collectDelivered()
    if (classifyDelivery(delivered, SAMPLE_TEXT) === 'interrupted') {
      const message =
        `目标窗口只收到 ${delivered.length}/${SAMPLE_TEXT.length} 个字符：` +
        '本环境没有可用的输入桌面，或打字途中焦点被别的进程抢走'
      if (process.env.CI) {
        console.warn(`⚠️ ${message}，本环境跳过真实注入用例`)
        return ctx.skip()
      }
      throw new Error(message)
    }

    expect(delivered).toBe(SAMPLE_TEXT)
    // 未显式发送退格，内容不应被改写
    expect(delivered).not.toContain('\b')
  }, 60_000)

  it('输入结束后没有按键粘住（releaseAll + probe 双重确认）', async (ctx) => {
    if (!focused) return ctx.skip()

    await driver.releaseAll()
    const probe = await driver.probe()
    expect(probe.stuckKeys).toEqual([])
  }, 30_000)

  it('前台窗口换了一个之后，焦点守护判定为“窗口已变化”', async (ctx) => {
    if (!focused) return ctx.skip()

    // 用**真实**的前台快照去对比一个明显不同的窗口快照（不会真的注入）：
    // 不要求此刻前台仍是目标窗口——用户或系统随时可能把焦点抢走，那种情况不该让用例变红
    const captured = await driver.foreground()
    expect(typeof captured.pid).toBe('number')

    const { evaluateFocus } = await import('@main/typing/focus/focusGuard')
    const verdict = evaluateFocus('strict', captured, {
      hwnd: captured.hwnd + 1,
      pid: captured.pid + 1,
      title: '其它窗口'
    })
    expect(verdict.blocked).toBe(true)
    expect(verdict.changed).toBe(true)
  }, 30_000)
})
