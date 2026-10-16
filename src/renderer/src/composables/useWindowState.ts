import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/**
 * 自绘标题栏的窗口状态（模块级单例）。
 *
 * 窗口是无边框的（`frame: false`），最小化/最大化/关闭都必须经由 IPC 交给主进程；
 * 最大化状态则反之由主进程推送（用户双击标题栏、`Win+↑`、拖拽到屏幕上边缘都会改变它，
 * 只靠渲染进程自己记录会失同步）。
 */
const maximized = ref(false)
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  window.api.window.onState((payload) => {
    maximized.value = payload.maximized
  })
  void sync()
}

async function sync(): Promise<void> {
  try {
    maximized.value = await window.api.window.isMaximized()
  } catch {
    // 忽略：读不到就维持当前状态，不影响按钮可用性
  }
}

export function useWindowState(): {
  maximized: Ref<boolean>
  maximizedLabel: ComputedRef<string>
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  sync: () => Promise<void>
} {
  wire()

  return {
    maximized,
    maximizedLabel: computed(() => (maximized.value ? '还原' : '最大化')),
    minimize: async () => {
      await window.api.window.minimize()
    },
    toggleMaximize: async () => {
      maximized.value = await window.api.window.toggleMaximize()
    },
    close: async () => {
      await window.api.window.close()
    },
    sync
  }
}
