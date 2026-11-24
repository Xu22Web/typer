# 项目约定（Typer）

给 AI 编码代理的项目级约定。只写"不写在代码里就容易被做错"的通用规则；单个功能的具体取舍写在对应代码注释里，不进本文件。

## 1. 命令与门禁

- 单测：`pnpm test`（`vitest --project unit`）；系统测试：`pnpm test:system`；e2e：`pnpm test:e2e`（会拉起 GUI，**不能并发跑**）。
- 类型检查：`pnpm run typecheck`（node / test / web 三段都要过）。
- 接收端脚本：`pnpm build:tools`，改动 `tools/**` 后必须重新构建。
- 提交前至少跑：`pnpm run typecheck` + 受影响目录的单测。

## 2. 设置项改动

新增/修改一个设置字段时，按顺序同步（漏一处就会编译失败或行为漂移）：

1. `src/main/settings/types.ts`：类型与注释。
2. `src/main/settings/schema.ts`：`DEFAULT_SETTINGS`、`NUMERIC_BOUNDS`、枚举白名单、`normalizeSettings`、`mergeSettings` 的分组白名单、`toEngineSettings`。
3. 渲染层：设置页控件 + 使用该设置的面板。
4. 引擎/主进程真正消费它的地方。
5. 测试（默认值、非法值回退、边界夹取）。

**旧配置**：`normalizeSettings` 是唯一入口——未知键丢弃、非法取值回默认，读取时不写回磁盘。

**废弃项**只在"移除/改名"时登记到 `src/main/settings/deprecatedSettings.ts`，每条带 `removeIn`；提示是过渡期的，到版本删规则，不当长期兼容层用。

## 3. 接收端脚本（`tools/typer-recv.mjs`）

- 产物会被**逐字符"打"进目标终端**：必须是**可打印 ASCII（0x20–0x7E）、单行、Node ≥ 14**，`scripts/build-tools.mjs` 的门禁不能绕过。
- 源码可写中文；进度条固定用方块字符（`█`/`░`），不做 ASCII 降级，模式差异靠文字/前缀符号区分。
- 只用 Node 14 可用的 API（`FORBIDDEN_APIS` 兜底）。
- 进度必须原地重绘（TTY）或按行（非 TTY），不在重绘区插入换行日志。
- 阶段、进度、速率、剩余时间要与主程序同口径；新增字段先确认两端含义一致，不要各定义一套。

## 4. 测试

- **只写能失败的测试**：每条断言对应一个真实失败模式（回归过的 bug、边界、协议不变量）。为凑覆盖率写的重复断言不加。
- **一条用例一个结论**：同一行为的不同输入用参数化并列，不复制粘贴多份；一个用例只验证一个因果，多步流程按"操作 → 结果"拆分或串联。
- **按层分工，不重复覆盖**：`unit` 只测纯逻辑与内存夹具（毫秒级、无 I/O）；`system` 测真实子进程 / 文件系统 / 构建产物；`e2e` 只覆盖关键交互链与两端一致性。上层已覆盖的路径不在下层重写。
- **断言行为而非实现**：断言用户可见结果（输出文本、退出码、文件字节、状态序列），不断言私有字段与内部调用次数；需要断言时序时用虚拟时钟。
- **应测尽测，但不越界**：改动涉及的入口、错误分支、配置降级必须覆盖；与本次改动无关的慢测试（尤其 e2e）可以跳过。
- 夹具只定义一次（`tests/helpers` 或文件顶部）；新增字段优先让类型检查兜住漂移，而不是手写完整对象。

## 5. 日志

- 只记录**排障必需且当前缺失**的信息；不为"每一行代码"加日志。
- 用户可见的进度/状态走 UI 或进度块，不用日志刷屏。
- 输入内容一律不进日志（只允许长度、字符数等元信息）。
- 级别语义：`error` 用户可感知的失败；`warn` 自动降级/回退；`info` 正常关键节点；`debug` 细节。

## 6. 文档（README）

- 只写**功能与行为**，用陈述句；不写过程语气（"按用户要求""本次修改"），不写废话。
- 功能变化才改；表述过时就删改，不做叠加式补充。新增依赖、新增设置项、行为变更必须同步。

## 7. 代码风格

- 注释解释"为什么"，不解释"做了什么"；一段复杂逻辑一处注释即可。
- 注释与文案用中文标点；命名用英文且保持通用性（不为单次场景命名）。
- 面向用户的文案客观、简短，不出现内部实现术语。
- 渲染外部内容必须先消毒（不可信输入不进 `v-html`），外链交给系统浏览器。
- 独立 `.ts`（composable / store / util）不依赖自动导入：`ElMessage` / `ElMessageBox` 等命令式 API 与 `Ref` / `ComputedRef` 等类型都显式 import；它们所需的组件样式在 `windows/main/index.ts` 统一引入。
- `src/renderer/src/auto-imports.d.ts` 与 `components.d.ts` 由 unplugin 在 dev / build 时生成：不手工编辑、不靠它判断组件是否还存在；增删组件或 API 后以重新生成的结果为准（生成物可能有短暂的过期条目）。
- 界面强调只有一套：`.em`（重点）与 `.risk`（风险），定义在 `assets/main.css`；不要再引入 `<strong>`、行内 `style` 等第二套机制。
- 内容区是 CodeMirror 6（`components/TextEditor.vue`）：编辑行为通过扩展实现，不退回 Element Plus 的 `textarea`（长文本会整块重排、明显掉帧）。
- 容量类限制（内容区字符数、导入体积、单文件上限）只在 `src/shared` 定义常量，渲染层与主进程引用同一份，不在文案或逻辑里写死数字。

## 8. 代码检索

优先用 Serena 的符号检索（`find_symbol` / `get_symbols_overview` / `find_referencing_symbols`），而不是整文件通读；只在需要上下文时读片段。

## 9. 发布

- 版本只改 `package.json` 的 `version`，关于页与更新检查都读它。
- 发布说明按 `docs/release.md` 的大纲与篇幅写，正文放 `docs/release-notes/v<版本>.md`；发布后用 `gh release edit v<版本> --notes-file` 覆盖工作流自动生成的说明。
