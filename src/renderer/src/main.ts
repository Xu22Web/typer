import './assets/main.css'
import 'virtual:uno.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

import { createApp, vaporInteropPlugin } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import router from './router'

/** 渲染进程入口：装配主题、Pinia、路由后挂载应用 */
const app = createApp(App)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

// Vapor 组件与 vdom 组件（Element Plus、vue-router）互操作必需
app.use(vaporInteropPlugin)
app.use(pinia)
app.use(router)

// 挂载前先把主题写到根元素，避免首帧闪白
setupTheme()

app.mount('#app')
