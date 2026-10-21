# EchoMusic v2.3.2-beta.16 / beta.17 技术分析

> 结论先行：**两版都没有新增插件 API**（能力 17 项、121 个插件 IPC 通道、`createPluginContext` 工厂实参全部未变）。
> 但 **beta.17 修了一个只影响「插件浮窗」的静默故障**：`plugin-window.html` 的 CSP 没放行内嵌封面协议
> `echo-player-cover:`，导致浮窗里的内嵌封面**被静默拦截（空白、无报错、无日志）**。
> beta.16 则把「播放时读取内嵌元数据 + 歌词体系」大改了一轮，与插件无关但解释了那个协议从哪来。
> ⚠️ **beta.17 的 Release Notes 与 beta.16 逐字相同** —— 连续第二次出现「Notes 不更新」。

分析时间：2026-10-19　分析对象：`hoowhoami/EchoMusic` @ `v2.3.2-beta.16` / `v2.3.2-beta.17`
数据来源：本机实装 `2.3.2-beta.17`（`<REDACTED>`，10,056,070 B，mtime 2026-10-18 15:11）+ GitHub compare 与提交级 patch + asar 逐字核验
前序：[beta.12~15](EchoMusic-v2.3.2-beta.12-beta.15-技术分析.md) · [beta.10/beta.11](EchoMusic-v2.3.2-beta.10-beta.11-技术分析.md) · [插件系统与加速链路调研](EchoMusic-插件系统与加速链路调研.md)

---

## 一、版本元数据

| 项 | beta.16 | beta.17 |
| --- | --- | --- |
| 发布时间（UTC） | 2026-10-16 15:57 | 2026-10-18 07:18 |
| 北京时间 | 10-16 23:57 | 10-18 15:18 |
| 提交数 | **7** | **7** |
| 变更文件 | 80（`src` 32 / `tests` 28 / `native` 16） | 20（`src` 8 / `tests` 6） |
| 距上一版 | ~40 h | ~39 h |

两版都是**常规小版本**（各 7 提交）。beta.16 的 16 个 `native` 文件是内嵌元数据解析与 opencc 词典；
beta.17 只有 20 个文件，是一次精准修补。

---

## 二、⚠️ Notes 连续第二次「不更新」

| 版本 | `total_commits` | 自己的 Release Notes | 实际情况 |
| --- | --- | --- | --- |
| beta.14 | **1** | 与 beta.13 **逐字相同** | 几乎空版本 |
| beta.16 | 7 | 正常（新增内嵌元数据、歌词搜索） | 正常 |
| **beta.17** | **7** | **与 beta.16 逐字相同** | 有 7 个提交、20 个文件，含一个真实修复 |

beta.17 隔了 **39 小时**、有 7 个提交（含 CSP 修复、`stream api`、双行同时间戳歌词），
但它的 Notes 一个字的差别都没有 —— 连「2.3.2-beta.17」这个标题都没在 Notes 里体现。

> 唯一能看出 beta.17 存在的痕迹是 **`package.json` / `CHANGELOG.md` 的版本号替换**（见提交 `c4e9a01` 的 patch）。
> → 再次确认：**Notes 完全不可用于判断增量**，`total_commits` + commit 列表是唯一路径。

---

## 三、✅ 四步核验：没有新增插件 API

| 核验项 | 结果 |
| --- | --- |
| 能力门禁文案 | **17 条**，与 beta.15 逐字相同 |
| 插件 IPC 通道 | **121 个**，无新增 |
| `createPluginContext` 工厂实参 | **未变**：`fs:C(n.id,y)` / `net:E(n,v,y)` / `ui:pe(n.id,o,v,_,h,capabilities)` / `theme:d(n.id,v,h,capabilities?.theme===!0)` |
| 插件朝向新文件 | 无 |

> 注：beta.17 里 JS 变量名有重排（`ui:pe(...,m,...)` → `ui:pe(...,h,...)`），
> 但**实参个数与形态完全一致** —— 只有形参名变了，属于构建器重命名的噪声。
> 判断时看**实参形态**，不要看变量名。

---

## 四、⭐ beta.17：插件浮窗的 CSP 放行内嵌封面协议（唯一的插件相关变更）

提交 `6f158f7 fix: 任务栏歌词与插件窗口的 CSP 放行内嵌封面协议`（3 个文件）。

### 4.1 改了什么（源码与构建产物双向确认）

```diff
- img-src 'self' data: file: http: https:;
+ img-src 'self' data: file: http: https: echo-player-cover:;
```
（`plugin-window.html`；`taskbar-player.html` 同步加，它的 `default-src 'self'` 更严）

源码里留了注释说明后果：

> `img-src` 里的 `echo-player-cover:` 是内嵌封面协议（见 `src/main/player/embeddedMetadata.ts`），
> **去掉后内嵌封面会被 CSP 静默拦截，表现为封面空白且无任何报错。**

配套新增测试 `tests/window-csp-image-schemes.test.mjs`，断言「所有带 CSP 的入口页面都必须在 `img-src` 里放行该协议」，
并且**额外加了两条"防止测试空跑"的断言**（找不到 `taskbar-player.html` 就失败、CSP 解析不出 `img-src` 就失败）——
这个测试写法值得学。

### 4.2 `echo-player-cover:` 协议的真实形态（asar 逐字核验）

```js
scheme  = 'echo-player-cover'
url     = `echo-player-cover://artwork/${sha256}.${ext}`   // host 必须是 'artwork'
允许扩展 = /^[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/           // 64 位小写 hex + 图片扩展名
允许 query = 仅 ?v=<1~20 位数字>（缓存击穿用，等于 createdAt 毫秒）
禁止      = hash 片段、非 artwork host、其它扩展名
单文件上限 = 8 MiB
魔数校验   = JPEG(FF D8 FF) / PNG / GIF87a|GIF89a / RIFF+WEBP
```

宿主内部还有一个封面加载器：**若 URL 以 `echo-player-cover:` 开头，就走本地协议读文件；否则走网络（5 s 超时）**。

> **一个值得记的推论**：宿主判断"这首歌还缺封面"的函数里，**形如 `echo-player-cover:` 的封面仍被算作「缺」**
> （`cover: !(url) || url.startsWith('echo-player-cover:')`）。
> 也就是说**内嵌封面是"兜底"，不是"首选"** —— 这解释了它为什么只用来补全缺失字段。

### 4.3 影响面：只有「浮窗」，插件页不受限

| 载体 | 是否有 CSP | 受此 bug 影响 |
| --- | --- | --- |
| 插件页面（走主窗口 `index.html`） | **无 CSP** | ❌ 不受影响 |
| 插件浮窗（`contributes.windows` → `plugin-window.html`） | 有 | ✅ **beta.17 之前会被静默拦截** |
| 任务栏歌词（`taskbar-player.html`） | 有（更严：`connect-src 'none'`） | 宿主自己修了 |

**典型症状**：插件浮窗里 `<img :src="snapshot.playback.coverUrl">`，某些歌封面空白、**控制台没有任何报错**。
命中条件：这首歌的元数据来自**内嵌标签**（beta.16 新增的能力），于是 `coverUrl` 是 `echo-player-cover://…` 形态。

### 4.4 本仓库影响：**0 命中**

7 个插件的 `manifest.json` 全部只写 `runtime: { miniPlayer: false, desktopLyric: false }`，
**没有任何插件声明 `contributes.windows`**（即没有插件有浮窗）。

→ **本仓库无需改动**。但这条对**将来做浮窗插件**（如桌面歌词外挂、灵动岛）是必要知识，
已写进技能 `14-extension-apis.md` 的浮窗一节。

---

## 五、beta.16：内嵌元数据 + 歌词体系大改（与插件无关，但解释了协议来源）

7 个提交，主体是 `36a8089 feat: embedded metadata & lyric`。

### 5.1 播放时读取内嵌信息

| 层 | 文件 |
| --- | --- |
| native 解析 | `native/echo-audio-player/src/embedded_metadata.rs`（**+217 新增**）、`decoder.rs` / `lib.rs` / `shared/types.rs`；`vendor/ffmpeg-audio` +5 |
| main | `src/main/player/embeddedMetadata.ts`（+45）—— **注册 `echo-player-cover:` 协议** |
| shared | `src/shared/embeddedMetadata.ts`（+29） |
| renderer | `src/renderer/stores/player/embeddedMetadata.ts`（+138） |

**能力**：播放时读取内嵌标签，补全缺失的**歌名 / 歌手 / 专辑 / 封面**，并支持**内嵌歌词候选**。
这直接解释了 §四 那个协议的来源 —— 它是 beta.16 才有的东西，所以 CSP 漏放行也是 beta.16 埋下、beta.17 才修。

### 5.2 歌词体系

- **`LyricSourceDialog.vue` +553/-269**：歌词选择弹窗新增**手动搜索**（可改歌名/歌手去查），并**为当前歌曲记住所选版本**；
  配套测试 `lyric-source-search.test.mjs` **+1435 行**（大得异常，说明交互分支极多）。
- **`src/renderer/stores/lyric.ts` +245/-97**：歌词 store 重构。
- **新增「异体繁体」**：`native/echo-opencc/dicts/TWVariantsRev.txt` / `TWVariantsRevPhrases.txt`（+1154）→
  简繁转换从 5 档变 6 档（原文 / 简体 / 繁体 / **异体繁体** / 台湾正体 / 香港繁体）。
- beta.17 续：`5c8bed2 feat: 支持内嵌歌词的「双行同时间戳」格式`（`src/shared/lyrics.ts` +24）、
  `2ae6a5f fix: 非逐字歌词在所有歌词表面整行直显`。

### 5.3 对话框相关（顺手修掉的真机问题）

`5793066 fix: dialog close` → **云盘上传 / 歌单导入过程中，点弹窗外、点关闭或按 Esc 后界面无法操作**。
涉及 `CloudUploadDialog.vue` / `ImportPlaylistDialog.vue`，新增 `import-dialog-lifecycle.test.mjs`。

> 这对本仓库的启示：**弹层类 UI 的"关闭后界面卡死"是这一类组件的通病**（遮罩/焦点/滚动锁没释放）。
> 插件自己做弹层时要显式清理这三样（技能 `30#UI-03`）。

---

## 六、内置酷狗服务子模块升级（可能影响 `kugou-*` 插件）

`c4e9a01 feat: update stream api` 的**真实内容**是 `server` 子模块指针前移：

```diff
-Subproject commit ba3645f2c89e6b9d4fec82ff783c15287e4c5f43
+Subproject commit 514f870db7e60ca37bc5535be5da36d32b571c6f
```

（同提交里还有 `package.json` / `CHANGELOG.md` 的版本号替换和 `.gitignore` 加 `.agentsroom`，
所以**提交标题里的 "stream api" 并不是插件 API**，别被误导。）

**本机核验**：内置路由模块现有 **236 个**（技能历史上记的是约 225，**增长了约 11 个**）。

**本仓库用到的 18 个路由模块逐个确认仍在**：

```
user_detail  user_vip_detail  youth_listen_song  youth_vip  youth_day_vip
everyday_recommend  everyday_style_recommend  everyday_history  personal_fm
ai_recommend_song  top_song  user_history  privilege_lite  song_url
playlist_tracks_add  user_playlist  search  fm_class
```

→ **本仓库 4 个走本地路由的插件（`kugou-daily-vip` / `kugou-recommend` / `playlist-importer` / `song-downloader`）
不受子模块升级影响**（至少路由名未变）。但**新增的 11 个模块值得后续扫一遍**——
它们可能带来新的推荐源/活动接口（详见技能 `20-kugou-routes.md` 的更新方式）。

---

## 七、本仓库影响与行动项

| 优先级 | 事项 |
| --- | --- |
| **P2**（新增） | 若将来做浮窗插件：浮窗里渲染封面要确认 `coverUrl` 是不是 `echo-player-cover:`，且**要求宿主 `>=2.3.2-beta.17`**（否则静默空白） |
| **P3**（新增） | 扫一遍新增的 ~11 个酷狗本地路由模块，看有没有能用的新推荐源/活动接口 |
| **—** | 本仓库 7 个插件**零改动**：无浮窗、18 个路由全在、无新 API |
| **P1**（沿用） | `song-downloader` 迁移 `ctx.fs.requestDirectory` + `ctx.net.download` |
| **P1**（沿用） | `kugou-daily-vip` 落盘键加 userid |
| **P1**（沿用） | 6 个插件的失效 CSS 变量替换 |
| **P1**（沿用） | 清掉 `playlist-importer` 的 `ctx.log` 死代码 |

---

## 八、方法附录

### 8.1 「提交标题会骗人」——`feat: update stream api`

`c4e9a01 feat: update stream api` 听起来像插件流式 API 变更，实际只是**子模块指针 + 版本号**。
**判断方法**：`gh api repos/.../commits/<sha>` 看 `files` 列表 —— 只有 4 个文件，且没有一行 API 实现。

→ 与 beta.7 的教训互补：**commit 列表定范围，提交级 patch 定内容，asar 检索定"到底有没有"**。
三步缺一不可 —— 只看标题会被"stream api"误导，只看 Notes 会以为两版一样。

### 8.2 静默失败类问题的排查姿势

本条 CSP 修复的注释值得当作模板：

> 去掉后内嵌封面会被 CSP 静默拦截，**表现为封面空白且无任何报错**。

**「有效果缺失但零报错」时，优先怀疑三件事**：CSP / 协议白名单 / 权限门禁。
它们的共同点是**在请求层被拦，不产生任何 JS 异常**。插件侧遇到同类症状（图片空白、`fetch` 静默失败）
也要先看宿主入口的 CSP 与自定义协议白名单。

### 8.3 测试写法可借鉴

`tests/window-csp-image-schemes.test.mjs` 有三条断言，其中两条是**元断言**（防止测试空跑）：

```js
test('入口 HTML 至少有被检查的那几个，避免读取目录的方式失效导致空跑', …)
test('CSP 解析本身可用（防止上面的断言因解析错误而空过）', …)
```

→ 这与技能 `50#TST-04`（变异测试）是同一个思路：**先证明"测试会红"，再相信"测试是绿的"**。

---

## 九、结论摘要

1. **beta.16 / beta.17 都没有新增插件 API**：能力 17 项、121 个 IPC 通道、`createPluginContext` 工厂实参全部未变；
2. **beta.17 唯一影响插件的变更**：`plugin-window.html` 的 CSP 放行内嵌封面协议 `echo-player-cover:`。
   之前浮窗里的内嵌封面**被静默拦截（空白、无报错）**；**插件页面不受影响**（主窗口 `index.html` 无 CSP）；
3. `echo-player-cover:` 的真实形态：`//artwork/<64位sha256>.<jpg|png|webp|gif>`，仅允许 `?v=<数字>`，
   禁 hash 与其它扩展名，单文件 ≤ 8 MiB，魔数校验；**内嵌封面在宿主判定里仍算"缺封面"**（是兜底不是首选）；
4. **本仓库 0 命中**：7 个插件都没有 `contributes.windows`，无需改动；但对将来的浮窗插件是必要知识；
5. **beta.16 是内嵌元数据与歌词体系的大改**（native 解析 +217 行、歌词弹窗 +553/-269、新增「异体繁体」6 档简繁），
   与插件无关，但**解释了那个协议的来源**；
6. **内置酷狗服务子模块升级**（`server` → `514f870`），模块从约 225 增至 **236**；
   本仓库用到的 **18 个路由模块全部仍在**，无破坏，但新增的约 11 个模块值得后续扫一遍；
7. ⚠️ **beta.17 的 Notes 与 beta.16 逐字相同**（连续第二次），`total_commits` 仍是唯一可靠的量级指标。
