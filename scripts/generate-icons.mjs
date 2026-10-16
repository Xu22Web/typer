// 由 resources/icon.svg 生成各平台位图：build/icon.png（1024，electron-builder 图标源）、build/icon.ico（多尺寸）、
// resources/icon.png（512，BrowserWindow 窗口图标）与 build/preview/*（人工核对小尺寸可读性）。
// 用 `pnpm icons` 重新生成；改动图标设计只需改 resources/icon.svg。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'resources', 'icon.svg')

/** ICO 里包含的尺寸（Windows 会按需挑选，缺少的尺寸会被缩放导致模糊）。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** 预览尺寸：覆盖列表视图、任务栏、磁贴等典型显示场景。 */
const PREVIEW_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/**
 * @description 把 SVG 按指定边长渲染成透明 PNG
 * @param size 目标边长（像素）
 * @returns PNG 数据
 */
async function renderPng(size) {
  const svg = readFileSync(source)
  return sharp(svg, { density: Math.max(72, Math.ceil((size / 512) * 72 * 8)) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** @description 生成全部图标资源与预览图 */
async function main() {
  const previewDir = join(root, 'build', 'preview')
  mkdirSync(previewDir, { recursive: true })

  const big = await renderPng(1024)
  writeFileSync(join(root, 'build', 'icon.png'), big)

  const windowIcon = await renderPng(512)
  writeFileSync(join(root, 'resources', 'icon.png'), windowIcon)

  const frames = []
  for (const size of ICO_SIZES) frames.push(await renderPng(size))
  const ico = await pngToIco(frames)
  writeFileSync(join(root, 'build', 'icon.ico'), ico)

  for (const size of PREVIEW_SIZES) {
    writeFileSync(join(previewDir, `icon-${size}.png`), await renderPng(size))
  }

  console.log(`icon.png      ${big.length} bytes (1024×1024)`)
  console.log(`icon.ico      ${ico.length} bytes (${ICO_SIZES.join('/')})`)
  console.log(`resources/icon.png ${windowIcon.length} bytes (512×512)`)
  console.log(`preview/      ${PREVIEW_SIZES.join('/')}`)
}

main().catch((error) => {
  console.error('生成图标失败：', error)
  process.exit(1)
})
