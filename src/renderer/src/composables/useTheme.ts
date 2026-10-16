import { useThemeStore } from '@renderer/store/theme'
import type { ComputedRef } from 'vue'

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
}

export function setupTheme(): void {
  applyTheme(useThemeStore().dark)
}

/** 正在播放的扩散过渡；用户连点时用它避免两段动画互相打架。 */
let active: ViewTransition | null = null

function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 从圆心向外扩散的圆形揭示动画。
 *
 * 几个刻意的选择：
 * - **以触发按钮的中心为圆心**，而不是点击坐标：切换是"这个按钮干的"，
 *   从按钮往外扩散更符合因果直觉，也不会因为点在按钮边缘而偏心。
 * - **半径取到最远的那个角**：否则扩散会在角落留下没被覆盖的死区。
 * - **只对 `::view-transition-new(root)` 施加 clip-path**，并配合 main.css 关掉
 *   默认交叉淡入，效果是"新主题从一个圆里长出来"，而不是两层半透明糊在一起。
 * - **连点直接落定**：上一段还在跑时不再嵌套启动，避免闪烁与卡顿。
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

export function useTheme(): {
  isDark: ComputedRef<boolean>
  toggle: (event: MouseEvent) => Promise<void>
} {
  const store = useThemeStore()

  async function toggle(event: MouseEvent): Promise<void> {
    const dark = !store.dark

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
