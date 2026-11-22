# 第三方许可声明

Typer 本体以 MIT 许可证发布（见 [LICENSE](LICENSE)）。下列第三方组件随程序分发，或在构建期嵌入产物，
其版权与许可归各自作者所有。安装目录 `resources\THIRD-PARTY-NOTICES.md` 为同名副本；
`app.asar` 内各组件目录也保留了上游原始的 `LICENSE` 文件。

## 1. 内容区编辑器

| 组件                   | 版本    | 许可 |
| ---------------------- | ------- | ---- |
| `@codemirror/view`     | 6.43.15 | MIT  |
| `@codemirror/state`    | 6.7.6   | MIT  |
| `@codemirror/commands` | 6.11.1  | MIT  |
| `@codemirror/language` | 6.13.1  | MIT  |
| `@lezer/common`        | 1.5.6   | MIT  |
| `@lezer/lr`            | 1.4.12  | MIT  |
| `@lezer/highlight`     | 1.2.5   | MIT  |

MIT © 2018–2021 Marijn Haverbeke 及贡献者。

## 2. 发布说明预览

| 组件          | 版本          | 许可                  | 版权                                |
| ------------- | ------------- | --------------------- | ----------------------------------- |
| `markdown-it` | 15.0.3        | MIT                   | © 2014 Vitaly Puzrin, Alex Kocharin |
| `linkify-it`  | 6.1.0         | MIT                   | © 2015 Vitaly Puzrin                |
| `mdurl`       | 2.1.0         | MIT                   | © 2015 Vitaly Puzrin                |
| `uc.micro`    | 3.0.0         | MIT                   | © 2015 Vitaly Puzrin                |
| `entities`    | 7.0.1 / 8.1.0 | BSD-2-Clause          | © Felix Böhm                        |
| `dompurify`   | 3.4.18        | MPL-2.0 OR Apache-2.0 | © Cure53, Mario Heiderich           |

`dompurify` 为双许可，本项目按 **Apache License 2.0** 使用（其 `LICENSE` 文件即 Apache-2.0 全文，
同目录另有 `LICENSE-MPL`）。

## 3. 界面框架与运行时

| 组件                                                                                                                                  | 许可                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Vue 3 / Vue Router / Pinia                                                                                                            | MIT © Evan You 及贡献者        |
| Element Plus / `@element-plus/icons-vue`                                                                                              | MIT © Element Plus 团队        |
| `pinia-plugin-persistedstate`                                                                                                         | MIT                            |
| `@vueuse/*`、`lodash-es`、`dayjs`、`async-validator`、`normalize-wheel-es`、`memoize-one`、`defu`、`@floating-ui/*`、`@popperjs/core` | MIT                            |
| `iconv-lite`                                                                                                                          | MIT © 2011 Alexander Shtuchkin |

## 4. 图标

Material Design Icons（`@iconify-json/mdi` 1.2.3，经 UnoCSS 在构建期内联为 SVG 数据）

- 许可：Apache License 2.0
- 版权：© Pictogrammers（<https://github.com/Templarian/MaterialDesign>）

## 5. 运行时宿主

| 组件     | 许可                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| Electron | MIT                                                                                    |
| Chromium | BSD-3-Clause 等；完整清单见安装包内 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` |

## 6. 许可全文

### MIT License

适用于上表中标注 MIT 的全部组件。

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0 / BSD-2-Clause / MPL-2.0

全文随安装包分发，位于 `app.asar` 内对应组件目录的 `LICENSE`（或 `LICENSE-MPL`）文件；
亦可参见：

- Apache License 2.0：<https://www.apache.org/licenses/LICENSE-2.0>
- BSD-2-Clause：<https://opensource.org/licenses/BSD-2-Clause>
- Mozilla Public License 2.0：<https://www.mozilla.org/en-US/MPL/2.0/>
