import { defineConfig, presetIcons, presetWind4 } from 'unocss'

export default defineConfig({
  presets: [
    // 关闭 preflight：项目已有自己的 reset（assets/base.css），避免两套重置互相干扰
    presetWind4({ preflights: { reset: false } }),
    // 图标：class 形如 `i-mdi-home`，图标集来自 @iconify-json/mdi
    presetIcons()
  ]
})
