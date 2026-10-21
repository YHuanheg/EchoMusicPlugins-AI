# EchoMusic v2.3.2-beta.18 / beta.19 技术分析

> 结论先行：**这两版对插件零影响，且体量极小 —— 本文件刻意写短。**
> beta.18 = 5 提交 / 12 文件（macOS 托盘置前 + 托盘显示当前曲目）；
> beta.19 = **5 提交 / 5 文件**，`src` 里**只改了 1 个文件**（`stores/lyric.ts` +9/-4）。
> 四步核验全绿：能力 17 项、121 个插件 IPC 通道、`createPluginContext` 工厂实参、插件管理页 DOM 契约、内置模块 236 个 —— **全部与 beta.17 一致**。

分析时间：2026-10-21　分析对象：`hoowhoami/EchoMusic` @ `v2.3.2-beta.18` / `v2.3.2-beta.19`
数据来源：本机实装 `2.3.2-beta.19`（`<REDACTED>`，10,056,709 B，mtime 2026-10-21 20:36）+ GitHub compare 与提交级 patch + asar 四步核验
前序：[beta.16/17](EchoMusic-v2.3.2-beta.16-beta.17-技术分析.md) · [beta.12~15](EchoMusic-v2.3.2-beta.12-beta.15-技术分析.md) · [插件系统与加速链路调研](EchoMusic-插件系统与加速链路调研.md)

---

## 一、为什么这份文档短

按技能 `11#CAP-12` 的档位（1~5 提交 = 修补版，看提交信息就能收工），这两版**都落在"修补版"区间**：

| 版本 | `total_commits` | 文件数 | `src` 实际改动 |
| --- | --- | --- | --- |
| beta.18 | 5 | 12 | 4 个（`main/tray.ts` / `main/ipc/tray.ts` / `main/window/index.ts` / `shared/tray.ts`）+ `Sidebar.vue` 1 行 |
| beta.19 | 5 | **5** | **1 个**（`stores/lyric.ts` +9/-4） |

把 17 个文件硬撑成一份 9 节分析是夸大 —— 该记的只有"确认没有影响"这件事和两处可复用的观察。

---

## 二、版本元数据

| 项 | beta.18 | beta.19 |
| --- | --- | --- |
| 发布时间（UTC） | 2026-10-20 04:05 | 2026-10-21 12:42 |
| 北京时间 | 10-20 12:05 | 10-21 20:42 |
| 提交数 | 5 | 5 |
| 变更文件 | 12 | 5 |
| 距上一版 | ~37 h | ~33 h |

本机实装 **beta.19**；asar 从 beta.17 的 10,056,070 B 只长了 **639 B**。

### beta.18 的 5 个提交

```
1063787  fix(macOS): 托盘唤起窗口时激活应用，使窗口能置到最前
e6648fb  feat(tray): 托盘菜单顶部显示当前曲目「歌名 - 歌手」
e5bdf54  Merge pull request #490 from devpenn/fix/macos-tray-window-frontmost
27e9f29  fix: macos window front most
3aa1124  fix: macos window front most
```

### beta.19 的 5 个提交

```
faa73d0  fix(lyrics): preserve unpaired lines across embedded LRC gaps
fb4e3fb  Merge pull request #491 from HDTHDT/fix/embedded-lyric-pairing-gaps
c159405  fix: lyric
3d60883  fix: switch style
cad5b8a  fix: switch style
```

---

## 三、✅ 四步核验：零插件影响

| 核验项 | beta.19 实测 | 与 beta.17 对比 |
| --- | --- | --- |
| 能力门禁文案 | **17 条** | 完全一致 |
| `plugins:*` IPC 通道 | **121 个** | 完全一致 |
| `createPluginContext` 工厂实参 | `fs:C(n.id,y)` / `net:E(n,v,y)` / `ui:pe(n.id,o,v,_,h,capabilities)` / `theme:d(n.id,v,h,capabilities?.theme===!0)` / `sqlite:O(n,v)` | 完全一致 |
| 插件管理页 DOM 契约 | `plugin-card-grid` 4 / `marketplace-toolbar` 2 / `plugin-content-heading` 5 / `plugin-empty-state` 3 / `marketplace-card` 6 / `plugin-card-actions` 5 | 完全一致 |
| 内置酷狗模块 | **236** | 完全一致 |
| 关键协议与日志 | `echo-player-cover` / `echo-plugin-media` / `[PluginResources]` / `[DialogHost]` 均在 | 完全一致 |

**→ 本仓库 7 个插件无需任何改动。**

---

## 四、⚠️ Release Notes：第七、八次确认「累积」，这次是"加一条"式

两版的 Notes 差异**只有两条新增行**：

| 条目 | beta.17 | beta.18 | beta.19 |
| --- | --- | --- | --- |
| 修复 macOS 托盘唤起窗口不能置到最前 | — | ✅ **新增** | 重复 |
| 修复开关样式开启/关闭边距不对称 | — | — | ✅ **新增** |
| 其余 28 条「新增」+ 27 条「优化」+ 27 条「修复」 | 重复 | 重复 | 重复 |

要点：

- **维护方式是"在滚动快照顶部追加一条"**，不是"每版重写"。所以**条目数只增不减**，
  永远无法从 Notes 反推某一版改了什么；
- beta.18 的 Notes 里 **5 个提交只体现了 1 条**（托盘置前），另一条实质改动（托盘显示当前曲目）没写；
- beta.19 的 Notes 里 **5 个提交只体现了 1 条**（开关样式），真正的逻辑修复（内嵌 LRC 配对）**没写**。

→ **`total_commits` + commit 列表仍是唯一可靠路径。** 这已经是连续第八个版本验证同一结论。

---

## 五、顺带两条可复用的观察

### 5.1 内嵌 LRC「双行同时间戳」的配对检测陷阱（beta.19 修的真问题）

beta.17 引入了内嵌歌词的「双行同时间戳」格式（原词 + 译文共享时间戳）。检测这种格式时，
`hasPairedTimestampLayout` 用一个 `pending` 变量记住"待配对的上一行"，并统计 `unpaired` 判断是否真的是这种格式。
**旧实现有两个错**：

```diff
-    if (!match) continue;            // 空行/元信息/KRC 行：直接跳过，pending 还留着
+    if (!match) { pending = null; continue; }   // ← 这类行同样打断"相邻性"

-    if (pending) unpaired += 1;
-    pending = current;
-  }
-  if (pending) unpaired += 1;
+    pending = current;
+  }
+  // 每个成功配对恰好消费两行 —— 直接算，不靠自增
+  const unpaired = entries - pairs * 2;
```

**症状**：内嵌 LRC 里有空隙（空行 / `[ar:Artist]` 元信息 / KRC 行）时，
**不成对的原词行会被当成译文吞掉，整行歌词凭空消失**；或者反过来，两对"巧合配对"让
8 行独唱被误判成"这是带译文的格式"，界面上冒出不该有的译文。

**这条的普适价值**：**"用计数器累加"在带状态机的解析里极易漏计/多计**。
改成"由守恒量推导"（`总数 - 配对消耗 = 未配对`）就不可能出现不自洽 —— 与技能
`40#ENG-10` 的"双函数写法"是同一类思路：**能算出来的就不要维护计数**。

测试也补得很扎实：新增了 `"timed empty lines"` / 4 种分隔符（空串、空格、`[ar:]`、KRC 行）/
`"blank separator preserves both original lines"` 等用例 —— 全是围绕"空隙"的边界。

> 与插件的关系：**没有直接关系**（`ctx.lyrics` 是宿主内部管道），
> 但如果你在插件里自己解析 LRC（`kugou-recommend` 之类不涉及），这个坑同样适用。

### 5.2 宿主 Switch 组件的 `translate-x` 用 px 而非 space 单位

```diff
- @apply data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-1;
+ @apply data-[state=checked]:translate-x-[22px] data-[state=unchecked]:translate-x-1;
```

`translate-x-5` 在 Tailwind 里是 `calc(var(--spacing) * 5)`，被宿主自己的间距体系影响；
改成硬编码 `22px` 后开关两端的边距才左右对称。

**与插件的关系**：只有用 `ctx.ui.components.Switch` 的插件会看到这个视觉变化（本仓库 **0 个插件**用它，
都按技能 `30#UI-06` 自己做 `role="switch"`）。**不是 breaking change，纯视觉**。

---

## 六、行动项

| 优先级 | 事项 |
| --- | --- |
| **—** | 本仓库 7 个插件**本区间零改动**（无新 API、无能力变更、DOM 契约未变） |
| **P1**（沿用） | `song-downloader` 迁移 `ctx.fs.requestDirectory` + `ctx.net.download` |
| **P1**（沿用） | `kugou-daily-vip` 「每天一次」落盘键加 userid |
| **P1**（沿用） | 6 个插件的 `--color-warning` / `--color-border` / `--color-bg-primary` 换成新变量 |
| **P1**（沿用） | 清掉 `playlist-importer/index.js:2386` 的 `ctx.log` 死代码 |
| **P3**（沿用） | 扫一遍内置酷狗新增的约 11 个路由模块 |

---

## 七、方法附录：什么时候该"轻量收工"

技能 `11#CAP-12` 附节给的档位在这两版上正好用上了：

| `total_commits` | 动作 | 本次 |
| --- | --- | --- |
| 1 ~ 5 | 看提交信息就够；**只跑 asar 四步核验确认无 API 变化**，不逐个读 patch | ✅ beta.18 / beta.19 |
| 6 ~ 30 | commit 列表 + 过滤出插件相关文件的 patch + 四步核验 | beta.16 / beta.17 |
| 30+ | commit 列表 + 本机 asar 检索（patch 会大量缺失） | beta.7 / beta.13 |

轻量路径下仍然**完整执行了四步核验**（能力文案 / 工厂实参 / IPC 通道数 / DOM 契约计数），
因为"体量小"不等于"不影响插件" —— beta.13 用了 193 个文件，反而是体量最大的一版里 DOM 契约最容易破。
**体量只决定读多少 patch，不决定要不要核验。**

---

## 八、结论摘要

1. **beta.18 / beta.19 对插件零影响**：能力 17 项、121 个 IPC 通道、工厂实参、插件管理页 DOM 契约、
   内置模块 236 个 —— 与 beta.17 逐项一致；本仓库 7 个插件无需改动；
2. beta.18 的实质内容只有两条：**macOS 托盘唤起居前**、**托盘菜单顶部显示当前曲目「歌名 - 歌手」**；
3. beta.19 的实质内容只有两条：**内嵌 LRC 配对检测的空隙 bug**、**宿主 Switch 组件的边距对称**（纯视觉）；
4. Release Notes 已连续**第八次**确认是"滚动快照 + 顶部追加"，**条目只增不减**，且这两版各自只体现了 5 个提交里的 1 条；
5. 一条可复用的工程教训：**带状态机的解析里不要用自增计数器统计"未配对"**，
   改用守恒量推导（`总数 - 配对消耗`）—— 少一个变量就少一类不自洽；
6. 体量小只代表**该少读 patch**，不代表可以不核验 —— 四步核验在轻量路径下照做。
