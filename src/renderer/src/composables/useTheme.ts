import { useThemeStore } from '@renderer/store/theme'
import type { ComputedRef } from 'vue'

/**
 * @description 把主题写到根元素上，供 CSS 变量与 Element Plus 深色变量选择
 * @param dark 是否深色
 */
function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
}

/** @description 把持久化的主题应用到根元素；在挂载前调用可避免首帧闪烁 */
export function setupTheme(): void {
  applyTheme(useThemeStore().dark)
}

/** 正在播放的扩散过渡；用户连点时用它避免两段动画互相打架。 */
let active: ViewTransition | null = null

/**
 * @description 系统是否要求减弱动效
 * @returns 是否应跳过过渡动画
 */
function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * @description 以触发按钮为圆心向外扩散的圆形揭示动画：半径取到最远的角，避免角落留下死区；
 * 只对 ::view-transition-new(root) 施加 clip-path，让新主题"从一个圆里长出来"
 * @param origin 圆心坐标
 */
function reveal(origin: { x: number; y: number }): void {
  const radius = Math.hypot(
    Math.max(origin.x, window.innerWidth - origin.x),
    Math.max(origin.y, window.innerHeight - origin.y)
  )

  const from = `circle(0px at ${origin.x}px ${origin.y}px)`
  const to = `circle(${radius}px at ${origin.x}px ${origin.y}px)`

  document.documentElement.animate(
    { clipPath: [from, to] },
    {
      duration: 420,
      // Fluent 的加速曲线：起步快、收尾平滑
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      pseudoElement: '::view-transition-new(root)'
    }
  )
}

/** @description 主题读写：返回当前是否深色，以及带圆形揭示过渡的切换函数 */
export function useTheme(): {
  isDark: ComputedRef<boolean>
  toggle: (event: MouseEvent) => Promise<void>
} {
  const store = useThemeStore()

  /**
   * @description 切换主题；支持 View Transition 时以点击元素为圆心做圆形揭示
   * @param event 触发切换的鼠标事件（用于取圆心）
   */
  async function toggle(event: MouseEvent): Promise<void> {
    const dark = !store.dark

    /** @description 提交主题：写 store 并立即应用到根元素 */
    const commit = (): void => {
      store.dark = dark
      applyTheme(dark)
    }

    if (!document.startViewTransition || prefersReducedMotion()) {
      commit()
      return
    }

    // 上一段动画还没结束：先把当前这段收尾，再落定最终状态
    if (active) {
      const current = active
      try {
        await current.finished
      } catch {
        // 被跳过或取消，忽略
      } finally {
        if (active === current) active = null
      }
      if (store.dark !== dark) commit()
      return
    }

    const target = event.currentTarget
    const rect = target instanceof HTMLElement ? target.getBoundingClientRect() : null
    const origin = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: event.clientX, y: event.clientY }

    const transition = document.startViewTransition(async () => {
      commit()
      await nextTick()
    })
    active = transition

    try {
      await transition.ready
      reveal(origin)
    } catch {
      // 浏览器跳过了过渡，忽略（主题已经提交）
    }

    try {
      await transition.finished
    } catch {
      // 同上
    } finally {
      if (active === transition) active = null
    }
  }

  return { isDark: computed(() => store.dark), toggle }
}
