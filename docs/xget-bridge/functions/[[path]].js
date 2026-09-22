/**
 * Xget ⇄ gh-proxy 形态桥接（Cloudflare Pages Function）
 *
 * 背景
 *   EchoMusic 的「GitHub 加速地址」拼的是 `<前缀>/<完整原始 URL>`（gh-proxy 形态），
 *   而自建 Xget 用的是路径重写形态（`/<平台前缀>/<平台内路径>`）。直接把 Xget 域名
 *   填进宿主设置会拼出 404。
 *
 * 这个函数把两者接起来：
 *   GET /https://github.com/owner/repo/archive/refs/heads/main.zip
 *     → 302 → /gh/owner/repo/archive/refs/heads/main.zip
 *
 * 于是宿主里填 `https://<你的 Xget 域名>` 就能用上 Xget 的带宽与多平台能力。
 * 用 302 而不是反向代理，是为了不改动 Xget 的响应头、缓存与 Range 语义。
 *
 * 部署（Cloudflare Pages）
 *   1. 把本文件放到 Xget Pages 项目的 `functions/[[path]].js`；
 *   2. 重新部署（`wrangler pages deploy` 或 Git 集成）；
 *   3. 验证：
 *        curl -sI 'https://<你的域名>/https://github.com/git/git/archive/refs/heads/master.zip' | head -3
 *        期望看到 302，Location 指向 /gh/git/git/archive/refs/heads/master.zip
 *
 * 注意
 *   · 只拦截形如 `/{http(s)://...}` 的路径，其余请求全部 next() 放行，不影响 Xget 自身路由；
 *   · 若你的 Xget Pages 项目使用 `_worker.js` 高级模式，functions/ 目录会被忽略，
 *     需要把 buildXgetPath() 与 onRequest() 的逻辑搬进 `_worker.js` 的路由分支里。
 */

/** 主机 → Xget 平台前缀（GitHub 系主机单独处理，见 githubFamilyPath） */
const PLATFORM_PREFIX = {
  'gitlab.com': 'gl',
  'gitea.com': 'gitea',
  'codeberg.org': 'codeberg',
  'sourceforge.net': 'sf',
  'android.googlesource.com': 'aosp',
  'huggingface.co': 'hf',
  'civitai.com': 'civitai',
  'registry.npmjs.org': 'npm',
  'pypi.org': 'pypi',
  'files.pythonhosted.org': 'pypi',
  'crates.io': 'crates',
  'repo1.maven.org': 'maven',
  'arxiv.org': 'arxiv',
  'f-droid.org': 'fdroid'
}

function githubFamilyPath(url) {
  const parts = url.pathname.split('/').filter(Boolean)

  switch (url.hostname) {
    case 'github.com':
      return `/gh${url.pathname}`

    case 'raw.githubusercontent.com': {
      if (parts.length < 3) return null
      const [owner, repo, ref, ...rest] = parts
      return `/gh/${owner}/${repo}/raw/${ref}${rest.length ? `/${rest.join('/')}` : ''}`
    }

    case 'objects.githubusercontent.com':
    case 'avatars.githubusercontent.com':
      return `/gh${url.pathname}`

    case 'codeload.github.com': {
      const match = /^\/([^/]+)\/([^/]+)\/(zip|tar\.gz|tar\.bz2)\/(.+)$/.exec(url.pathname)
      if (!match) return null
      const ext = match[3] === 'zip' ? '.zip' : match[3] === 'tar.gz' ? '.tar.gz' : '.tar.bz2'
      return `/gh/${match[1]}/${match[2]}/archive/${match[4]}${ext}`
    }

    case 'gist.github.com':
    case 'gist.githubusercontent.com':
      return `/gist${url.pathname}`

    default:
      return null
  }
}

/** 把任意受支持平台的原始 URL 换写成 Xget 规范路径；不支持时返回 null */
export function buildXgetPath(url) {
  if (!url || !url.hostname) return null

  const githubPath = githubFamilyPath(url)
  if (githubPath) return githubPath

  const prefix = PLATFORM_PREFIX[url.hostname]
  if (!prefix) return null
  return `/${prefix}${url.pathname}${url.search}`
}

/**
 * 从 gh-proxy 形态的 pathname 里取出原始 URL。
 * 容忍 Cloudflare 把 `//` 折叠成 `/` 的情况。
 */
export function extractOriginalUrl(pathname) {
  const match = /^\/(https?):(\/{1,2})(.+)$/i.exec(pathname || '')
  if (!match) return null
  const candidate = `${match[1]}://${match[3]}`
  try {
    const url = new URL(candidate)
    return url.hostname ? url : null
  } catch {
    return null
  }
}

export async function onRequest(context) {
  const { request, next } = context

  if (request.method !== 'GET' && request.method !== 'HEAD') return next()

  const incoming = new URL(request.url)
  const original = extractOriginalUrl(incoming.pathname)
  if (!original) return next()

  const xgetPath = buildXgetPath(original)
  if (!xgetPath) return next()

  return Response.redirect(`${incoming.origin}${xgetPath}`, 302)
}
