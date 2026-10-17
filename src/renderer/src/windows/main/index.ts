import '../styles'
import 'element-plus/theme-chalk/dark/css-vars.css'

import { createApp, vaporInteropPlugin } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import router from '@renderer/router'

/** 主窗口入口（`index.html`）：装配主题、Pinia、路由后挂载应用外壳 */
const app = createApp(App)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

// Vapor 组件与 vdom 组件（Element Plus、vue-router）互操作必需
app.use(vaporInteropPlugin)
app.use(pinia)
app.use(router)

// 主题存在 pinia store 里，必须在 app.use(pinia) 之后读取；挂载前写入根元素可避免首帧闪白
setupTheme()

app.mount('#app')
