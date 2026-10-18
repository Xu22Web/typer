/** 主题状态：是否深色与是否跟随系统，持久化到 localStorage，刷新后保持 */
export const useThemeStore = defineStore(
  'theme',
  () => {
    /** 是否使用深色主题（跟随系统开启时由系统偏好决定） */
    const dark = ref(true)
    /** 是否跟随系统的亮暗偏好；任何手动切换都会把它关掉 */
    const followSystem = ref(true)

    return { dark, followSystem }
  },
  { persist: true }
)
