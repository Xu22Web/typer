import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TEXT_INPUT_LIMIT } from '@shared/text/import'
import { useTyping } from '@renderer/composables/useTyping'

// 组件库的提示 API 在源码里是显式导入的：测试要 mock 模块，而不是往全局上挂桩
const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn()
}))

vi.mock('element-plus/es', () => ({
  ElMessage: { success: mocks.success, warning: mocks.warning, error: mocks.error },
  ElMessageBox: { confirm: mocks.confirm, alert: vi.fn() }
}))

interface ImportResultStub {
  path: string
  fileName: string
  text: string
  charset: 'utf8'
  bytes: number
}

/**
 * @description 安装 window.api.files.import 桩：导入内容固定为 `text`
 * @param text 导入后的文本
 * @returns 桩函数
 */
function installImportApi(text: string): ReturnType<typeof vi.fn> {
  const result: ImportResultStub = {
    path: 'C:\\tmp\\a.txt',
    fileName: 'a.txt',
    text,
    charset: 'utf8',
    bytes: Buffer.byteLength(text)
  }
  const importFile = vi.fn(async () => result)
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { files: { import: importFile } }
  }
  return importFile
}

/**
 * @description 安装一个总是抛错的导入桩（模拟二进制文件 / 读盘失败）
 * @param message 错误文案
 */
function installFailingImportApi(message: string): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      files: {
        import: vi.fn(async () => {
          throw new Error(message)
        })
      }
    }
  }
}

beforeEach(() => {
  mocks.success.mockReset()
  mocks.warning.mockReset()
  mocks.error.mockReset()
  mocks.confirm.mockReset()
  // 默认按"用户点了确认"处理，需要取消的用例自己覆盖
  mocks.confirm.mockResolvedValue('confirm')
})

describe('useTyping.importText', () => {
  it('内容区为空时直接填充，不弹确认', async () => {
    installImportApi('新内容')
    const typing = useTyping()
    typing.text.value = ''

    await expect(typing.importText('C:\\tmp\\a.txt')).resolves.toBe(true)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(typing.text.value).toBe('新内容')
    expect(mocks.success).toHaveBeenCalledTimes(1)
  })

  it('内容区已有内容时先确认；取消则保持原文，也不报成功', async () => {
    installImportApi('新内容')
    mocks.confirm.mockRejectedValueOnce(new Error('cancel'))
    const typing = useTyping()
    typing.text.value = '原文'

    await expect(typing.importText('C:\\tmp\\a.txt')).resolves.toBe(false)
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(typing.text.value).toBe('原文')
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('已有内容且确认替换时覆盖原文', async () => {
    installImportApi('新内容')
    const typing = useTyping()
    typing.text.value = '原文'

    await expect(typing.importText('C:\\tmp\\a.txt')).resolves.toBe(true)
    expect(typing.text.value).toBe('新内容')
  })

  it('只有空白也算已有内容：与插入接收脚本同一套规则', async () => {
    installImportApi('新内容')
    const typing = useTyping()
    typing.text.value = '   \n'

    await expect(typing.importText('C:\\tmp\\a.txt')).resolves.toBe(true)
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
  })

  it('读取失败时提示错误、保持原文，且不弹确认', async () => {
    installFailingImportApi('「a.bin」看起来是二进制文件')
    const typing = useTyping()
    typing.text.value = '原文'

    await expect(typing.importText('C:\\tmp\\a.bin')).resolves.toBe(false)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(typing.text.value).toBe('原文')
    expect(mocks.error).toHaveBeenCalledTimes(1)
  })

  it('按设置里的导入编码传 charset（设置未加载时用 auto）', async () => {
    const importFile = installImportApi('内容')
    const typing = useTyping()
    typing.text.value = ''

    await typing.importText('C:\\tmp\\a.txt')
    expect(importFile).toHaveBeenCalledWith('C:\\tmp\\a.txt', 'auto')
  })

  it('空文件：提示后忽略，不覆盖原文、不弹确认', async () => {
    installImportApi('')
    const typing = useTyping()
    typing.text.value = '原文'

    await expect(typing.importText('C:\\tmp\\empty.txt')).resolves.toBe(false)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(typing.text.value).toBe('原文')
    expect(mocks.warning).toHaveBeenCalledTimes(1)
  })

  it('超过上限：截断到上限并提示实际字数', async () => {
    const typing = useTyping()
    typing.text.value = ''
    installImportApi('a'.repeat(TEXT_INPUT_LIMIT + 25))

    await expect(typing.importText('C:\\tmp\\huge.txt')).resolves.toBe(true)
    expect(typing.text.value.length).toBe(TEXT_INPUT_LIMIT)
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('已截断到'))
    expect(mocks.success).not.toHaveBeenCalled()
  })
})
