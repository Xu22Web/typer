import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileDrop, type FileDropMessages } from '@renderer/composables/useFileDrop'

// 组件库的提示 API 在源码里是显式导入的，测试要 mock 模块而不是往全局上挂
const mocks = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn() }))

vi.mock('element-plus/es', () => ({
  ElMessage: { warning: mocks.warning, info: mocks.info }
}))

interface FakeDragEvent {
  dataTransfer: { types: string[]; files: unknown[]; dropEffect: string }
  preventDefault: ReturnType<typeof vi.fn>
}

/**
 * @description 造一个够用的拖拽事件（node 环境没有 DragEvent 构造器）
 * @param files 拖入的文件
 * @param types dataTransfer.types（默认带 Files）
 * @returns 假事件
 */
function makeEvent(files: unknown[], types: string[] = ['Files']): FakeDragEvent {
  return {
    dataTransfer: { types, files, dropEffect: '' },
    preventDefault: vi.fn()
  }
}

const asEvent = (event: FakeDragEvent): DragEvent => event as unknown as DragEvent

const MESSAGES: FileDropMessages = {
  reject: '拒绝',
  multiple: '只能一个',
  noPath: '没有路径'
}

let warnings: ReturnType<typeof vi.fn>
let infos: ReturnType<typeof vi.fn>
/**
 * @description 安装 window.api.files.pathOf 桩
 * @param resolvePath 文件 → 路径
 */
function installPathOf(resolvePath: (file: unknown) => string): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { files: { pathOf: vi.fn(resolvePath) } }
  }
}

beforeEach(() => {
  warnings = mocks.warning
  infos = mocks.info
  warnings.mockClear()
  infos.mockClear()
})

describe('useFileDrop', () => {
  it('拖入带文件时显示覆盖层，落下后归零并交出一个文件', async () => {
    installPathOf(() => 'C:\\tmp\\a.txt')
    const onFile = vi.fn()
    const drop = useFileDrop({ canAccept: () => true, messages: MESSAGES, onFile })

    drop.onDragEnter(asEvent(makeEvent([{}])))
    expect(drop.dragDepth.value).toBe(1)

    const event = makeEvent([{ name: 'a.txt' }])
    await drop.onDrop(asEvent(event))

    expect(drop.dragDepth.value).toBe(0)
    expect(onFile).toHaveBeenCalledWith('C:\\tmp\\a.txt', event.dataTransfer.files[0])
    expect(warnings).not.toHaveBeenCalled()
  })

  it('拖选文字（types 不带 Files）不进拖入态', () => {
    installPathOf(() => '')
    const drop = useFileDrop({ canAccept: () => true, messages: MESSAGES, onFile: vi.fn() })

    drop.onDragEnter(asEvent(makeEvent([], ['text/plain'])))
    expect(drop.dragDepth.value).toBe(0)
  })

  it('不接受时仍阻止默认行为，并给出拒绝提示、不处理文件', async () => {
    installPathOf(() => 'C:\\tmp\\a.txt')
    const onFile = vi.fn()
    const drop = useFileDrop({ canAccept: () => false, messages: MESSAGES, onFile })

    drop.onDragEnter(asEvent(makeEvent([{}])))
    expect(drop.dragDepth.value).toBe(0)

    const event = makeEvent([{}])
    await drop.onDrop(asEvent(event))

    expect(event.preventDefault).toHaveBeenCalled()
    expect(warnings).toHaveBeenCalledWith(MESSAGES.reject)
    expect(onFile).not.toHaveBeenCalled()
  })

  it('默认策略下多文件直接拒绝，不悄悄只取第一个', async () => {
    installPathOf(() => 'C:\\tmp\\a.txt')
    const onFile = vi.fn()
    const drop = useFileDrop({ canAccept: () => true, messages: MESSAGES, onFile })

    await drop.onDrop(asEvent(makeEvent([{}, {}])))

    expect(warnings).toHaveBeenCalledWith(MESSAGES.multiple)
    expect(onFile).not.toHaveBeenCalled()
  })

  it('multiple 为 first 时取第一个并提示（发送文件的策略）', async () => {
    installPathOf(() => 'C:\\tmp\\a.bin')
    const onFile = vi.fn()
    const drop = useFileDrop({
      canAccept: () => true,
      messages: MESSAGES,
      multiple: 'first',
      onFile
    })

    const event = makeEvent([{ name: 'a.bin' }, { name: 'b.bin' }])
    await drop.onDrop(asEvent(event))

    expect(infos).toHaveBeenCalledWith(MESSAGES.multiple)
    expect(onFile).toHaveBeenCalledWith('C:\\tmp\\a.bin', event.dataTransfer.files[0])
  })

  it('拿不到磁盘路径时提示并停止', async () => {
    installPathOf(() => '')
    const onFile = vi.fn()
    const drop = useFileDrop({ canAccept: () => true, messages: MESSAGES, onFile })

    await drop.onDrop(asEvent(makeEvent([{}])))

    expect(warnings).toHaveBeenCalledWith(MESSAGES.noPath)
    expect(onFile).not.toHaveBeenCalled()
  })

  it('checkFile 返回拒绝原因时给出该文案，不读路径、不处理文件', async () => {
    installPathOf(() => 'C:\\tmp\\big.txt')
    const onFile = vi.fn()
    const pathOf = vi.fn(() => 'C:\\tmp\\big.txt')
    ;(globalThis as unknown as { window: unknown }).window = { api: { files: { pathOf } } }
    const drop = useFileDrop({
      canAccept: () => true,
      messages: MESSAGES,
      checkFile: () => '超过上限',
      onFile
    })

    await drop.onDrop(asEvent(makeEvent([{}])))

    expect(warnings).toHaveBeenCalledWith('超过上限')
    expect(pathOf).not.toHaveBeenCalled()
    expect(onFile).not.toHaveBeenCalled()
  })

  it('拖离次数多于拖入时，层数不会变成负数', () => {
    installPathOf(() => '')
    const drop = useFileDrop({ canAccept: () => true, messages: MESSAGES, onFile: vi.fn() })

    drop.onDragLeave()
    expect(drop.dragDepth.value).toBe(0)
  })
})
