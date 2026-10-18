<script setup lang="ts">
/**
 * 新手引导（漫游式 Tour）：首次启动在输入页自动播放一遍；
 * 「关于」页的「重新查看新手引导」递增 tourSignal 重播。
 * 引导的目标元素由各组件上的 #tour-* id 提供，只在输入页存在——重播前由「关于」页跳回输入页。
 *
 * 注意：本文件故意不带 vapor 属性、按 vdom 编译。ElTour 靠组件名过滤默认插槽里的
 * ElTourStep vnode，Vapor 模板的插槽子节点会被 interop 包装成不透明片段、过滤不到
 * （内容渲染为空）。vdom 模板里 unplugin-vue-components 的自动解析走
 * _resolveComponent 路径（vapor 包装只作用于 createAssetComponent），因此
 * ElTour/ElTourStep 与本组件自身都不需要手动 import，样式也随解析自动注入。
 */
const store = useOnboardingStore()

/** 是否正在播放 */
const open = ref(false)
/** 当前步骤序号 */
const current = ref(0)

/** 遮罩浓度随主题走：浅色主题的半透明黑压得太深会显得"脏" */
const { isDark } = useTheme()
const maskColor = computed(() => (isDark.value ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.32)'))

/** 按钮文案（Element Plus 默认是英文，这里直接给中文） */
const prevText = { children: '上一步' }
const nextText = { children: '下一步' }
const doneText = { children: '开始使用' }

/**
 * @description 从若干候选选择器里挑第一个真正可见的元素。
 * 窄窗口下侧栏整块不参与布局、宽窗口下页头胶囊不渲染，隐藏目标的 rect 全为 0，
 * ElTour 会把卡片贴到视口左上角。这里按可见性挑选，都不可见时返回 null，
 * ElTour 会退回无目标的居中卡片，而不是贴边。
 */
function visibleTarget(...selectors: string[]): () => HTMLElement | null {
  return () => {
    for (const selector of selectors) {
      const el = document.querySelector<HTMLElement>(selector)
      if (el && el.getBoundingClientRect().width > 0) return el
    }
    return null
  }
}

/** @description 结束引导：走完或中途关闭都标记完成，不再自动播放 */
function finish(): void {
  open.value = false
  store.markTourDone()
}

/** @description 可见性变化：被关闭（X / ESC）时同样算完成 */
function onOpenChange(value: boolean): void {
  open.value = value
  if (!value) store.markTourDone()
}

onMounted(() => {
  if (store.tourDone) return
  // 等页面布局稳定后再开，避免第一步定位到还在参与布局计算的元素
  setTimeout(() => {
    open.value = true
  }, 500)
})

// 「关于」页请求重播：回到第一步；等路由切回输入页、目标元素挂载后再播放
watch(
  () => store.tourSignal,
  () => {
    current.value = 0
    setTimeout(() => {
      open.value = true
    }, 300)
  }
)
</script>

<template>
  <ElTour
    :model-value="open"
    :current="current"
    :show-arrow="false"
    :gap="{ offset: 6, radius: 8 }"
    :mask="{ color: maskColor }"
    :scroll-into-view-options="{ block: 'center' }"
    @update:model-value="onOpenChange($event as boolean)"
    @update:current="current = $event as number"
    @close="finish()"
    @finish="finish()"
  >
    <ElTourStep
      title="欢迎使用 Typer"
      description="Typer 把文本与文件模拟成真实键盘输入，落到任意窗口里。花一分钟认识几个关键位置，随时按 Esc 退出。"
      :next-button-props="nextText"
    />

    <ElTourStep
      target="#tour-mode-switch"
      placement="bottom-start"
      title="两种输入模式"
      description="「文本」把内容逐字符模拟打字；「文件」把文件切成帧逐片发送到目标机，支持断点续传。"
      :prev-button-props="prevText"
      :next-button-props="nextText"
    />

    <ElTourStep
      :target="visibleTarget('#tour-text-input')"
      placement="bottom-start"
      title="内容区"
      description="把要打的字粘贴到这里（Ctrl+V），或用「导入文本」读文件；下方实时显示字符数与预计耗时。"
      :prev-button-props="prevText"
      :next-button-props="nextText"
    />

    <ElTourStep
      :target="visibleTarget('#tour-target-refresh-wide', '#tour-target-refresh-chip')"
      placement="bottom-end"
      title="目标窗口"
      description="窗口指示显示当前前台窗口名，点这里可以重新检测。开始前先点一下目标程序的输入位置，输入就会落在它上面。"
      :prev-button-props="prevText"
      :next-button-props="nextText"
    />

    <ElTourStep
      target="#tour-start"
      placement="top-end"
      title="开始输入"
      description="点开始后有默认 3 秒倒计时，趁现在切到目标窗口。输入时主窗口会最小化，屏幕边缘留一条进度细条，鼠标靠近可展开成控制卡片。"
      :prev-button-props="prevText"
      :next-button-props="nextText"
    />

    <ElTourStep
      target="#tour-stop"
      placement="top"
      title="随时能停"
      description="点「停止」立即中止；焦点不在 Typer 上也能用 Ctrl+Alt+X 紧急停止、Ctrl+Alt+P 暂停/继续。热键可以在设置里改。"
      :prev-button-props="prevText"
      :next-button-props="nextText"
    />

    <ElTourStep
      target="#tour-sidenav-settings"
      placement="right"
      title="按需调整"
      description="节奏、错字、热键、文件传输参数都在「设置」；运行记录在「日志」。设置页右侧有目录锚点，长页面也能一键跳转。"
      :prev-button-props="prevText"
      :next-button-props="nextText"
    />

    <ElTourStep
      title="准备好了"
      description="现在就去粘贴点什么试试。想再看一遍引导，随时到「关于」页点「重新查看新手引导」。"
      :prev-button-props="prevText"
      :next-button-props="doneText"
    />
  </ElTour>
</template>
