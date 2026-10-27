# 产品配图更新 TODO

本清单记录基础能力与高级能力调整涉及的图像。以 [PRODUCT_NAMING.md](PRODUCT_NAMING.md) 为准。SVG 已更新并完成 Personal / Shared 与 Read / All Read 标签复核；README PNG 已随本轮子图重新生成，没有 SVG 源的独立截图仍需重截。

## 待更新：独立截图

| 状态 | 文件 | 旧内容／问题 | 目标及范围 |
|---|---|---|---|
| TODO | `docs/public/screenshots/cli-qr.png` | CLI 输出仍有 Search、Viewed tracking、Edit、Live、Chat、Shared notes 六个开关 | 重新截取当前 CLI：四高级开关 Edit、Chat、Live、Share；Search ready 独立显示，Progress 不出现复选开关 |
| TODO | `docs/public/og.jpg` | 独立 Markdiff 旧截图：文件控件 Viewed、左栏 `0 / 27 viewed` | 独立重截：状态 Read、计数 `n / total read`、筛选 Hide Read Files；不是 readme-hero 的派生文件 |
| TODO | `banner.png` | 根目录旧截图含 Section Viewed System、Viewed、Annotation System、Shared annotations；错误声称非共享批注存 localStorage | 若继续使用须重截：Progress、Annotate、Share；批注与章节进度始终存 SQLite。目前文档未检出引用，后续复用前必须更新 |

## 已完成：SVG 与派生 PNG

| 状态 | 文件 | 更新结果 |
|---|---|---|
| DONE | `docs/public/illustrations/13-workspace.svg` | Advanced 仅保留 Edit、Chat、Live、Share，顺序统一；Search Ready 独立显示索引状态 |
| DONE | `docs/public/illustrations/14-git-diff.svg` | 文件复选框状态为 Read；计数按五文件示例显示 `2 / 5 read`；筛选为 Hide Read Files，标明 File Progress 存在当前浏览器 |
| DONE | `docs/public/illustrations/19-viewed-complete.svg` | 文件状态为 Read，总计 `9 / 9 read`；Hide Read Files 未勾选，已读文件仍可见；标明本地保存范围 |
| DONE | `docs/public/illustrations/03-viewed.svg` | 使用 Progress；Personal 场景提供 All Read 复选框及 Print、Export Notes (0)、Fold All、Unfold All，零计数导出灰显；修正圆环为 3/7 |
| DONE | `docs/public/illustrations/18-section-reading.svg` | H1 与聚焦章节按 Progress、Print、Export Notes (n)、Fold 同序展示，H1 进度复选框为 All Read、章节为 Read，折叠仍为 Fold All / Unfold All；整页与章节文字批注计数分别为 3 / 2，当前为 Personal；说明相同基础操作适用于 Shared，不依赖 Admin 或 Share |
| DONE | `docs/public/illustrations/06-live.svg` | 使用 Live、Present、Follow、Off；两端分别标示 Present / Follow，Off 独立阅读，不暗示源码写入权限 |
| DONE | `docs/public/illustrations/05-annotate.svg` | 补 Annotate、Personal、Highlight / Strike / Note；说明基础个人批注不依赖 Admin 或 Share，Personal 与 Shared 均持久化到 SQLite |
| DONE | `docs/public/illustrations/07-sync.svg` | Share 范围明确为 Annotate + Section Progress；两设备同步章节标记，Fold、Resume、File Progress 继续本地保存；明确 Shared 共同作用域，不自动发布／合并浏览器私有 Personal，Share 关闭仍可个人审阅 |
| DONE | `docs/public/illustrations/17-export-notes.svg` | 标明 Output，保留 Export Notes，补齐 Download；说明只计文字 Note、零计数禁用、临时编辑无需 Edit 且不覆盖源文件；明确 Personal / Shared，个人导出无需 Admin 或 Share |
| DONE | `docs/public/illustrations/21-shortcuts.svg` | Actions & Shortcuts 按 Global、Workspace、Reading、Review、Output、Edit、Workspace AI、Live 分组；示例仅包含实际注册的快捷操作；标明 Personal，Review / Output 基础操作也适用于 Shared，无需 Admin 或 Share |
| DONE | `example/assets/sample-architecture.svg` | 示例能力统一为 Search、Annotate（含 Highlight / Strike / Note）、Edit、Git、Markdiff；不画成工作区开关 |
| DONE | `docs/public/readme-hero.svg`、`docs/public/readme-hero.png` | 组合描述同步 Read / All Read；按最新 `18-section-reading.svg`、`14-git-diff.svg` 重导出 1600 × 760 PNG，保留四图布局与图片地址 |

## 已核查，可保留

- `20-open-entrypoints.svg` 和 `16-open-folder-macos.svg` 的 Shared 是 macOS Finder 原生侧栏名称，与 Share 能力无关。
- `docs/public/screenshots/gui-cli-builder.png` 不含旧功能开关，只展示路径、监听地址、对外 URL、访问码与命令生成。
- `01-rendering.svg`、`02-search.svg`、`04-edit.svg`、`05-annotate.svg`、`08-print.svg`、`09-desktop.svg`、`10-mobile.svg`、`11-platforms.svg`、`12-chat.svg` 不含旧能力开关清单；设备示意中的进度勾选不代表可关闭 Progress。
- 品牌 logo、wordmark、favicon 不含能力标签；没有修改的 SVG 不重导出其图标资源。
- `docs/public/screenshots/macos-gatekeeper*.png`、`windows-smartscreen.png` 为系统安装警告，不涉及产品能力划分。
- 图片文件名 `03-viewed.svg`、`19-viewed-complete.svg`、示例文件名 `viewed.md` 与既有文档 URL 均保留。

## SVG 与派生 PNG 验收

- [x] 四高级开关名称与顺序一致，Search / Progress 不再画成功能开关。
- [x] Annotate 为批注总能力，Note 仅为文字子功能，Annotation 仅用于技术说明。
- [x] 能力名为 Share；Shared 可用于共同审阅作用域、系统原生名称或正常英文描述。
- [x] Section Progress 与 File Progress 的存储和共享边界准确。
- [x] H1 与章节工具栏操作分类、顺序与权限上下文一致。
- [x] 全部相关 SVG 的 XML 有效；前轮完成 22 张插画、示例与组合图渲染，本轮再复核 6 张作用域配图、79 处文字，无画布溢出。
- [x] 按本轮 Read / All Read 更新后的章节与 Markdiff 子图重新生成 README PNG，尺寸保持 1600 × 760；原有图片地址保留。
- [ ] 三张独立旧截图完成重截后，再验收全部视觉素材。

### README PNG 再生成

源文件为 `docs/public/readme-hero.svg`，依赖 `13-workspace.svg`、`12-chat.svg`、`18-section-reading.svg` 和 `14-git-diff.svg`。先完成子图修改，再从仓库根目录用 Chromium 导出。`MARKON_CHROME_BIN` 指向本机 Chromium 或 Chrome headless 可执行文件：

```bash
"$MARKON_CHROME_BIN" --headless --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1600,760 \
  --virtual-time-budget=1000 \
  --screenshot="$PWD/docs/public/readme-hero.png" \
  "file://$PWD/docs/public/readme-hero.svg"
```

导出后查看 PNG，确认四张子图均已加载，并运行文档链接检查与构建。

## 已完成：Personal / Shared 权限边界复核

- [x] 按最新作用域界面复核 `03-viewed.svg`、`05-annotate.svg`、`07-sync.svg`、`17-export-notes.svg`、`18-section-reading.svg`、`21-shortcuts.svg`：个人 Annotate、Progress、Export Notes 不得显示为需要 Admin 或开启 Share；标明 Personal / Shared 当前作用域。
- [x] Share 配图表达「切换到共同数据」，不能画成自动发布／合并浏览器私有 Personal 数据；Share 关闭后仍可个人审阅。
- [x] 与个人身份相关的说明采用浏览器私有 Cookie + SQLite，不暗示账号恢复、跨设备个人同步或 LocalStorage 批注副本。

本轮六张 SVG 已全部直接修改、通过 XML 解析与浏览器预览。`03-viewed.svg`、`18-section-reading.svg` 已将 Admin 角色标签替换为 Personal 作用域；所有相关基础操作均不以管理员身份为前提。README 派生 PNG 已按更新后的 `18-section-reading.svg` 重导出并查看，尺寸保持 1600 × 760；SVG 与派生 PNG 均无待办项。


## 已完成：Read / All Read 进度状态标签

- [x] 能力名仍为 Progress；进度复选框采用 Read／All Read，表示已读状态。正文和 diff 文件计数统一为 `n / total read`，筛选为 Hide Read Files。
- [x] 全面检索 `docs/public/illustrations/*.svg` 与组合 SVG；更新 03、14、18、19 中的旧进度标签、描述和状态注释。普通英语动词、Markon 品牌、文件名和历史截图问题记录不做机械替换。
- [x] 保留 Personal / Shared 与本地 File Progress 边界、导出零计数禁用、工具栏顺序和四高级开关。
- [x] 本轮 21 张插画与组合 SVG 通过 XML 解析和浏览器几何检查（234 处文字，无画布溢出），已查看修改后插画与 README PNG。
- [ ] 无 SVG 源的 cli-qr.png、og.jpg、banner.png 继续按上表记录重截，不对历史截图做文字覆盖。
