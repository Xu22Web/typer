/**
 * 文本导入的共享约定（主进程的文件选择框与渲染进程的拖入校验共用一份，避免两处清单漂移）。
 */

/**
 * 文本模式内容区的字符上限：内容区输入、导入截断与 IPC 校验都只用这一个数。
 *
 * 8 万字符在 446 字符/秒的节奏下约三分钟打完；再多就该改走「文件」通道。
 */
export const TEXT_INPUT_LIMIT = 80_000

/**
 * 导入文本文件的体积上限（拖入与「导入文本」按钮共用）。
 *
 * 320 KB 足够装下 8 万字符的任何常见编码（UTF-8 中文 240 KB、UTF-8 emoji 320 KB、UTF-16 160 KB），
 * 所以超限的文件必定会被截断；在读盘前就拒绕，避免把几十 MB 读进内存再丢掉。
 */
export const TEXT_IMPORT_MAX_BYTES = 320 * 1024

/**
 * 导入文本时优先展示的扩展名（不含点）。
 *
 * 覆盖常见纯文本与源码/配置/字幕格式：这些都是"键盘打得出来"的内容，直接用文本模式最省事；
 * 二进制与富文本格式不在此列（请走「文件」模式）。
 */
export const TEXT_IMPORT_EXTENSIONS: readonly string[] = [
  'txt',
  'text',
  'md',
  'markdown',
  'rst',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonc',
  'json5',
  'xml',
  'yaml',
  'yml',
  'ini',
  'conf',
  'cfg',
  'properties',
  'env',
  'toml',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'vue',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'bash',
  'bat',
  'cmd',
  'ps1',
  'sql',
  'srt',
  'vtt',
  'lrc',
  'ass',
  'ssa',
  'tex',
  'diff',
  'patch'
]
