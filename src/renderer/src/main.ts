import './assets/main.css'
import 'virtual:uno.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

import { createApp, vaporInteropPlugin } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import router from './router'

const app = createApp(App)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

// Vapor 组件 ↔ vdom 树互操作桥接（启用 features.vapor 后必需）
app.use(vaporInteropPlugin)
app.use(pinia)
app.use(router)

// 挂载前应用，避免首帧闪烁
setupTheme()

app.mount('#app')
