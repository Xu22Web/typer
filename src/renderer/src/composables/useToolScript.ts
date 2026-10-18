import { formatBytes } from '@shared/transfer/transfer'

/**
 * 把接收脚本放进内容区的交互（模块级单例）：取全文 → 视内容区情况确认覆盖 → 整体替换。
 * 取脚本与错误日志交给 useTransfer，这里只负责确认与替换这类界面行为。
 */
const loading = ref(false)

/**
 * @description 取回接收脚本全文并覆盖内容区；内容区已有内容时先请用户确认
 * @returns 是否真的替换了内容区（用户取消或取脚本失败时为 false）
 */
async function insert(): Promise<boolean> {
  if (loading.value) return false
  loading.value = true
  try {
    const script = await useTransfer().loadToolScript()
    if (!script) {
      ElMessage.error('读取接收脚本失败，详情见运行日志')
      return false
    }
    const typing = useTyping()
    if (typing.text.value.trim().length > 0) {
      try {
        await ElMessageBox.confirm(
          '内容区已有内容，插入接收脚本会覆盖它。是否继续？',
          '插入接收脚本',
          {
            type: 'warning',
            confirmButtonText: '覆盖内容区',
            cancelButtonText: '取消'
          }
        )
      } catch {
        return false
      }
    }
    typing.text.value = script.text
    // 脚本里含中文注释，按字符数报尺寸会偏小，这里按 UTF-8 字节数报
    const bytes = new TextEncoder().encode(script.text).length
    ElMessage.success(`已插入接收脚本（${formatBytes(bytes)}），可直接开始输入`)
    return true
  } finally {
    loading.value = false
  }
}

/**
 * @description 接收脚本插入交互
 * @returns 插入是否进行中，以及触发插入的方法
 */
export function useToolScript(): { loading: Ref<boolean>; insert: () => Promise<boolean> } {
  return { loading, insert }
}
