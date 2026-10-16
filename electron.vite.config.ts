import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import vueDevtools from 'vite-plugin-vue-devtools'
import AutoImport from 'unplugin-auto-import/vite'
import Components from '@xu22web/unplugin-vue-components/vite'
import { ElementPlusResolver } from '@xu22web/unplugin-vue-components/resolvers'
import UnoCSS from 'unocss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        // 主进程内部也用别名，避免深层相对路径
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // 渲染进程直接引用主进程的纯函数/类型（预览统计、状态标签、载荷净化等）
        '@main': resolve('src/main')
      }
    },
    plugins: [
      vue({
        features: {
          // Vue 3.6+ Vapor Mode
          vapor: true
        }
      }),
      // Vue DevTools（仅 dev）；launchEditor 支持编辑器跳转
      vueDevtools({
        launchEditor: 'code'
      }),
      // API 自动导入（组合式函数 + Element Plus 命令式 API）
      // 组件与组合式函数都不需要手写 import：dev / build 时会动态生成 dts
      AutoImport({
        imports: ['vue', 'pinia', 'vue-router'],
        dirs: [resolve('src/renderer/src/composables')],
        resolvers: [ElementPlusResolver()],
        dts: resolve('src/renderer/src/auto-imports.d.ts'),
        eslintrc: {
          enabled: true,
          filepath: resolve('src/renderer/src/.eslintrc-auto-import.json'),
          globalsPropValue: 'readonly'
        }
      }),
      // 组件自动导入：本地目录 + 第三方 resolver（支持 Vapor 模式）
      Components({
        vapor: true,
        dirs: [resolve('src/renderer/src/components')],
        dts: resolve('src/renderer/src/components.d.ts'),
        resolvers: [ElementPlusResolver()]
      }),
      UnoCSS({
        // 配置文件在渲染进程源码目录（写错路径时 UnoCSS 会静默退回默认配置，只有构建时才会报错）
        configFile: resolve('src/renderer/src/uno.config.ts')
      })
    ]
  }
})
