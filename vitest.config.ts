import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import AutoImport from 'unplugin-auto-import/vite'

export default defineConfig({
  plugins: [
    // 测试直接编译渲染进程源码，也要走与 electron.vite.config.ts 相同的 API 自动导入，
    // 否则去掉显式 import 的 composables / store 在测试里会 ReferenceError；
    // dts / eslintrc 关闭：那是 dev / build 的职责，测试不该并发写这些文件
    AutoImport({
      imports: ['vue', 'pinia', 'vue-router'],
      dirs: [resolve('src/renderer/src/composables'), resolve('src/renderer/src/store')],
      dts: false,
      eslintrc: { enabled: false }
    })
  ],
  resolve: {
    alias: {
      // 与 electron.vite.config.ts / tsconfig.*.json 保持一致
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.spec.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'system',
          environment: 'node',
          include: ['tests/system/**/*.spec.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/main/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/main/**/*.d.ts']
    }
  }
})
