# Typer 文件传输脚本

把**任意文件**从一台机器"打"到另一台机器（终端、串口、KVM、远程桌面里运行的接收端），
逐片校验、断点续传、合并后校验整文件完整性。

脚本是**零依赖**的纯 Node ESM：只用 `node:` 内置模块，**不需要 `npm install`**，Node ≥ 18 即可运行。

```bash
node tools/typer-recv.mjs --help      # 接收端（在目标机运行）
node tools/typer-chunk.mjs --help     # 分片端（离线生成帧文本）
```

---

## 1. 为什么不是"直接输入二进制"

| 问题     | 说明                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| 控制字符 | `\0` 无法输入；`\n` 是"回车提交"；`\t` 是 Tab 键；`\x1a`(Ctrl+Z) 在 Windows 控制台是 EOF |
| 终端行为 | 行缓冲有行宽上限、可能回显、启用 bracketed paste 会插入 `ESC[200~`                       |
| 链路质量 | 串口/远控会丢字符或重复字符，且没有重传机制                                              |

所以数据先编码成**纯 ASCII 的安全字符集**，切成**每片一行**的帧；每片自带 CRC32 + SHA-256 前缀，
接收端逐片校验、失败只重传该片，最后合并并校验整文件哈希。

## 2. 编码怎么选

| 编码          | 体积    | 适用                                                                               |
| ------------- | ------- | ---------------------------------------------------------------------------------- |
| `hex`（默认） | 2×      | **任何文件**（二进制、GBK、EXE…）。只有 `0-9A-F`，最抗终端与输入法干扰             |
| `b64`         | 1.34×   | 目标端可靠时的紧凑选择（含大小写与 `+ / =`）                                       |
| `txt`         | 近似 1× | 纯 UTF-8 文本，可读性最好（`空格`/`CR`/`LF`/`TAB` 会转义成 `\x20`/`\r`/`\n`/`\t`） |

需要**逐字节还原**（例如 GBK 文件）时用 `hex` 或 `b64`：它们传的就是文件原始字节，
与编码、locale、终端代码页都无关。`txt` 仅接受合法 UTF-8（带 BOM 会被拒绝），
因为只有"文件字节 == 该文本的 UTF-8 编码"时，两端的整文件哈希才一致。

## 3. 线格式 v1（收发双方唯一契约）

每帧**一行、纯 ASCII、无空白**：

```
开始帧  @TYPER1/B <job> <total> <size> <enc> <chunk> <nameB64> <sha256>
数据帧  @TYPER1/D <job> <seq> <total> <bytes> <crc32> <sha16> <enc> <payload>
结束帧  @TYPER1/E <job> <total> <size> <sha256>
续传令  @TYPER1/R <job> <total> <missing>
```

| 字段            | 含义                                                                             |
| --------------- | -------------------------------------------------------------------------------- |
| `job`           | 任务标识（8 位小写 hex）。接收端用它隔离工作目录，避免两次任务互相污染           |
| `seq` / `total` | 0 基片号 / 总片数                                                                |
| `size`          | 原始文件字节数                                                                   |
| `bytes`         | 本片原始字节数（`hex`/`b64` 为定长切片，末片可小；`txt` 为按字符切分后的字节数） |
| `crc32`         | 本片原始字节的 CRC32（8 位小写 hex）                                             |
| `sha16`         | `SHA-256(本片原始字节)` 的前 8 字节（16 位小写 hex）                             |
| `enc`           | `hex` / `b64` / `txt`                                                            |
| `payload`       | 编码后的数据（不含任何空白字符）                                                 |
| `nameB64`       | 文件名的 UTF-8 base64url（`-` 表示不指定）                                       |
| `sha256`        | 整文件 SHA-256（64 位小写 hex）                                                  |
| `missing`       | 缺失片号，逗号分隔，支持 `a-b` 区间（`-` 表示无缺失）                            |

**回执**（接收端输出，`#` 前缀）：`#BEGIN` / `#RESUME` / `#OK` / `#SKIP` / `#FAIL` / `#MISS` / `#DONE` / `#BAD`。

**退出码**：`0` 成功且校验通过；`2` 数据不全；`3` 完整性校验失败；`4` 参数或 IO 错误。

## 4. 接收端 `typer-recv.mjs`

```
node typer-recv.mjs [选项]
  -o, --out <path>        输出文件（默认用开始帧里的文件名，否则 job-<id>.bin）
  -d, --dir <path>        分片工作目录（默认 ./.typer-<job>）
      --in <file>         从文件读取帧（默认读标准输入）
      --cooked            强制行缓冲读入（TTY 下默认 raw：不回显、无行宽限制）
      --no-resume         忽略已有分片全部重收（默认：校验通过即跳过）
      --force             允许覆盖已存在的输出文件
      --report <path>     续传报告 JSON（默认 <dir>/resume.json；`-` 表示关闭）
      --token             数据不全时额外打印可回填 Typer 的续传令牌
      --ack <target>      回执输出到 stdout | stderr | none（默认 stdout）
      --progress-every <n> 每 n 片打印一次 #OK（0 = 只打印失败）
      --keep-parts        合并成功后保留分片目录
      --charset <cs>      txt 编码的写盘编码（默认 utf-8）
  -q, --quiet             只在失败 / 摘要 / 结果时输出
  -v, --verbose           额外诊断信息
      --selftest          环境自检后退出
```

### 典型流程

```bash
# ① 目标机：启动接收端，等待输入（raw 模式，粘贴/注入的内容不会回显）
node typer-recv.mjs -o received.bin --token

# ② 发送端：Typer 的「文件」页选择文件 → 开始输入（或把 typer-chunk 生成的 frames.txt 粘到文本页）

# ③ 中途失败 / 被打断：目标机会打印
#    #MISS 12-20
#    @TYPER1/R a1b2c3d4 69 12-20
#    把片号或续传令牌填回 Typer 的「只发指定片」/「续传状态」，只补这几片

# ④ 全部通过时：#DONE <路径> <字节数> <sha256>，退出码 0
```

### 场景要点

- **终端（Windows Terminal / conhost / bash）**：直接运行即可，TTY 下自动进 raw 模式（无回显、无行宽限制）。
- **串口 / 环回链路**：回执会顺着链路回到发送端，可能被对端当成键盘输入 →
  用 `--ack none`（或 `stderr`）关闭回执，靠退出码与 `--report` 判断结果；同时建议减小片、放慢节奏。
- **目标端没有 Node**：改用 `--in frames.txt` 在别处接收，或把 `tools/` 整个目录拷过去（只依赖 Node）。
- **只想离线验证**：`typer-chunk.mjs --verify` 会按接收端规则重新解析、逐片校验并合并比对，不发一个字节。

## 5. 分片端 `typer-chunk.mjs`

```
node typer-chunk.mjs <文件> [选项]
  -o, --out <dir>        输出目录（默认 ./.typer-chunks-<job>）
      --chunk <bytes>    每片原始字节数（默认 1024）
      --enc <enc>        hex | b64 | txt（默认 hex）
      --name <name>      接收端使用的文件名（默认源文件名）
      --job <id>         任务 id（默认随机）
      --single <path>    额外输出合并后的帧文本（可直接粘到 Typer 文本页）
      --no-frames        只输出 manifest.json
      --no-frame-list    manifest 里不记录每片校验和
      --max-frame-chars  帧长上限校验（默认 4096）
      --verify           生成后按接收端规则自检
  -q, --quiet  -h, --help
```

产物：`begin.txt`、`<seq>.txt`、`end.txt`、`manifest.json`、可选的 `frames.txt`。

`manifest.json` 记录任务规模、整文件哈希与**每片**的 `crc32`/`sha16`，接收端可以据此在
收到开始帧之前就知道所有期望值（也更便于事后审计）。

## 6. 片大小与帧宽的取舍

帧长 ≈ `45 + 数字位数 + 载荷字符数`。默认 `--chunk 1024` 时，`hex` 帧约 2.1 K 字符。

| 预设   | `--chunk` | `hex` 帧长 | 适用                                                        |
| ------ | --------- | ---------- | ----------------------------------------------------------- |
| 窄终端 | 256       | ≈ 560      | 串口、老式控制台、限宽终端                                  |
| 默认   | 1024      | ≈ 2.1 K    | 终端 raw 模式 / 剪贴板粘贴                                  |
| 宽松   | 4096      | ≈ 8.2 K    | Windows Terminal + 可靠剪贴板（需放宽 `--max-frame-chars`） |

超过 `--max-frame-chars` 时脚本会**在生成之前**失败并给出建议片大小，避免打到一半才发现终端吞内容。

## 7. 故障排查

| 现象                                | 原因与处理                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| 大量 `#FAIL <seq> field` / `marker` | 行被截断或混入回显/提示符。减小 `--chunk`、降低输入速率、确认输入流里只有帧     |
| 个别 `#FAIL <seq> crc`              | 链路丢/改字符。直接用 `--MISS`/续传令牌补传该片                                 |
| `#FAIL <seq> enc`                   | 载荷编码不合法，通常是粘贴时被输入法/终端改了字符（含大小写转换）→ 优先用 `hex` |
| `overlong`                          | 该帧超过长度上限（终端/剪贴板截断）→ 用更小的片                                 |
| `#BAD`                              | 合并后哈希不符。加 `--keep-parts` 保留分片后重跑排查（多为磁盘/权限问题）       |

```bash
# 环境自检（CRC / 编码 / 转义 / 片号解析）
node tools/typer-recv.mjs --selftest

# 不起进程、直接验证一批帧文本是否无损
node tools/typer-recv.mjs --in frames.txt -o out.bin -d /tmp/work --quiet
```

## 8. 与应用的关系

- `tools/lib/frame.mjs` 是线格式的**唯一实现**：Typer 主进程直接 import 同一份文件，
  所以"应用发出的帧"与"脚本解析的帧"永远一致（`tests/system/transferTool.spec.ts` 里也有跨进程交叉校验）。
- `tools/lib/frame.d.mts` 是给 TypeScript 用的类型声明；改动 `frame.mjs` 时必须同步更新它。
