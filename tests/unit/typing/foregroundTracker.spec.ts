import { describe, expect, it } from 'vitest'
import { createForegroundTracker } from '@main/typing/foregroundTracker'
import type { HostForegroundData } from '@main/typing/drivers/protocol'

const SELF_PID = 100

/** 构造一份窗口快照 */
function windowInfo(title: string, pid = 200): HostForegroundData {
  return { hwnd: 1, pid, title }
}

/** 构造一份"本程序自己的窗口"快照 */
function selfWindow(title = 'Typer'): HostForegroundData {
  return { hwnd: 2, pid: SELF_PID, title }
}

/** 按顺序返回预设结果的读取器：元素为 Error 时抛错，为 null 时读不到 */
function readerOf(sequence: Array<HostForegroundData | null | Error>) {
  let index = 0
  return async (): Promise<HostForegroundData | null> => {
    const next = sequence[Math.min(index, sequence.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    return next ?? null
  }
}

describe('foregroundTracker', () => {
  it('前台是别的程序：直接采用，并记成后续的回退值', async () => {
    const tracker = createForegroundTracker({
      read: readerOf([windowInfo('记事本')]),
      selfPid: () => SELF_PID
    })

    expect(await tracker.resolve()).toEqual(windowInfo('记事本'))
  })

  it('前台是自己：沿用上一次别的程序的窗口', async () => {
    const tracker = createForegroundTracker({
      read: readerOf([windowInfo('记事本'), selfWindow()]),
      selfPid: () => SELF_PID
    })

    await tracker.resolve()
    expect(await tracker.resolve()).toEqual(windowInfo('记事本'))
  })

  it('只有自己且没有缓存：返回 null，界面显示「未检测」而不是 Typer', async () => {
    const tracker = createForegroundTracker({
      read: readerOf([selfWindow()]),
      selfPid: () => SELF_PID
    })

    expect(await tracker.resolve()).toBeNull()
  })

  it('读取抛错：退回缓存，不把错误抛给界面', async () => {
    const tracker = createForegroundTracker({
      read: readerOf([windowInfo('记事本'), new Error('宿主没响应')]),
      selfPid: () => SELF_PID
    })

    await tracker.resolve()
    expect(await tracker.resolve()).toEqual(windowInfo('记事本'))
  })

  it('capture 只收下别人的窗口，自己的窗口不覆盖缓存', async () => {
    const tracker = createForegroundTracker({
      read: readerOf([windowInfo('VS Code'), selfWindow()]),
      selfPid: () => SELF_PID
    })

    await tracker.capture()
    await tracker.capture()

    expect(await tracker.resolve()).toEqual(windowInfo('VS Code'))
  })

  it('没有标题的窗口不算目标（只剩进程号时才允许退化显示）', async () => {
    const tracker = createForegroundTracker({
      read: readerOf([{ hwnd: 3, pid: 300, title: '   ' }]),
      selfPid: () => SELF_PID
    })

    expect(await tracker.resolve()).toBeNull()
  })

  it('pid 为 0（查询不到）时不当作别人的窗口', async () => {
    const tracker = createForegroundTracker({
      read: readerOf([windowInfo('记事本'), { hwnd: 0, pid: 0, title: '' }]),
      selfPid: () => SELF_PID
    })

    await tracker.resolve()
    expect(await tracker.resolve()).toEqual(windowInfo('记事本'))
  })
})
