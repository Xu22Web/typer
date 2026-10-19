<script setup lang="ts" vapor>
/**
 * 关于页：应用身份 + 更新中心 + 外部链接 + 说明；
 * 说明部分默认折叠，避免和"检查更新"这类要动手的事争抢注意力。
 */
/** 应用身份（名称/版本/平台与是否受支持）；读取失败时为 null */
const info = ref<{ name: string; version: string; platform: string; supported: boolean } | null>(
  null
)

/** 对外链接入口 */
const links = [
  { icon: 'i-mdi-github', label: 'GitHub 仓库', url: 'https://github.com/Xu22Web/typer' },
  {
    icon: 'i-mdi-tag-outline',
    label: '发布记录',
    url: 'https://github.com/Xu22Web/typer/releases'
  },
  {
    icon: 'i-mdi-bug-outline',
    label: '反馈问题',
    url: 'https://github.com/Xu22Web/typer/issues'
  },
  {
    icon: 'i-mdi-license',
    label: 'MIT 许可证',
    url: 'https://github.com/Xu22Web/typer/blob/master/LICENSE'
  }
]

/** 实现要点：让用户知道按键是怎么真的发出去的 */
const highlights = [
  {
    icon: 'i-mdi-keyboard-settings-outline',
    title: '真实按键',
    text: '可打印 ASCII 与需要 Shift 的组合键走 Win32 SendInput，修饰键与主键在同一批事件里原子下发。'
  },
  {
    icon: 'i-mdi-timer-cog-outline',
    title: '修饰键时序',
    text: '修饰键与主键分开下发并预留间隔：远程桌面会把同一批里的 Shift 合批丢弃，拆开后才能生效。'
  },
  {
    icon: 'i-mdi-package-variant-closed',
    title: '免原生编译',
    text: '注入逻辑由一个 PowerShell + 内联 C# 宿主进程完成，不需要 node-gyp 或 MSVC 工具链。'
  },
  {
    icon: 'i-mdi-shield-lock-outline',
    title: '安全边界',
    text: '输入内容不落盘；任何结束路径都会释放修饰键，避免"粘键"。'
  }
]

/** 已知限制：说明注入不生效的典型场景，避免用户把环境限制当成程序缺陷 */
const limitations = [
  '无法向"以管理员身份运行"的窗口注入按键（Windows UIPI 限制）——目标程序需与本体权限一致',
  '锁定屏幕、UAC 弹窗、安全桌面（Ctrl+Alt+Del 界面）无法注入',
  '部分安全软件会拦截合成按键，此时会返回可读错误而不是静默失败',
  '少数游戏或自绘界面只认扫描码、或忽略 WM_CHAR，无法通过合成按键输入',
  '键盘布局必须与目标窗口一致；布局里没有的字符会被判定为无法输入',
  '远程桌面只转发真实键盘事件：中文、emoji 等没有物理键位的字符无法输入（不会静默丢字，开始前会报错）'
]

/** @description 读取应用身份信息（失败时页面上显示占位符） */
onMounted(async () => {
  try {
    info.value = await window.api.getAppInfo()
  } catch {
    info.value = null
  }
})

const router = useRouter()
const onboarding = useOnboardingStore()

/**
 * @description 回到输入页并重播新手引导（引导目标都在输入页上）
 */
function replayTour(): void {
  void router.push('/')
  onboarding.restartTour()
}

/**
 * @description 用系统浏览器打开外部链接
 * @param url 目标地址
 */
async function open(url: string): Promise<void> {
  try {
    await window.api.openExternal(url)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <section class="page">
    <header class="hero">
      <img class="mark" src="@renderer/assets/logo.svg" alt="" />
      <div class="meta">
        <h1>Typer</h1>
        <div class="version mono">
          <div>版本 {{ info?.version ?? '—' }}</div>
          <div v-if="info && !info.supported" class="chip bad">当前平台不支持键盘注入</div>
        </div>
        <p class="tagline">把文本逐字符模拟输入到任意窗口的 Windows 桌面工具。</p>
      </div>
    </header>

    <UpdateCenter />

    <section class="card">
      <div class="card-head">
        <h2 class="card-title"><span class="icon i-mdi-map-marker-path" /><span>快速入门</span></h2>
      </div>
      <div class="quickstart">
        <p class="desc">
          首次启动的漫游式引导可以随时重看：回到输入页，逐步认识内容区、目标窗口与开始流程。
        </p>
        <ElButton size="small" @click="replayTour()">
          <span class="i-mdi-replay" /><span>重新查看新手引导</span>
        </ElButton>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title"><span class="icon i-mdi-link-variant" /><span>相关链接</span></h2>
      </div>
      <div class="links">
        <button
          v-for="item in links"
          :key="item.url"
          class="link"
          type="button"
          @click="open(item.url)"
        >
          <span class="icon" :class="item.icon" />
          <span class="label">{{ item.label }}</span>
          <span class="i-mdi-open-in-new open" />
        </button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">
          <span class="icon i-mdi-lightbulb-outline" /><span>它是怎么工作的</span>
        </h2>
      </div>
      <ul class="highlights">
        <li v-for="item in highlights" :key="item.title">
          <div class="icon" :class="item.icon" />
          <div>
            <strong>{{ item.title }}</strong>
            <p>{{ item.text }}</p>
          </div>
        </li>
      </ul>
    </section>

    <ElCollapse class="more">
      <ElCollapseItem name="limits">
        <template #title>
          <div class="collapse-title">
            <div class="i-mdi-alert-outline" />
            <div>已知限制（{{ limitations.length }} 条）</div>
          </div>
        </template>
        <ul class="limits">
          <li v-for="item in limitations" :key="item">{{ item }}</li>
        </ul>
      </ElCollapseItem>

      <ElCollapseItem name="license">
        <template #title>
          <div class="collapse-title">
            <div class="i-mdi-license" />
            <div>使用须知与许可</div>
          </div>
        </template>
        <div class="license">
          <p>
            本工具用于自动化填表、演示、批处理与测试等<strong>合法用途</strong>。
            请勿用于绕过安全控制、未获授权的自动化操作，或任何违反目标程序服务条款的场景；
            使用前请自行确认合规性。
          </p>
          <p>以 MIT 许可证分发，可自由使用、修改与再分发。</p>
        </div>
      </ElCollapseItem>
    </ElCollapse>
  </section>
</template>

<style scoped lang="scss">
.hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 4px 2px;

  .mark {
    width: 64px;
    height: 64px;
    border-radius: var(--radius-lg);
  }
}

.meta h1 {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.version {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--text-2);
}

.tagline {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-2);
}

.links {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}

.quickstart {
  display: flex;
  align-items: center;
  gap: 16px;
  justify-content: space-between;
  flex-wrap: wrap;

  .desc {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--text-2);
    flex: 1;
    min-width: 220px;
  }
}

.link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-md);
  background: var(--ctrl-fill);
  color: var(--text-1);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;

  &:hover {
    background: var(--ctrl-fill-hover);
    border-color: var(--stroke-hover);
  }

  .icon {
    font-size: 16px;
    color: var(--text-2);
  }

  .label {
    flex: 1;
  }

  .open {
    font-size: 13px;
    color: var(--text-3);
  }
}

.highlights {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;

  li {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--stroke);
    border-radius: var(--radius-md);
    background: var(--ctrl-fill);
  }

  .icon {
    flex: none;
    margin-top: 2px;
    font-size: 16px;
    color: var(--accent);
  }

  strong {
    display: block;
    font-size: 13px;
    font-weight: 600;
  }

  p {
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.7;
    color: var(--text-2);
  }
}

.collapse-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.limits {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 18px;
  list-style: disc;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-2);
}

.license {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--text-2);

  strong {
    font-weight: 600;
    color: var(--text-1);
  }
}

/* 折叠面板的"连体"外观（卡片化、间距）统一在 main.css 处理，这里只补本页的标题字重与箭头配色 */
.more :deep(.el-collapse-item__header) {
  font-weight: 600;
}

.more :deep(.el-collapse-item__arrow) {
  color: var(--text-2);
}
</style>
