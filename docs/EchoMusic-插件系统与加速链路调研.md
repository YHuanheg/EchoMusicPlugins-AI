# EchoMusic 插件系统与 GitHub 加速链路调研

> 结论先行：EchoMusic 的「GitHub 加速地址」只接受 **gh-proxy 形态**（`前缀 + / + 完整原始 URL`）。
> Xget 更快、支持平台更多，但它是**路径重写**形态，直接填会 404。
> 插件用两种方式打通：**内置本地桥**（`127.0.0.1` 上只做 302 跳转，零部署，已端到端实测）
> 与**可选云端桥**（Pages Function，插件关掉也生效）。

调研时间：2026-09-19　调研对象：`hoowhoami/EchoMusic`（安装版本 `2.3.2-beta.5`）

---

## 一、EchoMusic 是什么

一个第三方酷狗概念版音乐播放器的桌面客户端，技术栈：

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Electron 43.4 |
| 前端 | Vue 3.5 + TypeScript 5.9 + Vite 8 |
| 状态 | Pinia + 原生 SQLite 持久化 |
| UI | Reka UI + Tailwind CSS v4.3 |
| 音频 | FFmpeg 解码 + SoundTouch 变速 + Rust napi-rs 原生模块 |
| 后端 | 内置本地 Node 服务（进程内调用，`server` 子模块） |
| 包管理 | pnpm（workspace，含 `server` 子模块） |

平台产物：macOS（dmg/zip）、Windows（nsis，x64/arm64）、Linux（deb/rpm/AppImage/tar.gz）。

### 插件系统定位

官方文档写得很直白：**不兼容 Chrome 扩展规范，没有浏览器扩展级的进程与权限沙盒**。
插件是「受用户信任的本地代码」，定位接近 VS Code / Obsidian 的扩展模型。

- `capabilities` 是**运行契约与兼容性检查**，不是安全边界；
- 有配套的**安全模式**：插件导致渲染进程崩溃时自动切入并重载，也可 `--safe-mode` 手动进入；
- 插件禁用/卸载时，宿主会回收页面、设置项、菜单、命令、事件、快捷键、注入的 CSS、DOM 挂载与监听。

---

## 二、插件系统的真实形态（以本机已装的 18 个插件为样本核对）

### 2.1 目录与清单

```
<插件目录>/<插件文件夹>/
  manifest.json   # 必需
  index.js        # main，也支持 .mjs
  style.css       # 可选，仅 .css，宿主自动注入并在禁用时清理
  icon.svg        # 可选
```

本机插件目录（Electron `userData`）：

```
Windows  %APPDATA%\echo-music\plugins
macOS    ~/Library/Application Support/echo-music/plugins
Linux    ~/.config/echo-music/plugins
```

`manifest.json` 关键字段：`id` / `name` / `version` / `description` / `author` / `icon` / `main` / `style` /
`runtime.{miniPlayer,desktopLyric}` / `capabilities{...}` / `requires.echoMusicVersion`（semver range）。

### 2.2 在线插件源

插件源索引固定叫 `echo-plugins.json`，放在仓库根目录，只描述「有哪些插件、在哪个仓库哪个目录」：

```json
{
  "name": "插件源名称",
  "homepage": "https://github.com/owner/repo",
  "plugins": [
    { "id": "gh-accelerator", "path": "gh-accelerator", "repo": "https://github.com/owner/repo", "tags": ["..."] }
  ]
}
```

**版本、描述、作者、图标、能力、兼容性一律以插件目录内的 `manifest.json` 为准**，
插件源索引里不要重复维护这些字段（更新版本只需改插件自己的 manifest）。

安装流程：下载插件仓库 zip → 只提取 `path` 指向的目录 → 再次校验其中的 `manifest.json` → 应用。

本机实测：官方源已被添加为 `github:hoowhoami/echomusicplugins`，
并记录了每个已安装插件的 `plugins:install-source:<id>` 来源信息。

### 2.3 插件运行时 API（本项目实际用到并逐条核对过的）

| API | 说明 | 是否用到 |
| --- | --- | --- |
| `ctx.vue` | Vue 运行时（`h`/`ref`/`reactive`/`computed`/`defineComponent`/`nextTick`…） | ✅ |
| `ctx.stores.settings` / `ctx.settings` | 设置 store（**`githubProxyUrl` 就在这里**） | ✅ |
| `ctx.storage.get/set` | 插件私有 KV，宿主按插件 id 隔离 | ✅ |
| `ctx.ui.addPage({ id, title, icon, component, sidebar })` | 注册插件页面，可同时挂侧边栏 | ✅ |
| `ctx.ui.settings.define({ title, description, component })` | 插件设置面板 | ✅ |
| `ctx.ui.addSongContextMenuItem` / `ui.teleport` / `ui.titlebar.register` | 其它 UI 挂点 | ✖ |
| `ctx.net.request(options)` | 主进程 Axios，可覆盖 `User-Agent` 等禁止头，**不受 CORS 限制**；需 `capabilities.unrestrictedNetwork` | ✅ |
| `ctx.net.fetch` | 渲染进程 Fetch，受 CORS 与禁止头规则约束 | ✅（回退） |
| `ctx.css.inject` | 注入 CSS，禁用自动清理 | ✖（改用 manifest `style`） |
| `ctx.toast.{info,success,warning,danger}` | 应用内提示 | ✅ |
| `ctx.commands.register(id, handler)` | 注册命令 | ✅ |
| `ctx.dispose(fn)` | 清理回调 | ✅ |
| `ctx.appearance.getSnapshot/onSnapshot` | 深浅色、主题色快照（`{ isDark, accentColor }`） | ✖（改用 CSS 变量） |

> 存储落盘位置：`app_kv` 表中 `plugin:<pluginId>:<key>`，与 `ctx.storage.set(key, value)` 一一对应。

### 2.4 宿主主题变量（让插件样式原生融入）

通过统计本机 18 个插件里出现的 CSS 变量，得到宿主实际提供的 token。本插件主要使用：

```
--color-text-main        --color-text-secondary    --color-primary
--color-bg-elevated      --color-bg-card           --color-bg-primary
--border-subtle          --control-border          --control-bg
--control-hover-bg       --control-muted-bg        --color-danger
--color-warning          --font-sans               --font-mono
```

好处：深浅色切换和主题色变更时，插件 UI 自动跟随，无需自己监听主题。
官方文档也明确提醒：**不要**去探针读取 `--color-primary` 或监听 `document` 样式变化（主题切换有过渡动画，会拿到中间色）。

### 2.5 宿主页面 DOM 挂载点（用于把插件 UI 嵌进宿主界面）

宿主对插件页的包装元素是 `plugin-page-host h-full min-h-0 overflow-hidden`（**只裁剪、不滚动**）。
而要把 UI 塞进宿主的**内置页面**，需要知道它的类名。从 app.asar 里提取到的插件管理页结构：

| 类名 | 位置 | 用途 |
| --- | --- | --- |
| `.plugin-header` | 插件管理页顶部（`shrink-0 px-6 pt-4 pb-3`） | 标题 + 安全模式开关 + 视图标签 |
| `.plugin-view-tabs` | header 内（`mt-4`） | 「全部 / 已安装 / 在线插件 / 来源」切换 |
| `.plugin-content` | 内容区（`px-6 pb-6`） | 各视图内容容器 |
| `.marketplace-toolbar` | 仅「在线插件」视图 | 搜索框 + 来源筛选 + 一键更新 |
| `.plugin-card-grid` | 卡片网格 | 插件卡片列表 |
| `.plugin-source-manager` / `.plugin-source-row` | 「来源」视图 | 插件源管理 |
| `.plugin-card` / `plugin-card-actions` / `plugin-card-primary-actions` | 卡片内部 | 安装/更新按钮所在处 |

注入方式（官方插件 `channel-wander` 的写法，也是本插件采用的）：

```js
function inject() {
  if (document.querySelector('.my-strip-host')) return      // 防重复
  const anchor = document.querySelector('.marketplace-toolbar')
  if (!anchor?.parentNode) return
  const host = document.createElement('div')
  host.className = 'my-strip-host'
  anchor.parentNode.insertBefore(host, anchor.nextSibling)
  dispose = ctx.ui.mount(host, MyComponent)                 // 传入 Element
}
const stop = ctx.dom.observe('.marketplace-toolbar', inject) // 动态出现时触发
ctx.dispose(() => { stop(); /* 自行清理 DOM 与 mount */ })
```

要点：`ctx.ui.mount` 接受 **Element**（不只是选择器），所以可以自建容器再挂载，
这样「开关关闭时移除」就能靠 `container.remove()` + `mount` 返回的 dispose 实现；
宿主重渲染后旧容器会脱离文档，注入前要用 `isConnected` 检查并回收。

### 2.6 在线插件市场的刷新链路（逆向 app.asar，用于做进度显示）

宿主**不向插件暴露任何进度事件**，也没有字节回调。完整链路如下：

```
刷新按钮 → loadMarketplace(refresh=true) → N_() → D_()
  → 每个启用的源 并行执行：
      ① x_(indexUrl)  拉 echo-plugins.json（这里才知道插件总数 N）
      ② b_()          并行拉 N 个 manifest（Promise.allSettled）
      ③ C_()          返回 pluginCount
  → Pg(cache) 写缓存 → fetchedAt = Date.now()
  → E_() 补 iconUrl / downloadUrl（ku()）+ POST 热度统计
```

- 索引地址：`raw.githubusercontent.com/hoowhoami/EchoMusicPlugins/HEAD/echo-plugins.json`
  （仓库常量 `Yd = https://github.com/hoowhoami/EchoMusicPlugins`）。
- 缓存新鲜度 `Eu(fetchedAt, sources, refresh)`：`refresh` 为真 / `fetchedAt` 为 0 或未来 → 必刷；
  否则有 `lastError` 或缺 `lastFetchedAt` 时 60 秒，常态 300 秒。

**可观测的 DOM 契约**（做进度只能靠这些）：

| 选择器 | 含义 |
| --- | --- |
| `.plugin-card-grid[aria-busy="true"]` | **仍在加载**（宿主渲染 6 张骨架卡） |
| `.plugin-card-grid`（无 `aria-busy`） | 里面才是真实卡片 |
| `.plugin-content-heading > span` | 计数文案，形如「共 N 个 · …」 |
| `.marketplace-toolbar` 内的 `button` | 刷新按钮；拉取中图标带 `animate-spin` |

> ⚠️ 骨架卡和真实卡片**都**带 `.plugin-card.marketplace-card`，
> 必须靠**网格的 `aria-busy`** 区分，看卡片自身是分不出来的。

**进度只能推定**，插件用三路融合：① DOM 骨架（是否在拉、在哪段）② 真实卡片计数（已到手的代理）
③ 主动探针（自己按宿主同样的加速前缀拉一次索引 → 拿到总数 N 与真实字节/耗时）。
分母可信用「已到手/总数」，否则退回阶段权重。

**可选精确模式**：在刷新按钮上盖一个透明命中层，由插件自己驱动
`window.electron.plugins.marketplace.list({ githubProxyUrl, refresh: true })`，
返回的 `plugins` 数组长度即真实支数。不用 `.click()` 代理是因为宿主在拉取中会给按钮加 `disabled`，点了会被吞掉。

> 两个实现层面的坑：① `ctx.dom.observe()` 会**同步触发一次**回调，
> 被回调引用的 `let` 必须声明在 `observe()` 之前，否则命中 TDZ 直接激活失败；
> ② `computed` 里读 `Date.now()` 不会随时间重算（时间不是响应式依赖），
> 「已用/约剩/倒计时」需要一个心跳计数器显式建立依赖。

---

## 三、GitHub 加速链路（本次调研的核心发现）

### 3.1 设置项在哪里

| 项 | 值 |
| --- | --- |
| UI 位置 | 设置 → 更新 → 「GitHub 加速地址」 |
| 输入框 placeholder | `https://ghfast.top` |
| 说明文案 | 用于更新和在线插件；失败后自动切回原始 GitHub，两段均服从全局代理规则 |
| 存储键 | 设置 store 的 `githubProxyUrl`（落盘在 `app_kv` 的 `pinia:setting`） |
| 本机当前值 | **空**（即直连 GitHub） |

### 3.2 宿主如何拼接加速 URL

从主进程 bundle 中提取到的实际实现（变量名已压缩，逻辑等价）：

```js
const trim = (v) => String(v ?? '').trim().replace(/\/+$/, '')

const isGithubUrl = (u) => {
  try {
    const { hostname } = new URL(u)
    return hostname === 'github.com'
        || hostname === 'raw.githubusercontent.com'
        || hostname === 'codeload.github.com'
        || hostname.endsWith('.githubusercontent.com')
  } catch { return false }
}

const accelerate = (url, proxy) => {
  const target = String(url ?? '').trim()
  const base = trim(proxy)
  if (!target || !base || !/^https?:\/\//i.test(target) || !isGithubUrl(target)) return target
  return `${base}/${target}`      // ← 关键：简单拼接「前缀 / 完整原始 URL」
}
```

调用点：更新检查的 Release 资源下载、插件源索引拉取、插件 `manifest.json` 拉取、插件 zip 包下载。

**因此配置值的语义是「gh-proxy 形态前缀」**，而不是「任意反向代理域名」。

### 3.3 实测：Xget 与宿主格式不兼容

`<你的 Xget 域名>` 是 Xget 在 Cloudflare Pages 上的部署。Xget 的 URL 规则是
`https://<host>/<平台前缀>/<平台内路径>`，与上面的拼接方式冲突。

| 请求 | 状态 | 耗时 |
| --- | --- | --- |
| `https://<你的 Xget 域名>/gh/hoowhoami/EchoMusic/raw/main/docs/plugin-system.md` | ✅ 200 | 576 ms |
| `https://<你的 Xget 域名>/https://raw.githubusercontent.com/hoowhoami/EchoMusic/main/docs/plugin-system.md` | ❌ 404 | — |
| `https://<你的 Xget 域名>/gh/https://raw.githubusercontent.com/hoowhoami/EchoMusic/…` | ❌ 404 | — |
| `https://<你的 Xget 域名>/gh/github.com/hoowhoami/EchoMusic/archive/refs/heads/main.zip` | ❌ 404 | — |

（对照）gh-proxy 形态：

| 请求 | 状态 | 耗时 |
| --- | --- | --- |
| `https://gh-proxy.com/https://raw.githubusercontent.com/hoowhoami/EchoMusic/…` | ✅ 200 | 548 ms |
| `https://ghproxy.net/https://raw.githubusercontent.com/hoowhoami/EchoMusic/…` | ✅ 200 | 907 ms |
| `https://ghfast.top/https://raw.githubusercontent.com/hoowhoami/EchoMusic/…` | ⏱ 超时 | — |
| `https://gh.llkk.cc/https://raw.githubusercontent.com/hoowhoami/EchoMusic/…` | ⏱ 超时 | — |
| `https://github.moeyy.xyz/…` | ⏱ 超时 | — |
| `https://github.akams.cn/…` | 🔒 TLS 信任失败 | — |

> 公共镜像的可用性随时间和地区剧烈波动，**这正是插件必须内置「实测排序」而不是硬编码一条默认线路的原因**。

### 3.4 实测：Xget 的路径重写规则

Xget 的 `gh` 前缀对应的是 **`github.com` 的网页路径结构**，直接把 `raw.` / `codeload.` 的原始路径拼上去会 404，
必须先换算成等价的 `github.com` 路径：

| 原始 URL | 必须换算成 | 实测 |
| --- | --- | --- |
| `raw.githubusercontent.com/o/r/ref/f` | `/gh/o/r/raw/ref/f` | ✅ 200 |
| `codeload.github.com/o/r/zip/refs/heads/b` | `/gh/o/r/archive/refs/heads/b.zip` | ✅ 200 |
| `github.com/o/r/archive/refs/heads/b.zip` | `/gh/o/r/archive/refs/heads/b.zip` | ✅ 200 |
| `github.com/o/r/raw/ref/f` | `/gh/o/r/raw/ref/f` | ✅ 200 |

这个换算已经实现在插件的 `githubFamilyPath()` 里，并用真实请求验证过。

### 3.5 吞吐对比（实测，同一台机器、同一文件）

插件默认拿 `EchoMusicPlugins` 仓库的 zip 做吞吐测试（体积足够，且正好是插件市场的真实场景）：

| 线路 | 形态 | 传输量 | 耗时 | 吞吐 |
| --- | --- | --- | --- | --- |
| Xget 实例 | Xget | 465 KB | 787 ms | **577 KB/s** |
| Xget 实例（codeload 大包） | Xget | 23.9 MB | 4.64 s | **5.0 MB/s** |
| `gh-proxy.com` | gh-proxy | 264 KB | 854 ms | 302 KB/s |
| `ghproxy.net` | gh-proxy | 274 KB | 1196 ms | 224 KB/s |

**Xget 在吞吐上明显占优**，但受 3.3 的形态约束不能直填——这就是桥接函数存在的意义。

### 3.6 公益加速源普查（38 条候选 → 24 条可用）

清单来源：XIU2 的「Github 增强 - 高速下载」油猴脚本（`@version 2.6.41`）。
该脚本人工维护了一份规模最大的公益加速源列表，且**带节点地区与缓存说明**，
是目前质量最高的一份；但它没有做可用性校验（只把已知挂掉的注释掉）。

把其中的 gh-proxy 形态前缀抽出，**在本机逐条实测**（取真实 GitHub 文件，9 秒超时，并发 8）：

| 结果 | 数量 | 节点 |
| --- | --- | --- |
| ✅ 可用 | 24 | `wget.la`(532ms)、`git.yylx.win`、`gh-proxy.com`、`g.blfrp.cn`、`gitproxy.mrhjx.cn`、`ghproxy.net`、`gh.xxooo.cf`、`gh.monlor.com`、`hk.gh-proxy.org`、`cdn.gh-proxy.org`、`edgeone.gh-proxy.org`、`github.ednovas.xyz`、`ghproxy.monkeyray.net`、`ghpxy.hwinzniej.top`、`gh.chjina.com`、`gh-proxy.org`、`ghp.keleyaa.com`、`github.boki.moe`、`gh.zwy.one`、`ghproxy.cxkpro.top`、`github.geekery.cn`、`ghfile.geekertao.top`、`cdn.crashmc.com`、`gh.ddlc.top`(4150ms) |
| ❌ 限流 | 2 | `gh.h233.eu.org`(403)、`gh.idayer.com`(429) |
| ❌ 超时 | 4 | `ghfast.top`、`ghproxy.it`、`github.moeyy.xyz`、`gh.llkk.cc` |
| ❌ 失败 | 8 | `github.akams.cn`、`gh.jasonzeng.dev`、`fastly.jsdelivr.net`、`raw.ihtw.moe`(DNS)、`cors.isteed.cc`(404) 等 |

**结论**：

1. 本插件原来的 6 条预置里有 4 条已失效 —— 静态清单一定会腐坏，**必须保留运行时实测排序**；
2. 从这份清单里可以补充到 24 条可用节点，比原预置多 20 条，选择性大幅提升；
3. XIU2 脚本里的 `download_url_us` 特意做「每次随机 6 个美国节点」以分散压力，
   并在说明里请用户优先用美国节点 —— 这是公益节点能活下去的关键。插件的「负载均衡」选项采纳了同样思路。

**jsDelivr 不适合本场景**：`/gh/user/repo@branch/file` 形态**不支持 >50 MB 文件**
（插件包上限 80 MB）、且**不支持 `v1.2.3` 形式的分支名**，所以没有收进预置。

### 3.7 未被采纳的形态

| 形态 | 例子 | 为什么不收 |
| --- | --- | --- |
| 路径形态 | `cors.isteed.cc/github.com/...`、`raw.ihtw.moe/github.com/...` | 与宿主 `{前缀}/{完整URL}` 拼接规则不符，且实测 404 / DNS 失败 |
| jsDelivr | `fastly.jsdelivr.net/gh/user/repo@branch/file` | 50 MB 上限 + 分支名格式限制，与插件包下载场景冲突 |
| Git Clone 加速 | `gitclone.com`、`githubfast.com` | 面向 `git clone`，不是 HTTP 文件下载 |

---

## 四、方案：让Xget 也能当宿主加速地址

### 4.1 前提：宿主的下载器跟随重定向

从主进程 bundle 挖到插件市场的下载实现：

```js
$s = async (url, options) => (await getSession()).fetch(url instanceof URL ? url.toString() : url, options)
```

也就是 **Electron 的 `session.fetch()`**，按 Fetch 规范默认 `redirect: 'follow'`，
并且会走宿主配置的全局代理。这决定了「用 302 把 gh-proxy 形态转成 Xget 形态」是可行的。

### 4.2 首选：插件内置本地桥（零部署）

插件用 `ctx.webServer` 在 `127.0.0.1` 起一个只做 302 跳转的本地服务：

```
宿主  →  http://127.0.0.1:47823/https://github.com/o/r/archive/refs/heads/main.zip
      ←  302  Location: https://<你的 Xget 域名>/gh/o/r/archive/refs/heads/main.zip
      →  Xget 200 + 文件内容
```

**为什么必须用重定向、不能反向代理**：`ctx.webServer` 的单次响应体上限是 **8 MB**，
而插件市场允许的 zip 上限是 **80 MB**（主进程里 `a.byteLength>83886080` 才报错），
代理必然失败；重定向还能保留 Xget 的 Range / 缓存 / 重试语义，也不占用本地带宽。

关键实现点：

- 端口必须**固定**（默认 `47823`，可配），否则宿主里存的前缀会在重启后失效；
- 插件启动时若发现宿主加速地址仍指向本地桥且开启了「自动恢复」，会重新监听该端口；
- 插件被禁用/卸载或宿主退出时端口释放，宿主按官方逻辑自动回退原始 GitHub，不会卡死更新；
- 处理器只做纯字符串换算，不做任何网络请求，因此没有超时风险。

端到端实测（真实 HTTP 客户端，走完整 302 链路）：

| 通过桥请求 | 结果 | 传输量 | 吞吐 |
| --- | --- | --- | --- |
| `EchoMusicPlugins` 仓库 zip | ✅ 200 | 465 KB | 308 KB/s |
| `codeload` 大包 | ✅ 200 | 23.9 MB | 4.5 MB/s |
| `raw` 小文件 | ✅ 200 | 3.8 KB | — |
| 含 query 的 URL | ✅ 200 | 16.8 KB | — |
| 不支持的主机 | ✅ 502（按设计拒绝） | — | — |

最终 URL 均落在 `https://<你的 Xget 域名>/gh/...`。

### 4.3 备选：云端桥（不改插件也生效）

在 Xget 的 Cloudflare Pages 项目里加一个 catch-all Function（见 `docs/xget-bridge/`）：

- 只拦截 `/{http(s)://...}` 这种 gh-proxy 形态的请求；
- 解析后按平台换算成 Xget 的规范路径，**302 重定向**过去；
- 其它请求 `next()` 放行，不影响 Xget 原有路由。

优点是不依赖插件生命周期（插件关掉也加速）；代价是需要一次部署。

> 该函数逻辑已按 Pages Functions 规范编写并对 URL 换算做了离线校验，但**未经线上部署验证**。

---

## 五、设计决策记录

| 决策 | 理由 |
| --- | --- |
| 用「真实下载一个 GitHub 文件」测速，而不是 ping 站点根目录 | 根目录可达不代表能取到 GitHub 内容；实测下载同时覆盖 DNS / TLS / 代理 / 上游 / 限流 |
| 区分 gh-proxy 与 Xget 两类线路并明确标注 | 避免用户把 Xget 域名填进宿主设置后得到 404 却不知道原因 |
| 写入宿主设置后回读校验 | Pinia 写入可能静默失败；回读能把「看起来成功」变成「确定成功」 |
| 不可达线路只标红、不重试轰炸 | 公共镜像常有超时；并发压测会放大失败，且插件对单次测速已设超时 |
| 只用宿主 CSS 变量，不硬编码颜色 | 深浅色与主题色自动跟随，零维护 |
| 不引入构建步骤（纯 ESM 单文件） | 降低安装与审计门槛，用户可以直接读源码 |
| Xget 走「本地桥 302」而不是反向代理 | 本地服务的单次响应体上限是 8 MB，而插件 zip 上限 80 MB，代理必然失败；重定向还保留 Xget 的 Range 与缓存语义 |
| 本地桥端口固定且可配置 | 宿主里存的加速前缀必须跨主程序重启有效，随机端口会导致失效 |
| 启用桥时同时写「回读校验」+ 提供自检按钮 | 桥涉及宿主设置、本地端口、重定向三方，必须能一次性定位失败环节 |

---

## 六、参考

- `hoowhoami/EchoMusic` — 主程序，`docs/plugin-system.md` 说明插件系统的用户语义
- `hoowhoami/EchoMusicPlugins` — 官方插件源与 `docs/plugin-development.md`（插件 API 权威文档）
- `xixu-me/xget` — Xget 加速引擎与 URL 转换规则
- `KenDvD/xget-enhanced` — 油猴脚本「Xget 加速器增强版」，本插件的多线路 + 测速 + 故障回退思路来源
- `blingbling-bow/HugoAura-Enhanced-Install` — 多镜像测速换源思路的参考实现
