import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
