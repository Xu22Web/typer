<script setup lang="ts" vapor>
/**
 * 左侧导航：四个平级页面入口，选中态为"左侧 3px 强调条 + 轻微填充"（Fluent 的选择指示方式）。
 */
/** 导航项：路径、图标、名称与悬停提示 */
const items = [
  { to: '/', icon: 'i-mdi-keyboard-outline', label: '输入', hint: '粘贴内容并开始模拟输入' },
  { to: '/logs', icon: 'i-mdi-text-box-search-outline', label: '日志', hint: '查看运行记录' },
  { to: '/settings', icon: 'i-mdi-tune-vertical', label: '设置', hint: '节奏、随机性、焦点与隐私' },
  { to: '/about', icon: 'i-mdi-information-outline', label: '关于', hint: '版本、更新与链接' }
]

/** 是否有可用更新，用于在「关于」项上加提示点 */
const { available } = useUpdate()
</script>

<template>
  <nav class="sidenav">
    <ul class="list">
      <li v-for="item in items" :key="item.to">
        <RouterLink class="item" :to="item.to" :title="item.hint">
          <div class="nav-indicator" />
          <div class="icon" :class="item.icon" />
          <div class="label">{{ item.label }}</div>
          <div
            v-if="item.to === '/about' && available"
            class="badge"
            title="有新版本可用"
            aria-label="有新版本可用"
          />
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped lang="scss">
.sidenav {
  flex: none;
  width: var(--sidenav-w);
  padding: 8px;
  border-right: 1px solid var(--stroke);
  overflow-y: auto;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 10px 0 14px;
  border-radius: var(--radius-md);
  color: var(--text-1);
  text-decoration: none;
  font-size: 13px;
  transition: background-color 0.12s ease;

  &:hover {
    background: var(--ctrl-fill);
    text-decoration: none;
  }

  &:active {
    background: var(--ctrl-fill-pressed);
  }

  /* 选中指示条：默认不可见，选中时从 12px 长到 16px */
  .nav-indicator {
    position: absolute;
    left: 0;
    top: 50%;
    width: 3px;
    height: 0;
    border-radius: 999px;
    background: var(--accent);
    transform: translateY(-50%);
    transition: height 0.15s ease;
  }

  &.active {
    background: var(--ctrl-fill);

    .nav-indicator {
      height: 16px;
    }

    .icon {
      color: var(--accent);
    }

    .label {
      font-weight: 600;
    }
  }
}

.icon {
  flex: none;
  font-size: 18px;
  color: var(--text-2);
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  margin-left: auto;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
</style>
