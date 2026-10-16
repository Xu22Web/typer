import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useThemeStore = defineStore(
  'theme',
  () => {
    const dark = ref(true)

    return { dark }
  },
  { persist: true }
)
