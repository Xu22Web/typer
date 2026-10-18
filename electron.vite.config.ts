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
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        // 两个窗口各自的 HTML 入口：主窗口与进度浮窗（浮窗只挂载 FloatWindow，不引入路由与页面）
        input: {
          index: resolve('src/renderer/index.html'),
          float: resolve('src/renderer/float.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // 渲染进程直接引用主进程的纯函数/类型（预览统计、状态标签、载荷净化等）
        '@main': resolve('src/main'),
        // 跨进程共享的纯常量/纯函数（不含 node: 依赖）
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      // Vue 3.6+ Vapor Mode：文件级 opt-in——每个 SFC 的 <script setup> 必须显式写 vapor
      // 属性（约定由 tests/unit/renderer/vaporConvention.spec.ts 守护）。
      // 不开 features.vapor 强制开关：个别需要按 vdom 编译的例外组件（如 ElTour 的
      // FirstRunTour，见其文件头注释）只要不写属性即可，不必扭曲写法
      vue(),
      // Vue DevTools（仅 dev）；launchEditor 支持编辑器跳转
      vueDevtools({
        launchEditor: 'code'
      }),
      // API 自动导入（组合式函数 + Element Plus 命令式 API）
      // 组件与组合式函数都不需要手写 import：dev / build 时会动态生成 dts
      AutoImport({
        imports: ['vue', 'pinia', 'vue-router'],
        // 组合式函数与 Pinia setup store 都是 use* 形态，一并自动注册
        dirs: [resolve('src/renderer/src/composables'), resolve('src/renderer/src/store')],
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
