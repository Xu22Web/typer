# Typer

把文本**逐字符"打"进任意窗口**的 Windows 桌面工具：粘贴内容 → 点击开始 → 倒计时结束后自动模拟键盘输入。
支持中文、emoji，以及需要 `Shift` / `AltGr` 组合键的特殊符号。

![Typer 输入页](docs/screenshot.png)

[![CI](https://github.com/Xu22Web/typer/actions/workflows/ci.yml/badge.svg)](https://github.com/Xu22Web/typer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4.svg)

基于 [electron-vite](https://electron-vite.org/) + Vue 3（Vapor Mode）+ Element Plus + Pinia + UnoCSS。
界面按 Windows 11 (Fluent 2) 的设计语言组织：无边框窗口 + 自绘标题栏 + 左侧导航 + 卡片刻度。

> **平台：仅 Windows 10/11。** 注入依赖 Win32 `SendInput`；打包配置、CI 与更新流程都只针对 Windows。

---

## 功能

- **内容区粘贴 + 一键开始**：倒计时（可配置 0–60s）结束后开始输入，倒计时期间随时可取消
- **逐字符真实输入**：可打印 ASCII 与特殊符号走真实虚拟键事件，`Shift` 等修饰键与主键在**同一批事件**里原子下发
- **中文 / emoji 支持**：没有物理键位的字符走 `KEYEVENTF_UNICODE` 报文（绕过布局与输入法，BMP 外字符按代理对拆分）
- **节奏可控**：字符/秒、词/分钟或固定间隔；抖动幅度与分布（均匀/正态）；标点、空格、换行、空行、周期性停顿
- **拟人随机性**：可配置错字概率与方式（相邻键位/形近字/相邻字符颠倒），支持自动退格纠正
- **目标窗口与焦点保护**：开始前记录前台窗口，输入中检测窗口变化（提示或直接中止）
- **全局热键**：焦点在别的窗口也能紧急停止 / 暂停（默认 `Ctrl+Alt+X`、`Ctrl+Alt+P`）
- **剪贴板回退**：长文本或目标程序不认 Unicode 报文时，改用"写入剪贴板 + `Ctrl+V`"，结束后自动还原
- **多种键盘布局**：US / UK / DE / FR / ES，另有"全部用 Unicode 注入"的布局无关模式
- **文本导入**：UTF-8 / UTF-16 / GBK 自动识别（中文 Windows 常见编码）
- **内置更新**：检查 GitHub Release → 下载 → SHA-256 校验 → 交给安装程序（详见下文）
- **隐私默认安全**：输入内容不落盘，日志只记录长度、种子等元信息

## 界面与交互

| 页面     | 职责                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| **输入** | 主任务：内容区（实时统计字符/中文/动作/预计耗时）、目标窗口、运行状态、主操作条 |
| **日志** | 运行记录，按级别筛选、复制、清空；新条目自动滚动                                |
| **设置** | 八组设置整页编辑，粘底保存条显示"有未保存改动 / 已保存"                         |
| **关于** | 版本与更新中心、外部链接、实现要点与已知限制                                    |

设计取向：

- **主次分明**：开始输入是唯一主按钮（强调色实底），暂停/停止为次要（浅填充）与危险样式，
  "调整设置 / 查看运行日志"降级为文字入口；日志与设置不再挤在输入页
- **自绘标题栏**：品牌 + 当前页面名 + 主题切换 + 最小化/最大化/还原/关闭。
  窗口是无边框的（`frame: false`），空白处拖拽移动、双击最大化，最大化状态由主进程推送保持同步
- **左侧导航**：选中态为"左侧 3px 强调条 + 轻微填充"（Win11 NavigationView 的指示方式）；
  检测到新版本时「关于」右侧出现提示点
- **常驻状态栏**：引擎状态与进度始终可见，切到任何页面都不会丢失对输入任务的感知
- **全局倒计时遮罩**：跨页面可见，大号数字 + 进度环 + 直接取消
- **快捷键**：内容区 `Ctrl+Enter` 开始输入；全局 `Ctrl+Alt+X` 紧急停止

## 快速开始

```bash
pnpm install     # 需要 Node >= 20.19，pnpm 由 corepack 提供
pnpm dev         # 开发模式（HMR）
pnpm build       # 类型检查 + 构建产物到 out/
pnpm start       # 运行已构建产物
pnpm build:win   # 生成 Windows 安装包（NSIS）→ dist/Typer-<version>-setup.exe
pnpm icons       # 由 resources/icon.svg 重新生成 PNG/ICO/预览图
```

使用步骤：

1. 把要输入的内容粘贴到内容区（或点"导入文本"）
2. 点"开始输入"，在倒计时内切换到目标窗口（例如记事本），先点一下输入位置
3. 需要中断时按全局热键，或切回本窗口点"停止"

## 自动更新

更新由主进程的 [`src/main/update`](src/main/update) 自行实现（不依赖 electron-updater）：

```
检查：GET https://api.github.com/repos/Xu22Web/typer/releases/latest
下载：流式写入 %TEMP%\Typer-update\<asset>.exe（边下边报进度，可随时取消）
校验：计算 SHA-256 → 与发布校验和比对
安装：以 detached 方式启动安装程序，随后退出本程序，由安装向导完成文件替换
```

- **校验和有两个来源**，按优先级取用：
  1. 发布附带的 `SHA256SUMS.txt`（由发布工作流生成）
  2. GitHub 接口给出的 `asset.digest`（`sha256:…`）
- **校验不通过会删除文件并拒绝安装**；两个来源都拿不到时状态为"未校验"，
  界面只提供"手动前往发布页"，不会把来源不明的可执行文件推给用户。
- 下载放在系统临时目录而非 `%APPDATA%\Typer`：卸载/升级流程会清理后者，
  而安装包在启动安装程序之后、安装完成之前必须一直存在。
- 「设置 → 更新」可关闭启动时自动检查；检查失败（离线、限流）只记录日志，不打扰用户；
  检查带 30 秒节流，避免连点按钮打满 GitHub 匿名接口额度。

### 发布新版本

```bash
# 1) 更新 package.json 里的 version 并提交
# 2) 打标签推送：release.yml 会在 windows-latest 上构建并创建 Release
git tag v0.2.0
git push origin v0.2.0
```

工作流产出 `Typer-<version>-setup.exe` 与 `SHA256SUMS.txt` 并一起上传到 Release，
后者就是应用内更新所用的校验和清单（缺少它时应用会拒绝自动安装）。

## 实现要点

| 关注点                       | 做法                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 为什么不用 Electron 自带输入 | `webContents.sendInputEvent` 只能发给自己窗口，无法向其它程序打字，必须走 OS 级注入                        |
| 注入后端                     | 独立 PowerShell 进程 + 内联 C# `SendInput`（免 node-gyp / MSVC 工具链；Windows 全版本自带 PowerShell 5.1） |
| 通信协议                     | stdin/stdout 上的 JSON Lines，**发送前把非 ASCII 转义成 `\uXXXX`**，彻底规避控制台代码页问题               |
| 时序精度                     | 宿主内部用 `Stopwatch` + `SpinWait` 等待（Windows 定时器粒度约 15.6ms，`Start-Sleep` 做不到 50ms 级精度）  |
| 中止响应                     | 按 chunk（默认 8 个动作）下发，chunk 之间检查暂停/中止，紧急停止延迟 ≤ 一个 chunk                          |
| 防粘键                       | 任何结束路径（完成/中止/异常/进程崩溃）都调用 `releaseAll`，并用 `GetAsyncKeyState` 自检                   |
| 可复现                       | 所有随机性来自可播种的 mulberry32 PRNG；"动作计数"与"动作产出"两次遍历使用同种子的独立随机源               |
| 无边框窗口                   | 窗口按钮自绘：主进程暴露 `window:minimize/toggle-maximize/close`，最大化变化再反向推送给界面               |
| 更新                         | GitHub Releases API + 流式下载 + SHA-256 校验 + detached 启动安装程序                                      |
| 免编译风险                   | 不依赖 nut.js / robotjs 之类原生模块（需要 electron-rebuild，安装脆弱）                                    |

### 目录结构

```
src/main/
├─ index.ts                    # 组装：窗口、设置、驱动、引擎、IPC、热键、更新、宿主预热
├─ ipc/                        # 频道常量、入参校验、处理器注册、事件桥、载荷净化
├─ settings/                   # 纯类型、归一化/夹取、原子写持久化
├─ update/                     # 版本比较、校验和、GitHub 客户端、流式下载、更新服务
├─ typing/
│  ├─ planner/                 # 文本归一化 → 键位映射（5 种布局）→ 动作流（纯函数）
│  ├─ scheduling/              # 可播种 PRNG、节奏模型、错字模型、预设
│  ├─ engine/                  # 状态机（倒计时/运行/暂停/中止）、进度与 ETA
│  ├─ drivers/                 # 驱动接口、协议编解码、Windows 实现、Mock、剪贴板回退
│  └─ focus/                   # 焦点守护（off / warn / strict）
└─ util/                       # 日志、时钟、文本文件解码（UTF-8/UTF-16/GBK）

src/preload/                   # 受控 API（统一净化 IPC 载荷、清理错误包装）；契约在 api.d.ts
src/renderer/src/
├─ App.vue                     # 外壳：标题栏 + 左侧导航 + 内容区 + 状态栏 + 倒计时遮罩
├─ components/                 # TitleBar / SideNav / StatusBar / CountdownOverlay /
│                              # RunStatusPanel / UpdateCenter / ThemeToggle / Versions
├─ composables/                # useTyping / useSettings / useTheme / useWindowState / useUpdate
├─ views/                      # TyperView（输入）/ LogsView / SettingsView / AboutView
└─ assets/                     # base.css（设计 token）/ main.css（组件样式）/ logo.svg

resources/icon.svg             # 图标源文件（无底色键盘）
scripts/generate-icons.mjs     # SVG → 多尺寸 PNG / ICO / 预览图
scripts/typing-host.ps1        # 输入宿主（打包时通过 extraResources 分发）
build/installer.nsh            # NSIS 自定义卸载脚本（清掉卸载残留）
tests/unit/                    # 单元测试（假时钟 + Mock 驱动，无需真实键鼠）
tests/system/                  # 系统测试（真实宿主；真实注入部分为 opt-in）
```

### 开发约定

- **自动导入**：Vue / Pinia / Vue Router 的 API、`src/renderer/src/composables` 下的组合式函数，
  以及 `src/renderer/src/components` 下的组件都由 `unplugin-auto-import` /
  `unplugin-vue-components` 自动注册，**不需要手写 import**。类型与 ESLint 全局声明由
  `pnpm dev` / `pnpm build` 自动生成（`auto-imports.d.ts`、`.eslintrc-auto-import.json`）。
- **路径别名**：跨目录引用一律走别名，不用 `../../..` 相对路径。
  `@renderer/*` → `src/renderer/src/*`，`@main/*` → `src/main/*`
  （main / preload / renderer / 测试四套配置保持一致）。
- **样式**：`assets/base.css` 放设计 token 与基础重置（含 `ul`/`ol` 重置，避免浏览器默认
  `padding-inline-start` 干扰布局），`assets/main.css` 放组件与 Element Plus 覆盖样式。
- **文案**：产品名统一写作 **Typer**（界面、标题栏、README、安装包名一致），
  只有 npm 包名、仓库名与 appId 保留小写 `typer`。

## 测试

```bash
pnpm test          # 单元测试（默认）：纯逻辑 + 假时钟 + Mock 驱动，不产生任何真实按键
pnpm test:watch    # 监听模式
pnpm test:cov      # 覆盖率
pnpm test:system   # 系统测试：默认层校验宿主脚本；TYPIST_E2E=1 时追加真实注入
```

- **单元测试**覆盖：文本归一化（CRLF/Tab/控制字符/代理对）、95 个可打印 ASCII 的键位完整性、
  中文与 emoji 的注入方式选择、随机性与节奏边界、错字纠正净效果、引擎状态机（倒计时取消/中止/暂停/异常/分块/幂等）、
  协议编解码（分片与粘包、纯 ASCII 传输、注入不足的报错）、驱动生命周期、剪贴板恢复、焦点守护、
  设置夹取与损坏回退、IPC 校验（含窗口控制与更新频道）、更新流程（版本比较、校验和解析、
  下载成功/摘要不符/无校验和/被截断/取消/安装包被清理）、渲染侧 composable（窗口状态、更新中心）
- **系统测试**分两层：
  - 默认层：用 Windows PowerShell 5.1 解析脚本语法、校验 UTF-8 BOM 与关键实现细节，并以 `-DryRun`
    真实启动宿主，验证"Add-Type 编译 → 协议 → 事件计数"（不产生真实按键）
  - opt-in 层（`TYPIST_E2E=1`）：启动自建的 WinForms 目标窗口，真实注入"中英混排 + `Shift` 符号 + emoji"，
    在**消息循环层**（`IMessageFilter`）捕获原始 `WM_CHAR` 码元并与期望文本逐字比对，最后校验无粘键

> opt-in 层要求测试窗口能取得前台焦点：若抢不到焦点，用例会自动跳过并在输出中提示，
> **绝不会把按键打到用户其它窗口上**。

## 设置项

| 分组         | 说明                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| 启动与模式   | 倒计时、输入方式（逐字/粘贴/自动）、自动粘贴阈值、每批动作数、随机种子       |
| 速度与随机性 | 速度模式与数值、抖动幅度、抖动分布                                           |
| 停顿节奏     | 标点后、空格后、换行后、空行后、每 N 个字符后的停顿                          |
| 错字与纠正   | 错字概率、错字方式、是否自动纠正                                             |
| 键盘布局     | 目标窗口布局、是否全部用 Unicode 注入                                        |
| 焦点与热键   | 焦点守护模式、紧急停止/暂停热键、完成后粘键自检                              |
| 隐私与剪贴板 | 是否保存输入内容（默认否）、是否保存设置、粘贴后是否恢复剪贴板、导入文件编码 |
| 更新         | 是否在启动时检查更新                                                         |

设置保存在 `%APPDATA%\Typer\settings.json`（原子写；损坏时自动备份为 `.corrupt` 并回退默认值）。
保存失败（磁盘满、无权限、路径被占用）会**明确报错并保留编辑内容**，
不会出现"提示已保存、磁盘其实没变"。

## 打包与卸载

```bash
pnpm build:win    # → dist/Typer-<version>-setup.exe（中文界面 NSIS 安装向导）
```

- **图标**：`resources/icon.svg` 是唯一源文件（无底色键盘：白色键盘体 + 青绿→蓝键位 + 一颗按下的键）；
  `pnpm icons` 生成 `build/icon.png`(1024)、`build/icon.ico`(16/24/32/48/64/128/256)、
  `resources/icon.png`(512) 与 `build/preview/*` 预览图。改图标只需改这个 SVG 后重新生成。
- **安装向导**：非一键安装、可选安装目录、可选"仅当前用户 / 所有用户"；
  许可协议取自 `build/license_zh_CN.txt` / `build/license_en.txt`。
- **卸载清理**：`deleteAppDataOnUninstall: true` 删除 `%APPDATA%\Typer`（设置与缓存），
  安装目录、快捷方式与注册表项由 NSIS 常规流程清理。另外安装程序会把自身副本（约 88MB）留在
  `%LOCALAPPDATA%\Typer-updater`，**官方卸载模板不会删除它**，所以 `build/installer.nsh`
  里补了一段 `customUnInstall` 一并清理（实测连续多轮安装/卸载均无残留）。
  升级流程（`--updated`）会跳过用户数据删除，避免升级丢配置。
- **不使用 electron-builder 的发布器**：配置里显式 `publish: null`，否则 electron-builder 会因为
  `package.json` 中的 `repository` 自动推导出 GitHub 发布器，生成用不到的 `app-update.yml`。
- **只针对 Windows**：打包配置只有 `win` / `nsis` 段；没有 mac/linux 目标，
  也没有 `electron-updater` 依赖与 `build:mac` / `build:linux` 脚本。

## 已知限制与注意事项

1. **权限（UIPI）**：无法向"以管理员身份运行"的窗口注入按键。目标程序需与本程序权限一致，
   否则会返回可读错误而不是静默失败。
2. **安全桌面**：锁屏界面、UAC 弹窗、`Ctrl+Alt+Del` 界面无法注入。
3. **安全软件**：部分杀毒/EDR 会拦截合成输入；此时 `SendInput` 的成功事件数会少于请求数，本程序会明确报错。
4. **游戏与自绘界面**：少数程序只认扫描码或忽略 `WM_CHAR`，请改用"剪贴板粘贴"模式。
5. **键盘布局**：真实按键由**目标窗口的布局**解释。非 US 布局下不确定时请开启"全部用 Unicode 注入"；
   本程序的非 US 布局只收录了确定无误的键位，其余字符自动回退到 Unicode（结果同样正确）。
6. **输入法**：中文等字符走 Unicode 注入，不经过输入法；但**真实按键**输入字母时，
   目标窗口若开着中文输入法可能被其截获，建议输入前切到英文输入法。
7. **代理对与组合字符**：emoji 会按代理对拆成两个报文，ZWJ 组合（如 👨‍👩‍👧）在部分程序里会显示为多个字形。
8. **焦点**：开始后不要移动鼠标或切换窗口；`strict` 模式下窗口变化会直接中止输入。

## 免责声明

本工具用于自动化填表、演示、批处理与测试等**合法用途**。请勿用于绕过安全控制、
未获授权的自动化操作或任何违反目标程序服务条款的场景；使用前请自行确认合规性。

## 许可

[MIT](LICENSE)
