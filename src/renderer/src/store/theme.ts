import { ref } from 'vue'
import { defineStore } from 'pinia'

/** 主题状态：只保存"是否深色"，持久化到 localStorage，刷新后保持 */
export const useThemeStore = defineStore(
  'theme',
  () => {
    /** 是否使用深色主题（默认深色，与 Windows 应用观感一致） */
    const dark = ref(true)

    return { dark }
  },
  { persist: true }
)
