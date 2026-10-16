import { readFileSync } from 'node:fs'
import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

// 生成文件，读取而非 import，避免模块缓存导致 globals 过期
const autoImportConfig = JSON.parse(
  readFileSync(new URL('./src/renderer/src/.eslintrc-auto-import.json', import.meta.url), 'utf8')
)

export default defineConfig(
  {
    // tools/*.mjs 是 scripts/build-tools.mjs 打包出来的接收端产物（机器生成，不参与 lint）
    ignores: ['**/node_modules', '**/dist', '**/out', 'tools/*.mjs']
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    languageOptions: {
      globals: autoImportConfig.globals
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    // scripts/ 下是纯 JS 的构建/工具脚本（不参与类型检查），无需 TS 风格的类型标注
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // tools/ 下是接收端源码（tools/**/*.ts；它的构建产物 tools/*.mjs 已在上面被忽略）：
    // 它要能直接 `node typer-recv.mjs` 运行，因此会用 node: 内置模块与 process / console / Buffer
    // 这类全局，这里显式声明可用全局；类型标注已由 tsc 收敛，不再额外强制
    files: ['tools/**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
