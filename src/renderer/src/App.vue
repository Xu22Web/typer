<script setup lang="ts" vapor>
/**
 * 应用外壳：标题栏 / 左侧导航 / 内容区 / 状态栏。
 *
 * 这里同时负责两件"全局"的事：
 *  - 挂载全局倒计时遮罩（跨页面可见）
 *  - 启动一次更新检查（节流由主进程负责），让侧边导航能给出"有新版本"提示
 */
const { init } = useUpdate()

onMounted(() => {
  void init()
})
</script>

<template>
  <TitleBar />

  <div class="body">
    <SideNav />

    <main class="main">
      <div class="content">
        <RouterView />
      </div>
    </main>
  </div>

  <StatusBar />
  <CountdownOverlay />
</template>

<style scoped lang="scss">
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.content {
  display: flex;
  flex-direction: column;
  max-width: 1080px;
  min-height: 100%;
  margin: 0 auto;
  padding: 20px 24px 28px;
}
</style>
