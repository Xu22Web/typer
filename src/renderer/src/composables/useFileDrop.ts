/**
 * 面板拖入文件的统一交互：判断能否接受、维护覆盖层显隐、挑出单个文件并解析路径。
 *
 * 文本页与文件页只有"文案"和"收到文件后做什么"不同，规则完全一致；
 * 把这段逻辑收在一处，避免两个面板各写一份再慢慢跑偏（多文件、拒绝反馈、drop 默认行为）。
 */
import { ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus/es'

/** 拖入时的三种拒绝文案：措辞随面板不同，规则相同 */
export interface FileDropMessages {
  /** 当前不接受拖入（输入中 / 准备中） */
  reject: string
  /** 一次拖了多个文件 */
  multiple: string
  /** 拿不到文件在磁盘上的路径 */
  noPath: string
}

export interface FileDropOptions {
  /** 当前是否接受拖入；返回 false 时不显示覆盖层，落下时给出 `reject` 提示 */
  canAccept: () => boolean
  /** 拒绝文案 */
  messages: FileDropMessages
  /**
   * 一次拖入多个文件时的策略：
   * - `reject`（默认）：拒绝并提示——导入文本会覆盖内容区，多选容易误操作；
   * - `first`：只取第一个并提示——发送文件不会覆盖内容区，多选取第一个更顺手。
   */
  multiple?: 'reject' | 'first'
  /**
   * 落盘前的额外校验（体积等）；返回非空字符串表示拒绝，内容直接作为提示文案。
   * 放在这里而不是 `onFile` 里，是为了在读取文件之前就拦住。
   */
  checkFile?: (file: File) => string | null
  /** 收到一个可用文件后的处理（读取、准备、校验都交给调用方） */
  onFile: (path: string, file: File) => void | Promise<void>
}

export interface FileDrop {
  /** 拖拽层数：> 0 时显示覆盖层（dragenter / dragleave 会在子元素间反复触发，用计数防抖） */
  dragDepth: Ref<number>
  onDragEnter: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent) => Promise<void>
}

/**
 * @description 建立拖入交互（覆盖层显隐 + 单文件校验 + 路径解析）
 * @param options 可否接受、拒绝文案与文件处理回调
 * @returns 拖入事件处理器与拖拽层数
 */
export function useFileDrop(options: FileDropOptions): FileDrop {
  const dragDepth = ref(0)

  /**
   * @description 有东西拖进面板：拖选文字也会触发 dragenter，只有带文件才进入拖入态
   * @param event 拖拽事件
   */
  function onDragEnter(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    if (!options.canAccept()) return
    dragDepth.value += 1
  }

  /**
   * @description 停在面板上：必须阻止默认行为，否则浏览器不会派发 drop，还会把文件当成导航目标
   * @param event 拖拽事件
   */
  function onDragOver(event: DragEvent): void {
    event.preventDefault()
    if (!options.canAccept()) return
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  /** @description 离开面板：层数归零时才隐藏覆盖层 */
  function onDragLeave(): void {
    dragDepth.value = Math.max(0, dragDepth.value - 1)
  }

  /**
   * @description 松手：挑出唯一文件并解析磁盘路径，其余交给 `onFile`
   * @param event 拖拽事件
   */
  async function onDrop(event: DragEvent): Promise<void> {
    dragDepth.value = 0
    event.preventDefault()

    if (!options.canAccept()) {
      ElMessage.warning(options.messages.reject)
      return
    }

    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    if (files.length > 1) {
      if ((options.multiple ?? 'reject') === 'reject') {
        ElMessage.warning(options.messages.multiple)
        return
      }
      ElMessage.info(options.messages.multiple)
    }

    const file = files[0] as File
    const rejection = options.checkFile?.(file)
    if (rejection) {
      ElMessage.warning(rejection)
      return
    }

    const path = window.api.files.pathOf(file)
    if (path.length === 0) {
      ElMessage.warning(options.messages.noPath)
      return
    }

    await options.onFile(path, file)
  }

  return { dragDepth, onDragEnter, onDragOver, onDragLeave, onDrop }
}
