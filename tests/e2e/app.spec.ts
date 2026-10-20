/**
 * 端到端测试：用远程调试端口（CDP）驱动**真实应用**，跑通「基本文本输入」与「文件输入」。
 *
 * 与其它测试的分工：
 * - `tests/unit` 用假时钟 + Mock 驱动跑引擎与 planner 的逻辑；
 * - `tests/system` 用真实 PowerShell 宿主与接收端脚本验证协议与线格式；
 * 这里补的是最后一环：**界面 → IPC → 引擎 → 宿主 → 接收端** 这条链路真的通，且浮窗在结束后按设置停住。
 *
 * 宿主以 dry-run 启动（`TYPER_DRY_RUN=1`，见 `startE2EApp`），所以不会真的按键；但它会把**本来会发出**
 * 的按键事件记进 `keys.txt`，测试据此重放出“目标窗口本该收到的文本”（`helpers/replay.ts`），
 * 文件用例还会把重放出来的帧文本交给**真正的接收端** `tools/typer-recv.mjs` 还原文件，
 * 并与源文件逐字节比对——所以断言的是“收到了什么”，而不只是“任务跑完了”。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  applyFastSettings,
  findPage,
  makeSampleFile,
  readRecordedLines,
  resetRecording,
  runReceiver,
  startE2EApp,
  RUN_TIMEOUT_MS,
  type E2EApp
} from './helpers/appSession'
import { CdpClient, waitFor } from './helpers/cdp'
import { parseRecordedEvents, replayAsText } from './helpers/replay'

/** 文本用例：ASCII 字符 + 大小写 + 需要 Shift 的符号，长度固定便于断言动作数 */
const TEXT_SAMPLE = 'Hello, Typer! 0123456789 abc XYZ ~#@'

/**
 * @description 从接收端的 `#DONE <size> <sha256> <path>` 行里取出它**实测**的字节数与摘要
 * @param stdout 接收端标准输出
 * @returns 实测的字节数与 SHA-256；没有 #DONE 行时返回 null
 */
function parseDoneLine(stdout: string): { size: number; sha256: string } | null {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith('#DONE '))
  if (!line) return null
  const [, size, sha256] = line.split(' ')
  return { size: Number(size), sha256: sha256 ?? '' }
}

describe.skipIf(process.platform !== 'win32')('端到端（真实应用 + dry-run 宿主）', () => {
  let app: E2EApp
  let sample: { dir: string; file: string; bytes: number }
  /** 源文件的 SHA-256：测试自己算一份，用来对比发送端声明与接收端实测 */
  let sourceSha256: string

  beforeAll(async () => {
    sample = makeSampleFile()
    sourceSha256 = createHash('sha256').update(readFileSync(sample.file)).digest('hex')
    // 「选择文件」的原生对话框由操作系统绘制，无法被可靠地自动化；
    // 把答案预置给主进程，测试才能真的去点界面上的按钮
    app = await startE2EApp({ pickPaths: [sample.file] })
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
    '基本文本输入：界面填内容 → 点开始 → 收到的文本与内容逐字符一致',
    async () => {
      // 内容区是异步视图，慢一点的机器上要等它挂载完成
      await waitFor(
        () => app.cdp.evaluate<boolean>("Boolean(document.querySelector('#tour-text-input'))"),
        { timeoutMs: 60_000, label: '文本输入框渲染完成' }
      )

      // 只重放本次运行的按键
      resetRecording(app.recordPath)

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

      // 关键断言：宿主实际发出的按键流（含 Shift 的按下/抬起）重放后，必须与源文本逐字符相同。
      // 这一步能抓到“修饰键顺序错/漏发”——那样 `!` 会重放成 `1`，而界面上的计数依旧“完成”。
      const rawLines = readRecordedLines(app.recordPath)
      const received = replayAsText(parseRecordedEvents(rawLines))
      expect(received).toBe(TEXT_SAMPLE)
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
    '文件输入：帧被接收端还原后与源文件逐字节一致',
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

      const prepared = await app.cdp.evaluate<{ total: number; size: number; sha256: string }>(
        `(async () => await window.api.transfer.prepare(${JSON.stringify(sample.file)}, ${JSON.stringify(options)}))()`
      )
      expect(prepared.total).toBeGreaterThan(0)
      expect(prepared.size).toBe(sample.bytes)
      // 发送端这一端：它会写进开始/结束帧、供接收端校验的摘要，必须就是源文件的摘要
      expect(prepared.sha256).toBe(sourceSha256)

      const plan = await app.cdp.evaluate<{ indexes: number[] }>(
        '(async () => await window.api.transfer.plan({}))()'
      )
      expect(plan.indexes).toHaveLength(prepared.total)

      // 只重放本次传输的按键（上一次文本用例的记录要清掉）
      resetRecording(app.recordPath)

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

      // 接收端校验：把重放出来的帧文本原样交给真正的 typer-recv.mjs，让它还原出文件
      const frameText = replayAsText(parseRecordedEvents(readRecordedLines(app.recordPath)))
      expect(frameText.startsWith('@T2')).toBe(true)
      writeFileSync(join(sample.dir, 'frames.txt'), frameText, 'utf8')

      // 注意：接收端成功后会把「分片工作目录」整个清空，所以 -d 必须是专用子目录，
      // 不能指向放着源文件的那个目录
      const shardDir = join(sample.dir, 'shards')
      const received = await runReceiver(
        ['--in', 'frames.txt', '-o', 'received.bin', '-d', shardDir, '--quiet'],
        sample.dir
      )
      expect(received.code).toBe(0)
      expect(received.stderr).toBe('')

      // 接收端实测：它自己算出来的字节数与 SHA-256 必须与源文件一致
      //（#BAD sha256 时接收端会以非 0 退出并打印期望/实际两个摘要）
      const done = parseDoneLine(received.stdout)
      expect(done).not.toBeNull()
      expect(done?.size).toBe(sample.bytes)
      expect(done?.sha256).toBe(sourceSha256)

      // 逐字节比对：收到的文件必须与源文件完全一致（CRC32 + SHA-256 已由接收端校验过）
      const restored = readFileSync(join(sample.dir, 'received.bin'))
      expect(restored.equals(readFileSync(sample.file))).toBe(true)
      expect(restored.length).toBe(sample.bytes)
    },
    RUN_TIMEOUT_MS + 30_000
  )

  it(
    '文件输入走界面：点「选择文件」→ 点开始 → 接收端还原后与源文件逐字节一致',
    async () => {
      // 切到「文件」模式（文本模式的输入框与文件面板互斥）
      await app.cdp.evaluate(`(() => {
        const group = document.querySelector('#tour-mode-switch')
        if (!group) throw new Error('找不到模式切换')
        const button = [...group.querySelectorAll('button, [role="tab"]')].find((item) =>
          item.textContent.includes('文件')
        )
        if (!button) throw new Error('找不到「文件」模式')
        button.click()
        return true
      })()`)

      // 真正去点界面上的「选择文件」：主进程按 TYPER_PICK_PATHS 直接给出结果，不弹原生框
      await waitFor(
        () =>
          app.cdp.evaluate<boolean>(`(() => {
              const panel = document.querySelector('.file-panel')
              if (!panel) return false
              return [...panel.querySelectorAll('button')].some((item) =>
                item.textContent.includes('选择文件')
              )
            })()`),
        { timeoutMs: 30_000, intervalMs: 200, label: '文件面板出现「选择文件」按钮' }
      )

      resetRecording(app.recordPath)
      await app.cdp.evaluate(`(() => {
        const panel = document.querySelector('.file-panel')
        const button = [...panel.querySelectorAll('button')].find((item) =>
          item.textContent.includes('选择文件')
        )
        button.click()
        return true
      })()`)

      // 面板出现文件名与片数 = 对话框结果已经回到界面、并且分片准备完成
      const panelText = await waitFor(
        async () => {
          const text = await app.cdp.evaluate<string>(
            "(document.querySelector('.file-panel')?.innerText ?? '')"
          )
          return text.includes(basename(sample.file)) ? text : null
        },
        { timeoutMs: 90_000, intervalMs: 300, label: '界面完成文件准备' }
      )
      expect(panelText).not.toContain('还没有选择文件')

      const startLabel = await waitFor(
        () =>
          app.cdp.evaluate<string | null>(`(() => {
              const button = document.querySelector('#tour-start button')
              if (!button || button.disabled) return null
              return button.textContent.trim()
            })()`),
        { timeoutMs: 30_000, intervalMs: 200, label: '「开始发送」按钮可用' }
      )
      expect(startLabel).toContain('发送')

      await app.cdp.evaluate(`(() => {
        document.querySelector('#tour-start button').click()
        return true
      })()`)

      const run = await waitFor(
        async () => {
          const status = await app.cdp.evaluate<{ state: string; typed: number; total: number }>(
            '(async () => await window.api.typing.status())()'
          )
          return ['completed', 'aborted', 'failed'].includes(status.state) ? status : null
        },
        { timeoutMs: RUN_TIMEOUT_MS, intervalMs: 300, label: '文件输入跑到终态' }
      )
      expect(run.state).toBe('completed')
      expect(run.typed).toBe(run.total)

      // 收到的内容：把重放的按键流交给真正的接收端还原，再与源文件逐字节比对
      const frameText = replayAsText(parseRecordedEvents(readRecordedLines(app.recordPath)))
      expect(frameText.startsWith('@T2')).toBe(true)
      writeFileSync(join(sample.dir, 'frames-ui.txt'), frameText, 'utf8')

      const received = await runReceiver(
        [
          '--in',
          'frames-ui.txt',
          '-o',
          'received-ui.bin',
          '-d',
          join(sample.dir, 'shards-ui'),
          '--quiet'
        ],
        sample.dir
      )
      expect(received.code).toBe(0)

      // 接收端实测的摘要 = 源文件摘要（与发送端声明的一致，三方对齐）
      const doneUi = parseDoneLine(received.stdout)
      expect(doneUi).not.toBeNull()
      expect(doneUi?.size).toBe(sample.bytes)
      expect(doneUi?.sha256).toBe(sourceSha256)

      const restored = readFileSync(join(sample.dir, 'received-ui.bin'))
      expect(restored.equals(readFileSync(sample.file))).toBe(true)

      // 接收端脚本这一端也要单独验证：界面里「插入接收脚本 / 导出脚本」给用户的，
      // 是主进程读出来的脚本全文（随包分发的构建产物）。把它落到一个**干净的目录**里
      // （周围没有 node_modules、也没有仓库其它文件）单独执行——只有脚本本身自包含、
      // 没有被漏打包的依赖时才能跑通，跑不通就说明是接收端脚本的问题。
      const toolScript = await app.cdp.evaluate<{ path: string; text: string }>(
        '(async () => await window.api.transfer.toolScript())()'
      )
      expect(toolScript.text.length).toBeGreaterThan(0)
      // 界面拿到的必须就是随包分发的那个产物，避免"界面上是一份、跑的是另一份"
      expect(readFileSync(toolScript.path, 'utf8')).toBe(toolScript.text)

      const standalone = join(sample.dir, 'standalone')
      mkdirSync(standalone, { recursive: true })
      const standaloneScript = join(standalone, 'typer-recv.mjs')
      writeFileSync(standaloneScript, toolScript.text, 'utf8')
      writeFileSync(join(standalone, 'frames.txt'), frameText, 'utf8')

      const receivedStandalone = await runReceiver(
        ['--in', 'frames.txt', '-o', 'received.bin', '-d', 'shards', '--quiet'],
        standalone,
        standaloneScript
      )
      expect(receivedStandalone.code).toBe(0)
      expect(receivedStandalone.stderr).toBe('')

      // 界面分发出去的那份脚本，实测结果也必须与源文件对齐
      const doneStandalone = parseDoneLine(receivedStandalone.stdout)
      expect(doneStandalone).not.toBeNull()
      expect(doneStandalone?.size).toBe(sample.bytes)
      expect(doneStandalone?.sha256).toBe(sourceSha256)

      const restoredStandalone = readFileSync(join(standalone, 'received.bin'))
      expect(restoredStandalone.equals(readFileSync(sample.file))).toBe(true)
      expect(restoredStandalone.equals(restored)).toBe(true)
    },
    RUN_TIMEOUT_MS + 60_000
  )
})
