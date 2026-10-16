import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evaluateFocus, FocusGuard } from '@main/typing/focus/focusGuard'
import { nodeSpawnAdapter } from '@main/typing/drivers/spawn'
import { WindowsSendInputDriver } from '@main/typing/drivers/WindowsSendInputDriver'
import { HOST_SCRIPT, launchTargetWindow, waitFor, type TargetWindow } from './helpers/system'

/**
 * 焦点守护的系统级验证（opt-in）：确认 `foreground` 命令返回的
 * hwnd/pid/title 与实际前台窗口一致 —— 这是"窗口变了就停止输入"的前提。
 *
 * 只做查询，不注入任何按键。
 */
const enabled = process.env.TYPIST_E2E === '1'
const describeE2E = enabled ? describe : describe.skip

describeE2E('焦点守护（系统级）', () => {
  let target: TargetWindow
  let driver: WindowsSendInputDriver

  beforeAll(async () => {
    target = await launchTargetWindow({ timeoutSeconds: 120 })
    await waitFor(() => target.readyState().length > 0, {
      timeoutMs: 30_000,
      description: '目标窗口完成初始化'
    })

    driver = new WindowsSendInputDriver({
      spawn: nodeSpawnAdapter,
      hostScriptPath: HOST_SCRIPT,
      clipboard: { readText: () => '', writeText: () => {} }
    })
    await driver.start()
  }, 120_000)

  afterAll(async () => {
    try {
      await driver?.dispose()
    } catch {
      // 忽略
    }
    target?.stop()
  })

  it('foreground 返回的 pid 与标题可信（能与目标进程对应）', async () => {
    const foreground = await driver.foreground()
    expect(typeof foreground.pid).toBe('number')
    expect(foreground.pid).toBeGreaterThan(0)
    expect(typeof foreground.hwnd).toBe('number')

    // 目标窗口恰好在前台时，标题必须与它一致（保证 pid/title 可信）
    if (foreground.pid === target.pid) {
      expect(foreground.title).toBe('typer-system-test-target')
    }

    // 无论当前前台是谁：把"别的窗口"当作期望窗口时，strict 必须判定为"窗口已变化"
    const otherWindow = {
      hwnd: foreground.hwnd + 12345,
      pid: foreground.pid + 1,
      title: '其它窗口'
    }
    const verdict = evaluateFocus('strict', otherWindow, foreground)
    expect(verdict.changed).toBe(true)
    expect(verdict.blocked).toBe(true)
  }, 30_000)

  it('FocusGuard.capture + verify 在窗口变化时按 strict 阻止输入', async () => {
    const guard = new FocusGuard('strict', driver)
    const captured = await guard.capture()
    expect(captured).not.toBeNull()

    // 伪造一个变化后的前台窗口，验证判定链路
    const verdict = await guard.verify({ hwnd: 1, pid: 999_999, title: '其它窗口' })
    expect(verdict.changed).toBe(true)
    expect(verdict.blocked).toBe(true)
  }, 30_000)
})
