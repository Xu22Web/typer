import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeSpawnAdapter } from '@main/typing/drivers/spawn'
import { WindowsSendInputDriver } from '@main/typing/drivers/WindowsSendInputDriver'
import type { HostItem } from '@main/typing/drivers/protocol'
import { buildPlan } from '@main/typing/planner/plan'
import { HOST_SCRIPT, launchTargetWindow, waitFor, type TargetWindow } from './helpers/system'

/**
 * 真实键盘注入测试（opt-in，TYPIST_E2E=1）：唯一会**真的往一个窗口打字**
 * 的用例，因此必须先确认目标窗口就是前台窗口，否则立即跳过——绝不能把按键打到用户其它窗口上。
 * 目标是一个自建的 WinForms 窗口（把收到的字符写回文件），断言即文本比较。
 *
 * “注入能不能送到”是环境属性：同一份托管 runner 前几次能送进去（用例真跑），某次会话
 * 没有可用的交互式输入桌面时会静默丢事件。因此先只等第一个字符：一个都到不了就判定环境
 * 不支持（CI 上跳过、本地照常报错）；只要到了第一个字符，后面就必须完整到达。
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
   * @description 等目标窗口收到第一个字符，用来区分“环境送不到”与“注入真的坏了”
   * @returns 是否收到了任意字符
   */
  const firstCharArrived = async (): Promise<boolean> => {
    try {
      await waitFor(() => target.readKeys().length > 0, {
        timeoutMs: 5_000,
        description: '目标窗口收到第一个字符'
      })
      return true
    } catch {
      return false
    }
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

    // 先确认注入真的进了目标窗口：托管 runner 上 `SendInput` 有时会“报告成功但事件
    // 到不了窗口”（会话没有可用的输入桌面）。一个字符都收不到就归为环境限制，
    // CI 上跳过（本地仍然报错，避免把真的注入回归当成环境问题藏起来）。
    if (!(await firstCharArrived())) {
      const message = '目标窗口收不到注入的按键（当前会话可能没有可用的交互式输入桌面）'
      if (process.env.CI) {
        console.warn(`⚠️ ${message}，本环境跳过真实注入用例`)
        return ctx.skip()
      }
      throw new Error(message)
    }

    // 必须等到**完整字符流**落盘再断言：fixture 每收到一个 WM_CHAR 就重写一次文件，
    // 只等"文件非空"会读到只到一半的状态
    await waitFor(() => target.readKeys() === SAMPLE_TEXT, {
      timeoutMs: 15_000,
      description: '目标窗口收到完整字符流'
    })

    expect(target.readKeys()).toBe(SAMPLE_TEXT)
    // 未显式发送退格，内容不应被改写
    expect(target.readKeys()).not.toContain('\b')
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
