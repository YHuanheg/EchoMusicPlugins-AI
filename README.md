# EchoMusic 插件合集

给 [EchoMusic](https://github.com/hoowhoami/EchoMusic) 写的插件，一个仓库当**在线插件源**用。

```
.
├─ echo-plugins.json                  # EchoMusic 插件源索引（推到 GitHub 后可在线安装）
├─ gh-accelerator/                    # 插件：GitHub 加速器
│  ├─ manifest.json
│  ├─ index.js                        # 纯 ESM 单文件，无构建步骤
│  ├─ style.css                       # 全部使用宿主主题变量
│  ├─ icon.svg
│  └─ README.md
├─ kugou-daily-vip/                   # 插件：概念版每日领VIP
├─ kugou-recommend/                   # 插件：推荐电台（多源音乐推荐）
├─ tests/                             # 无头集成测试 + 真实网络冒烟 + 变异测试
│  ├─ kugou-recommend.smoke.mjs      # 真实 Vue 3 ESM + mock ctx，275 条断言
│  ├─ kugou-recommend.live.mjs       # 打真实网关，验证上游形态确实能解析
│  └─ mutate-check.mjs               # 把关键行为改回 bug，确认测试真的会失败
└─ docs/
   ├─ EchoMusic-插件系统与加速链路调研.md   # 调研 + 实测数据 + 设计决策
   └─ xget-bridge/                        # 可选：让Xget 兼容宿主格式的 Pages Function
      ├─ functions/[[path]].js
      └─ README.md
```

## 插件一览

| 插件 | id | 一句话 | 文档 |
|---|---|---|---|
| **GitHub 加速器** | `gh-accelerator` | 为宿主的更新检查与在线插件下载挑选最快线路，把Xget 接进来，并在在线插件页显示加速状态与刷新进度 | [README](gh-accelerator/README.md) |
| **概念版每日领VIP** | `kugou-daily-vip` | 每天自动领取酷狗概念版畅听 VIP（听歌 + 广告 + 签到） | [README](kugou-daily-vip/README.md) |
| **推荐电台** | `kugou-recommend` | 八源音乐推荐：频道漫游 / 每日推荐 / 猜你喜欢 / 曲风 / AI / 新歌 / 历史 / 排行 | [README](kugou-recommend/README.md) |

## 安装

**方式一：在线安装（推荐）**

EchoMusic「插件管理 → 在线插件源」里添加：

```
https://github.com/YHuanheg/EchoMusic-GhAccelerator
```

宿主会自动读取仓库根目录的 `echo-plugins.json`。

**方式二：本地安装**

```powershell
# Windows：把插件文件夹复制进 EchoMusic 插件目录
Copy-Item -Recurse -Force ".\kugou-recommend" "$env:APPDATA\echo-music\plugins\kugou-recommend"
```

macOS：`~/Library/Application Support/echo-music/plugins/`　Linux：`~/.config/echo-music/plugins/`

然后在「插件管理」→ 刷新插件列表 → 启用。

---

# 推荐电台（`kugou-recommend`）

参考 [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)，把酷狗的推荐类接口
（`everyday_*` / `fm_*` / `personal_fm` / `ai_recommend_*` / `top_song` / `user_history` / `youth_*`）
编排成一个**能播、能续杯、能反馈**的推荐电台。

**八个推荐源**，两条取数通道：

| 源 | 通道 | 登录 | 无限流 |
|---|---|---|---|
| 频道漫游（默认） | 概念版网关直连 | 否 | ✅ |
| 每日推荐 | 本地路由 `/everyday/recommend` | 是 | — |
| 猜你喜欢 | 本地路由 `/personal/fm` | 否 | ✅ |
| 曲风推荐 | 本地路由 `/everyday/style/recommend` | 是 | — |
| AI 推荐 | 本地路由 `/ai/recommend/song` | 是 | ✅ |
| 新歌速递 | 本地路由 `/top/song` | 否 | ✅ |
| 每日历史 | 本地路由 `/everyday/history` | 是 | — |
| 听歌排行 | 本地路由 `/user/history` | 是 | — |

```
① 本地路由通道   ctx.electron.api.request({ url: '/everyday/recommend' })
                 └─ 主进程内的 KuGouMusicApi 模块（resources/server/module/*.js）
                    路由换算：模块文件名去掉 .js，再把 _ 换成 /
                    签名 / 加密 / 设备指纹 / cookie 注入全部由宿主完成

② 网关直连通道   ctx.net.request({ url: 'https://gateway.kugou.com/youth/...' })
                 └─ 概念版（youth）网关，与官方插件 channel-wander 同源同款
                    无需登录，是「没有账号也能用」的兜底
```

核心能力：单曲/整批播放、**推荐电台自动续杯**（播完自动补下一批）、喜欢与「不感兴趣」、
跨批去重、**每个源各自保留列表**（多标签页式，切回去直接恢复不重新请求）、
**切源自动刷新开关**（可关掉，只换源不立即拉取）、**按 hash 反查歌曲信息**
（听歌排行只给 hash，靠 `/privilege/lite` 补全歌名歌手）、源健康检查
（一键看到各源 HTTP / error_code / 条数 / 耗时，含重试标记与「未识别」告警）、复制诊断。

两套测试：

```
tests/kugou-recommend.smoke.mjs   无头集成测试（真实 Vue 3 ESM + mock ctx） 275/275 通过
tests/kugou-recommend.live.mjs    真实网络冒烟（打真实网关）                 19/19  通过
tests/mutate-check.mjs            变异测试（改回 bug，确认断言有效）           7/7   被抓到
```

```powershell
# 跑测试（需要一份 Vue 浏览器 ESM 构建，可用 VUE_ESM_PATH 指定）
node tests/kugou-recommend.smoke.mjs
node tests/kugou-recommend.live.mjs
node tests/mutate-check.mjs
```

完整说明、错误码对照与踩坑记录见 [`kugou-recommend/README.md`](kugou-recommend/README.md)。

---

# GitHub 加速器（`gh-accelerator`）

> 当前版本 **1.1.0**（新增：在线插件页刷新进度 / 数量 / 速率）

为宿主的**更新检查**与**在线插件市场下载**挑选最快的 GitHub 加速线路，并提供 Xget 多平台链接转换。

## 一句话结论

EchoMusic 的「GitHub 加速地址」只接受 **gh-proxy 形态**（`前缀 + / + 完整原始 URL`）；
Xget 更快、支持 20+ 平台，但属于**路径重写**形态，直接填入会 404（实测确认）。

插件用两条路把 Xget 接进来：

| 方式 | 说明 | 是否需要外部部署 |
| --- | --- | --- |
| **本地桥（内置）** | 插件用 `ctx.webServer` 在 `127.0.0.1` 起一个只做 302 跳转的服务，把宿主请求换算成 Xget 规范路径 | 不需要，插件内一键启用 |
| **云端桥（可选）** | 在 Xget 的 Cloudflare Pages 项目加一个 catch-all Function | 需要一次部署，但插件关掉也生效 |

## 快速开始

**1. 在 EchoMusic 里启用**

「插件管理」→ 刷新插件列表 → 启用「GitHub 加速器」→ 侧边栏「插件」分组会出现「加速器」。

**2. 启用 Xget 加速（推荐）**

进入「加速器」页面 →「Xget 本地加速」卡片 → 点「启用 Xget 加速」→ 点「自检」确认链路通
→ 回「插件管理」刷新在线插件列表即可。

想改用公共 gh-proxy 镜像：等自动测速完成，在 gh-proxy 分组里点最快那条右侧的 ⬆。

## 实测数据（2026-09-19，本机）

线路可用性差异极大，**这就是必须实测排序、不能硬编码默认线路的原因**：

| 线路 | 形态 | 探测文件 | 插件 zip 吞吐 |
| --- | --- | --- | --- |
| Xget 实例 | Xget | ✅ 200 / 1121 ms | **577 KB/s**（大包 5.0 MB/s） |
| `gh-proxy.com` | gh-proxy | ✅ 200 / 766 ms | 302 KB/s |
| `ghproxy.net` | gh-proxy | ✅ 200 / 862 ms | 224 KB/s |
| `ghfast.top` | gh-proxy | ⏱ 超时 | — |
| `gh.llkk.cc` | gh-proxy | ⏱ 超时 | — |
| `github.moeyy.xyz` | gh-proxy | ⏱ 超时 | — |
| `github.akams.cn` | gh-proxy | 🔒 TLS 信任失败 | — |

### 本地桥 + Xget 端到端实测

用真实 HTTP 客户端通过本地桥取真实 GitHub 文件（等价于宿主 `session.fetch()` 的行为）：

| 通过桥请求 | 结果 | 传输量 | 吞吐 |
| --- | --- | --- | --- |
| `EchoMusicPlugins` 仓库 zip（插件市场真实场景） | ✅ 200 | 465 KB | 308 KB/s |
| `codeload` 大包（等价换算） | ✅ 200 | 23.9 MB | **4.5 MB/s** |
| `raw` 小文件（探测文件） | ✅ 200 | 3.8 KB | — |
| 含 query 的 URL | ✅ 200 | 16.8 KB | — |
| 不支持的主机 | ✅ 502（按设计拒绝） | — | — |

最终响应 URL 均落在 `https://<你的 Xget 域名>/gh/...`，证明 302 → Xget 的链路成立。

**公益加速源普查（2026-09-19）**：以 [XIU2/UserScript](https://github.com/XIU2/UserScript)
「Github 增强 - 高速下载」维护的公益加速源清单为来源，逐条在本机实测 ——
**38 条候选里 24 条可用**。其中 `gh.h233.eu.org` 返回 403、`gh.idayer.com` 返回 429（限流），
`ghfast.top` / `ghproxy.it` / `github.moeyy.xyz` / `gh.llkk.cc` 超时。
插件预置清单已按实测结果换成这 24 条（旧预置里 4 条已失效），并附带地区标签。
详见 [`gh-accelerator/README.md`](gh-accelerator/README.md) 的「预置线路」一节。

**Xget 形态不兼容宿主设置**（实测）：

| 请求 | 结果 |
| --- | --- |
| `<你的 Xget 域名>/gh/owner/repo/raw/main/file.md` | ✅ 200 |
| `<你的 Xget 域名>/https://raw.githubusercontent.com/...` | ❌ 404 |
| `<你的 Xget 域名>/gh/https://raw.githubusercontent.com/...` | ❌ 404 |

完整数据与推导过程见 [`docs/EchoMusic-插件系统与加速链路调研.md`](docs/EchoMusic-插件系统与加速链路调研.md)。

## 插件能力

- 一键测速 + 按吞吐排序（真实下载 GitHub 文件，而不是 ping 站点根目录）
- **Xget 本地桥加速**：一键让Xget 接管宿主加速地址，含完整链路自检
- **在线插件界面加速状态条**：在「插件管理 → 在线插件」直接显示当前线路、实时速度与快捷操作
- 一键把最快线路写入宿主 `githubProxyUrl`，写入后回读校验
- 单条线路吞吐测速，区分「能连通」与「真的快」
- 自定义线路增删（gh-proxy / Xget 两种形态）
- **24 条实测可用的公益加速源**，带地区标签；可选「负载均衡」在最快 4 条里随机，避免打挂单个节点
- 单条与批量链接转换，一键复制
- 排除规则（正则 / 字面量）
- 统计面板与完整设置项（并发、超时、测速文件、体积上限、桥端口、调试日志）

---

# 安全边界

三个插件都遵守同一套边界：

- 只读写自己命名空间下的 `ctx.storage`（`plugin:<插件id>:<key>`）；
- 不采集、不上传任何用户数据；
- EchoMusic 插件不是浏览器沙盒，安装第三方插件前请自行确认来源可信。

## 许可

MIT。
