// 由 resources/icon.svg 生成各平台所需位图：
//   build/icon.png     1024×1024（electron-builder 的图标源，Windows 会自动转成多尺寸 ICO）
//   build/icon.ico     16/24/32/48/64/128/256 多尺寸（供直接引用与跨机器构建）
//   resources/icon.png 512×512（BrowserWindow 窗口图标）
//   build/preview/*    预览图（人工检查小尺寸可读性）
//
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

async function renderPng(size) {
  const svg = readFileSync(source)
  return sharp(svg, { density: Math.max(72, Math.ceil((size / 512) * 72 * 8)) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function main() {
  const previewDir = join(root, 'build', 'preview')
  mkdirSync(previewDir, { recursive: true })

  // 1) 大图标（electron-builder 的源图）
  const big = await renderPng(1024)
  writeFileSync(join(root, 'build', 'icon.png'), big)

  // 2) 窗口图标
  const windowIcon = await renderPng(512)
  writeFileSync(join(root, 'resources', 'icon.png'), windowIcon)

  // 3) 多尺寸 ICO
  const frames = []
  for (const size of ICO_SIZES) frames.push(await renderPng(size))
  const ico = await pngToIco(frames)
  writeFileSync(join(root, 'build', 'icon.ico'), ico)

  // 4) 预览图，便于人工核对小尺寸是否清晰
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
