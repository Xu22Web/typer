/** 新手引导状态：首次启动自动播放漫游式引导；重播信号由「关于」页触发 */
export const useOnboardingStore = defineStore(
  'onboarding',
  () => {
    /** 是否已完成首次引导（走完或中途关闭都算，之后不再自动播放） */
    const tourDone = ref(false)
    /** 重播信号：每次递增都请求从头播放一次（不持久化） */
    const tourSignal = ref(0)

    /** @description 标记引导完成，自动播放不再触发 */
    function markTourDone(): void {
      tourDone.value = true
    }

    /** @description 请求重播引导（配合跳回输入页使用） */
    function restartTour(): void {
      tourSignal.value += 1
    }

    return { tourDone, tourSignal, markTourDone, restartTour }
  },
  { persist: { pick: ['tourDone'] } }
)
