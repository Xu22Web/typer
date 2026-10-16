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
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
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
    // tools/ 下的接收/分片脚本要能直接 `node xxx.mjs` 运行（目标机不一定有构建环境），
    // 因此同样是纯 JS：不做类型标注要求，并且允许脚本里用 process / console 这类全局。
    files: ['tools/**/*.mjs'],
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
