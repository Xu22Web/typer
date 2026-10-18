/** 渲染进程与主进程之间的频道名（preload 与主进程共享，避免手写字符串出错）。 */
export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsReset: 'settings:reset',
  typingStart: 'typing:start',
  typingPause: 'typing:pause',
  typingResume: 'typing:resume',
  typingStop: 'typing:stop',
  typingStatus: 'typing:status',
  typingForeground: 'typing:foreground',
  filesImport: 'files:import',
  filesPick: 'files:pick',
  /** 文件传输（把文件逐片"打"到目标窗口） */
  transferPick: 'transfer:pick',
  transferPrepare: 'transfer:prepare',
  transferCancelPrepare: 'transfer:cancel-prepare',
  transferPlan: 'transfer:plan',
  transferResumeState: 'transfer:resume-state',
  transferExportTools: 'transfer:export-tools',
  transferRevealTools: 'transfer:reveal-tools',
  /** 把打包后的接收端脚本全文交给渲染进程（界面里可直接查看 / 复制，不必去安装目录翻文件） */
  transferToolScript: 'transfer:tool-script',
  transferStartFrames: 'transfer:start-frames',
  /** 自绘标题栏的窗口控制（frameless 窗口没有系统按钮，必须自己实现） */
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  /** 把最小化的主窗口召回并聚焦（进度浮窗点击时用） */
  windowFocusMain: 'window:focus-main',
  /** 进度浮窗：拖动 / 落定吸附 / 展开 / 收起 / 收起动画完成回执 / 请求接收鼠标 */
  floatDrag: 'float:drag',
  floatDrop: 'float:drop',
  floatDock: 'float:dock',
  floatExpand: 'float:expand',
  floatCollapse: 'float:collapse',
  floatCollapseDone: 'float:collapse-done',
  floatInteractive: 'float:interactive',
  /** 更新检查与安装 */
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateCancel: 'update:cancel',
  updateInstall: 'update:install',
  updateState: 'update:get-state',
  /** 用默认浏览器打开外部链接（只允许 http/https） */
  shellOpenExternal: 'shell:open-external',
  /** 主进程 → 渲染进程的事件 */
  eventProgress: 'typing:progress',
  eventState: 'typing:state',
  eventLog: 'typing:log',
  eventWindowState: 'window:state',
  eventUpdateState: 'update:state',
  eventUpdateProgress: 'update:progress',
  eventTransferPrepare: 'transfer:prepare-progress',
  /** 浮窗形态（贴边圆球 / 展开卡片）与贴边方向 */
  eventFloatState: 'float:state'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 主进程主动推送的频道。 */
export const EVENT_CHANNELS: readonly string[] = [
  IPC.eventProgress,
  IPC.eventState,
  IPC.eventLog,
  IPC.eventWindowState,
  IPC.eventUpdateState,
  IPC.eventUpdateProgress,
  IPC.eventTransferPrepare,
  IPC.eventFloatState
]
