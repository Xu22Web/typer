/**
 * @description 把主题写到根元素上，供 CSS 变量与 Element Plus 深色变量选择
 * @param dark 是否深色
 */
function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
}

/** @description 系统当前是否偏好深色主题 */
function systemPrefersDark(): boolean {
  return matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * @description 解析 localStorage 里持久化的主题状态（字段缺失或损坏时对应项为 undefined）
 * @returns 主题状态
 */
function readPersistedTheme(): { dark?: boolean; followSystem?: boolean } {
  try {
    const raw = localStorage.getItem('theme')
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { dark?: unknown; followSystem?: unknown }
    return {
      dark: typeof parsed.dark === 'boolean' ? parsed.dark : undefined,
      followSystem: typeof parsed.followSystem === 'boolean' ? parsed.followSystem : undefined
    }
  } catch {
    return {}
  }
}

/** @description 把持久化的主题应用到根元素；在挂载前调用可避免首帧闪烁，并开始跟随系统 */
export function setupTheme(): void {
  const store = useThemeStore()
  if (store.followSystem) store.dark = systemPrefersDark()
  applyTheme(store.dark)

  // 每个窗口各自调用一次；系统亮暗变化时，跟随系统开启的窗口同步切换（无动画）
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    const current = useThemeStore()
    if (!current.followSystem || current.dark === event.matches) return
    current.dark = event.matches
    applyTheme(event.matches)
  })

  // 跨窗口同步：主题存在各窗口自己的 pinia 里，另一侧手动切换时靠 storage 事件跟过来
  window.addEventListener('storage', (event) => {
    if (event.key !== 'theme') return
    const persisted = readPersistedTheme()
    const current = useThemeStore()
    const dark = persisted.dark ?? current.dark
    const follow = persisted.followSystem ?? current.followSystem
    if (current.dark === dark && current.followSystem === follow) return
    current.dark = dark
    current.followSystem = follow
    applyTheme(dark)
  })
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

/** @description 主题读写：手动切换（自动停止跟随系统）与跟随系统开关 */
export function useTheme(): {
  isDark: ComputedRef<boolean>
  followSystem: ComputedRef<boolean>
  toggle: (event: MouseEvent) => Promise<void>
  setDark: (dark: boolean, event?: MouseEvent) => Promise<void>
  setFollowSystem: (value: boolean) => void
} {
  const store = useThemeStore()

  /**
   * @description 手动切换主题：关闭跟随系统；支持 View Transition 时以触发元素为圆心做圆形揭示
   * @param dark 目标主题
   * @param event 触发切换的鼠标事件（用于取圆心；省略则直接切换）
   */
  async function setDark(dark: boolean, event?: MouseEvent): Promise<void> {
    /** @description 提交主题：写 store 并立即应用到根元素 */
    const commit = (): void => {
      store.followSystem = false
      store.dark = dark
      applyTheme(dark)
    }

    if (!document.startViewTransition || prefersReducedMotion() || !event) {
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

  /**
   * @description 标题栏按钮的切换：反转当前主题（手动切换，自动停止跟随系统）
   * @param event 触发切换的鼠标事件
   */
  async function toggle(event: MouseEvent): Promise<void> {
    await setDark(!store.dark, event)
  }

  /**
   * @description 跟随系统的开关；打开时立即同步到系统当前偏好
   * @param value 是否跟随系统
   */
  function setFollowSystem(value: boolean): void {
    store.followSystem = value
    if (!value) return
    const dark = systemPrefersDark()
    if (store.dark === dark) return
    store.dark = dark
    applyTheme(dark)
  }

  return {
    isDark: computed(() => store.dark),
    followSystem: computed(() => store.followSystem),
    toggle,
    setDark,
    setFollowSystem
  }
}
