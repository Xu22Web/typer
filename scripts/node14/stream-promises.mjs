// `node:stream/promises` 的 Node 14 垫片。
//
// 这个模块是 Node 15 才加的；接收端产物要能跑在 Node 14 上，于是 esbuild 在打包时用原生 `alias`
// 把源码里的 `node:stream/promises` 指到这里（见 scripts/build-tools.mjs 的 NODE14_ALIAS）。
// 这里只用 Node 14 也有的回调式 `pipeline`，用 promisify 包成 Promise —— 行为与 `stream/promises`
// 的 `pipeline` 等价（同样等所有流收尾、任意一环出错即整体 reject）。
import { pipeline as callbackPipeline } from 'stream'
import { promisify } from 'util'

export const pipeline = promisify(callbackPipeline)

export default { pipeline }
