/**
 * 端到端测试：用远程调试端口（CDP）驱动**真实应用**，跑通「基本文本输入」与「文件输入」。
 *
 * 与其它测试的分工：
 * - `tests/unit` 用假时钟 + Mock 驱动跑引擎与 planner 的逻辑；
 * - `tests/system` 用真实 PowerShell 宿主与接收端脚本验证协议与线格式；
 * - 这里补的是最后一环：**界面 → IPC → 引擎** 这条链路真的通，且浮窗在结束后按设置停住。
 *
 * 宿主以 dry-run 启动（`TYPER_DRY_RUN=1`，见 `startE2EApp`），所以不会真的按键；
 * 用例只断言"任务被完整跑到终态、动作数与内容对得上"。
 */
import { rmSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  applyFastSettings,
  findPage,
  makeSampleFile,
  startE2EApp,
  RUN_TIMEOUT_MS,
  type E2EApp
} from './helpers/appSession'
import { CdpClient, waitFor } from './helpers/cdp'

/** 文本用例：ASCII 字符 + 大小写 + 需要 Shift 的符号，长度固定便于断言动作数 */
const TEXT_SAMPLE = 'Hello, Typer! 0123456789 abc XYZ ~#@'

describe.skipIf(process.platform !== 'win32')('端到端（真实应用 + dry-run 宿主）', () => {
  let app: E2EApp
  let sample: { dir: string; file: string; bytes: number }

  beforeAll(async () => {
    app = await startE2EApp()
    sample = makeSampleFile()
    await applyFastSettings(app.cdp)
    // 在页面里挂一个进度监听：用于断言"进度确实在推进"而不只是终态正确
    await app.cdp.evaluate(`(() => {
      window.__e2eProgress = []
      window.api.onProgress((snapshot) => window.__e2eProgress.push(snapshot))
      return true
    })()`)
  }, 240_000)

  afterAll(async () => {
    await app?.stop()
    if (sample) rmSync(sample.dir, { recursive: true, force: true })
  })

  it(
    '基本文本输入：界面填内容 → 点开始 → 引擎跑到完成态且动作数与内容一致',
    async () => {
      // 内容区是异步视图，慢一点的机器上要等它挂载完成
      await waitFor(
        () => app.cdp.evaluate<boolean>("Boolean(document.querySelector('#tour-text-input'))"),
        { timeoutMs: 60_000, label: '文本输入框渲染完成' }
      )

      await app.cdp.evaluate(`(() => {
        window.__e2eProgress.length = 0
        const field = document.querySelector('#tour-text-input')
        if (!field) throw new Error('找不到文本输入框')
        // Vue 的 v-model 监听 input 事件：直接改 value 不触发，必须走原型上的 setter 再派发事件
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(field, ${JSON.stringify(TEXT_SAMPLE)})
        field.dispatchEvent(new Event('input', { bubbles: true }))
        return field.value.length
      })()`)

      // 内容非空后「开始」才可点（canStart 依赖统计结果）
      await waitFor(
        () =>
          app.cdp.evaluate<boolean>(`(() => {
            const button = document.querySelector('#tour-start button')
            return Boolean(button) && !button.disabled
          })()`),
        { timeoutMs: 20_000, label: '「开始输入」按钮可用' }
      )

      await app.cdp.evaluate(`(() => {
        document.querySelector('#tour-start button').click()
        return true
      })()`)

      const summary = await waitFor(
        async () => {
          const status = await app.cdp.evaluate<{ state: string; typed: number; total: number }>(
            '(async () => await window.api.typing.status())()'
          )
          return ['completed', 'aborted', 'failed'].includes(status.state) ? status : null
        },
        { timeoutMs: RUN_TIMEOUT_MS, intervalMs: 200, label: '文本输入跑到终态' }
      )

      expect(summary.state).toBe('completed')
      // dry-run 下不真的按键，但动作规划与下发计数都必须完整
      expect(summary.total).toBe(TEXT_SAMPLE.length)
      expect(summary.typed).toBe(summary.total)

      const progress = await app.cdp.evaluate<Array<{ percent: number }>>(
        'window.__e2eProgress.slice()'
      )
      expect(progress.length).toBeGreaterThan(0)
      expect(progress[progress.length - 1]?.percent).toBe(1)
    },
    RUN_TIMEOUT_MS + 30_000
  )

  it('结束后浮窗停在完成态：卡片给出「返回主窗口」，点它才回主界面', async () => {
    // 上一步是手动返回模式（默认）：浮窗此刻应仍在屏幕上，并停在卡片形态
    const page = await findPage(
      app.port,
      (target) => target.url.includes('float.html'),
      '进度浮窗出现在调试端口上'
    )
    if (!page.webSocketDebuggerUrl) throw new Error('浮窗没有 webSocketDebuggerUrl')

    const float = await CdpClient.connect(page.webSocketDebuggerUrl)
    try {
      const label = await waitFor(
        () =>
          float.evaluate<string | null>(`(() => {
              const button = [...document.querySelectorAll('.actions button')].find((item) =>
                item.textContent.includes('返回主窗口')
              )
              return button ? button.textContent.trim() : null
            })()`),
        { timeoutMs: 20_000, intervalMs: 200, label: '浮窗出现「返回主窗口」按钮' }
      )
      expect(label).toContain('返回主窗口')

      // 主窗口在运行期被最小化；只有"环境确实支持最小化语义"时才断言返回后恢复可见，
      // 避免在没有桌面会话的机器上产生假红
      const minimized = await app.cdp.evaluate<boolean>("document.visibilityState === 'hidden'")

      await float.evaluate(`(() => {
          const button = [...document.querySelectorAll('.actions button')].find((item) =>
            item.textContent.includes('返回主窗口')
          )
          button.click()
          return true
        })()`)

      if (minimized) {
        await waitFor(() => app.cdp.evaluate<boolean>("document.visibilityState === 'visible'"), {
          timeoutMs: 20_000,
          intervalMs: 200,
          label: '主窗口重新可见'
        })
      }

      // 状态不会被"返回"这一步改坏
      const status = await app.cdp.evaluate<{ state: string }>(
        '(async () => await window.api.typing.status())()'
      )
      expect(status.state).toBe('completed')
    } finally {
      float.close()
    }
  }, 150_000)

  it(
    '文件输入：prepare → plan → start 跑到完成态，进度覆盖全部动作',
    async () => {
      await app.cdp.evaluate('window.__e2eProgress.length = 0')

      const options = {
        // 零 Shift 的 5 位档：远程桌面默认档，顺便验证编码能覆盖整个文件
        alphabet: 'ascii32',
        compression: 'none',
        quality: 9,
        chunkBytes: 1024,
        maxFrameChars: 65_536,
        mode: 'term'
      }

      const prepared = await app.cdp.evaluate<{ total: number; size: number }>(
        `(async () => await window.api.transfer.prepare(${JSON.stringify(sample.file)}, ${JSON.stringify(options)}))()`
      )
      expect(prepared.total).toBeGreaterThan(0)
      expect(prepared.size).toBe(sample.bytes)

      const plan = await app.cdp.evaluate<{ indexes: number[] }>(
        '(async () => await window.api.transfer.plan({}))()'
      )
      expect(plan.indexes).toHaveLength(prepared.total)

      const run = await app.cdp.evaluate<{ state: string; typed: number; total: number }>(
        '(async () => await window.api.transfer.start({}))()'
      )

      expect(run.state).toBe('completed')
      // 每片 = 帧字符 + 行尾，另有开始帧与结束帧各重复数遍，因此动作数一定多于片数
      expect(run.total).toBeGreaterThan(prepared.total)
      expect(run.typed).toBe(run.total)

      const progress = await app.cdp.evaluate<Array<{ percent: number; frames?: unknown }>>(
        'window.__e2eProgress.slice()'
      )
      expect(progress.length).toBeGreaterThan(0)
      expect(progress[progress.length - 1]?.percent).toBe(1)
      // 文件传输的进度按"片"上报
      expect(progress[progress.length - 1]?.frames).toBeTruthy()
    },
    RUN_TIMEOUT_MS + 30_000
  )
})
