import type { Ref } from 'vue'
import { ElMessage } from 'element-plus/es'
import { TEXT_INPUT_LIMIT } from '@shared/text/import'
import { formatBytes } from '@shared/transfer/transfer'

/**
 * 把接收脚本放进内容区的交互（模块级单例）：取全文 → 交给 `useTyping.replaceText`
 * 执行覆盖确认与写入 → 成功提示。
 *
 * 覆盖确认只写在 `replaceText` 一处：拖入文件、导入文件、插入脚本都走同一条规则，
 * 这里不再自己判断内容区是否为空。
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
    // 内容区有硬上限：脚本一旦超限就会被静默截断，而越断的脚本根本跑不起来
    if (script.text.length > TEXT_INPUT_LIMIT) {
      const message =
        `接收脚本 ${script.text.length.toLocaleString()} 字符，超过内容区上限 ` +
        `${TEXT_INPUT_LIMIT.toLocaleString()}：请改用「以文件方式发送脚本」`
      useTyping().log('warn', message)
      ElMessage.warning(message)
      return false
    }
    const typing = useTyping()
    // 写入内容区的确认逻辑只有一处：这里只需给出“插入脚本”的文案
    const replaced = await typing.replaceText(script.text, {
      title: '插入接收脚本',
      confirmText: '覆盖内容区',
      describe: (current) => `内容区已有 ${current.toLocaleString()} 字符，插入接收脚本会覆盖它。`
    })
    if (!replaced) return false

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
