# EchoMusic v2.3.2-beta.7 技术分析

> 结论先行：beta.7 是**插件 API 的一次大扩容**（83 提交 / 约 5 周），新增 **1 个能力 `theme`** 与 **3 个新 API 面**：
> `ctx.theme`（全局主题）、`ctx.ui.playerbar`（播放栏操作）、`ctx.ui.sidebar.shortcuts`（侧栏快捷卡片），另有 `ctx.ui.addSongContextMenuItem`。
> 同时有 **1 处破坏性变更**（`ctx.ui.settings.define` 移除 `sections`/`fields`/`onChange`，`component` 变为必填）与 **1 组 CSS 变量重命名**。
> ⚠️ Release Notes 依然是**累积**的 —— beta.7 的 Notes 把 beta.6 和 beta.5 的条目也一起列了，**判断增量必须看 commit**。

分析时间：2026-10-08　分析对象：`hoowhoami/EchoMusic` @ `v2.3.2-beta.7`
数据来源：本机实装 `2.3.2-beta.7`（`<REDACTED>`，9,465,309 B，mtime 2026-10-08 11:42）+ 官方插件文档 + GitHub API
前序：[beta.6 技术分析](EchoMusic-v2.3.2-beta.6-技术分析.md) · [插件系统与加速链路调研](EchoMusic-插件系统与加速链路调研.md)

---

## 一、版本元数据（本机核验）

| 项 | 值 |
| --- | --- |
| tag | `v2.3.2-beta.7` |
| 发布类型 | 预发布（`prerelease: true`） |
| 发布时间 | 2026-10-08 03:44:53 UTC（北京时间 11:44） |
| 本机 exe `FileVersion` | `2.3.2-beta.7`（`ProductVersion` = `2.3.2.0`） |
| 距上一版 | beta.6 = 2026-09-22，间隔 **16 天** |
| 提交数 | **83**（beta.6 是 19） |
| 变更文件 | 300（其中 **253 个在 `native/`**，是 vendored Rust 依赖） |
| 真正的应用源码改动 | `src/` 下约 19 个文件 |
| 产物 | Windows x64/arm64、macOS dmg/zip、Linux deb/rpm/AppImage/tar.gz/pkg.tar.zst + 4 个 `latest*.yml` |

> ⚠️ **"300 文件"是假象**。`native/` 的 253 个文件来自 vendored 依赖（含新增的 `ECHOMUSIC_VENDOR.md`，对应 DLNA/AirPlay 用到的 `rupnp`、`airplay2-rs`）。
> GitHub 的 compare API 对其中部分文件不给 patch 内容（`+0/-0`），所以**不要依赖 compare 的 diff 正文**做代码级分析，改用本机 asar。

---

## 二、⚠️ Release Notes 依旧累积（三版对照）

| 条目 | beta.5 | beta.6 | beta.7 |
| --- | --- | --- | --- |
| 服务请求拦截插件 API | ✅ 新增 | ✅ 重复 | ✅ **重复** |
| 页面歌词换肤功能 | ✅ 新增 | ✅ 重复 | ✅ **重复** |
| 修复浮窗插件播放 API 缺失 | ✅ 修复 | ✅ 重复 | ✅ **重复** |
| 插件本地 WebSocket API | — | ✅ 新增 | ✅ **重复** |
| MV 收藏 / 标题栏「更多」加插件管理 / Windows 任务栏播控 | — | ✅ 新增 | ✅ **重复** |
| 节奏融合「对齐节拍」 | — | ✅ 新增 | ✅ **重复** |
| 统一主题中心 / 侧边栏布局编辑 / 刷歌 / 歌词简繁 / 全局歌词偏移 / DLNA·AirPlay … | — | — | ✅ **真正属于 beta.7** |

beta.7 的「新增」段有 17 条，其中 **10 条是 beta.5/beta.6 的旧条目**。

**规则：判断某版本增量，只用 `git compare` 的 commit 列表（或本机 asar 检索）。Notes 只能当宣传摘要看。**

### beta.7 的关键提交（83 个中的信号项）

```
8bb5ffc  09-24  feat: dlna & airplay
6529af5  09-24  feat: sidebar layout                    ← 侧边栏布局编辑
43fbc95  09-25  feat(lyrics): persistent global lyric timing calibration
3b0a8ce  09-27  feat: 歌词支持 LRC 增强模式逐字时间戳
eb263b0  09-30  feat: opencc                            ← 歌词简繁转换
1a92ad7  09-30  feat(macOS): background close mode
8aa5bc1  10-04  feat: unify app themes and customizable sidebar shortcuts  ← 主题中心 + 快捷卡片
0f3e1e8  10-05  optimize: song url fetch
b309a87  10-05  optimize: playlist song metadta
72217f1  10-07  feat: Apple Music 预设添加歌词过滤功能
95e0be6  10-07  fix(upnp): 兼容非规范的服务端点写法
7804b72  10-07  fix(airplay): mDNS 浏览流让出控制权
70c9b85  10-07  fix(output): 修正搜索状态上报、刷新重扫与设备列表显示
```

> 注意：**没有任何一条提交信息提到 `theme` / `playerbar` / `sidebar.shortcuts` 这几个插件 API**，它们藏在 `feat: unify app themes and customizable sidebar shortcuts` 与 `feat: sidebar layout` 里。
> 靠提交信息找插件 API 会漏掉——**必须靠 asar 检索**。

---

## 三、能力（capabilities）变化：新增 `theme`

beta.7 的能力门禁共 **16 项**。相比 beta.6 的 15 项，**新增 `theme`**：

```
插件未声明主题能力（capabilities.theme）        ← NEW
插件未声明服务请求拦截能力（capabilities.serverIntercept）
插件未声明歌词页能力（capabilities.lyricsPage）
…（其余 13 项与 beta.6 一致）
```

manifest 校验器（按校验顺序，`theme` 排在**第一位**）覆盖 15 项：
`theme` `audioSource` `audioSpectrum` `backups` `kugouApi` `kugouVerification` `localFiles`
`lyricEffects` `lyrics` `process` `sqlite` `tcp` `unrestrictedNetwork` `webServer` `serverIntercept`

⚠️ **`lyricsPage` 仍不在校验器里**（beta.6 就如此）——它有运行期门禁却没有类型校验，写错类型不会在清单校验阶段被拦下。

插件卡片上展示的授权芯片（宿主内部顺序，可用于对照 README 写法）：

| 来源 | 芯片文案 |
| --- | --- |
| `runtime.miniPlayer` | Mini 运行时 |
| `runtime.desktopLyric` | 桌面歌词 |
| `capabilities.theme` | 主题 |
| `capabilities.lyricEffects` | 歌词动效 |
| `capabilities.lyrics` | 歌词解析 |
| `capabilities.audioSource` | 音源解析 |
| `capabilities.audioSpectrum` | 音频频谱 |
| `capabilities.backups` | 备份与恢复 |
| `capabilities.kugouApi` | 酷狗 API |
| `capabilities.kugouVerification` | 酷狗验证 |
| `capabilities.localFiles` | 本地文件 |
| `capabilities.process` | 本地进程 |
| `capabilities.sqlite` | SQLite |
| `capabilities.unrestrictedNetwork` | 原生网络 |
| `capabilities.serverIntercept` | 请求拦截 |
| `capabilities.tcp` | TCP 网络 |
| `contributes.windows` | 插件浮窗 |

---

## 四、新 API 之一：`ctx.theme`（全局主题中心）

能力：`capabilities.theme`。官方文档：[`docs/themes.md`](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/themes.md)（本次实现基于 2.3.2-beta.7）。

### 4.1 注册契约（本机 asar 逐字核验）

```js
const dispose = ctx.theme.register({
  id: 'mist',                 // 插件内稳定唯一；跨插件同名不冲突（key = [pluginId, id]）
  title: '晨雾',
  type: 'default',            // 'default' 静态 | 'solid' 纯色 | 'dynamic' 动态；省略 = default
  defaultMode: 'system',      // 'system' | 'light' | 'dark'
  variants: {
    light: { tokens: { shell:'#eef3f3', main:'#f8fbfb', text:'#172c2e', secondary:'#52676a' }, accent:'#188c87' },
    dark:  { tokens: { shell:'#171d29', main:'#1b2230', text:'#f3f5fb', secondary:'#b6c0d5' }, accent:'#8d9deb' },
  },
});
ctx.theme.openThemes();       // 打开主题中心
```

**校验与报错文案（本机核验，可直接用于排查）**：

| 触发条件 | 报错 |
| --- | --- |
| 未声明能力 | `插件未声明主题能力（capabilities.theme）` |
| 缺 `id` / `title` / `variants.light.tokens` / `variants.dark.tokens` | `主题需要 id、title 与 light/dark tokens` |
| `settings.defaults` 不是普通对象 | `主题 settings.defaults 必须是普通对象` |
| `type` 不在 `default/solid/dynamic` | `主题类型无效` |
| `defaultMode` 不在 `system/light/dark` | `主题显示模式无效` |
| `resolve` 不是函数 | `主题 resolve 必须是函数` |
| token 键名不在白名单 | `未知主题颜色 token` |
| token 值不是 6 位十六进制 | `主题颜色必须为六位十六进制颜色` |
| `floating` 键不在 `background/card/text/secondary/border` | `主题浮层颜色无效` |
| `accent` / `background.color` 非 6 位 HEX | `主题强调色无效` / `主题背景颜色无效` |
| `background.gradient` 不是合法 gradient | `主题背景渐变无效` |
| 外观对象是 thenable（`async` 返回） | `主题必须同步返回外观对象` |
| `settings.defaults` 含非 JSON 值 | `主题配置只能包含 JSON 数据` |
| 在组件外调用 `ctx.theme.useTheme()` | `useTheme 必须在主题设置或装饰组件中调用` |

`register()` **返回注销函数**，并已自动登记到插件 disposer；同 `key` 重复注册会替换旧 revision（旧 dispose 不影响新主题）；禁用时宿主自动注销。

### 4.2 颜色 token 白名单

`variants.light/dark` **均必填**，`tokens` 可部分填写（未填由统一解析器按前景明暗补齐）。允许的 token 键：

```
shell  sidebar  main  card  elevated  player  text  secondary  border
```

外加三个独立字段：

| 字段 | 形态 | 说明 |
| --- | --- | --- |
| `accent` | 6 位 HEX | 强调色。跟随主题时保留原值，**不再做提取色归一化** |
| `background` | `{ color, gradient, image, position, fit }` | `fit: 'cover' \| 'contain'`；`image` 可为插件资源 URL 或 data URL |
| `floating` | `{ background, card, text, secondary, border }` | 弹窗/抽屉/菜单/提示的独立配色组，字段均可选 |

解析规则要点（决定"写了没效果"的原因）：

- `tokens.shell` 与 `background.color` 都是**全局背景底色**，后者优先；侧栏与外层留白共用它，**侧栏不再绘制独立表面**；
- `tokens.main` = 主内容 + 播放栏共用底色（缺省用 `shell`）；**播放栏固定用 `main`，插件不能单独指定播放栏底色**；
- `tokens.card` 只是"语义实色卡片基色"，普通内容卡片实际用宿主统一轻量材质，**不铺设该实色**；
- `tokens.elevated` 是**旧字段**，新主题请用 `floating`；
- 浮层文字对比不足 4.5:1 会被**自动纠正**；
- **不要写 CSS 覆盖控件、边框、行悬停、内容卡片** —— 这些在内容区与浮层各自作用域内统一派生。

### 4.3 设置与装饰

```js
settings: {
  defaults: { texture: 20 },                       // 仅 JSON 数据，不存组件/函数/资源句柄
  validate: values => values.texture >= 0 && values.texture <= 50,   // 返回 boolean 或 { errors: string[] }
  component: ThemeSettings,
},
resolve: ({ isDark, settings }) => ({ /* 同步返回外观字段，必须无副作用 */ }),
decorations: { background: Texture, sidebar: SidebarDecoration, player: PlayerDecoration },
```

设置组件与装饰组件的 `setup()` 内调用 `ctx.theme.useTheme()`，可拿到：
`key` / `isDark` / `settings` / `accentColor` / `appearance`（只读 computed）、`updateSettings(patch)` / `resetSettings()`、**`motionEnabled`**。

⚠️ **动画必须遵守 `motionEnabled`**（窗口可见且系统未要求减少动态效果）—— 声明 `type: 'dynamic'` 本身**不会**启动动画。

装饰只能位于宿主指定的三处：**背景、侧栏底图、播放器底图**，不能替换业务结构；不接收指针事件。

### 4.4 与旧接口的关系（向后兼容但语义变了）

- `ctx.theme.surface.set/clear` 与 `accentGradient.set/clear` **仍可用**，但降级为"Echo 内置主题下的默认外观贡献"；
- **旧 surface 贡献不能改变主内容与播放栏的固定透明度**（这两处改为宿主固定面板材质）；
- 明确关闭氛围/封面氛围时，**优先于**旧 gradient 贡献；
- `pageTransition` 保持独立的页面动效语义；
- 不要直接改宿主 store 或 CSS 选择器来激活主题。

其它窗口（浮窗/桌面歌词/mini）通过 `ctx.appearance.getSnapshot()` 取普通 JSON 快照：`isDark / accentColor / fontFamily / colors / floatingSurfaceFrosted`。**快照不含主题组件与主窗口背景图**。

---

## 五、新 API 之二：`ctx.ui.playerbar`（播放栏操作）

官方文档：[`docs/playerbar.md`](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/playerbar.md)（5,089 B）

```js
const dispose = ctx.ui.playerbar.register({
  id: 'open-panel',           // 必填，插件内稳定唯一；升级不要换 ID（否则用户布局失配）
  title: '插件面板',           // 必填
  icon: 'tabler:music-cog',   // 必填，Iconify 名称或图标数据对象
  tooltip: '打开插件播放面板',
  defaultPlacement: 'more',   // 'left' | 'center' | 'right' | 'more'，默认 'more'
  trigger: 'click',           // 'click' | 'hover'，默认 'click'
  order: 100,                 // 默认 1000，越小越靠前；用户排序优先
  badge: () => '3',           // 字符串/数字/null/同步函数；异常 → 隐藏徽标并上报
  badgeTitle: '待处理数量',
  badgeDefaultVisible: true,
  visible: () => true,        // 布尔或同步函数；异常 → 隐藏
  disabled: () => false,      // 布尔或同步函数；异常 → 禁用
  onClick: async () => {},    // 必填；异步执行期间自动禁用，防重复触发
});
```

宿主统一负责**首页播放栏、歌词页底部控制栏、更多菜单、布局编辑、Tooltip、徽标显示与生命周期清理**。插件**不要**自行插入播放栏 DOM。

四个可管理位置：`left`（歌曲信息下方小按钮区）、`center`（播放控制上方）、`right`（右侧功能区）、`more`（默认收纳）。

「更多功能」弹出层两种状态：日常模式只列被收纳的可执行操作；**编辑布局模式**显示四区，可拖动调整位置与顺序，带徽标的按钮后方有「徽标」复选框。修改即时生效并自动保存。

其他要点：

- 布局按 **插件 ID + 操作 ID** 隔离；停用插件移除入口但**保留用户偏好**，重新启用或升级后恢复；
- `visible: false` 在播放栏与更多菜单里都隐藏，同样保留偏好；
- 空间不足时宿主会把放不下的操作**临时**收入更多菜单，窗口恢复后回到保存位置；
- 宿主内置操作（播放、上一首/下一首、音质、音效、桌面歌词、播放队列…）**参与同一套布局管理**，与插件操作混合排序；
- `visible` / `disabled` / `badge` 函数应**无副作用**；注册后改响应式状态即可生效，改标题/图标需用相同 ID 重新注册。

---

## 六、新 API 之三：`ctx.ui.sidebar.shortcuts`（侧栏快捷卡片）

官方文档：[`docs/sidebar-shortcuts.md`](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/sidebar-shortcuts.md)（7,363 B）

**它只往侧栏「添加卡片」弹窗的「常用功能」候选列表里注册**，由用户点 `+` 选择后才出现在侧栏。**不需要额外能力声明**。

```js
ctx.ui.sidebar.shortcuts.register({
  id: 'workspace-card',       // 必填，稳定唯一
  title: '工作台',             // 必填
  icon: 'tabler:layout-dashboard',   // 可选；不传用宿主插件图标；不能传图片 URL / Vue 组件
  pageId: 'workspace',        // 与 onClick 二选一
  order: 100,                 // 默认 1000；只影响候选列表，不覆盖用户已选顺序
  visible: () => true,
  disabled: () => false,
});

// 动作卡片：与 pageId 二选一
ctx.ui.sidebar.shortcuts.register({ id: 'quick-action', title: '快捷操作', icon: 'tabler:bolt', async onClick() {} });
```

**三个侧栏区域的分工**（这是最容易搞错的）：

| 区域 | 插件接入方式 | 用户调整方式 |
| --- | --- | --- |
| 上方**快捷卡片** | `ctx.ui.sidebar.shortcuts.register(...)` | 通过 `+` 添加、卡片右上角移除、直接拖动排序 |
| 中间**音乐菜单及插件菜单** | `ctx.ui.sidebar.addItem(...)` 或 `ctx.ui.addPage({ sidebar })` | 底部编辑入口的「菜单与歌单」中隐藏/显示/排序 |
| 下方**固定歌单入口** | 宿主提供 | 「菜单与歌单」控制显示，位置固定 |

- 「为您推荐」「探索发现」是**宿主保留卡片**，用户不能移除，插件不能替换或删除；
- 两个区域的「恢复默认」**互相独立**；
- 注册会抛异常的四种情况：缺 `id`/`title`、没提供动作、同时提供 `pageId` 和 `onClick`、`onClick` 不是函数；
- **此 API 不接收 `section` / `sectionTitle` / `before` / `after` / `path`**（那是下方菜单的字段）；
- 同一功能若确实要两个入口，可分别注册上方卡片和下方菜单；只注册其一不会自动生成另一个。

> ⚠️ 依赖 `ctx.theme.openThemes()` 这类受能力控制的 API 时，仍需声明对应能力（`theme`）。

---

## 七、侧栏 `addItem` 的扩展 + 歌曲右键菜单

### 7.1 `ctx.ui.sidebar.addItem` 新增字段（本机 asar 核验）

```js
ctx.ui.sidebar.addItem({
  id, pageId, title, icon, order,
  section: 'plugins',        // 默认 'plugins'
  sectionTitle, sectionOrder, collapsible,   // ← 分组级
  before, after,             // ← 相对定位（参与布局编辑排序）
  visible, disabled,         // ← 可动态控制
  path,
});
```

`addPage({ sidebar: ... })` 内部走同一套字段（`typeof o === 'object' ? o : {}`，即 `sidebar: true` 仍是简写）。

**侧边栏现在是用户可编辑布局**（本机核验）：

- 宿主内置分组 + 插件贡献分组按 **id 合并**，再按 `order` → `title.localeCompare(..., 'zh-Hans-CN')` 排序；
- 条目按 `order` → title 排序，并支持 `before`/`after` 相对重排；
- **`stable section` 过滤**：`home` / `explore` / `personal-fm` / `purchased` 这几个内置条目会从宿主分组里被摘出（它们改由布局编辑管理）；
- 条目必须 `visible`（求值异常则默认 `true`）才显示；**空分组会被整体丢弃**（`items.length > 0`）；
- 用户隐藏状态存在 `setting.sidebarLayout = { hiddenSections, hiddenItems }`；
- ⚠️ **`sidebarSectionCollapsed` 语义收紧**：现在**只对 `collapsible: true` 的分组生效**。

→ **对本仓库的影响**：`gh-accelerator` 这类往侧栏加条目的插件，现在用户**可以把它的入口隐藏或挪走**。插件不应假设自己的入口一定可见；需要"重新暴露"能力的话，应自己做「展开分组 / 取消隐藏」的自检按钮（读 `setting.sidebarLayout`）。

### 7.2 `ctx.ui.addSongContextMenuItem`（歌曲右键菜单扩展）

```js
ctx.ui.addSongContextMenuItem({
  id,                    // 必填
  label,                 // 必填
  order: 1000,
  danger: false,
  visible: (song) => true,   // 求值异常 → 隐藏，并上报「歌曲菜单可见性」
  enabled: (song) => true,   // 求值异常 → 禁用，并上报「歌曲菜单可用性」
  onSelect: async (song) => {},  // 异常 → 上报「歌曲菜单操作」
});
```

内部按 `${pluginId}:${id}` 去重：**同 id 重复注册会先注销旧的**。三个回调全部包了 try/catch，异常不会炸宿主。

---

## 八、⚠️ 破坏性变更：`ctx.ui.settings.define`

**这是 beta.7 唯一会直接让插件报错的变更**（本机 asar 逐字核验）：

```js
ctx.ui.settings.define({
  component: MySettings,     // ← 现在「必填」
  // sections / fields / onChange 已移除
});
```

两种情况抛异常：

```
ctx.ui.settings.define 已移除 sections/fields/onChange 设置方式，请提供 component
ctx.ui.settings.define 需要提供 component
```

**自查结果（本仓库 7 个插件）**：全部使用 `ctx.ui.settings.define({ component })` 形式，**无一使用 `sections`/`fields`/`onChange` 声明式写法** → **不受影响**。

> 但要注意：宿主现在把 `sections`/`fields`/`onChange` 视为**硬错误**（`in` 判断，不是 truthy 判断）。
> 如果将来某个插件的设置对象里"顺手"带了这三个键名之一（哪怕是 `onChange: undefined`），也会直接抛错。

---

## 九、⚠️ CSS 变量变化（"统一主题中心"的副作用）

主题中心把颜色体系重新整理了一遍。**实测命中次数（全 asar）**：

| 变量 | beta.7 命中 | 状态 |
| --- | --- | --- |
| `--color-bg-primary` | **0** | ❌ 已消失 |
| `--color-warning` | **0** | ❌ 已消失 → 用 `--state-warning` |
| `--color-border` | **1** | ⚠️ 实际等于不存在 → 用 `--border-subtle` / `--control-border` |
| `--color-bg-main` | 72 | ✅ 替代 `--color-bg-primary` |
| `--color-primary-text` | 255 | ✅ 未记录过的**主力** token |
| `--color-on-primary` | 28 | ✅ 新增 |
| `--color-secondary` | 14 | ✅ 新增 |
| `--state-warning` / `--state-danger` / `--state-success` | 33 / 57 / 12 | ✅ 语义状态色，含 `--state-*-bg-soft` |
| `--plugin-accent` | 11 | ✅ **插件专用**强调色 |
| `--plugin-settings-dialog-bg` | 5 | ✅ **插件专用**设置弹窗底色 |
| `--floating-surface-bg` / `--floating-border` / `--floating-text-main` … | 21 / 5 / 5 | ✅ 浮层族（弹窗/抽屉/菜单） |
| `--content-panel-bg` / `--content-panel-border` | 66 / 40 | ✅ 内容卡片 |
| `--radius-control` / `--radius-card` | 341 / 185 | ✅ 圆角族（含 `--radius-dialog/-popover/-item/-media/-micro/-shell`） |
| `--layout-sidebar-width` / `--layout-top-inset` / `--layout-edge-inset` / `--layout-panel-gap` / `--layout-panel-radius` | 3 / 5 / 6 / 4 / 5 | ✅ **新布局体系** |
| `--sidebar-section-gap` | 7 | ✅ 与侧栏布局配套 |
| `--icon-main` / `--icon-secondary` | 86 / 4 | ✅ 图标色 |
| `--shadow-card` / `-dialog` / `-elevated` / `-cover` | 14 / 10 / 12 / 11 | ✅ |
| `--scrollbar-thumb-bg` / `-hover` / `-active` | 9 / 5 / 4 | ✅ |
| `--text-main` / `--text-secondary` | 127 / 127 | ✅ 短别名（宿主内部与 `--color-*` 成对使用） |

宿主自己的写法是**成对兜底**，例如：

```css
color: var(--color-text-main, var(--text-main));
```

### 本仓库自查结果

6 个插件的 `style.css` 里仍在用已消失的变量（**全部带兜底值，所以不会白屏/错乱，但会失去跟随主题的能力**）：

| 插件 | 失效变量 | 出现次数 |
| --- | --- | --- |
| `gh-accelerator` | `--color-warning` ×7、`--color-bg-primary` ×1 | 8 |
| `playlist-importer` | `--color-warning` ×5、`--color-border` ×4 | 9 |
| `song-downloader` | `--color-warning` ×4 | 4 |
| `tag-filter` | `--color-warning` ×2 | 2 |
| `kugou-recommend` | `--color-warning` ×2 | 2 |
| `kugou-daily-vip` | `--color-warning` ×1（内联 style） | 1 |

**替换建议**：`--color-warning` → `--state-warning`；`--color-border` → `--border-subtle`（或 `--control-border`）；`--color-bg-primary` → `--color-bg-main`。

---

## 十、`ctx` 全貌（beta.7，从 `createPluginContext` 逐字提取）

这是 beta.7 的**完整**插件上下文，之前的手册只覆盖了其中一部分：

```js
// 元信息
id · manifest · descriptor · app · vue · router · pinia

// 状态
stores { player(响应式) · playlist · lyric · settings · theme }
player · playlist · lyric
settings

// 播放与音频
audio · lyrics · lyricEffects · nowPlaying · desktopLyric · miniPlayer

// 主题与外观（beta.7 大增）
theme            ← NEW（需 capabilities.theme）
appearance · fonts · cover · scroll · graphics
ui               ← 含 lyricsPage · titlebar · playerbar(NEW) · addPage · sidebar · addSongContextMenuItem(NEW) · settings · cover

// 酷狗
kugou · kugouVerification · server

// 宿主能力
net · fs · process · webServer · sqlite · backups · dialogs { selectDirectory, selectFiles }
windows · host · tasks · shortcuts · commands { register, execute } · events { onTrackChange, onPlaybackChange, onPlaybackStateChange, onPlay, onPause, onEnded, onSeek, onError, onTimeUpdate, on } · css { inject }

// 图标与通知
icons · appIcons { refresh, restoreDefaultDesktopIcon, restoreDefaultTaskbarIcon, setRuntimeWindowIcon, restoreDefaultWindowIcon }
toast

// 基础设施
storage { get, set, delete } · dom · electron · dispose
```

> ⚠️ **`ctx.log` 不存在。** 全 asar 检索 `ctx.log` 与 `plugins.log` **均为 0 命中**，`createPluginContext` 也没有 `log` 键。
> 本仓库 `AGENTS.md:132` 写的「用 `ctx.log`」是**事实错误**（`AGENTS.md:218` 自己也承认 `ctx.log` 不落日志文件），
> `playlist-importer/index.js:2386` 的 `if (ctx.log && typeof ctx.log === 'function')` 是一段**永不执行的死代码**。
> 插件日志请用 `ctx.toast` 做用户可见反馈，调试信息靠宿主代打的 `[Plugin]` / `[AudioSpectrum]` 标记。

### 插件性能与日志脱敏（Notes 的两条"优化"）

- **性能**：不可见的插件页面与歌词皮肤会**自动暂停音频频谱推送**；隐藏的插件窗口**允许降频休眠**。
  → 推论：依赖频谱/`requestAnimationFrame` 的插件**不能假设回调持续触发**，恢复可见后要重新取一次状态（回声式刷新），不要用 `rAF` 的调用次数当计时器。
- **网络失败日志脱敏**：宿主侧记录插件、请求方法、**脱敏 URL** 与错误码。本机核验到脱敏的两层规则：
  - 键名黑名单（正则 `Fi` 覆盖）：`token` `cookie` `authorization` `accesskey` `dfid` `mid` `uuid` `guid` `dev` `mac` `password` `pwd` `secret` `key` `verifycode` `qrcode` `qrsig` `pt_login_sig` `pt_openlogin_data` `xlogin_url` `h5sig` `login_sig` `sid` `edt`；
  - `k=v` 形态替换（正则 `Ii`）：`(token|accesskey|dfid|mid|KUGOU_API_MID|uuid|guid|KUGOU_API_DEV|KUGOU_API_MAC|Authorization|cookie|password|…)=([^;&\s]+)` → 打码；
  - 另有一套日志级别机制：级别 `error/warn/info/debug/verbose`（默认 `info`）、`apiResponseBody`（是否记录响应体，默认 `false`）、`diagnosticUntil`（限时诊断窗口）。
  → 推论：**插件在 URL query / header 里塞自定义字段时，如果字段名命中上面这批键名，控制台/日志里会被打码**，排查时别以为值丢了。

---

## 十一、与插件无关但值得知道的宿主变更

| 变更 | 备注 |
| --- | --- |
| **DLNA / AirPlay 发现与连接** | 新增 `native/` 下的 `rupnp`、`airplay2-rs` vendored 依赖；对应向上游输出的设备/搜索状态修复 |
| **统一主题中心** | 新增路由 `/main/themes`（`ThemeCenter-*.js`）、侧栏入口「主题中心」；三个页签「主题 / 纯色 / 自定义」；软件设置负责显示模式，主题页负责配色/背景/皮肤透明度/毛玻璃 |
| **侧边栏布局编辑** | 见 §七。新增 `--layout-*` 变量族 |
| **播放栏「更多功能」与布局编辑** | 见 §五 |
| **歌词体系大改** | 简繁转换（opencc，支持原文/简体/繁体/台湾正体/香港繁体）、**全局时间偏移**（播放页/桌面歌词/Mini/任务栏统一校准）、增强 LRC 逐字时间戳、歌词设置结构重组、Apple Music 预设加歌词过滤 |
| **刷歌 / 发现歌曲** | `feat: song discover` |
| **macOS 后台模式** | 独立控制 Dock 与菜单栏图标隐藏开关 |
| **Windows 失焦保持毛玻璃** | 支持 Win11 22H2+，移动时也生效 |
| 其它修复 | 随机/单曲循环过渡不生效、播放进度跨窗口同步偏差、macOS Now Playing 速率误报、音源加载中播放命令被静默丢弃、红心状态不及时、Win10 透明背景窗体异常、"设备断开时暂停"误报错、Tab 状态丢失 |

---

## 十二、行动项（针对本仓库 7 个插件）

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| **P1** | 替换 3 个已消失的 CSS 变量 | 6 个插件受影响（见 §九）。**不紧急但不修就永远不跟随主题** |
| **P1** | 修 `AGENTS.md` 的 `ctx.log` 说法 | 该 API 不存在；`AGENTS.md:132` 与 `:218` 自相矛盾。顺手清掉 `playlist-importer` 的死代码 |
| **P2** | `gh-accelerator`：侧栏入口可被用户隐藏/挪动 | 见 §7.1。建议加"检测入口是否被隐藏/分组是否折叠"的自检与一键恢复 |
| **P2** | 评估 `ctx.ui.playerbar` 的接入价值 | `gh-accelerator`（快速测速/切换线路）、`tag-filter`（一键切换筛选）、`song-downloader`（下载当前曲）都适合放一个播放栏入口 |
| **P3** | 评估 `ctx.theme` | 本仓库暂无主题类插件；若要做一个"晨雾/暮色"这类主题包，`app-theme-example` 是官方可运行样例 |
| **P3** | 评估 `ctx.ui.sidebar.shortcuts` | 比 `addItem` 更轻（用户可选、可拖动），适合"低频但有价值"的入口 |
| **—** | `ctx.ui.settings.define` | **无需改动**（本仓库全部用 `component` 形式） |
| **—** | 兼容性声明 | 用到 beta.7 新 API 的插件，`requires.echoMusicVersion` 应提到 `>=2.3.2-beta.7`；仅用 `component` 形式的无需改 |

---

## 十三、方法附录

```powershell
# 1) 确认本机版本
(Get-Item "<REDACTED>").VersionInfo.FileVersion    # → 2.3.2-beta.7

# 2) asar 检索（不解包）
$bytes = [System.IO.File]::ReadAllBytes("<REDACTED>")
$txt   = [System.Text.Encoding]::UTF8.GetString($bytes)
$txt.IndexOf('capabilities?.theme')     # → 8123576（插件上下文组装处）
$txt.IndexOf('插件未声明主题能力')        # → 8780305（ctx.theme.register 实现）

# 3) 取窗口 + 插换行（压缩 bundle 是超长单行，Read 会按 2000 字符截断）
$chunk = $txt.Substring($idx-2000, 5200) -replace ',(?=[A-Za-z_$"''\{])', ",`r`n"
$chunk | Out-File "$env:TEMP\win.txt" -Encoding utf8

# 4) 精确计数（判断某个 CSS 变量/字符串还在不在）
$n=0;$i=0; while($true){$i=$txt.IndexOf('--color-warning',$i); if($i -lt 0){break}; $n++; $i+=15}; $n
```

⚠️ **WebFetch 拉 GitHub compare API 不可靠**：`beta.6...beta.7` 的 JSON 有 1.24 MB，WebFetch 会拿不到内容并给出无关回复。
**改用 PowerShell + `WebClient`（`.Proxy = $null`）下载后 `ConvertFrom-Json` 解析**：

```powershell
$wc = New-Object System.Net.WebClient; $wc.Proxy = $null
$wc.Headers.Add("User-Agent","probe"); $wc.Headers.Add("Accept","application/vnd.github+json")
$j = ($wc.DownloadString("https://api.github.com/repos/hoowhoami/EchoMusic/compare/v2.3.2-beta.6...v2.3.2-beta.7")) | ConvertFrom-Json
$j.total_commits; $j.files.Count; $j.commits | ForEach-Object { $_.sha.Substring(0,7) + " | " + $_.commit.message.Split("`n")[0] }
```

判断"某 API 属于哪个版本"的可靠顺序（beta.6 起沿用，已两次验证）：

1. **官方文档里的版本提示**（`web-server.md` 写 `>=2.3.2-beta.6`；`themes.md` 写"本次实现基于 2.3.2-beta.7"）；
2. **`git compare` 的 commit 列表**（拉 commits，不拉 files 的 diff 正文）；
3. **本机 `app.asar` 检索**（定"这份实装到底有没有"）；
4. Release Notes → **只当摘要，绝不能当增量依据**。

另：`EchoMusicPlugins` 官方文档是模块化的，`plugin-development.md`（144 KB）只是索引，正文拆到
`themes.md` / `playerbar.md` / `sidebar-shortcuts.md` / `floating-windows.md` / `graphics.md` / `tasks.md` /
`titlebar.md` / `backups.md` / `tcp.md` / `web-server.md` / `server-interceptor.md`。**查某个 API 要直接抓对应子文档。**

---

## 十四、结论摘要

1. beta.7 新增 **1 个能力 `theme`**（插件主题进入统一主题中心）与 **3 个新 API 面**：`ctx.theme`、`ctx.ui.playerbar`、`ctx.ui.sidebar.shortcuts`，外加 `ctx.ui.addSongContextMenuItem`；侧栏 `addItem` 也扩展出 `before/after/visible/disabled/collapsible/sectionOrder` 并纳入用户布局编辑；
2. **唯一的破坏性变更**是 `ctx.ui.settings.define` 移除 `sections`/`fields`/`onChange`、`component` 变必填 —— **本仓库不受影响**；
3. **3 个 CSS 变量已消失**（`--color-bg-primary`、`--color-warning`、`--color-border`），本仓库 6 个插件命中，因有兜底值不会崩但会失去主题跟随；替代品是 `--color-bg-main` / `--state-warning` / `--border-subtle`；
4. **`ctx.log` 不存在**，本仓库 `AGENTS.md` 的这条规范是错的；
5. Release Notes 第三次被确认是**累积**的（beta.7 的「新增」里 10/17 条是旧版残留）；
6. 宿主侧还有一批与插件间接相关的改动：DLNA/AirPlay、歌词简繁与全局偏移、增强 LRC、播放栏「更多功能」、侧栏布局编辑 —— 插件若要联动这些功能，时机已到。
