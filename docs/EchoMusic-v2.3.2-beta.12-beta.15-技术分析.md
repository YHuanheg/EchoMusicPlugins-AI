# EchoMusic v2.3.2-beta.12 ~ beta.15 技术分析

> 结论先行：**这四个版本都没有新增插件 API，能力清单仍是 17 项**（工厂实参、IPC 通道均未变）。
> 唯一影响插件的变更是 **beta.15 把原生对话框改成「不挂父窗口」并给标题加上 `EchoMusic · ` 前缀** ——
> 它同时修掉了一个真机可复现的严重 bug（**弹窗弹不出来 + 应用整体卡死**），而受影响的正是
> **文件授权选择器（`ctx.fs.requestDirectory` / `requestFiles`）** 与 **`ctx.process.launch` 的授权确认框**。
> 另外 **beta.14 是个"空档版本"**：只有 1 个提交，Release Notes 与 beta.13 **逐字相同**。

分析时间：2026-10-15　分析对象：`hoowhoami/EchoMusic` @ `v2.3.2-beta.12` / `.13` / `.14` / `.15`
数据来源：本机实装 `2.3.2-beta.15`（`<REDACTED>`，10,038,255 B，mtime 2026-10-15 22:58）+ GitHub compare 与提交级 patch + asar 四步核验
前序：[beta.10/beta.11](EchoMusic-v2.3.2-beta.10-beta.11-技术分析.md) · [beta.8/beta.9](EchoMusic-v2.3.2-beta.8-beta.9-技术分析.md) · [插件系统与加速链路调研](EchoMusic-插件系统与加速链路调研.md)

---

## 一、版本元数据

| 项 | beta.12 | beta.13 | beta.14 | beta.15 |
| --- | --- | --- | --- | --- |
| 发布时间（UTC） | 10-13 16:05 | 10-14 08:45 | 10-14 14:38 | 10-15 15:01 |
| 北京时间 | 10-14 00:05 | 10-14 16:45 | 10-14 22:38 | 10-15 23:01 |
| **提交数** | **19** | **11** | **1** | **8** |
| 变更文件 | 47 | **193** | 13 | 19 |
| 距上一版 | ~28 h | ~8 h | ~6 h | ~24 h |

**四版都是小步快跑**（合计 39 提交）。beta.13 的 193 个文件看着吓人，但其中 **`src` 占 165 个**，
且绝大多数是**对话框组件的统一重构**（一次改 ~20 个 `*Dialog.vue`），不是功能扩张。

本机实装 **beta.15**。

---

## 二、⚠️ Release Notes 累积：第六次验证，且这次出现了「空档版本」

| 条目 | 首次出现 | β.12 | β.13 | β.14 | β.15 |
| --- | --- | --- | --- | --- | --- |
| 插件文件授权 / 流式下载 / 媒体读取 API | beta.10 | 重复 | 重复 | 重复 | 重复 |
| Windows 任务栏歌词 | beta.11 | 重复 | 重复 | 重复 | 重复 |
| **Windows 安装目录沙箱权限致启动即退出**（修复） | **beta.12** | ✅ | 重复 | 重复 | 重复 |
| **MV 音频兜底功能** | **beta.13** | — | ✅ | 重复 | 重复 |
| **原生对话框标题带应用名 / 对话框卡死修复** | **beta.15** | — | — | — | ✅ |

**beta.14 的「新增 / 优化 / 修复」三段与 beta.13 逐字相同** —— 它的 release notes 完全没改。
而 git compare 显示 **beta.14 只有 1 个提交、13 个文件**（`2b64611 fix: UI & style`）。

→ **这是"Notes 不可信"的极端例子：一个几乎没有内容的版本，配了一份和上一版一模一样的发布说明。**
如果只看 Notes 判断版本，会得出"beta.14 内容很多"的错误结论。

**判断增量的唯一可靠路径仍然是**：commit 列表定范围 + 逐文件 patch 定内容（见技能 `11#CAP-12` / `50#TST-18`）。

---

## 三、✅ 四步核验：没有新增插件 API

本机 beta.15 的 asar 逐项核验：

| 核验项 | 结果 |
| --- | --- |
| 能力门禁文案 | **17 条，与 beta.11 逐字相同**（含 `插件未声明所需文件/下载能力`、`插件未声明主题能力（capabilities.theme）`） |
| `plugins:*. *` IPC 通道 | **121 个，无新增类别**（`resources:call/grants/subscribe`、`fs:*`、`process:*`、`dialog:*`、`icons:*` 全在） |
| `createPluginContext` 工厂实参 | **逐字未变**：`fs:C(n.id,y)` / `net:E(n,v,y)` / `ui:pe(n.id,o,v,_,m,capabilities)` / `theme:s(n.id,v,m,capabilities?.theme===!0)` / `sqlite:O(n,v)` / `webServer:w(n,v,_,m)` |
| 插件朝向新文件 | 无（`src/renderer/plugins/` 下本区间只改了 `types.ts`，且是**构建期**改动） |

**→ beta.10 引入的文件授权 / 流式下载 / 媒体读取 API 在这四版里没有任何契约变化。**

beta.12 唯一动到插件目录的那行 patch 是**构建期**的（对运行时零影响）：

```diff
-declare module '@vue/runtime-core' {
+// 扩充 'vue' 而不是 '@vue/runtime-core'：后者不是直接依赖，pnpm 的非提升
+// node_modules 布局下 TS 解析不到它，会报 "Invalid module name in augmentation…"
+declare module 'vue' {
   interface ComponentCustomProperties { $echo: EchoGlobalRuntime; }
```

---

## 四、⭐ beta.15：原生对话框不再挂父窗口（唯一影响插件的变更）

提交 `6cc21cf fix: 原生对话框一律不挂父窗口，避免弹窗不可见并卡死应用` +
`40e4082 feat: 原生对话框标题统一带上应用名` + `d564598 fix: native dialog`。

### 4.1 根因（新增的 `src/main/ipc/dialogHost.ts` 注释里写得很清楚）

> 带父窗口的 `dialog.show*Dialog(win, options)` 会把对话框建到与宿主**不同的线程**上。
> 跨线程的 Win32 模态框会被正常创建、正常布局，却**永远不会显示**，同时把宿主窗口禁用掉 ——
> 表现为「弹窗弹不出来 + 应用整体卡死」，而且往对话框投 `WM_CLOSE` 也无人处理（它的消息循环不在那个线程上跑），只能杀进程。

源码里记录的真机现场（**插件触发的**）：

```
#32770「选择音乐文件夹」   可见=False  可用=True   线程=27216
Chrome_WidgetWin_1 主窗口  可见=True   可用=False  线程=26852
```

> 触发路径是插件「简单本地音乐」添加音乐文件夹 —— 也就是走 **`ctx.fs.requestDirectory`**。
> 所以这个 bug 的受害者**正是用新文件授权 API 的插件**。

### 4.2 修法（asar 逐字核验）

新增 `dialogHost.ts`，三个安全包装 + 一个标题包装：

```js
Lp = 1500                                   // SURFACE_TIMEOUT_MS
Rp = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible())
zp = async () => {                          // surfaceWindow
  const t = Rp(); if (t && !t.isMinimized()) return;
  const { showMainWindow } = await import('../window');   // 动态导入，避免 环依赖
  // race(showMainWindow(), 1500ms) —— 置前只是锦上添花，超时即放行
  if (timedOut) log.warn(`[DialogHost] 置前超过 ${Lp}ms，仍继续显示对话框`)
  if (!Rp()) log.warn('[DialogHost] 没有可见窗口，原生对话框仍会以独立窗口显示')
}
Bp = async show => { await zp(); return show() }            // runDetached
Vp = 'EchoMusic'                                            // APP_LABEL
Hp = o => (typeof o.title !== 'string' || !o.title.trim() || o.title.includes(Vp))
  ? o : { ...o, title: `${Vp} · ${o.title}` }               // withAppLabel
Up = o => Bp(() => dialog.showOpenDialog(Hp(o)))            // showOpenDialogSafely —— 注意没有父窗口
Wp = o => Bp(() => dialog.showSaveDialog(Hp(o)))
Gp = o => Bp(() => dialog.showMessageBox(Hp(o)))
```

两个设计点值得记：

1. **不挂父窗口是有意的**，代价是失去"相对主窗口的模态"，所以用 `surfaceWindow()` 把一个可见窗口带到前台，
   让用户知道是哪个应用在问；并且**加了 1500 ms 超时兜底** ——
   因为 `showMainWindow()` 会 await 渲染进程挂载，渲染进程起不来时会永久挂起，那就把"弹窗卡死"换个形式请回来了。
2. **标题统一加前缀放在 `dialogHost` 而不是逐个调用点**，注释写明是为了"以后新增对话框不会再退回裸标题"。

### 4.3 ⚠️ 标题格式变了（插件文档要更新）

| 选择器 | 旧标题 | **新标题** |
| --- | --- | --- |
| `ctx.fs.requestDirectory`（读写） | `{插件名} · 读写目录 · {用途}` | **`EchoMusic · {插件名} · 读写目录 · {用途}`** |
| `ctx.fs.requestDirectory`（只读） | `{插件名} · 读取目录 · {用途}` | **`EchoMusic · {插件名} · 读取目录 · {用途}`** |
| `ctx.fs.requestFiles` | `{插件名} · 读取文件 · {用途}` | **`EchoMusic · {插件名} · 读取文件 · {用途}`** |

标题里**已经有 `EchoMusic` 就不再重复加**（例如设置备份那几条自带应用名）。

配套的 `properties` 没变：目录是 `['openDirectory','createDirectory']`，文件是 `['openFile', ...(multiple ? ['multiSelections'] : [])] + filters`。

### 4.4 影响面（三个插件 API 都走这条路）

| 插件 API | 走的包装 | 变化 |
| --- | --- | --- |
| `ctx.fs.requestDirectory` / `requestFiles` | `showOpenDialogSafely` | 不挂父窗口 + 标题加前缀 |
| `ctx.dialog.selectDirectory` / `selectFiles` | `showPluginOpenDialog` → `showOpenDialogSafely` | 同上（`registerPluginResourceHandlers()` 也不再收 `context`） |
| `ctx.process.launch` 的**授权确认框** | `showMessageBoxSafely` | 同上（`confirmPluginProcessLaunch` 去掉了 `owner` 参数） |

**插件侧无需改代码** —— 但如果插件在文档/引导里**引用了对话框标题文案**，要同步。

### 4.5 新增：宿主侧的插件文件对话框日志

`pluginResources.ts` 现在会打四条日志（以前没有），**这是插件文件授权问题的新诊断通道**：

```
[PluginResources] 请求选择目录  { pluginId, access, purpose }
[PluginResources] 目录选择结束  { pluginId, canceled }
[PluginResources] 请求选择文件  { pluginId, multiple, purpose }
[PluginResources] 文件选择结束  { pluginId, canceled, count }
```

→ 用户报「点了授权没弹窗 / 选了没反应」时，可以直接看宿主的 `echo-music-*.log`：
**有「请求」没有「结束」= 卡在对话框上**（正是本次修掉的那个场景）。

> 顺带纠正一条旧认知：技能 `00#HOST-08` 记的是"插件侧没有日志可以落进宿主日志"——这仍然成立（`ctx.log` 不存在），
> 但**宿主代插件打的日志在增加**：`[Plugin]` / `[AudioSpectrum]` / **`[PluginResources]`** / **`[DialogHost]`**。

---

## 五、beta.13 的插件管理页大改：**契约未破（已核验）**

beta.13 一次性重写了 `src/renderer/views/plugins/` 下的 8 个文件（`InstalledPluginCard.vue` +43/-50、
`MarketplacePluginCard.vue` +40/-58、`pluginManagement.css` -22、`PluginAuthorizedFilesDialog.vue`、
`PluginCardOrigin.vue`、`PluginShareResolve.vue`、`PluginSourceDialog.vue`、`PluginSourceInfo.vue`），
外加约 20 个 `*Dialog.vue` 的统一改造。

**这对本仓库是最需要警惕的一类改动** —— `gh-accelerator` 与 `tag-filter` 都靠 `ctx.dom.observe`
抓插件管理页的类名注入 UI。所以我在 beta.15 的 asar 里对技能 `31#DOM-*` 记录的契约类名做了**计数核验**：

| 契约类名 | beta.15 命中 | 状态 |
| --- | --- | --- |
| `.plugin-card-grid` | 4 | ✅ 在 |
| `.marketplace-toolbar` | 2 | ✅ 在 |
| `.plugin-content-heading` | 5 | ✅ 在 |
| `.plugin-empty-state` | 3 | ✅ 在 |
| `.plugin-card` | 97 | ✅ 在 |
| `.marketplace-card` | 6 | ✅ 在 |
| `.plugin-card-actions` | 5 | ✅ 在 |
| `.plugin-content` / `.plugin-header` | 7 / 17 | ✅ 在 |
| `.plugin-source-manager` / `.plugin-source-row` | 2 / 3 | ✅ 在 |
| `.plugin-view-tab` / `.plugin-failure-card` / `.plugin-safe-mode-control` | 5 / 6 / 3 | ✅ 在 |
| `.is-disabled` | 38 | ✅ 在 |

**结论：文档化的 DOM 契约全部存活，`gh-accelerator` / `tag-filter` 无需改动。**
（但 `pluginManagement.css` 被删了 22 行，说明**未文档化的样式细节**可能有变 —— 若某天出现"注入的 UI 样式走样"，先查这里。）

---

## 六、其余变更（与插件无关）

| 版本 | 变更 |
| --- | --- |
| β.12 | **任务栏歌词改为嵌入 `Shell_TrayWnd` 的子窗口**（`lyric.rs` +240/-20）+ 新增 `docs/taskbar-child-window-pitfalls.md`；AMLL 歌词跟随显示器刷新率（PR #473，含可选高刷）；音质面板云盘项显示文件大小；图标替换；**修复 Windows 安装目录缺沙箱读取权限导致启动即退出**；修复独立窗口拖动 seek 提交后进度条闪回；修复任务栏封面因 WebP 解码失败退回应用图标；`pnpm` 原生构建白名单整理 |
| β.13 | **新增 MV 音频兜底**（「播放体验」里开启，默认关闭）；任务栏歌词行切换淡入淡出；**播放器弹出层去掉箭头并统一间距**（减少材质绘制与几何监听）；悬停提示去重；启动展示与异常文案；**对话框组件全面重构**（~20 个 `*Dialog.vue` + 新增 `TaskPanelDialog.vue` +454 + 新增 `theme/buttons.css` / `fields.css`）；修复 macOS 切浅色/深色时播放卡顿；修复歌曲列表按钮 hover 位移与 MV 图标；修复投放浮层设备名被挤压 |
| β.14 | 仅 `fix: UI & style`（`Sidebar.vue` / `SidebarShortcuts.vue` / `LyricSourceDialog.vue`） |
| β.15 | **原生对话框改造**（见 §四）；任务栏歌词换行动画改为**主副两行整块向上滚动**；**修复退出应用或关闭任务栏歌词时歌词闪现在屏幕顶部**（解挂时先隐藏并停放到屏幕外） |

---

## 七、本仓库影响与行动项

| 优先级 | 事项 |
| --- | --- |
| **P1**（沿用） | `song-downloader` 迁移到 `ctx.fs.requestDirectory` + `ctx.net.download`（beta.10 起可行，仍是最高价值项） |
| **P1**（沿用） | `kugou-daily-vip` 「每天一次」落盘键加 userid（多账号串号） |
| **P1**（沿用） | 6 个插件的 `--color-warning` / `--color-border` / `--color-bg-primary` 换成 `--state-warning` / `--border-subtle` / `--color-bg-main` |
| **P2**（新增） | 若插件文档/引导里写了文件选择器的标题文案，同步成 `EchoMusic · …` 新格式 |
| **P2**（新增） | 把 `[PluginResources]` 四条日志写进排查手册 —— 「有请求无结束 = 卡在对话框」，这正是 beta.15 修的 bug 的指纹 |
| **—** | `gh-accelerator` / `tag-filter` 的 DOM 契约已核验未破，**无需改动** |
| **—** | 其余插件本区间**零影响**（无新 API、无能力变更） |

> 注：本仓库**没有任何插件使用 `ctx.fs.requestDirectory` / `requestFiles`**（beta.10 分析已确认 0 命中），
> 所以 §四那个对话框 bug 对本仓库无实际影响 —— 但它解释了**为什么新 API 上线后很快就要修这个**。

---

## 八、方法附录

### 8.1 「空档版本」的识别（本轮新增）

**症状**：某版本的 Release Notes 与上一版**逐字相同**，但看起来"内容很多"。

**验证**：直接跑 compare 看 `total_commits` 与 `files.Count`。
beta.14 → **1 commit / 13 files**，而 Notes 列了 25 条「新增」+ 24 条「优化」+ 24 条「修复」。

**结论**：本项目的 Notes 是**整个 beta 线的滚动快照**，与单个版本的改动量**完全无关**。
`total_commits` 是唯一诚实的量级指标。

### 8.2 DOM 契约回归核验（可复用套路）

宿主大改某个页面（如 beta.13 重写插件管理页）后，**不要凭"感觉没动我的类名"下结论**，
在 asar 里对契约类名**逐个数命中次数**：

```powershell
$bytes=[System.IO.File]::ReadAllBytes("<REDACTED>")
$txt=[System.Text.Encoding]::UTF8.GetString($bytes)
foreach($k in @('plugin-card-grid','marketplace-toolbar','plugin-content-heading','plugin-empty-state')){
  $n=0;$j=0; while($true){$j=$txt.IndexOf($k,$j); if($j -lt 0){break}; $n++; $j+=$k.Length}
  "{0,-24} {1}" -f $k,$n }
```

全部 `> 0` 即契约存活。**这比肉眼扫 patch 靠谱，也比重装验证快。**

### 8.3 提交级 patch 仍是定位根因的最快路径

beta.15 的 `612f...`/`6cc21cf` 只看 compare 的文件清单（`ipc/dialogHost.ts [added] +99`）
是看不出"跨线程 Win32 模态框不显示"这一层的；`gh api repos/.../commits/<sha>` 拿到的
`dialogHost.ts` 全文注释把真机现场（线程号、可见/可用状态）都写进去了。

---

## 九、结论摘要

1. **beta.12 ~ beta.15 都没有新增插件 API**：能力清单 17 项不变、121 个插件 IPC 通道无新增、
   `createPluginContext` 工厂实参逐字未变；beta.10 引入的文件授权/下载/媒体 API 契约无变化；
2. **唯一影响插件的变更是 beta.15 的原生对话框改造**：一律**不挂父窗口**（修掉"弹窗不显示 + 应用卡死"的
   跨线程 Win32 模态框 bug），并把标题统一加上 `EchoMusic · ` 前缀 ——
   受影响的正是 `ctx.fs.requestDirectory/requestFiles`、`ctx.dialog.select*`、`ctx.process.launch` 的确认框；
   插件侧**无需改代码**，但引用标题文案的文档要同步；
3. **beta.15 还新增了宿主侧 `[PluginResources]` 四条日志**，成为插件文件授权问题的新诊断通道
   （「有请求无结束 = 卡在对话框」）；
4. **beta.13 重写了插件管理页**，但技能文档化的 **DOM 契约类名全部存活**（已逐个数命中次数核验），
   `gh-accelerator` / `tag-filter` 无需改动；
5. ⚠️ **beta.14 是个空档版本**：只有 1 个提交 / 13 个文件，Release Notes 却与 beta.13 **逐字相同** ——
   这是"Notes 不可信"的极端例子，`total_commits` 才是唯一诚实的量级指标；
6. 其余变更集中在本项目的主线（Windows 任务栏歌词、MV 音频兜底、AMLL 高刷、对话框组件统一重构），与插件无关。
