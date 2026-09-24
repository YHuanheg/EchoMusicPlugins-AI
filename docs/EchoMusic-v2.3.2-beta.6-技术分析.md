# EchoMusic v2.3.2-beta.6 技术分析

> ⚠️ **本文是 `v2.3.2-beta.6` 时点的时间点快照**，用于留档当时的 asar 核验数据，**不再随宿主版本更新**。
> 现行事实以开发者的本地插件开发技能包为准；引用本文结论前请先核对宿主当前版本。
> 本文保留原样是为了留证据链（哪些结论是从哪次核验得来的），**不要在这里继续追加新发现**。


> 结论先行：**beta.6 对插件开发者只有一个真正的新增能力 —— 插件本地 WebSocket API**（复用既有 `ctx.webServer` 端口，靠 `onConnection` 接入）。
> 其余「新增」条目要么是 beta.5 就已交付（服务请求拦截 API、页面歌词换肤、浮窗播放 API 修复），要么与插件无关。
> **不要用 Release Notes 判断增量**：该项目的 beta 线 Notes 是**累积**的，beta.6 的 Notes 原样重复了 beta.5 的三条内容，详见 §三。
> **§十 的行动项已落地复核**：其中两条的前提经回代码核对并不成立，另有两个真实风险点已修（v1.2.0），详见 §十·补。

分析时间：2026-09-22　分析对象：`hoowhoami/EchoMusic` @ `v2.3.2-beta.6`
数据来源：本机实装 `2.3.2-beta.6`（`<REDACTED>`，9,160,009 B，mtime 2026-09-22 17:09）+ 官方插件文档 + GitHub API
配套文档：[插件系统与加速链路调研](EchoMusic-插件系统与加速链路调研.md)（上一版基线为 `2.3.2-beta.5`）

---

## 一、版本元数据（本机核验）

| 项 | 值 |
| --- | --- |
| tag | `v2.3.2-beta.6` |
| 发布类型 | 预发布（`prerelease: true`） |
| 发布时间 | 2026-09-22 09:12:47 UTC（北京时间 17:12） |
| 本机 exe `FileVersion` | `2.3.2-beta.6` |
| `ProductVersion` | `2.3.2.0` |
| 距上一版 | beta.5 = 2026-09-17 15:15 UTC，间隔约 5 天 |
| 提交数 | 19 |
| 产物 | Windows x64/arm64 Setup、macOS dmg/zip（x64/arm64）、Linux deb/rpm/AppImage/tar.gz/pkg.tar.zst + 4 个 `latest*.yml` |

> 注意 `FileVersion` 与 `ProductVersion` 不同：宿主内部做版本比对时用的是 `2.3.2-beta.6` 这种**带预发布标记**的形态，
> 且校验启用 `includePrerelease: true`（见 §六），所以 `requires.echoMusicVersion: ">=2.3.2-beta.6"` 这类约束是**精确生效**的。

---

## 二、一句话总览：beta.6 里"对插件有意义"的只有 4 件事

| # | 变更 | 类型 | 影响面 |
| --- | --- | --- | --- |
| 1 | **插件本地 WebSocket API** | 🆕 新能力 | 需要在同端口跑长连接的插件（硬件桥、外部控制端、实时联动） |
| 2 | **插件市场统计缓存与批量查询重写** | ⚙️ 内部重构 | **直接影响本仓库 `gh-accelerator`**（它挂在"在线插件"页上做进度推定） |
| 3 | **浮窗宽高限制调整**（去掉"不合理的最小/最大值"） | 🔧 行为修正 | 所有声明 `contributes.windows` 的浮窗插件 |
| 4 | 标题栏「更多」加入插件管理 / Windows 独立任务栏播控 | 🖥️ 宿主 UI | 插件无需改代码，但入口位置变了 |

其余 15 个提交（UI/style 重构、Electron 升级、评论页与私人 FM 优化、Tab 路由修复、音效切换修复、Native Addons CI）与插件系统无直接关系。

---

## 三、⚠️ 最大的坑：Release Notes 是累积的

把三版 Notes 并排看，问题立刻暴露：

| 条目 | beta.4 | beta.5 | beta.6 |
| --- | --- | --- | --- |
| 服务请求拦截插件 API | — | ✅ 新增 | ✅ **新增（重复）** |
| 页面歌词换肤功能 | — | ✅ 新增 | ✅ **新增（重复）** |
| 修复浮窗插件播放 API 缺失 | — | ✅ 修复 | ✅ **修复（重复）** |
| 插件本地 WebSocket API | — | — | ✅ 新增（真正属于 beta.6） |

beta.5 的 Notes 全文只有 4 条；beta.6 把其中的 3 条**原样搬了过来**，只在"新增"里插入了 4 条新内容。

**结论：判断"某版本新增了什么"必须用 `git compare` 或 commit 列表，不能读 Notes。**
本仓库 `README.md` 里的插件兼容性声明、以及 `requires.echoMusicVersion` 的下限，都应该以**实际提交**为准。

### beta.6 的 19 个提交（按时间序）

```
82df2e7  optimize: comment page & personal fm
507c9e6  fix: global error page
69d7132  feat: upgrade electron version
a7a33a5  feat: plugin websocket api              ← 本次唯一新插件能力
850539e  feat(windows): add standalone taskbar player and favorite controls
1a4a9d5  optimize: UI & style
b8036a5  optimize: UI & style
54e21fa  ci: 添加手动构建 Native Addons 的 GitHub Actions 流程
09a1372  ci: 更新 GitHub Actions 流程以优化 artifact 打包和上传逻辑
797d75a  fix: 修复 native addons 验证逻辑以确保文件计数正确
e9501a5  Merge pull request #431 from xiaotian2333/main
0d8f548  Merge branch 'main'
f381000  optimize: UI & style
7c2e2b5  fix(windows): reconcile taskbar creation after concurrent toggles
59568a3  fix: song effect switch
fdf21b3  Merge pull request #427 from HDTHDT/feat/windows-taskbar-player
ec1584e  Merge branch 'main'
e15c471  optimize: plugin marketplace stats      ← 影响 gh-accelerator
0285cd7  fix: tab router query
```

> 该版本的 `base_commit`（即 beta.5 标签所指）提交信息为 `feat: lyric page skin & server interceptor` —— 这从 git 层面二次确认了「服务请求拦截 + 歌词换肤」是 **beta.5** 的成果。

---

## 四、插件本地 WebSocket API（beta.6 唯一新能力）

### 4.1 一句话定位

**没有独立的 `ctx.websocket`。** WebSocket 由既有的 `ctx.webServer` 在**同一个 `127.0.0.1` 端口**上通过协议升级（upgrade）提供，插件拿到的是**普通 socket**，不是自定义帧格式或回调袋。

```js
export async function activate(ctx) {
  if (typeof ctx.webServer.listen !== "function") {
    throw new Error("请升级 EchoMusic 以使用 WebSocket 插件");
  }
  const result = await ctx.webServer.listen({
    path: "/live",
    onUpgrade: (request) =>
      request.protocols.includes("echo")
        ? { accept: true, protocol: "echo" }
        : false,
    onConnection(socket) {
      socket.onMessage(async ({ data }) => { await socket.send(data); });
      socket.onClose(({ code, reason }) => { console.log("closed", code, reason); });
      socket.onError((error) => { console.error(error); });
      void socket.send("ready");
    },
  });
  if (!result.ok) return;
}
```

能力声明沿用 `webServer`，**不需要**额外的 `tcp` 或 `unrestrictedNetwork`：

```json
{ "capabilities": { "webServer": true } }
```

**版本门槛必须写**（官方文档明确要求）：

```json
{ "requires": { "echoMusicVersion": ">=2.3.2-beta.6" } }
```

并在运行时做存在性探测 —— 这是必要的双保险，因为 `requires` 只能拦住"版本不满足"，拦不住"用户装了未声明版本约束的旧版"的情况。

### 4.2 `socket` 对象契约

| 成员 | 说明 |
| --- | --- |
| `connectionId` | 连接 id |
| `protocol` | 协商后的子协议，**可能为空字符串** |
| `url` / `path` / `query` / `headers` / `remoteAddress` | 升级请求信息 |
| `readyState` | `1` 打开，`3` 已关闭 |
| `send(data)` | 文本帧 / 二进制帧。字符串走文本；`ArrayBuffer` / `Uint8Array` / `{ type: "base64", data }` 走二进制 |
| `ping(data?)` | 发 ping；**pong 由宿主自动回，插件收不到 ping/pong 事件** |
| `close(code?, reason?)` | `code` 只允许 `1000` 或 `3000..4999` |
| `onMessage` / `onClose` / `onError` | 注册监听，**返回取消函数** |

事件载荷：`onMessage` → `{ data }`（文本为 `string`，二进制为 `ArrayBuffer`）；`onClose` → `{ code, reason }`；`onError` → `Error` 实例。

`onConnection(handler)` 的 `handler` **可以返回清理函数**，连接关闭或插件停用时由宿主调用（本机 asar 已核实：返回值被存进 `Map`，在 `onClose` 分支里 `?.()` 调用后删除）。

### 4.3 限制常量（本机 asar 逐字节核验，非文档推导）

从 `app.asar` 中提取到的真实常量：

```js
pm = '127.0.0.1'
mm = 2 * 1024 * 1024      // 2 MiB   HTTP 单次请求体上限
hm = 8 * 1024 * 1024      // 8 MiB   HTTP 单次响应体上限
gm = 15e3                 // 15 s    HTTP handler 超时
_m = 1e4                  // 10 s    升级请求必须被插件裁决的时限
vm = 16                   // 默认 maxConnections
ym = 64                   // maxConnections 上限
bm = 1 * 1024 * 1024      // 默认 maxMessageBytes = 1 MiB
xm = 8 * 1024 * 1024      // maxMessageBytes 上限
Sm = 32 * 1024 * 1024     // maxBufferedBytes 上限
```

| 参数 | 默认 | 允许区间 | 越界报错 |
| --- | --- | --- | --- |
| `port` | `0`（随机可用端口） | `0..65535` | `端口必须是 0-65535 之间的整数` |
| `host` | `127.0.0.1` | 仅 `127.0.0.1` / `localhost` | `插件 Web 服务只能监听 127.0.0.1` |
| `maxConnections` | `16` | `1..64` | `限制必须是 1-64 之间的整数` |
| `maxMessageBytes` | `1 MiB` | `1024..8 MiB` | `限制必须是 1024-8388608 之间的整数` |
| `maxBufferedBytes` | `min(maxMessageBytes × 4, 32 MiB)` | `maxMessageBytes..32 MiB` | `限制必须是 <msg>-33554432 之间的整数` |
| `allowCrossOrigin` | `false` | 布尔 | — |

`allowCrossOrigin` 这个选项**官方文档里没写**，但本机实现确实透传（`allowCrossOrigin: i?.allowCrossOrigin`），说明后端存在跨源放行开关。

其余边界：

- 超 `mm`（2 MiB）的请求体 → 宿主报 `请求体超过插件 Web 服务限制` 并 `destroy()` 连接；
- 升级请求超 `_m`（10 s）未裁决 → **503**；
- 压缩扩展关闭；
- `handler` 抛错 → 宿主记录插件运行异常并返回 **500**；
- 无 `onRequest` 时默认响应 `{ status: 404, body: 'Not Found' }`（本机实现，文档未写）；
- 同一插件同一时间**只有一个服务**；再次 `listen()` 会替换 HTTP 处理器、必要时重启端口。

### 4.4 `listen()` 真实签名（本机核验）

```js
listen(handler | options, options?)
```

实现里的分派逻辑是 `typeof t === "function" ? t : i?.onRequest` —— 即：

- `listen(handlerFn)` → 只注册 HTTP 处理器
- `listen(options)` → `options.onRequest` 作 HTTP 处理器
- `listen(handlerFn, options)` → 两个参数，**只有这是"传自定义 HTTP handler + 附带端口/限制/WS 配置"的写法**

`onConnection` 之后也可单独追加：`ctx.webServer.onConnection(handler, { path, onUpgrade })`。

`path` 的语义（本机核验）：**只接受该 pathname 的升级**；不匹配时调 `upgrade(pluginId, { connectionId, accept: false })` 交给其他处理器或默认拒绝，**当前处理器不会主动 403** —— 所以多个 `path` 处理器可以共存于一个端口。

### 4.5 适合与不适合

- ✅ 硬件/设备桥（本机 TCP/串口 → 本地 WS 暴露给渲染层）、OBS 类外部控制端（`ws://127.0.0.1:38123/live`）、局域网外的本机联动工具
- ❌ **不要**当公网入口；**不要**把整首音频经 WS 推给渲染进程（该场景用 `ctx.net.tcp` 或宿主自身播放链路）

---

## 五、服务请求拦截 API —— 属于 beta.5，但值得完整记录

`ctx.server.intercept()` 让插件以洋葱中间件方式介入**主程序发往酷狗服务端的每一次逻辑 API 调用**：

```
主程序业务代码 → 插件拦截器链（按 priority 排列）→ 酷狗 server
```

### 5.1 声明与门禁

```json
{ "capabilities": { "serverIntercept": true } }
```

本机核验的门禁文案（可用于排查"为什么没生效"）：

```
插件未声明服务请求拦截能力（capabilities.serverIntercept）
```

> 该能力可读取 Authorization 中的登录 token、userid、设备标识与**全部听歌数据**，敏感度与 `unrestrictedNetwork` 同级。
> 需要转发到自建/第三方服务时，还要额外声明 `unrestrictedNetwork: true`。

### 5.2 请求 / 响应对象（本机文档核验）

| `request` 字段 | 说明 |
| --- | --- |
| `method` | `'GET'` / `'POST'` |
| `url` | 逻辑路由，如 `'/song/url'` |
| `params` | 查询参数，**活对象**，可原地修改 |
| `data` | POST 请求体，可能不存在 |
| `headers` | 请求头，**已包含注入后的 Authorization** |
| `origin` | 固定 `{ type: 'host' }`；插件经 `ctx.kugou` 发起的请求**不进链** |

| `next()` 解析结果 | 说明 |
| --- | --- |
| `status` | HTTP 状态码 |
| `body` | 响应体 |
| `headers` | 响应头，可能不存在 |
| `cookie` | `string[]`，Set-Cookie |
| `mocked` | 该响应是否被链上某拦截器短路（**未真实出网**） |
| `handledBy` | 短路该请求的插件 id |

### 5.3 三个核心决策

| `options` | 语义 |
| --- | --- |
| `priority` | 数值**越大越靠外层**（请求阶段越早执行、响应阶段越晚拿到结果）。同优先级按注册先后。**每次请求开始时顺序冻结** |
| `match` | 字符串（路由前缀）/ 正则（对 `url` 做 `test`）/ 函数（拿完整 request 自行判断）。不匹配则 handler **完全不执行**（零开销跳过），且**逐层即时求值** —— 外层改了 `url`，内层按改写后的值重新判定 |
| `name` | 调试标识 |

约定档位（非强制）：`100` 观测/日志 → `0`（默认）数据转换 → `-100` Mock/转发。

`next()` 的四种写法：

| 写法 | 行为 |
| --- | --- |
| `return next()` | 透传，可在其 resolve 后加工响应 |
| `return next({ params, headers })` | 补丁式修改后透传（浅合并，headers 深合并） |
| 不调 `next`，`return { status, body }` | **短路接管**，后续拦截器与真实 server 都不触达，响应自动标 `mocked: true` |
| 不调 `next` 且抛错/返回非法值 | **fail-open** 自动放行原请求，并在插件管理页记异常 |

### 5.4 四条硬边界

1. 拦截点在**逻辑 API 层**（路由 + params + data + headers），位于**签名之前** —— 改参数不会破坏签名，宿主自动重算；
2. 看不到也改不了 server 内部生成的签名、默认设备参数、最终出网域名（想透明换网关请用主程序的网络代理设置）；
3. **音频流、封面图片直连、WebSocket、`ctx.net.*` 自身请求都不在拦截范围**；
4. ⚠️ **不要用 `throw` 来"阻断"请求** —— 异常会被 fail-open 放行。要屏蔽就返回错误形态的 Mock（如 `{ status: 403, body: {...} }`）。

第 4 条是最容易写错的：很多人直觉上会用 `throw new Error('blocked')` 来拒请求，结果请求照常发出去。

---

## 六、插件能力全清单（beta.6 本机核验）

从 asar 的能力门禁与 manifest 校验器提取出的**完整** `capabilities` 集合（比官方文档当前列出的更全）：

| capability | 入口 | 未声明时的报错 |
| --- | --- | --- |
| `audioSource` | `ctx.audioSource.register` | 插件未声明音源解析能力 |
| `audioSpectrum` | `ctx.audio.spectrum` | 插件未声明音频频谱能力 |
| `backups` | `ctx.backups` | 插件未声明备份与恢复能力 |
| `kugouApi` | `ctx.kugou` | 插件未声明酷狗 API 能力 |
| `kugouVerification` | `ctx.kugouVerification.request` | 插件未声明酷狗安全验证能力 |
| `localFiles` | `ctx.fs` | 插件未声明本地文件能力 |
| `lyricEffects` | `ctx.lyricEffects` | 插件未声明歌词动效能力 |
| `lyrics` | `ctx.lyrics` | 插件未声明歌词解析能力 |
| `process` | `ctx.process` | 插件未声明本地进程能力 |
| `sqlite` | `ctx.sqlite.open` | 插件未声明 SQLite 能力 |
| `tcp` | `ctx.net.tcp` | 插件未声明 TCP 能力 |
| `unrestrictedNetwork` | `ctx.net.request` | 插件未声明不受限网络能力 |
| `webServer` | `ctx.webServer` | 插件未声明 Web 服务能力 |
| `serverIntercept` | `ctx.server.intercept` | 插件未声明服务请求拦截能力（capabilities.serverIntercept） |
| `lyricsPage` | 歌词页注册 | 插件未声明歌词页能力（capabilities.lyricsPage） |

⚠️ **发现一处不一致**：`lyricsPage` 有运行期门禁、却**没有**出现在 manifest 的布尔类型校验器里（校验器只覆盖上表前 14 项）。
意味写错类型（比如 `"lyricsPage": "yes"`）不会在 manifest 校验阶段被拦下，只在调用时炸。依赖该能力的插件应自行做类型自检。

### 版本比对语义（本机核验）

```js
satisfies(currentVersion, range, { includePrerelease: true })
```

失败文案：`版本不兼容：需要 EchoMusic 主程序 ${range}，当前版本 ${current}`。
`requires.echoMusicVersion` 写错格式的报错有两种：`主程序版本要求无效` / `主程序版本范围无效`。

### 插件 SQLite（本机核验，非 beta.6 新增但常被忽略）

`ctx.sqlite.open(options?)` → `{ databaseId, exec, run, all, get, transaction, close }`，按插件 id 隔离。
`get` 返回 `{ ok: true, row: rows[0] ?? null }`。窗口入口的 `ctx.sqlite` 与主入口一致。

---

## 七、插件市场统计缓存重写（直接影响 `gh-accelerator`）

提交 `e15c471 optimize: plugin marketplace stats`。本机 asar 核验出的完整常量与算法：

```js
Su = 5 * 6e4    // 300000 ms = 5 min   常态缓存新鲜度
Cu = 6e4        //  60000 ms = 1 min   有 lastError / 缺 lastFetchedAt 时的新鲜度
Tu = 10 * 6e4   // 600000 ms = 10 min  stats 条目允许的陈旧窗口
Eu = 30 * 6e4   // 1800000 ms = 30 min retryAt 上限
Du = 2e3        // 2000                缓存条目上限
```

三个关键机制：

1. **在途请求去重（这就是"减少重复请求"的实现）**：模块持有单例 `{ promise, endpoint, keys }`。相同 endpoint 的并发调用会 `await` 同一个 promise，不会各发一轮 —— 所以"刷新按钮连点"不会叠加请求。
2. **批量分片**：keys 按 **200 个一批**（`t += 200` 循环）下发；任一 key 缺失即判定 `插件统计响应不完整` 并整体失败。
3. **指数退避 + 失败计数**：`failures` 上限 6，`retryAt = now + min(30min, 60s × 2^(failures-1))`；成功后清零。新请求只在 `now >= retryAt` 时才发。

缓存条目上限 2000，超出时从最旧一端删除；持久化键为 `plugins:marketplace:cache`（对比：插件源列表在 `plugins:marketplace:sources`）。

### 对 `gh-accelerator` 的影响

| 受影响点 | 说明 |
| --- | --- |
| 进度推定的**分母** | 索引 JSON 拉取链路未变，`echo-plugins.json` → N 个 manifest 的并行结构不变，分母推定方式仍成立 |
| **速率探测的准确性** | 在途去重让宿主"看起来只发了一轮"，插件自己按同样前缀探针拉索引时，测得的是**与宿主不同的连接**，所以速率仍可用，但**不能再用"宿主请求次数"反推进度** |
| 刷新耗时 | 200 一批 + 退避意味着**首次冷启动变慢、连点变快**；进度条的渐近权重应偏向"首轮慢" |
| 失败态 | `retryAt` 最长 30 分钟 —— 插件若在做"刷新失败自动重试"，必须对齐这个窗口，否则重试会被宿主静默丢弃（表现为"点了没反应"） |

> 行动项：`gh-accelerator` 的进度推定里，把"宿主请求计数"这条依据降级，主依据改为 DOM 骨架 `aria-busy` + 卡片计数 + 自探针总量三路互校（现有实现已是三路，但权重需重排）。

---

## 八、浮窗宽高限制调整

提交落在 `optimize: UI & style` 批次里，Notes 单独列了一条「优化调整浮窗 API 不合理的最小和最大宽高限制」。本机核验的实现：

```js
Qu = (e, t, n) => Math.min(n, Math.max(t, e))          // clamp(value, min, max)
ld = (e, t) => e.allowOutsideWorkArea ? t.bounds : t.workArea   // 边界基准
ud = (e, t) => {
  const n = Qu(round(t.width  || e.defaultWidth),  e.minWidth,  e.maxWidth)
  const r = Qu(round(t.height || e.defaultHeight), e.minHeight, e.maxHeight)
  // …再按显示器的 bounds / workArea clamp 位置与尺寸
}
```

**结论：尺寸上限现在只由 manifest 的 `min*` / `max*` + 当前显示器范围决定，宿主不再额外施加硬编码的实用上限**（旧实现有类似 `1400×900` 的夹取）。

| 项 | 现行为 |
| --- | --- |
| `minWidth` / `minHeight` | 宿主下限均为 **`1`**（未声明时落到 `1`） |
| `maxWidth` / `maxHeight` | 宿主不设实用上限，实际受显示器范围约束 |
| `allowOutsideWorkArea: true` | 用显示器完整 `bounds` 作边界（可贴近/覆盖 Windows 任务栏）；`false` 用 `workArea` |
| `show()` / `move()` / `resize.bind()` | 最终尺寸夹到 manifest `min*`–`max*` 与显示器范围内 |
| `rememberBounds` | 位置尺寸持久化到 `plugin-window:<pluginId>:<windowId>:bounds`，**防抖 180 ms** 落盘 |

任务栏单行歌词这类场景把 `minHeight` 设到 `1` 即可贴合字体高度 —— 依赖此行为的插件应用 `requires.echoMusicVersion` 卡住下限。

---

## 九、与插件无关但值得知道的宿主变更

| 变更 | 备注 |
| --- | --- |
| 标题栏「更多」加入插件管理 | 插件管理多了一个入口；若插件在做 `ctx.dom.observe` 定位，注意**同一页面可能被两处挂载**，注入逻辑要按"是否已注入"守卫（`querySelector` 查自己的 host）|
| Windows 独立任务栏快捷播控与收藏 | 会话 `850539e` + `7c2e2b5`（并发切换时重建任务栏按钮的竞态修复）。创建的是宿主自己的窗口，**不是插件浮窗**，不占用 `contributes.windows` |
| Electron 版本升级 `69d7132` | Windows ARM 上"浏览器同时播放视频时音乐卡顿"的修复应与此相关 |
| Native Addons CI（`54e21fa` / `09a1372` / `797d75a`） | 手动触发构建，产物打包与文件计数校验。影响 Rust napi 模块发布流程，不影响插件接口 |
| Tab 路由修复 `0285cd7` | 搜索/发现/收藏/已购/历史/详情页返回或刷新后 Tab 状态丢失 |
| 音效切换修复 `59568a3` | 部分歌曲切换人声/伴奏失败。注意这是**播放引擎层**修复，插件若在 `ctx.player.setAudioEffect` 上做过 workaround，可以移除了 |
| 私人 FM 优化 `82df2e7` | 推荐池切换 / 喜欢 / 不喜欢逻辑重写，并新增「电台」模式。`ctx.player.dislikePersonalFm()` 语义需重新核对 |

---

## 十、行动项（针对本仓库三个插件）

| 插件 | 结论 | 动作 |
| --- | --- | --- |
| `gh-accelerator` | 🟡 需跟进 | ① 重排进度推定权重（见 §七）；② 失败重试对齐 30 min `retryAt`；③ 顺带受益：在途去重后，"刷新"按钮连点的真实行为变了，测试断言需更新 |
| `kugou-recommend` | 🟢 无需改动 | 取数走本地路由 + 网关直连，两者在 beta.6 均未变。可选：评估用 `ctx.server.intercept` 做统一的错误码观测 |
| `kugou-daily-vip` | 🟢 无需改动 | 活动接口未变。可选：用 `ctx.server.intercept` 替代手写的验证码兜底（`error_code 20028` 观测），但需权衡 fail-open 语义 |
| 新插件机会 | 💡 | `ctx.webServer` + WebSocket 打开了"本机外部控制端"这类此前做不了的场景（如用手机/浏览器遥控播放器、硬件旋钮桥） |

### 十·补、`gh-accelerator` 行动项的落地复核（2026-09-22 已执行）

逐条回代码核对后：**两条的前提不成立，一条是软建议且无实测支撑**；同时翻出两个真正需要修的风险点，已在 v1.2.0 落地。

| 行动项 | 复核结果 | 依据 |
| --- | --- | --- |
| ① 重排进度推定权重 | **前提不成立** | 前提是"不能再用宿主请求次数反推进度"。实际进度输入只有三路：DOM 骨架（`.plugin-card-grid[aria-busy]`）、真实卡片计数、自探针总数；`probeRequests` 记的是**插件自己**探针的请求数，与宿主无关。从来没有"用宿主请求计数反推"这条依据，无权重可降。 |
| ② 失败重试对齐 30 min `retryAt` | **前提不成立** | 该条自带条件"插件若在做刷新失败自动重试"。插件没有任何市场刷新自动重试逻辑，刷新完全由用户点击驱动。无需对齐。 |
| ③ 测试断言需更新（连点） | **不成立** | 接管模式连点由 `if (m.own) return` 守卫，两条管线本就不会叠加；测试里也没有依赖宿主请求次数的断言。 |

> 教训：§十 是按"插件大概会怎么做"推断出来的，不是读代码得出的。**行动项必须先验证前提再动手**，
> 否则会为一个不存在的问题改代码。

**复核中翻出的两个真实风险点（本轮修复，v1.2.0）：**

1. **探针缺了宿主的"回落直连"语义。** 宿主索引取数走 `Nu({acceleratorEnabled, accelerated, github, onAcceleratorFailure})` —— 加速失败会回落直连；探针原先只打加速那一次，镜像抖动或返回 HTML 错误页就会丢掉「插件总数」，进度只能退回阶段估算。
2. **探针超时过紧（4 s）。** 宿主给索引请求的预算在 asar 里是 `pf = 3e4`（30 s），探针 4 s 就放弃，等于主动丢掉分母。

修法：探针改为「加速 → 失败回落直连」，成功回落时在进度条标注「总数经直连取得」；默认超时放宽到 8 s。

**顺带核实：`gh-accelerator` 依赖的市场契约在 beta.6 全部未变。**

| 契约 | beta.6 实况 |
| --- | --- |
| 索引 URL 形态 | `vv` 内 `F_(repo, 'echo-plugins.json')` → `raw.githubusercontent.com/<owner>/<repo>/HEAD/echo-plugins.json`，与插件 `marketplaceIndexUrl()` 构造的形态**完全一致** |
| GitHub 主机判定 + 前缀拼接 | `ju` / `Mu` 与插件的 `isGithubHost` / 前缀拼接逐字一致 |
| 骨架屏 | `.plugin-card-grid[aria-busy="true"]` 仍在（asar 内 `aria-busy` 共 43 处） |
| 工具条锚点 | `.marketplace-toolbar` 只有 **1 处模板 + 1 处 CSS**，不存在"同页两处挂载" |
| 官方仓库常量 | `Qd = https://github.com/hoowhoami/EchoMusicPlugins` 未变 |
| 存储键 | `plugins:marketplace:sources` / `plugins:marketplace:cache` 未变 |

> ⚠️ **一个极易看错的点**：宿主来源对象上的 `indexUrl` 字段是 `L_(repo, ...)` 造的
> `https://github.com/<owner>/<repo>/blob/HEAD/<file>`，那是**展示用**形态。
> 实测该形态（经加速前缀）返回的是 **HTML**（484 KB），不是 JSON。
> 真正取数用的是 `F_` 的 **raw** 形态 —— 照 `indexUrl` 去构造探针地址会拿到 HTML，从而误判成"镜像坏了"。

**实测数据**（本机，2026-09-22，经Xget）：

```
/gh/hoowhoami/EchoMusicPlugins/raw/HEAD/echo-plugins.json  → 200 ·  13979 B ·  290 ms · plugins=39
/gh/hoowhoami/EchoMusicPlugins/raw/main/echo-plugins.json  → 200 ·  13979 B · 1316 ms · plugins=39
/gh/hoowhoami/EchoMusicPlugins/blob/main/echo-plugins.json → 200 · 484931 B · HTML（非 JSON）
/gh/hoowhoami/EchoMusicPlugins/echo-plugins.json           → 404
```

即官方源当前有 **39 个插件**；`/raw/` 段是必须的（漏掉会 404，用 `/blob/` 会拿到 HTML）。

---

## 十一、方法附录：怎么自己复核这些结论

```powershell
# 1) 确认本机版本
(Get-Item "<REDACTED>").VersionInfo.FileVersion

# 2) 在 asar 里检索某个 API 是否存在（不需要解包）
$bytes = [System.IO.File]::ReadAllBytes("<REDACTED>")
$txt   = [System.Text.Encoding]::UTF8.GetString($bytes)
$txt.IndexOf('onConnection')      # → 8179942（存在）
$txt.IndexOf('serverIntercept')   # → 5001241（存在）

# 3) 取窗口 + 插换行（压缩 bundle 是超长单行，Read 会按 2000 字符截断）
$chunk = $txt.Substring($idx-2000, 4000) -replace ',(?=[A-Za-z_$"''\{])', ",`r`n"
$chunk | Out-File "$env:TEMP\win.txt" -Encoding utf8
```

判断"某 API 属于哪个版本"的可靠顺序：

1. **官方文档里的版本提示**（如 `web-server.md` 直接写「应声明 `requires.echoMusicVersion: ">=2.3.2-beta.6"`」）—— 最权威；
2. **`git compare base...target`** 的 commit 列表 —— 定增量；
3. **本机 `app.asar` 检索** —— 定"这份实装到底有没有"；
4. Release Notes —— **只当摘要看，不能当增量依据**（本项目累积）。

---

## 十二、结论摘要

1. beta.6 对插件开发者**只新增了一个能力**：`ctx.webServer` 上的 WebSocket（`onConnection`），门槛 `>=2.3.2-beta.6`；
2. 该项目 beta 线的 Release Notes 是**累积**的，beta.6 重复了 beta.5 的三条，**判断增量必须看 commit**；
3. `capabilities` 实际有 **15 项**，其中 `lyricsPage` 有门禁但缺 manifest 类型校验（可报的坑）；
4. 市场统计缓存重写引入了**在途去重 + 200/批 + 指数退避（最大 30 min）**，这是 `gh-accelerator` 最需要跟进的点；
5. 浮窗尺寸上限不再有硬编码实用上限，`min*` 可低到 `1`；
6. 服务请求拦截 API 的**最高危误区是"用 throw 阻断请求"** —— 会被 fail-open 放行。
