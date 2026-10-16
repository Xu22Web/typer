import { describe, expect, it } from 'vitest'
import { pasteWithClipboard } from '@main/typing/drivers/clipboard'
import { ProtocolError } from '@main/typing/drivers/protocol'
import { createFakeClipboard } from '../../helpers/fakes'

describe('pasteWithClipboard', () => {
  it('写入文本 → 发送粘贴 → 恢复原剪贴板', async () => {
    const clipboard = createFakeClipboard('用户原来的内容')
    let pasteCalled = 0

    const result = await pasteWithClipboard({
      clipboard,
      text: '要输入的中文',
      restoreClipboard: true,
      sendPaste: async () => {
        pasteCalled += 1
        // 粘贴那一刻剪贴板里应该是新内容
        expect(clipboard.readText()).toBe('要输入的中文')
      }
    })

    expect(pasteCalled).toBe(1)
    expect(result.restored).toBe(true)
    expect(clipboard.readText()).toBe('用户原来的内容')
    expect(clipboard.history).toEqual(['要输入的中文', '用户原来的内容'])
  })

  it('restoreClipboard = false 时不恢复（保留输入内容）', async () => {
    const clipboard = createFakeClipboard('旧内容')
    await pasteWithClipboard({
      clipboard,
      text: '新内容',
      restoreClipboard: false,
      sendPaste: async () => {}
    })
    expect(clipboard.readText()).toBe('新内容')
    expect(clipboard.history).toEqual(['新内容'])
  })

  it('粘贴失败时也恢复剪贴板，并抛可读错误', async () => {
    const clipboard = createFakeClipboard('旧内容')
    await expect(
      pasteWithClipboard({
        clipboard,
        text: '新内容',
        restoreClipboard: true,
        sendPaste: async () => {
          throw new Error('注入被拒绝')
        }
      })
    ).rejects.toThrow(ProtocolError)

    expect(clipboard.readText()).toBe('旧内容')
  })

  it('错误码为 E_CLIPBOARD 且保留原因', async () => {
    const clipboard = createFakeClipboard('')
    try {
      await pasteWithClipboard({
        clipboard,
        text: 'x',
        restoreClipboard: false,
        sendPaste: async () => {
          throw new Error('底层失败')
        }
      })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ProtocolError).code).toBe('E_CLIPBOARD')
      expect((error as ProtocolError).detail).toContain('底层失败')
    }
  })
})
