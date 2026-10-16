<script setup lang="ts" vapor>
/** 应用外壳：标题栏 / 左侧导航 / 内容区 / 状态栏 / 全局倒计时遮罩 */
const { init } = useUpdate()

/** @description 启动一次更新检查（节流由主进程负责），供侧边导航显示"有新版本"提示 */
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
        <RouterView v-slot="{ Component }">
          <KeepAlive>
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
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
