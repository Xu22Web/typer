import '../styles'

import { createApp, vaporInteropPlugin } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import FloatWindow from './FloatWindow.vue'

/**
 * 进度浮窗入口（`float.html`）：只装配浮窗需要的最小运行时。
 */
const app = createApp(FloatWindow)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(vaporInteropPlugin)
app.use(pinia)

// 主题存在 pinia store 里，必须在 app.use(pinia) 之后读取
setupTheme()

app.mount('#app')
