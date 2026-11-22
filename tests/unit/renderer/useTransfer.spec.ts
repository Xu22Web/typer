import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferJobSummary } from '@shared/transfer/transfer'
import { useTransfer } from '@renderer/composables/useTransfer'

// 组件库的提示 API 由 useTyping 显式导入：测试要 mock 模块，而不是往全局上挂桩
vi.mock('element-plus/es', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: vi.fn(), alert: vi.fn() }
}))

/** 准备成功后的任务摘要（只填断言会读到的字段，其余按类型给默认值） */
const jobStub: TransferJobSummary = {
  path: 'C:\\tmp\\typer-paste\\1.txt',
  name: '文本-20261123-120000.txt',
  size: 12,
  job: 'job-1',
  alphabet: 'ascii32',
  compression: 'none',
  quality: 9,
  mode: 'term',
  chunkBytes: 16384,
  maxFrameChars: 65536,
  total: 1,
  sha256: '0'.repeat(64),
  wireBytes: 12,
  tailBytes: 12,
  peakFrameChars: 40,
  frameChars: 40,
  typedActions: 40,
  preview: [],
  looksUtf8: true,
  compressionNote: '',
  kind: 'text',
  kindLabel: '文本',
  prepareMs: 1
}

interface TransferApiStub {
  prepareText: ReturnType<typeof vi.fn>
  plan: ReturnType<typeof vi.fn>
}

/**
 * @description 安装 window.api.transfer 桩
 * @param prepareText 主进程准备文本时用的实现
 * @returns 两个可断言的桩函数
 */
function installTransferApi(prepareText: () => Promise<TransferJobSummary>): TransferApiStub {
  const api: TransferApiStub = {
    prepareText: vi.fn(prepareText),
    plan: vi.fn(async () => ({ indexes: [0], ranges: '1', sendBegin: true, sendEnd: true }))
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { transfer: { onPrepareProgress: vi.fn(), ...api } }
  }
  return api
}

describe('useTransfer.prepareText', () => {
  let transfer: ReturnType<typeof useTransfer>

  beforeEach(() => {
    transfer = useTransfer()
    // 模块级单例：上一个用例的摘要与错误不能漏到下一个里
    transfer.summary.value = null
    transfer.error.value = ''
  })

  it('主进程拒绝超长文本时返回 false，原因留在 error 里', async () => {
    installTransferApi(async () => {
      throw new Error('文本过长（3,000,000 字符），上限 80,000 字符')
    })

    const ready = await transfer.prepareText('x', transfer.options.value)

    expect(ready).toBe(false)
    expect(transfer.error.value).toContain('文本过长')
    expect(transfer.summary.value).toBeNull()
  })

  it('准备成功后返回 true 并标记来源为内容区文本', async () => {
    installTransferApi(async () => jobStub)

    const ready = await transfer.prepareText('x', transfer.options.value)

    expect(ready).toBe(true)
    expect(transfer.source.value).toBe('text')
    expect(transfer.summary.value?.name).toBe(jobStub.name)
  })
})
