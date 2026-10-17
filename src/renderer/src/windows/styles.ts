/**
 * 两个窗口共用的基础样式。
 *
 * `virtual:uno.css` 只能在这一个文件里引入：UnoCSS 的构建扫描要求全项目只有一处引入，
 * 多个入口各引一次会报警告并只采用第一处。
 */
import '@renderer/assets/main.css'
import 'virtual:uno.css'
