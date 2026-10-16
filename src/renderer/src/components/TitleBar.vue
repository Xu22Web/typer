<script setup lang="ts" vapor>
/**
 * 自绘标题栏。
 *
 * 窗口是 `frame: false`，系统按钮不存在，因此这里承担三件事：
 * 1. 提供拖拽区域（`-webkit-app-region: drag`；空白处双击由系统接管为最大化）
 * 2. 承载品牌标识与当前页面标题，让"我在哪"始终可见
 * 3. 用自定义按钮替代最小化/最大化/关闭，视觉上与界面完全一致
 */
const { maximized, maximizedLabel, minimize, toggleMaximize, close } = useWindowState()

const route = useRoute()

const pageTitle = computed(() => {
  const matched = route.matched.at(-1)
  return (matched?.meta?.title as string | undefined) ?? 'Typer'
})
</script>

<template>
  <header class="titlebar">
    <RouterLink class="brand" to="/" title="Typer · 模拟键盘输入">
      <img class="mark" src="@renderer/assets/logo.svg" alt="" />
      <span class="name">Typer</span>
    </RouterLink>

    <span class="divider" />
    <span class="page-title">{{ pageTitle }}</span>

    <div class="spacer" />

    <ThemeToggle />

    <div class="controls">
      <button class="ctrl" type="button" title="最小化" aria-label="最小化" @click="minimize()">
        <span class="i-mdi-window-minimize" />
      </button>
      <button
        class="ctrl"
        type="button"
        :title="maximizedLabel"
        :aria-label="maximizedLabel"
        @click="toggleMaximize()"
      >
        <span :class="maximized ? 'i-mdi-window-restore' : 'i-mdi-window-maximize'" />
      </button>
      <button class="ctrl close" type="button" title="关闭" aria-label="关闭" @click="close()">
        <span class="i-mdi-close" />
      </button>
    </div>
  </header>
</template>

<style scoped lang="scss">
.titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--titlebar-h);
  padding-left: 14px;
  background: var(--acrylic);
  backdrop-filter: blur(30px) saturate(140%);
  border-bottom: 1px solid var(--stroke);
  flex: none;
  /* 盖在内容遮罩（倒计时等）之上，窗口按钮始终可用 */
  position: relative;
  z-index: 30;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
  border-radius: var(--radius-md);
  color: var(--text-1);
  text-decoration: none;
  transition: background-color 0.12s ease;

  &:hover {
    background: var(--ctrl-fill);
    text-decoration: none;
  }

  .mark {
    width: 22px;
    height: 22px;
  }
}

.name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
}

.divider {
  width: 1px;
  height: 16px;
  background: var(--stroke-strong);
}

/*
 * 当前页面名。类名刻意不叫 `.page`：全局样式里的 `.page` 是"页面骨架"
 * （width: 100% + flex-direction: column），撞名会让这里被撑满整条标题栏，
 * 文本随即被 align-items 水平居中——看起来就像"页面名莫名其妙居中了"。
 */
.page-title {
  font-size: 13px;
  line-height: 1;
  color: var(--text-2);
}

/* 窗口按钮：占满整条标题栏高度，颜色随主题走 */
.controls {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  margin-left: 4px;
}

.ctrl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 16px;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;

  &:hover {
    background: var(--ctrl-fill);
    color: var(--text-1);
  }

  &:active {
    background: var(--ctrl-fill-pressed);
  }

  &.close:hover {
    background: #c42b1c;
    color: #fff;
  }
}
</style>
