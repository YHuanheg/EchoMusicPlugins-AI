# EchoMusic v2.3.2-beta.10 / beta.11 技术分析

> 结论先行：**beta.10 是自 beta.7 以来第一个真正新增插件能力的版本** —— 新增能力 **`downloads`**（清单 16 → 17 项），
> 并给 `ctx.fs` / `ctx.net` 加了一整套**文件授权 + 流式下载 + 媒体读取** API。
> 这解开了「插件写不了任意路径、下载大文件要靠 `Blob`/`showSaveFilePicker` 绕」这条长期限制。
> **beta.11 则修了一个由它引入的严重回归**：流式下载器把 302 重定向判成 `Redirect was cancelled`，
> 导致**走 GitHub 加速桥安装插件全线失败** —— 这条直接打在 `gh-accelerator` 上。

分析时间：2026-10-13　分析对象：`hoowhoami/EchoMusic` @ `v2.3.2-beta.10`、`v2.3.2-beta.11`
数据来源：本机实装 `2.3.2-beta.11`（`<REDACTED>`，10,035,897 B，mtime 2026-10-11 20:30）+ GitHub compare 逐文件 patch + 官方新文档 `files-and-downloads.md` + asar 逐字核验
前序：[beta.8/beta.9](EchoMusic-v2.3.2-beta.8-beta.9-技术分析.md) · [beta.7](EchoMusic-v2.3.2-beta.7-技术分析.md) · [插件系统与加速链路调研](EchoMusic-插件系统与加速链路调研.md)

---

## 一、版本元数据

| 项 | beta.10 | beta.11 |
| --- | --- | --- |
| 发布时间（UTC） | 2026-10-10 07:33 | 2026-10-11 12:34 |
| 北京时间 | 10-10 15:33 | 10-11 20:34 |
| 提交数 | **4** | **13** |
| 变更文件 | 86（`src` 60 / `tests` 22） | 86（`src` 38 / `tests` 22 / `native` 18） |
| 间隔上一版 | beta.9 → 约 16 h | beta.10 → 约 29 h |

beta.10 的 4 个提交：
```
2f178b5  optimize: UI & style
97bc354  feat: plugin download api & file api      ← 本次主角
9186dc3  feat: plugin download api & file api
ab858a9  feat: update
```

beta.11 的 13 个提交以 **Windows 任务栏歌词**为主线（`df381d0 refactor: windows taskbar thumbnail & lyric` + 5 个 `fix: taskbar lyric`），
最后一条 `812f152 fix: plugin download` 才是插件相关。

> 本机实装 **beta.11**。asar 从 beta.9 的 9.94 MB 长到 10.04 MB。

---

## 二、⚠️ Release Notes 累积：第五次验证

| 条目 | 首次出现 | beta.10 | beta.11 |
| --- | --- | --- | --- |
| 服务请求拦截插件 API | beta.5 | 重复 | 重复 |
| 插件本地 WebSocket API | beta.6 | 重复 | 重复 |
| 统一主题中心 / 侧边栏布局编辑 / DLNA | beta.7 | 重复 | 重复 |
| 多账号切换 / 免费听 / 歌词色跟随封面 | beta.9 | 重复 | 重复 |
| **插件文件授权、流式下载与媒体读取 API** | **beta.10** | ✅ 新增 | 重复 |
| 统一「已授权文件与目录」管理 | **beta.10** | ✅ 新增 | 重复 |
| **Windows 任务栏歌词** | **beta.11** | — | ✅ 新增 |

beta.11 的「新增」段 25 条里 **24 条是旧的**。`requires.echoMusicVersion` 的下限判断继续只看 commit。

---

## 三、⭐ beta.10：文件授权 + 流式下载 + 媒体读取（新能力 `downloads`）

官方文档：**`EchoMusicPlugins/docs/files-and-downloads.md`**（13,882 B，本次新增）。

### 3.1 能力与版本门槛

```json
{
  "capabilities": { "localFiles": true, "downloads": true },
  "requires": { "echoMusicVersion": ">=2.3.2-beta.10" }
}
```

| 用法 | 需要的能力 |
| --- | --- |
| 普通下载（`ctx.net.download`） | **`localFiles` + `downloads`** |
| 本地文件操作与复制（`ctx.fs.*`、`copyFile`） | 只要 `localFiles` |

本机核验的门禁文案（asar 逐字）：

```
插件未声明所需文件/下载能力
```

实现里是**组合判断**：`capabilities?.localFiles !== true || (需要下载时 && capabilities?.downloads !== true)`。
→ 所以**只声明 `downloads` 不声明 `localFiles` 是无效的**，两项必须一起写。

**能力清单从 16 项涨到 17 项**（新增 `downloads`），其余 16 项与 beta.9 逐字相同。
**`createPluginContext` 的键表没有新增键** —— 新 API 全部挂在既有的 `ctx.fs` / `ctx.net` 上。

### 3.2 授权模型：**引用式，不是裸路径**

这是与旧接口最本质的区别。插件再也拿不到也不该拼接绝对路径：

```js
const selection = await ctx.fs.requestDirectory({
  access: 'read-write',      // 或 'read'
  purpose: '保存插件资源',
  persist: true,             // 默认 true；false 只在本次主进程会话有效
});
if (!selection.ok) throw new Error(selection.error.message);
if (selection.canceled) return;
const directory = selection.directory;

const file = { kind: 'directory-file', directoryId: directory.id, relativePath: 'resources/background.mp4' };
```

两种引用：

| 引用 | 形态 |
| --- | --- |
| 目录内文件 | `{ kind: 'directory-file', directoryId, relativePath }` |
| 单独授权的文件 | `{ kind: 'selected-file', fileId }`（**只读**） |

`DirectoryRef` 字段：`id / name / access / kind / available / displayPath`。
**`displayPath` 仅用于显示** —— 操作一律用 ID + 相对路径。相对路径会被拒绝：越界、绝对路径、**链接**、Windows 设备名。

> **旧接口仍兼容**：裸路径版本的 `listFiles` / `readTextFile` / `readFileBytes` / `writeFile` 继续可用。
> 新接口返回**结果对象**，其余新接口**抛带 `code/message/retryable` 的错误**。注意「引用读取音频元数据」与「旧裸路径重载」的结果结构不同。

### 3.3 `ctx.fs` 新增面（官方文档整理）

| 接口 | 返回与语义 |
| --- | --- |
| `requestDirectory(options)` | `{ok:true,canceled:true}` 或 `{ok:true,canceled:false,directory}`；错误 `{ok:false,error}` |
| `requestFiles({purpose, persist?, multiple?, filters?})` | 同上结构，成功给 `files: FileRef[]`；**单个文件授权只读** |
| `listDirectoryGrants()` | 已登记目录（**含不可用/已撤销**）；不含单个文件 |
| `reauthorizeDirectoryGrant(id, options)` | 重开系统选择器；同一路径**保留 ID**，换目录返回**新 ID** |
| `revokeDirectoryGrant(id)` / `revokeFileGrant(id)` | 撤销访问、保留实际文件；中断相关传输、关闭媒体租约 |
| `getPrivateDirectory({kind})` | `kind` = `data` \| `cache`；**私有目录，不打开选择器** |
| `stat(file)` | 文件名/大小/修改时间/是否目录 |
| `mkdir(file)` | 在授权目录内建子目录（含父目录） |
| `listFiles(directory, options?)` | `{ok:true,files,limitReached}`；条目带 `file` 引用，支持 `video` 分类 |
| `readTextFile(file, options?)` / `readFileBytes(file, options?)` | `{ok:true,content/data,size,bytesRead,truncated}`；默认 ≤ 1 MiB，最多 4 MiB |
| `readAudioMetadata(file)` | 音频元数据；失败抛带 code 的错误 |
| `writeFile(file, data, options?)` | `{ok:true,file,bytesWritten}`；**最多 8 MiB**；`overwrite:true` 才替换 |
| `deleteFile(file)` | **仅删文件，不递归删目录** |
| `copyFile(source, target, {conflict?})` | **主进程流式复制**，返回与下载一样的句柄，**无 8 MiB 限制** |
| `openMedia(file)` | `{id, url, release()}`；给 `video/audio/img` 的 `src` 用，**不把大文件塞进 renderer** |

⚠️ **`writeFile` 仍是 8 MiB 上限** —— 大文件必须走 `ctx.net.download` 或 `ctx.fs.copyFile`。

### 3.4 `ctx.net.download` 与任务句柄

```js
const directory = await ctx.fs.getPrivateDirectory({ kind: 'data' });
const task = await ctx.net.download({
  url: 'https://your-server.example/video.mp4',
  target: { directoryId: directory.id, relativePath: 'videos/background-v1.mp4' },
  headers, name, sourceKey, idempotencyKey, expectedBytes, checksum, maxBytes,
  conflict, resume, connectTimeoutMs, idleTimeoutMs,
});

const unsubscribe = task.subscribe((snapshot) => {
  // snapshot.state / receivedBytes / totalBytes / bytesPerSecond / remainingSeconds
});
try {
  const result = await task.wait();          // result.file 是最终文件引用
  const lease = await ctx.fs.openMedia(result.file);
  video.src = lease.url;
} finally { unsubscribe(); }
```

**任务句柄**：`getSnapshot()` / `subscribe(cb)`（**立即发一次缓存快照**，返回取消函数）/ `pause()` / `resume(source?)` /
`retry(source?)` / `cancel()` / `wait({signal?})`。

**状态机**：`queued → connecting → downloading → verifying → committing → completed`，另有 `paused / interrupted / failed / canceled`。
`revision` 单调递增，`runId` 在 retry 时增加。**进入 `committing` 后暂停/取消要等提交结束**，不能把已提交的文件改报成 canceled。

**跨会话恢复**：

```js
const snapshots = await ctx.net.downloads.list({ offset: 0, limit: 50 });
const task = await ctx.net.downloads.attach(savedTaskId);
if ((await task.getSnapshot()).canResume) await task.resume(source);
// get(id) 取快照；remove(id) 删终态记录与残留 partial，保留最终文件
// interrupted 任务须先 cancel 再 remove
```

### 3.5 媒体租约与自定义协议（本机 asar 核验）

- 宿主注册了自定义协议 **`echo-plugin-media`**（`protocol.registerSchemesAsPrivileged`，`standard/secure/supportFetchAPI/stream/corsEnabled` 全开），
  在 `session.defaultSession` 上 `protocol.handle` —— 这就是 `openMedia()` 返回的 `url` 的形态。
- ⚠️ **媒体 URL 是「当前插件上下文的短期租约」，不要落盘**。宿主明确要求：持久化 `DirectoryRef.id` + 相对路径 + 资源版本/哈希，
  启动时先 `stat` 本地文件，存在就重新 `openMedia()`。
- **禁用插件、进入安全模式或更新** → 关闭旧上下文的媒体租约并中断其任务；重新启用后用新上下文 attach/resume。

### 3.6 限制与配额（文档 + asar 交叉核验）

| 项 | 值 |
| --- | --- |
| 全局活动传输 | **3** |
| 每个所有者活动传输 | **2** |
| 队列预算 | 全局 **100** / 单插件 **50** |
| 默认连接超时 / 读取空闲超时 | **30 s / 60 s**（可覆盖） |
| 重定向 | 最多 **5** 次 |
| 普通下载文件大小 | **无固定上限**（安装包仍有 80 MiB 预算） |
| 上游编码 | **必须 identity**，否则续传偏移不可靠 |
| 单窗口资源订阅数 | **100**（超出报 `订阅数量过多`） |
| `writeFile` | 8 MiB（未变） |
| `readTextFile` / `readFileBytes` | 默认 1 MiB，最多 4 MiB |

**跨来源重定向会剥离鉴权与自定义头**（`Authorization` / `Cookie` / 自定义头全丢）——
beta.11 的测试里有硬断言。**URL 与请求头不落盘。**

### 3.7 错误码（asar 逐字核验）

宿主用统一的 `ResourceError(code, 中文消息)`，插件侧拿到 `{code, message, retryable}`：

| code | 已核验的中文消息 |
| --- | --- |
| `PLUGIN_UNAVAILABLE` | `插件安装身份失效` / `插件来源已经变化` / `插件未启用或已失效` / `插件运行上下文已失效` / `窗口已关闭` / `插件上下文已销毁` / `插件不存在` |
| `CAPABILITY_REQUIRED` | `插件未声明所需文件/下载能力` |
| `INVALID_ARGUMENT` | `私有目录类型无效` / `文件引用无效` / `授权尚未撤销` / `授权管理操作无效` / `请指定授权所属插件` / `请指定授权记录` / `上下文已登记` |
| `GRANT_REQUIRED` | `未授权此文件` / `此授权仅可读取` / `目录未授权` / `授权不属于此插件` / `该文件或目录不属于用户授权` |
| `GRANT_REVOKED` | `目录授权已撤销` / `授权记录已变化，请刷新后重试` |
| `PATH_OUTSIDE_ROOT` | `授权路径不能经过链接` |
| `FILE_MISSING` | （文档示例里出现，用于「本地还没有这个文件」的正常分支） |

### 3.8 实现细节（asar 挖取，文档没写）

**授权是绑定「安装身份」而不是插件 id 的**：

```
<userData>/plugin-file-grants/identities.json
  → { <pluginId>: { origin: <installSource 指纹>, owner: <随机 UUID> } }
<userData>/plugin-transfers/                # 传输任务
<userData>/plugin-package-downloads/        # 安装包
<userData>/plugin-data/<owner>/             # 私有 data
<userData>/plugin-cache/<owner>/            # 私有 cache
```

`origin` 取自安装来源：marketplace 时是 `{kind, source, origin}`，本地安装时是 `{kind:'local', directory}`。
→ **插件换安装来源（换源/改目录）后 `origin` 变化 → 身份重建 → 旧授权不再沿用**（`插件来源已经变化`）。
这也解释了文档那句「不同来源不能沿用同 ID 的授权」。

**主进程 IPC 形态**（插件侧经 preload 封装，不直接碰）：

| 通道 | 用途 |
| --- | --- |
| `plugins:resources:call` | `(pluginId, op, payload, contextId)` 通用 RPC |
| `plugins:resources:subscribe` / `unsubscribe` | 注册上下文以接收进度 |
| `plugins:resources:download` | **主进程 → renderer 推送进度** `{pluginId, snapshot}` |
| `plugins:resources:grants` | 授权管理：`revoke` / `remove` / `reauthorize`，省略操作时返回全量列表 |

**授权选择器的标题文案**（用户看到的就是这个，可用于写自己的引导文案）：

```
{插件名} · {读取目录|读写目录} · {用途}       ← requestDirectory
{插件名} · 读取文件 · {用途}                  ← requestFiles
```

`requestDirectory` 的属性含 `openDirectory` + **`createDirectory`**（这就是 release notes 里「目录选择支持新建文件夹」）。
`requestFiles` 支持 `multiSelections` 与 `filters`。**首次选择只打开系统选择器，选成功后宿主登记授权，不再弹额外确认框。**

**宿主侧的统一管理入口**：插件管理页顶部「**已授权文件与目录**」对话框（`PluginAuthorizedFilesDialog.vue`，新增 237 行），
按插件分组、逐项撤销，**插件已禁用时也能撤销**。私有 `data`/`cache` 不打开选择器、也不出现在这个列表里。

**下载日志的 URL 脱敏**（沿用 beta.7 的机制，本次覆盖到新下载 API）：query 与 hash 会被替换成 `?[redacted]` / `#[redacted]`。

---

## 四、⚠️ beta.11 修的回归，直接打在加速器桥上

提交 `812f152 fix: plugin download`（5 个文件），CHANGELOG 原文：

> 修复引入流式下载后，插件市场下载安装 GitHub Release 等重定向资源时提示 **"Redirect was cancelled"** 的回归问题

### 4.1 根因（patch 逐行读完）

beta.10 的流式下载器用的是 **Electron 的 `Session.fetch()`**（`getManagedNetworkSession(...).fetch(url, init)`），
并期望它能像浏览器 fetch 那样在 `redirect: 'manual'` 时**把 302 响应连同 `Location` 头交给调用方**。

但 `Session.fetch` 的实际行为是：**在返回 manual-redirect 响应之前就把底层 Chromium 请求 abort 掉**，
于是调用方拿到的是 `Redirect was cancelled` 而不是一个可读的 302。

→ 后果：**任何重定向的下载都失败**。GitHub Release 资源正是重定向的
（`github.com/.../releases/download/...` → `objects.githubusercontent.com/...`），所以**插件市场安装/更新全线挂**。

### 4.2 修法

新增并从 `electronAxiosAdapter.ts` 导出 **`fetchWithElectronSession`**，改用 `net.request({ redirect: 'manual' })` 直接实现，
**在 abort 之前先把 `status` + `location` 解析成 Response**；再把公共逻辑抽成 `requestWithSession(fetchRequest, session, options)`：

```ts
// Unlike Session.fetch, this exposes a manual redirect as a Response before aborting
// the Chromium request, so download callers can validate each hop themselves.
export const fetchWithElectronSession = (input, init, networkSession) => {
  const fetchRequest = new Request(input, init)
  return requestWithSession(fetchRequest, networkSession, {
    redirectLimit: DEFAULT_MAX_REDIRECTS,
    redirectMode: fetchRequest.redirect,
    maxBodyLength: -1, maxContentLength: -1,
    credentials: fetchRequest.credentials === 'same-origin' ? undefined : fetchRequest.credentials,
  })
}
```

调用点只改了一行：

```diff
-      fetch: async (url, init) => (await getManagedNetworkSession('echo-plugin-downloads')).fetch(url, init),
+      fetch: async (url, init) => fetchWithElectronSession(url, init, await getManagedNetworkSession('echo-plugin-downloads')),
```

新增的测试覆盖 **301 / 302 / 303 / 307 / 308** 五种状态、跨主机重定向、以及**敏感头剥离**断言。

### 4.3 ⚠️ 为什么这对本仓库是大事

`gh-accelerator` 的核心机制就是**本地桥返回 302**：

```
宿主 → http://127.0.0.1:<port>/https://github.com/o/r/archive/refs/heads/main.zip
     ← 302 Location: https://xget-.../gh/o/r/archive/refs/heads/main.zip
```

**beta.10 上，只要用户开着加速桥，「在线插件」的安装/更新就会因为那条 302 而失败**，报的正是 `Redirect was cancelled`。
beta.11 修好了。

| 结论 | 说明 |
| --- | --- |
| 现象 | beta.10 + 加速桥开启 → 插件市场安装/更新失败，提示 `Redirect was cancelled` |
| 不是插件 bug | 是宿主流式下载器的回归 |
| 处方 | **升级到 beta.11 及以上**；临时可关掉加速桥直连 GitHub |
| 本仓库要做什么 | **无需改代码** —— `gh-accelerator` 的 `requires.echoMusicVersion` 是 `>=2.3.0`，没有上界，不用动 |
| 但值得记 | 若用户报「装了加速器就装不上插件」，先问版本 |

> 顺带一条边界：新引擎**跨来源重定向会剥离自定义头**。加速桥是 1 跳（`127.0.0.1` → `github.com`），
> 公共仓库下载本来不带鉴权，所以桥照常工作；但**不要指望通过桥给需要鉴权的私有源传 token**。

---

## 五、beta.11 的其它变更

| 变更 | 说明 |
| --- | --- |
| **Windows 任务栏歌词** | 新增 `native/echo-platform-adaptor/src/windows/taskbar/`：`lyric.rs`(+829) / `thumbnail.rs`(+268) / `geometry.rs`(+140) / `window_lifecycle.rs`(+175)；删除了旧的 C# `native/taskbar-layout/TaskbarLayout.cs`(-142) 与 `src/taskbar.rs`(-196)，改成 Rust 实现 |
| 任务栏封面预览 | `optimize: Windows 任务栏封面预览` + `src/main/taskbarMediaBar.ts`(+222/-173) |
| 托盘菜单 | 右键「显示窗口」拆成「打开主窗口」/「打开 Mini 窗口」（PR #475） |
| 个人信息展示 | `feat: 丰富的个人信息展示` + `SidebarAccountPopover.vue`(+16/-2) / `Sidebar.vue`(+34/-24) |
| 音频输出 | `native/echo-audio-player/src/output/cpal_shared.rs`(+52)：共享模式 CPAL 输出调整 |
| 设置页 | `WindowSettingsSection.vue`(-126/+45)，窗口相关设置收敛 |
| AirPlay | `fix: airplay` 一轮 |

**与插件 API 无关** —— 这一版的插件相关改动只有 `812f152` 那一条。

---

## 六、本仓库影响与行动项

以 `!**/.workbuddy/**` 过滤后逐项检索 7 个插件：

| 检索项 | 命中 | 结论 |
| --- | --- | --- |
| `ctx.fs.requestDirectory` / `requestFiles` / `getPrivateDirectory` / `openMedia` | **0** | 7 个插件都还没用新 API |
| `ctx.net.download` | **0** | 同上 |
| `showSaveFilePicker` / `createWritable` | **仅 `song-downloader`** | 见下 |
| `capabilities.downloads` | **0** | 无插件声明 |

### 6.1 `song-downloader`：新 API 正好解开了它当年绕的那个弯

它自己的代码注释和 README 里写得很清楚（当时的结论）：

> `ctx.fs.writeFile`：路径被硬限制在插件目录内（`ip()` 里 resolve + relative 校验）
>
> 宿主把「写任意路径」堵死了：`ctx.fs.writeFile` 被限制在插件目录内且单次 ≤ 8 MB，`ctx.process.launch` 只允许插件目录内的 exe，
> 主进程也没有 `will-download`。**不绕过这条安全边界**

所以它只能退化成 `Blob + <a download>`（落系统下载目录）或 `showSaveFilePicker`，
并因此吃到了**「先弹对话框会留下 0 KB 空文件」**那个坑（README 里记着 1.1.0 的真实反馈）。

**beta.10 之后，这条限制不再成立**：

| 旧做法 | 新做法 | 收益 |
| --- | --- | --- |
| `showSaveFilePicker` + `createWritable` | `ctx.fs.requestDirectory({access:'read-write'})` + `ctx.net.download({target})` | 用户授权一次目录，之后任意子路径可写 |
| `Blob` 全量进内存再 `<a download>` | 主进程流式写盘（**无 8 MiB / 80 MiB 上限**） | 内存占用从"整个文件"降到常量 |
| 自己防「0 KB 文件」 | 宿主 `commit` 阶段才替换，`conflict:'fail'` 是默认 | **从根上不会留半成品** |
| `FileSystemFileHandle` 被 reactive 代理 → `Illegal invocation` | 授权引用是纯数据对象 | 那个坑一起消失 |

→ **建议列为 P1 重构项**：把 `song-downloader` 的落盘路径迁到 `ctx.fs.requestDirectory` + `ctx.net.download`，
但要注意 (a) 需新增 `capabilities.downloads`；(b) `requires.echoMusicVersion` 提到 `>=2.3.2-beta.10`（会缩小可用人群）；
(c) 保留旧路径作为低版本回退。

### 6.2 行动项

| 优先级 | 事项 |
| --- | --- |
| **P1** | `song-downloader` 迁移到 `ctx.fs.requestDirectory` + `ctx.net.download`（含 `capabilities.downloads` 与版本门槛，保留旧路径回退） |
| **P2** | 给插件 README 补一句：beta.10 + 加速桥 → 插件安装报 `Redirect was cancelled`，升到 beta.11 解决（避免用户误判成加速器坏了） |
| **P3** | 评估 `ctx.fs.openMedia` 替代"把音频整段读进 renderer"的可行性（当前 0 个插件用它） |
| **P3** | 评估 `ctx.net.downloads.list/attach` 做"下载任务跨重启恢复"（对 `song-downloader` 的批量下载有吸引力） |
| **—** | 其余 6 个插件无需改动 |

---

## 七、方法附录

沿用 beta.8/9 固化的流程（见技能 `50#TST-18` 与 `11#CAP-12`），本轮有三点强化：

### 7.1 「新 API 落在哪个 ctx 键上」——不要只看键表变没变

本轮的 `ctx.fs` / `ctx.net` 都**没有新增 ctx 键**，键表逐字不变。若只看键表会得出"没有新 API"的错误结论。
**正确做法：在 `createPluginContext` 的返回对象里看每个工厂函数的实参个数/形态有没有变**：

```diff
- fs:C(t.id)          # beta.7
+ fs:C(r.id, y)       # beta.11 —— 多了一个 disposable 收集器
- net:T(t,p)          # beta.7
+ net:E(r, v, y)      # beta.11 —— 多了一个 arg
```

实参变多 = 该工厂的返回对象大概率扩充了。**再用能力门禁文案的"项数"交叉验证**（本轮从 16 涨到 17，
新增的 `插件未声明所需文件/下载能力` 就是铁证）。

### 7.2 官方文档是权威，但**必须找对子文档**

`EchoMusicPlugins/docs/plugin-development.md`（144 KB）只是索引。新 API 的完整契约在**新增的**
`files-and-downloads.md` 里。查新 API 时先列 `docs/` 目录，找**新增的文件名**，比在索引里翻快得多。

### 7.3 用「提交级 patch」定位回归的根因

`gh api repos/.../commits/<sha>` 可以直接拿**单个提交**的逐文件 patch。
本轮就是靠它把 `812f152` 的根因读到"`Session.fetch` 在返回 manual redirect 前就 abort"这一层 ——
只看 compare 的文件清单（`electronAxiosAdapter.ts +41/-11`）是看不出所以然的。

```powershell
$c = (((& $gh api "repos/hoowhoami/EchoMusic/commits/812f152" 2>&1) -join "`n")) | ConvertFrom-Json
$c.files | ForEach-Object { $_.filename; $_.patch }
```

---

## 八、结论摘要

1. **beta.10 新增能力 `downloads`**（清单 16 → 17 项），并给 `ctx.fs` / `ctx.net` 加了
   **引用式文件授权 + 流式下载 + 媒体读取**一整套 API；**`createPluginContext` 键表未变**，新 API 全挂在既有键上；
2. 这是**长期限制的解除**：插件终于能在用户授权的任意目录里写文件与下载大文件（**无固定大小上限**），
   不必再用 `Blob` / `showSaveFilePicker` 绕过 —— `song-downloader` 是最大受益者，也是本轮唯一 P1 重构项；
3. 授权绑定**安装身份 UUID**（源自 `installSource`），支持撤销 / 移除 / 重新授权，带 revision 乐观锁，拒绝符号链接；
4. 媒体走自定义协议 `echo-plugin-media`，**URL 是短期租约、不要落盘**；持久化 `DirectoryRef.id` + 相对路径；
5. ⚠️ **beta.11 修了一个打在加速器桥上的回归**：beta.10 的流式下载器把 302 判成 `Redirect was cancelled`
   （`Session.fetch` 在返回 manual redirect 前就 abort），导致**走 GitHub 加速桥安装插件全线失败**；
   beta.11 新增 `fetchWithElectronSession` 修好。**本仓库无需改代码，但要记住这个版本分界**；
6. Release Notes **第五次**被验证是累积的（beta.11 的 25 条「新增」里 24 条是旧的）；
7. 方法上新增一条：**判断"有没有新 API"不能只看 ctx 键表，要看各工厂函数的实参有没有变** + 能力门禁项数交叉验证。
