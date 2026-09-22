# Xget ⇄ gh-proxy 形态桥接

**可选增强，插件本身不依赖它。**

## 要解决什么

EchoMusic 的「GitHub 加速地址」实际请求的是：

```
<你填的前缀>/<完整原始 URL>
```

也就是 gh-proxy 形态。而自建 Xget 是路径重写形态：

```
https://xget-ckf.pages.dev/gh/owner/repo/archive/refs/heads/main.zip
```

两者不兼容，实测把 Xget 域名填进宿主设置会拼出 404（详见 `../EchoMusic-插件系统与加速链路调研.md` 第 3.3 节）。

加上这个 Pages Function 之后：

```
宿主请求  https://xget-ckf.pages.dev/https://github.com/o/r/archive/refs/heads/main.zip
   ↓ 302
Xget      https://xget-ckf.pages.dev/gh/o/r/archive/refs/heads/main.zip
   ↓ 200
         （真正的文件内容，带 Xget 的边缘缓存与重试）
```

于是宿主里填 `https://xget-ckf.pages.dev` 就能用上 Xget。实测自建 Xget 的吞吐在测试环境下约为
`gh-proxy.com` 的 **1.9×**（577 KB/s vs 302 KB/s），大包场景可达 **5 MB/s**。

## 部署

1. 把 `functions/[[path]].js` 放到你的 Xget Cloudflare Pages 项目的 **`functions/`** 目录下；
2. 重新部署：`wrangler pages deploy <你的输出目录>`，或直接 push 触发 Git 集成构建；
3. 验证重定向：

```bash
curl -sI 'https://xget-ckf.pages.dev/https://github.com/git/git/archive/refs/heads/master.zip' | head -5
```

期望看到 `HTTP/2 302`，且 `location` 形如 `https://xget-ckf.pages.dev/gh/git/git/archive/refs/heads/master.zip`。

4. 再验证 Xget 本身没被影响：

```bash
curl -sI 'https://xget-ckf.pages.dev/gh/hoowhoami/EchoMusic/raw/main/docs/plugin-system.md' | head -3
```

期望仍是 `200`。

5. 最后在 EchoMusic「设置 → 更新 → GitHub 加速地址」填 `https://xget-ckf.pages.dev`，
   进「插件管理」刷新在线插件列表验证。

## 实现要点

- **只拦截 `/{http(s)://...}` 形态**，其余请求原样 `next()` 放行，不碰 Xget 原有路由；
- 用 **302 重定向**而非反向代理：不改动 Xget 的响应头、`Cache-Control`、Range 与流式语义，
  宿主（Axios / Electron net）都会跟随重定向；
- 路径重写复用了与插件一致的规则，包括 `raw.githubusercontent.com` → `github.com/.../raw/...`、
  `codeload.github.com` → `github.com/.../archive/...` 的换算；
- 正则容忍 Cloudflare 把 `//` 折叠成 `/` 的情况。

## 已知限制

- **未经线上部署验证**：函数逻辑已按 Cloudflare Pages Functions 规范编写并对 URL 转换做了离线校验，
  但需要在你的项目上部署后按上面的步骤实测。
- 如果你的 Xget Pages 项目使用 **`_worker.js` 高级模式**，`functions/` 目录会被忽略，
  需要把 `buildXgetPath()` / `extractOriginalUrl()` 的逻辑搬进 `_worker.js` 的路由分支。
- 增加了 1 次重定向往返（通常几毫秒），换来的是 Xget 的缓存与重试能力。

## 如果不部署

完全没问题。插件会实测所有 gh-proxy 形态线路并让宿主直接使用最快的一条，
Xget 分组继续用于「转换并复制链接」。桥接只是让 Xget 也能直接服务宿主设置。
