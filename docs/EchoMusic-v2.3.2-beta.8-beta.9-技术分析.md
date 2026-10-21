# EchoMusic v2.3.2-beta.8 / beta.9 技术分析

> 结论先行：**beta.8 与 beta.9 都没有新增插件 API，能力清单仍是 16 项，`createPluginContext` 的键表逐字未变。**
> 但两版各改了一处**会静默影响插件**的宿主契约：
> **beta.8** 把首页路由 `/main/home` 改为 `/main`、并**取消了侧栏快捷卡片的「必留」规则**；
> **beta.9** 新增多账号切换，登录态从「单账号 token」变成**多源会话**。
> 另有两条宿主能力面扩张需要跟进：**新音质 `viper_clear` / `viper_atmos`** 与 **VIP 模型重构**。

分析时间：2026-10-10　分析对象：`hoowhoami/EchoMusic` @ `v2.3.2-beta.8`、`v2.3.2-beta.9`
数据来源：本机实装 `2.3.2-beta.9`（`<REDACTED>`，9,936,867 B，mtime 2026-10-09 15:40）+ GitHub compare 的**逐文件 patch** + 官方文档
前序：[beta.7](EchoMusic-v2.3.2-beta.7-技术分析.md) · [beta.6](EchoMusic-v2.3.2-beta.6-技术分析.md) · [插件系统与加速链路调研](EchoMusic-插件系统与加速链路调研.md)

---

## 一、版本元数据

| 项 | beta.8 | beta.9 |
| --- | --- | --- |
| 发布时间（UTC） | 2026-10-08 17:46 | 2026-10-09 07:45 |
| 北京时间 | 10-09 01:46 | 10-09 15:45 |
| 类型 | 预发布 | 预发布 |
| **间隔上一版** | beta.7 → **约 12 小时** | beta.8 → **约 14 小时** |
| 提交数 | **7** | **7** |
| 变更文件 | **160**（`src` 120 / `tests` 35） | **140**（`src` 100 / `tests` 35） |
| 产物 | 20 个 | 20 个 |

**两版都是"小时内连发"的补丁级迭代**，量级与 beta.7（83 提交 / 300 文件）完全不是一个档次。
本机实装为 **beta.9**，可直接核验。

> 这两版的 `src/` 改动里 **测试占了 35 个文件**，属于本项目"改一点补一堆断言"的常规节奏，
> 其中 4 个是**新增**的重量级测试套件：`sidebar-home.test.mjs`(+464)、`floating-lyric-cover-color.test.mjs`(+586)、
> `theme-image-crop.test.mjs`(+327)、`lyric-fluid-background.test.mjs`(+405)、`settings-entry-latency.test.mjs`(+197)。

---

## 二、⚠️ Release Notes 累积：第四次验证

| 条目 | beta.5 | beta.6 | beta.7 | beta.8 | beta.9 |
| --- | --- | --- | --- | --- | --- |
| 服务请求拦截插件 API | ✅ | 重复 | 重复 | 重复 | 重复 |
| 页面歌词换肤 | ✅ | 重复 | 重复 | 重复 | 重复 |
| 插件本地 WebSocket API | — | ✅ | 重复 | 重复 | 重复 |
| 统一主题中心 / 侧边栏布局编辑 / 歌词简繁 / DLNA | — | — | ✅ | 重复 | 重复 |
| 多账号切换管理 | — | — | — | — | ✅ |
| 「添加到」多选歌单 / 概念版免费听 / 歌词色跟随封面 | — | — | — | — | ✅ |
| 超级VIP与豪华VIP展示 / 3 个蝰蛇音质 | — | — | — | ✅ | 重复 |

beta.9 的「新增」段有 **23 条**，其中 **19 条是 beta.7/beta.8 的旧条目**。

**判断增量只有两条路**：`git compare` 的 commit 列表定范围，**逐文件 patch** 定内容。Notes 永远只当摘要。

> 本轮的额外收获：**compare API 对小文件会返回 `patch` 正文**。beta.8/beta.9 都是小版本，
> 所以 260+ 个文件里绝大部分能拿到真实 diff —— **这是小版本比大版本更好做深度分析的原因**，
> 大版本（如 beta.7）的 `native/` 会把 payload 撑爆并让 WebFetch 直接失败。

---

## 三、✅ 核心结论：没有新插件 API、没有能力变更

本机 beta.9 的 asar 逐项核验：

| 核验项 | 结果 |
| --- | --- |
| 能力门禁文案 | **16 条，与 beta.7 逐字相同**（含 `插件未声明主题能力（capabilities.theme）`） |
| `capabilities?.X !== !0` 门禁键 | **15 个，与 beta.7 相同**（`process/tcp/unrestrictedNetwork/webServer/sqlite/localFiles/backups/theme/lyricEffects/lyrics/audioSource/audioSpectrum/kugouApi/kugouVerification/serverIntercept`） |
| `createPluginContext` 返回键表 | **逐字未变**（`theme` / `graphics` / `playerbar` / `sidebar.shortcuts` / `addSongContextMenuItem` 全在，无新增） |
| `ctx.theme.register` 契约 | **校验分支与报错文案逐字未变**（token 白名单、`floating` 键、`主题必须同步返回外观对象` …） |
| `ctx.ui.sidebar.shortcuts.register` | **未变**（`快捷卡片需要 id、title，以及 pageId 或 onClick 之一`） |
| `ctx.ui.sidebar.addItem` | **未变**（`before/after/visible/disabled/collapsible/sectionOrder` 全在） |

**→ 用 beta.7 的插件开发姿势写的代码，在 beta.9 上不需要任何适配就能跑。**

新功能都落在宿主 UI / 业务层：多账号、免费听、主题自定义背景图片编辑器、歌词色跟随封面、流体背景重写。

---

## 四、beta.8：侧栏快捷卡片体系重构（+ 一处路由破坏）

7 个提交：`feat: update screenshots` / `optimize: plugin source info` / 5 × `optimize: UI & style`。

### 4.1 ⚠️ 路由变更：`/main/home` → `/main`

```diff
-        await router.push('/main/home');
+        await router.push('/main');
```

同时**新增** `src/renderer/views/SidebarHome.vue`（40 行，挂在 `/main`）+ `src/renderer/utils/sidebarHome.ts`（21 行）。

**含义**：`/main` 现在是"未选中任何页时自动打开你的第一张快捷卡片"的入口页，
而不再是固定的"为您推荐"。

**对插件的影响**：任何硬编码 `/main/home` 的跳转都会失效。
**本仓库自查结果：0 命中** —— 7 个插件都没用这个路由，**无需改动**。

### 4.2 ⚠️ 侧栏快捷卡片：取消了「必留」规则

这是 beta.8 对插件语义影响最大的一处。旧实现有硬编码的必留集：

```diff
-export const REQUIRED_SHORTCUT_KEYS = ['home', 'explore'];
-export const DEFAULT_SHORTCUT_KEYS = [...REQUIRED_SHORTCUT_KEYS];
+export const DEFAULT_SHORTCUT_KEYS = ['home', 'explore'];
 export function normalizeShortcutKeys(keys?: readonly string[]): string[] {
-  const unique = [...new Set(keys ?? DEFAULT_SHORTCUT_KEYS)].filter(k => typeof k === 'string');
-  return [...REQUIRED_SHORTCUT_KEYS.filter(k => !unique.includes(k)), ...unique];
+  const unique = [...new Set(Array.isArray(keys) ? keys : DEFAULT_SHORTCUT_KEYS)]
+    .filter((key) => typeof key === 'string' && key.trim().length > 0);
+  return unique.length ? unique : ['home'];
 }
```

新规则由**数量**决定，而不是白名单：

```js
const canRemove = (entry) => visible.value.length > 1 && keys.value.includes(entry.key);
```

| 旧行为 | 新行为 |
| --- | --- |
| `home` / `explore` **不可移除**（锁图标） | 任意卡片都可移除，**只要还剩 ≥ 1 张** |
| 「必留」由 key 白名单决定 | 由**卡片数量**决定；空则回退 `['home']` |
| 顺序固定：必留项永远排前面 | **顺序完全由用户拖动决定** |
| 第一张卡没有特殊含义 | **第一张卡 = 首页**（Tooltip 会标「（首页）」） |

**对插件的影响**：

1. 插件注册的快捷卡片**可以被用户移除**（以前 `home`/`explore` 那种"钉死"待遇，插件从来就没有，但现在连宿主项也没有了）；
2. **插件卡片可以成为首页** —— 用户在"添加卡片"里把它拖到第一位，下次启动 `/main` 就直达你的插件页；
3. **不要用 `'home'` / `'explore'` 作为自己的卡片 id**（占用宿主保留 key）；
4. `order` **只影响候选列表的排列**，不覆盖用户已选顺序。

**本仓库自查：0 个插件注册过 `sidebar.shortcuts`，也 0 命中 `'home'`** —— 无需改动。

### 4.3 插件运行时就绪信号：`waitForPluginRuntimeReady()`

`src/renderer/plugins/runtime/index.ts` 新增（+6 行）：

```js
let completeFirstPluginRefresh: () => void;
const firstPluginRefresh = new Promise<void>((resolve) => { completeFirstPluginRefresh = resolve; });
export const waitForPluginRuntimeReady = () => firstPluginRefresh;
// …在 refreshPlugins() 的 finally 里：completeFirstPluginRefresh();
```

`src/renderer/utils/sidebarHome.ts` 用它做启动竞态保护：

```js
/** 读取恢复后的卡片顺序，插件首页等待首次注册完成，避免启动时误选推荐页。 */
if (!isBuiltin && !isResource) {
  const { waitForPluginRuntimeReady } = await import('@/plugins/runtime');
  await waitForPluginRuntimeReady();
}
```

**含义**：当用户的第一张卡片是**插件卡片**时，宿主会**等插件首次注册完成**再解析首页。

**⚠️ 对插件的影响（重要）**：插件 `activate()` 的耗时现在**会直接阻塞首页解析**。
不要在 `activate()` 里做同步重活（大 JSON 解析、同步 localStorage 遍历、几百次 DOM 查询）——
这从"只影响自己"升级成了"影响应用启动"。重活一律 `await` 异步化或延后到 `nextTick` / `setTimeout`。

### 4.4 VIP 模型重构（宿主侧）

`Sidebar.vue` 里原本内联的 `busi_vip` 解析被抽成工具（新增 `src/renderer/utils/accountVip.ts`）：

```diff
-const svip = computed(() => busiVip.value.find(v => v.product_type === 'svip' && v.is_vip === 1));
-const tvip = computed(() => busiVip.value.find(v => v.product_type === 'tvip' && v.is_vip === 1));
-const vipBadge = computed(() => svip.value ? 'svip' : tvip.value ? 'tvip' : 'novip');
+const vipBadge = computed(() => getPrimaryVipBadge(getAccountVipStatus(userInfo.value?.extendsInfo?.vip)));
```

徽章种类从 `svip` / `tvip` / `novip` 变成 **`super` / `deluxe` / `concept` / `music`**，
CSS 类也同步改（`badges.css`）：`.sidebar-member-badge.is-super` / `.is-deluxe` / `.is-concept` / `.is-music`；
配色 `super` = `#f97316`、`deluxe` = `#e8a317`、`concept` = `#8b5cf6`、`music` = `#07c160`。

对应 release notes 的「新增超级VIP和豪华VIP展示」，读到的新字段是 **`su_vip_end_time`**（超级VIP）与 **`vip_end_time`**（豪华VIP）。

**对插件的影响**：这是**宿主内部 store** 的模型重构，不改变 `ctx.pinia` 里 `user.info` 的原始形态。
但插件若自己在 UI 上按 `product_type === 'svip' | 'tvip'` 渲染 VIP 徽章，语义已经对不上了
（宿主现在把它们分别叫「概念会员」「畅听会员」，并新增了超级VIP / 豪华VIP）。
**本仓库 `kugou-daily-vip` 读的是自己调 `/user/vip/detail` 拿到的上游载荷**（不是宿主 store），
所以**不会报错**，但它的打分表没考虑 `su_vip_end_time`，用户同时有超级VIP 时可能挑错展示条目 —— 见 §七。

### 4.5 音质枚举扩张：3 个蝰蛇音质

`src/renderer/plugins/audioSource.ts`（**这是插件侧代码**）：

```diff
 const normalizeAudioQuality = (value: unknown): AudioQualityValue | null =>
   value === '320' || value === 'flac' || value === 'high' || value === 'viper_tape'
+    || value === 'viper_clear' || value === 'viper_atmos'
     ? value : null;
```

`src/renderer/views/settings/constants.ts` 同步新增两项菜单：

```js
{ label: '蝰蛇超清',   value: 'viper_clear' },
{ label: '蝰蛇全景声', value: 'viper_atmos' },
```

`src/renderer/stores/setting.ts`：设置键 **`viperTapeQualityEnabled` → `viperQualityEnabled`**（重命名）。

**⚠️ 对插件的影响（直接影响 `song-downloader`）**：
`ctx.player.setAudioQuality()` 与 `ctx.player.audioQuality` 现在接受 `viper_clear` / `viper_atmos`，
但 `song-downloader` 的梯度表仍是 5 档：

```js
const QUALITY_LADDER = ['128', '320', 'flac', 'high', 'viper_tape']
const QUALITY_BITRATE = { '128':128, '320':320, flac:900, high:1200, viper_tape:1300 }
if (quality === 'viper_tape') return name === 'viper_tape' || level === 101
```

→ **这两个新音质在插件里完全不可见、不可选、不可下载**。属于功能缺口，不是故障。

### 4.6 主题颜色解析多了 `surfaceDark`

```diff
-export function resolveThemeColors(appearance, requestedDark): ResolvedThemeColors {
-  const dark = usesLightForeground(text);
+/** Custom artwork can fix surface polarity independently of its chosen text color. */
+export function resolveThemeColors(appearance, requestedDark, surfaceDark?): ResolvedThemeColors {
+  const dark = surfaceDark ?? usesLightForeground(text);
```

**含义**：主题带自定义图片时，**表面明暗可以脱离文字色独立指定**。
对 `ctx.theme.register` 的契约无影响（多一个可选入参），但写主题包时要知道**宿主可能让你的配色按图片明暗走**。

### 4.7 其它

- `SidebarLayoutEditor.vue`：歌单区变成**一个整体可开关的分组**（Tooltip 从「显示分组」变成「显示**整个歌单区域**」）；
  新增常量 `SIDEBAR_PLAYLIST_SECTION_ID = 'created-playlist-defaults'` 与 `isSidebarPlaylistVisible(layout)`。
- `PluginSourceInfo.vue`：纯样式（`v-text` + `white-space: pre`），无功能变化。
- `Sidebar.vue`：`.user-info-card` 去掉 `border`（`var(--border-subtle)` → `none`）。

---

## 五、beta.9：多账号 + 免费听 + 主题图片编辑器

7 个提交，核心三条：

```
8c4eb79  feat: 新增概念版「免费听」
ade9fe6  fix: 免费听补齐嵌套字段映射与账号会话守卫
7a22cbf  feat: account switch & free listen
```

### 5.1 ⚠️ 多账号切换：登录态不再是「一个 token」

新增 `AccountSwitcherDialog.vue`，`SidebarAccountPopover.vue` 里加了「切换账号」入口（+55/-16）。
关键新 API（宿主侧工具，插件拿不到但**语义要跟上**）：

```js
import { userSessionSources } from '@/utils/userSession';
import { watchUserSession } from '@/utils/watchUserSession';

watchUserSession(userStore, ({ isLoggedIn }) => { /* … */ });
watch([...userSessionSources(user), () => route.fullPath], () => { /* 重置 UI */ });
```

原先各处写的是 `[isLoggedIn, currentUserId, userStore.accountRevision]`，现在统一收敛成
`userSessionSources(user)`。`user.savedAccounts` 是已保存账号列表。

**⚠️ 对插件的影响**：

1. `accountRevision` **仍然存在**，是"账号发生了变化"的信号 —— 插件监听登录态时，
   **不要只看 `token`**，要同时看 `accountRevision`（切账号后 token 可能相同或短暂复用）；
2. 切换账号会**清空并重建播放列表**（`Sidebar.vue` 里 `playlistStore.userPlaylists = []` 的分支），
   插件缓存的"用户相关列表"（歌单、听歌记录、VIP 状态）**在切账号后必须作废重取**；
3. `kugou-daily-vip` 这类"每天领一次"的插件，`lastDoneDate` 落盘键应**包含 userid**，
   否则切账号后会把 A 的"今天已领"记到 B 头上。**本仓库自查：`kugou-daily-vip` 的落盘键未含 userid → 待评估。**

### 5.2 概念版「免费听」：新路由 + 新保留 key

```diff
+      {
+        id: 'free-listen', key: 'free-listen', title: '免费听',
+        path: '/main/free-listen', builtinIcon: 'headphones', order: 30,
+      },
```

并且加进了"从菜单区排除、交给快捷卡片管理"的内置清单：

```diff
-        (item) => !['home', 'explore', 'personal-fm', 'purchased'].includes(item.id),
+        (item) => !['home', 'explore', 'free-listen', 'personal-fm', 'purchased'].includes(item.id),
```

beta.9 还专门修了一次：`6befd30 fix: 免费听不再默认占用侧边栏快捷卡片`
→ 它进了候选列表但**不默认占用卡片位**（与 `builtinSidebarShortcuts` 里的位置一致，需用户主动添加）。

**⚠️ 对插件的影响**：`free-listen` 是**新的宿主保留 key**。插件不要用这个 id。

### 5.3 主题自定义背景图片编辑器（宿主 UI 重写）

`ThemeCenter.vue` **-341/+172**（大幅重写），并抽出 5 个新文件：

| 新文件 | 行数 | 作用 |
| --- | --- | --- |
| `theme/ThemeImage.vue` | 43 | 背景图渲染 —— **有 `crop` 时用 `<svg viewBox>` 裁切**，否则退回 CSS background |
| `theme/ThemeImageCropper.vue` | **349** | 裁剪交互（四角手柄 nw/ne/se/sw、拖动、缩放） |
| `theme/ThemeImageEditor.vue` | **307** | 编辑器外壳（viewport、重置、取消、应用） |
| `theme/imageCrop.ts` | 131 | `backgroundCropLayout` / `backgroundCropStage` / `moveBackgroundCrop` / `resizeBackgroundCrop` |
| `theme/imageStyle.ts` | 40 | `customBackgroundImageStyle` |

`theme/model.ts` +43：**`ThemeOverride['background']` 新增 `crop` 字段**，与既有的
`positionX` / `positionY` / `fit` / `zoom` / `textColor` / `shade` / `panelOpacity` 并列：

```js
const customBackgroundHasAdjustments = computed(() => {
  const defaults = defaultOverride().background;
  return (['positionX','positionY','fit','zoom','crop','textColor','shade','panelOpacity'] as const)
    .some((key) => customBackground.value[key] !== defaults[key]);
});
```

**⚠️ 对 `ctx.theme` 的影响**：**注册契约没变**（已逐字核验）。变的是**宿主自己的「自定义图片皮肤」**——
它属于 `host:custom`，按官方文档「不单独作为主题分类、不属于主题包目录」，**插件主题拿不到这条路径**。
但要注意：`ctx.theme.useTheme()` 拿到的 `appearance.background` 现在**可能携带 `crop`**，
如果你的主题插件的装饰组件要渲染背景图，可以考虑支持它（不处理也不会出错，只是忽略裁切信息）。

### 5.4 歌词颜色跟随封面 + Mini 歌词设置

新增 `src/shared/lyricColor.ts`（+18）、`src/renderer/views/settings/components/MiniLyricSettingsSection.vue`（**+264 新增**），
`MiniLyricPanel.vue` +43 / `desktopLyric/sync.ts` +9 / `main/desktopLyric.ts` +15。

`stores/setting.ts` 新增一批键：

```js
miniLyricFollowCoverColor: false,
miniLyricUnplayedFollowCoverColor: false,
miniLyricPlayedColor: '',  miniLyricUnplayedColor: '',
miniLyricFontSize, miniLyricSecondaryFontSize, miniLyricFontWeight,
miniLyricAlignment, miniLyricLineGap, miniLyricBackgroundBlur,   // 来自 DEFAULT_MINI_LYRIC_STYLE
```

**⚠️ 对插件的影响**：声明了 `runtime.miniPlayer` 的插件，其 Mini 窗口的**外观现在会被封面主色影响**。
如果插件在自己的 Mini 组件里硬编码了颜色，会和宿主其他 Mini 元素产生色差。
`ctx.nowPlaying.getSnapshot().appearance.accentColor` 仍是最可靠的跟随来源。

### 5.5 播放页流体背景重写

`fluidBackgroundRenderer.ts`（**+395 新增**）+ `LyricFluidBackground.vue`（-258/+187），
对应 release notes 的「优化播放页背景律动性能」。**宿主内部渲染，与 `ctx.graphics` 无关**。

---

## 六、⚠️ 影响清单（按"插件会不会踩"排序）

| # | 变更 | 类型 | 本仓库命中 | 处方 |
| --- | --- | --- | --- | --- |
| 1 | 首页路由 `/main/home` → `/main` | 🔴 **硬失效**（跳转 404/无页） | **0** | 用 `/main`；不要假设"首页永远是推荐页" |
| 2 | 侧栏快捷卡片「必留」规则取消，改为「至少 1 张」，第一张 = 首页 | 🟠 语义变化 | **0**（无插件注册卡片） | 别用 `'home'`/`'explore'` 作 id；`order` 不覆盖用户顺序 |
| 3 | 插件 `activate()` 会阻塞首页解析（若是第一张卡片） | 🟠 性能契约 | — | `activate()` 里禁止同步重活 |
| 4 | 新音质 `viper_clear` / `viper_atmos` | 🟠 能力面扩张 | **`song-downloader` 未支持** | 扩 `QUALITY_LADDER` / 标签 / 匹配与码率表 |
| 5 | VIP 模型重构（`su_vip_end_time`、super/deluxe/concept/music） | 🟠 语义变化 | `kugou-daily-vip` 打分表未含超级VIP | 打分表补超级VIP；展示文案对齐新命名 |
| 6 | 多账号切换 + `userSessionSources` | 🟠 语义变化 | `kugou-daily-vip` 落盘键未含 userid | 「每天一次」类落盘键**必须含 userid**；监听 `accountRevision` |
| 7 | 新保留 key `free-listen` | 🟡 命名冲突 | 0 | 不要用这个 id |
| 8 | Mini 歌词颜色跟随封面 + 10 个新设置键 | 🟡 外观 | 0（无插件声明 miniPlayer） | 别硬编码 Mini 颜色 |
| 9 | `resolveThemeColors` 增 `surfaceDark` | 🟡 可选入参 | 0 | 主题包无需改；知道宿主会按图片明暗定表面 |
| 10 | `ThemeOverride.background.crop` 新增 | 🟡 数据面 | 0 | 主题装饰组件可选支持 |
| 11 | `viperTapeQualityEnabled` → `viperQualityEnabled` | 🟡 设置键重命名 | 0 | 插件读宿主设置时注意 |

> **注意 4 与 5 的差别**：4 是"宿主变强了、插件没跟上"（功能缺口），5 是"宿主改了语义、插件可能挑错数据"。
> 后者更危险，因为它**不报错**。

---

## 七、本仓库自查结果（2026-10-10）

以 `!**/.workbuddy/**` 过滤后逐项检索 7 个插件：

| 检索项 | 命中 | 结论 |
| --- | --- | --- |
| `/main/home` | **0** | ✅ 路由变更不影响本仓库 |
| `'home'`（作为快捷键 key） | **0** | ✅ 无保留 key 冲突 |
| `viper_clear` / `viper_atmos` | **0** | 🟠 `song-downloader` 缺这 2 档音质 |
| `su_vip_end_time` | **0** | 🟠 `kugou-daily-vip` 打分表未考虑超级VIP |
| `savedAccounts` | **0** | — 宿主内部概念，插件无需直接读 |
| `busi_vip` | 仅 `kugou-daily-vip` + 其测试 | ✅ 读的是**自己调 `/user/vip/detail` 的上游载荷**，不是宿主 store，宿主重构不改变它的输入 |

**净结论：beta.8 / beta.9 对本仓库 7 个插件「零硬破坏」，两处功能缺口可选跟进。**

---

## 八、行动项

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| **P1** | `kugou-daily-vip` 落盘键加 userid | 多账号下「今天已领」会串号。这是**数据正确性**问题，优先于功能 |
| **P2** | `kugou-daily-vip` 打分表补超级VIP | `su_vip_end_time` 缺失时展示条目可能与宿主徽章不一致 |
| **P2** | `song-downloader` 扩音质梯度 | 加 `viper_clear`（蝰蛇超清）/ `viper_atmos`（蝰蛇全景声）的标签、码率与匹配分支 |
| **P3** | 评估"插件卡片当首页"的产品价值 | beta.8 起可行。若某个插件有"每日入口"属性（如 `kugou-daily-vip`），做一张快捷卡片并提示用户拖到第一位 |
| **P3** | 检查 `activate()` 是否有同步重活 | 见 §4.3。可在首次注册前埋 `performance.now()` 打点自测 |
| **—** | 其余 5 个插件 | 无需改动 |

---

## 九、方法附录

### 9.1 用 `gh` CLI 取 compare + patch（本轮升级）

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # ← 不设这行中文会变 GBK 乱码
$env:HTTP_PROXY=""; $env:HTTPS_PROXY=""
$gh = "C:\Program Files\GitHub CLI\gh.exe"
$j = (((& $gh api "repos/hoowhoami/EchoMusic/compare/v2.3.2-beta.7...v2.3.2-beta.8" 2>&1) -join "`n")) | ConvertFrom-Json
$j.total_commits; $j.files.Count
$j.commits | ForEach-Object { $_.sha.Substring(0,7) + " | " + $_.commit.message.Split("`n")[0] }
# 逐文件 patch（小版本才有；大版本会被省略成 +0/-0）
$j.files | Where-Object { $_.filename -match 'plugin|sidebar|theme' } | ForEach-Object { $_.filename; $_.patch }
```

三个**必须知道**的坑：

1. **`gh` 不在 bash 沙箱的 PATH 里**，但确实装着 → 全路径 `C:\Program Files\GitHub CLI\gh.exe`（已认证，5000 次/小时）。
2. **未认证的 `WebClient` 调 api.github.com 会 403**（60 次/小时很快用光）；`gh api` 走认证不受影响。
3. **`ConvertFrom-Json` 必须先把 `gh` 的输出 `-join "`n"`**，否则拿到的是**行数组**，解析出来所有字段都是空 ——
   本轮第一次跑就是这样，`total_commits=` 空白、`files=0`，看起来像"compare 失败"，实际是解析姿势错了。

### 9.2 中文编码

PowerShell 子进程输出按控制台代码页解码。**`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 是前提**，
否则 `gh` 的中文（release notes、commit message）会变成 `鏂板` 这类乱码，且 `Out-File -Encoding utf8` 救不回来
（乱码在解码那一刻就已经产生了）。

### 9.3 判断"是否新增插件 API"的三步核验（本轮再次验证有效）

1. **能力门禁文案去重** —— 搜 `插件未声明`，比对项数；
2. **`createPluginContext` 返回对象** —— 搜 `createPluginContext`，往回取 ~2400 字符，读返回键表；
3. **关键 API 的校验分支** —— 搜该 API 的报错文案（如 `主题需要 id` / `快捷卡片需要`），对比分支是否变化。

三步全绿 = "没有新 API、没有破坏性变更"，可以下结论。

---

## 十、结论摘要

1. **beta.8 / beta.9 都没有新增插件 API**：能力清单 16 项不变、`createPluginContext` 键表逐字未变、
   `ctx.theme` / `sidebar.shortcuts` / `playerbar` / `addSongContextMenuItem` 契约全部未变 →
   **按 beta.7 写的插件在 beta.9 上零适配可跑**；
2. **beta.8 有两处语义变化要记牢**：首页路由 `/main/home` → `/main`；侧栏快捷卡片**取消必留规则**，
   改为「至少保留一张」，且**第一张卡就是首页**（插件卡片可当首页）；
3. **beta.8 引入了一个性能契约**：`waitForPluginRuntimeReady()` 让 `activate()` 的耗时会**阻塞应用首页解析**；
4. **beta.9 让登录态变成多源会话**（多账号切换），"每天一次"类的落盘键**必须含 userid**——
   这是本轮唯一一条 P1；
5. 宿主能力面新增 **2 档蝰蛇音质**与**超级VIP/豪华VIP**，本仓库 `song-downloader` 与 `kugou-daily-vip`
   各有一处功能缺口（P2）；
6. **Release Notes 第四次被验证是累积的**（beta.9 的 23 条「新增」里 19 条是旧的），
   增量判断继续走「commit 列表定范围 + 逐文件 patch 定内容」；
7. 小版本（7 提交 / 150 文件）的 compare **能拿到逐文件 patch**，是大版本做不了深度分析时的重要补充。
