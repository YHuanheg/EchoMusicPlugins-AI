/**
 * GitHub 加速器 —— EchoMusic 插件
 *
 * 作用：为 EchoMusic 自身（更新检查、在线插件市场下载）挑选最快的 GitHub 加速线路，
 *      并把结果一键写入「设置 → GitHub 加速地址」；同时提供 Xget 多平台链接转换。
 *
 * 关键事实（实测得出，详见仓库 docs/）：
 *   EchoMusic 内部把该设置拼成 `${githubProxyUrl}/${完整原始URL}`（gh-proxy 形态），
 *   因此只有 gh-proxy 形态的线路能直接写入；Xget 是「路径重写」形态
 *   （`https://host/gh/owner/repo/path`），只能用于链接转换或配合桥接函数使用。
 */

const STORAGE_KEY = 'gh-accelerator-settings'
const STATS_KEY = 'gh-accelerator-stats'

/** 连通性测试目标：任意 GitHub 主机下的小文件即可 */
const DEFAULT_PROBE_URL =
  'https://raw.githubusercontent.com/hoowhoami/EchoMusic/main/docs/plugin-system.md'
/** 吞吐测试目标：体积较大，用来区分线路的真实下载速度 */
const DEFAULT_THROUGHPUT_URL =
  'https://github.com/hoowhoami/EchoMusicPlugins/archive/refs/heads/main.zip'

/**
 * 官方在线插件源所在的仓库（`owner/repo`）。
 * 宿主把每个源的索引固定取为 `raw.githubusercontent.com/<owner>/<repo>/HEAD/echo-plugins.json`
 * （见 app.asar 里的 `Vg(repo, 'echo-plugins.json')`），探测插件总数时沿用同一地址。
 */
const OFFICIAL_MARKETPLACE_REPO = 'hoowhoami/EchoMusicPlugins'

/**
 * gh-proxy 形态：`{前缀}/{完整原始URL}`，可直接写入 EchoMusic 的 GitHub 加速地址。
 *
 * 清单来源：XIU2「Github 增强 - 高速下载」脚本的公益加速源列表，
 * 再于本机逐条实测筛选（2026-09-19，38 条候选里 24 条可用）。
 * 公益节点随时会挂、会限流（实测 gh.h233.eu.org 返回 403、gh.idayer.com 返回 429），
 * 所以这里只作为「候选池」，最终仍以插件内的实测排序为准。
 */
const PRESET_PROXY = [
  { id: 'wget-la', name: 'wget.la', domain: 'https://wget.la', region: '多地区', note: 'CDN 不固定，实测最快' },
  { id: 'git-yylx', name: 'git.yylx.win', domain: 'https://git.yylx.win', region: '美国', note: 'Cloudflare CDN' },
  { id: 'ghproxy-com', name: 'GH-Proxy 美国', domain: 'https://gh-proxy.com', region: '美国', note: 'gh-proxy 官方节点' },
  { id: 'g-blfrp', name: 'g.blfrp.cn', domain: 'https://g.blfrp.cn', region: '日本', note: '东京节点' },
  { id: 'gitproxy-mrhjx', name: 'gitproxy.mrhjx.cn', domain: 'https://gitproxy.mrhjx.cn', region: '美国', note: 'Cloudflare CDN' },
  { id: 'ghproxy-net', name: 'GHProxy 法国', domain: 'https://ghproxy.net', region: '法国', note: '老牌公共节点' },
  { id: 'gh-xxooo', name: 'gh.xxooo.cf', domain: 'https://gh.xxooo.cf', region: '美国', note: 'Cloudflare CDN' },
  { id: 'gh-monlor', name: 'gh.monlor.com', domain: 'https://gh.monlor.com', region: '美国', note: 'Cloudflare CDN' },
  { id: 'hk-ghproxy-org', name: 'gh-proxy 香港', domain: 'https://hk.gh-proxy.org', region: '中国香港', note: 'gh-proxy 官方节点' },
  { id: 'cdn-ghproxy-org', name: 'gh-proxy Fastly', domain: 'https://cdn.gh-proxy.org', region: 'Fastly', note: 'gh-proxy 官方节点' },
  { id: 'edgeone-ghproxy-org', name: 'gh-proxy EdgeOne', domain: 'https://edgeone.gh-proxy.org', region: 'EdgeOne', note: 'gh-proxy 官方节点' },
  { id: 'github-ednovas', name: 'github.ednovas.xyz', domain: 'https://github.ednovas.xyz', region: '美国', note: 'Cloudflare CDN' },
  { id: 'ghproxy-monkeyray', name: 'monkeyray.net', domain: 'https://ghproxy.monkeyray.net', region: '美国', note: '洛杉矶节点' },
  { id: 'ghpxy-hwinzniej', name: 'ghpxy.hwinzniej.top', domain: 'https://ghpxy.hwinzniej.top', region: '美国', note: 'Cloudflare CDN' },
  { id: 'gh-chjina', name: 'gh.chjina.com', domain: 'https://gh.chjina.com', region: '美国', note: 'Cloudflare CDN' },
  { id: 'ghproxy-org', name: 'gh-proxy.org', domain: 'https://gh-proxy.org', region: '美国', note: 'gh-proxy 主域' },
  { id: 'ghp-keleyaa', name: 'ghp.keleyaa.com', domain: 'https://ghp.keleyaa.com', region: '美国', note: 'Cloudflare CDN' },
  { id: 'github-boki', name: 'github.boki.moe', domain: 'https://github.boki.moe', region: '美国', note: 'Cloudflare CDN' },
  { id: 'gh-zwy', name: 'gh.zwy.one', domain: 'https://gh.zwy.one', region: '美国', note: '洛杉矶节点' },
  { id: 'ghproxy-cxkpro', name: 'ghproxy.cxkpro.top', domain: 'https://ghproxy.cxkpro.top', region: '美国', note: 'Cloudflare CDN' },
  { id: 'github-geekery', name: 'github.geekery.cn', domain: 'https://github.geekery.cn', region: '美国', note: 'Cloudflare CDN' },
  { id: 'ghfile-geekertao', name: 'ghfile.geekertao.top', domain: 'https://ghfile.geekertao.top', region: '美国', note: 'Cloudflare CDN' },
  { id: 'cdn-crashmc', name: 'cdn.crashmc.com', domain: 'https://cdn.crashmc.com', region: '美国', note: 'Cloudflare CDN' },
  { id: 'gh-ddlc', name: 'gh.ddlc.top', domain: 'https://gh.ddlc.top', region: '美国', note: 'Cloudflare CDN，实测偏慢' }
].map((source) => ({ ...source, kind: 'ghproxy' }))

/** Xget 形态：`{域名}/{平台前缀}{路径}`，全平台，但不兼容 EchoMusic 的加速地址格式 */
const PRESET_XGET = [
  {
    id: 'xget-self',
    name: 'Xget（自建）',
    domain: 'https://xget-ckf.pages.dev',
    kind: 'xget',
    prefix: 'gh',
    note: '你的 Cloudflare Pages 实例'
  },
  {
    id: 'xget-official',
    name: 'Xget 官方实例',
    domain: 'https://xget.xi-xu.me',
    kind: 'xget',
    prefix: 'gh',
    note: '官方预部署实例，仅适合试用'
  }
]

/**
 * 主机 → Xget 平台前缀。
 * GitHub 系主机不走这张表（它们的路径需要重写），见 githubFamilyPath()。
 */
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

/** EchoMusic 只会对 GitHub 系主机做加速，与宿主内部判定保持一致 */
function isGithubHost(hostname) {
  return (
    hostname === 'github.com' ||
    hostname === 'raw.githubusercontent.com' ||
    hostname === 'codeload.github.com' ||
    hostname.endsWith('.githubusercontent.com')
  )
}

/**
 * GitHub 系主机的 Xget 路径重写。
 *
 * Xget 的 gh 前缀对应 github.com 的网页路径结构，实测把 raw / codeload 的原始
 * 路径直接拼上去会 404，必须先换算成等价的 github.com 路径：
 *   raw.githubusercontent.com/o/r/ref/f  →  /gh/o/r/raw/ref/f
 *   codeload.github.com/o/r/zip/refs/... →  /gh/o/r/archive/refs/....zip
 */
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

/**
 * 从 gh-proxy 形态的路径里取出原始 URL。
 *   "/https://github.com/o/r/archive/main.zip?x=1"  →  "https://github.com/o/r/archive/main.zip?x=1"
 * 容忍 Cloudflare / Node 把 `//` 折叠成 `/` 的情况。
 */
function extractOriginalUrl(rawPath) {
  const match = /^\/(https?):(\/{1,2})(.+)$/i.exec(String(rawPath ?? ''))
  if (!match) return null
  const candidate = `${match[1]}://${match[3]}`
  try {
    const url = new URL(candidate)
    return url.hostname ? candidate : null
  } catch {
    return null
  }
}

/** 本地桥接默认端口：宿主设置里会写成 http://127.0.0.1:<port> */
const DEFAULT_BRIDGE_PORT = 47823

/**
 * 市场索引探针的默认超时。
 * 宿主自己对索引请求给的预算比这宽得多，探针若过早放弃就会丢掉「插件总数」，
 * 进度只能退回阶段估算 —— 而总数正是本功能要给用户看的东西，所以取一个更从容的值。
 */
const DEFAULT_MARKETPLACE_PROBE_TIMEOUT_MS = 8000

const DEFAULT_SETTINGS = {
  showSidebarEntry: true,
  autoTestOnOpen: true,
  notify: true,
  concurrency: 6,
  timeoutMs: 8000,
  probeUrl: DEFAULT_PROBE_URL,
  throughputUrl: DEFAULT_THROUGHPUT_URL,
  throughputLimitMiB: 12,
  bridgePort: DEFAULT_BRIDGE_PORT,
  bridgeAutoStart: true,
  xgetPrimaryId: '',
  showMarketplaceStrip: true,
  showMarketplaceProgress: true,
  probeMarketplaceCount: true,
  marketplaceProbeTimeoutMs: DEFAULT_MARKETPLACE_PROBE_TIMEOUT_MS,
  takeoverMarketplaceRefresh: false,
  loadBalance: false,
  excludeList: [],
  debug: false
}

/** 市场刷新进度条的阶段定义（顺序即推进顺序） */
const MKT_PHASES = [
  { id: 'idle', label: '待命' },
  { id: 'probe', label: '探测插件源' },
  { id: 'index', label: '拉取插件索引' },
  { id: 'manifests', label: '拉取插件信息' },
  { id: 'settle', label: '写入缓存' },
  { id: 'done', label: '已完成' }
]

const EMPTY_STATS = {
  conversions: 0,
  succeeded: 0,
  failed: 0,
  applies: 0,
  lastTestAt: 0,
  lastTestCount: 0,
  /** 在线插件页刷新的累计次数与最近一次耗时 */
  marketplaceRefreshes: 0,
  lastMarketplaceMs: 0
}

export async function activate(ctx) {
  const { h, ref, reactive, computed, defineComponent, onMounted, onBeforeUnmount, nextTick } = ctx.vue

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  const log = (...args) => {
    if (state?.settings?.debug) console.log('[gh-accelerator]', ...args)
  }

  const trimSlash = (value) => String(value ?? '').trim().replace(/\/+$/, '')

  /** 等待 Vue 刷新一次视图；ctx.vue.nextTick 在某些版本可能缺失，做存在性兜底 */
  const flush = async () => {
    try {
      if (typeof nextTick === 'function') await nextTick()
      else await new Promise((resolve) => setTimeout(resolve, 0))
    } catch (error) {
      log('flush 失败', error)
    }
  }

  function parseUrl(raw) {
    try {
      return new URL(String(raw ?? '').trim())
    } catch {
      return null
    }
  }

  function describeError(error) {
    const text = String((error && error.message) || error || '未知错误')
    if (/timeout|timed out|ETIMEDOUT|ECONNABORTED/i.test(text)) return '请求超时'
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return '域名解析失败'
    if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(text)) return '连接被拒绝'
    if (/maxContentLength|maxResponseBytes|exceed/i.test(text)) return '响应超过体积上限'
    if (/certificate|CERT_|self signed/i.test(text)) return '证书校验失败'
    if (/Network Error|Failed to fetch/i.test(text)) return '网络不可达'
    return text.length > 46 ? `${text.slice(0, 46)}…` : text
  }

  function formatKbps(kbps) {
    if (!Number.isFinite(kbps) || kbps <= 0) return '—'
    if (kbps >= 1024) return `${(kbps / 1024).toFixed(2)} MB/s`
    return `${kbps.toFixed(0)} KB/s`
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—'
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
  }

  /** 毫秒 → 人读时长（`1.2s` / `12.3s` / `1分05秒`） */
  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${Math.round(ms)}ms`
    const seconds = ms / 1000
    if (seconds < 10) return `${seconds.toFixed(1)}s`
    if (seconds < 60) return `${Math.round(seconds)}s`
    const minutes = Math.floor(seconds / 60)
    const rest = Math.round(seconds % 60)
    return `${minutes}分${String(rest).padStart(2, '0')}秒`
  }

  function formatTime(ts) {
    if (!ts) return '尚未测速'
    const d = new Date(ts)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function copyText(text) {
    const value = String(text ?? '')
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value)
        return true
      }
    } catch (error) {
      log('clipboard API 失败，改用兜底方案', error)
    }
    try {
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch (error) {
      log('复制失败', error)
      return false
    }
  }

  function openExternal(url) {
    try {
      const api = ctx.electron
      if (api && typeof api.openExternal === 'function') {
        api.openExternal(url)
        return true
      }
    } catch (error) {
      log('openExternal 不可用', error)
    }
    try {
      window.open(url, '_blank', 'noopener,noreferrer')
      return true
    } catch (error) {
      log('打开链接失败', error)
      return false
    }
  }

  /** 跳到本插件的「加速器」页面 */
  function openPluginPage() {
    try {
      ctx.router.push(`/main/plugin/${encodeURIComponent(ctx.id)}/accelerator`)
      return true
    } catch (error) {
      log('跳转加速器页面失败', error)
      return false
    }
  }

  function toast(type, message) {
    if (!state.settings.notify) return
    const fn = ctx.toast && typeof ctx.toast[type] === 'function' ? ctx.toast[type] : null
    if (fn) fn.call(ctx.toast, message)
    else if (ctx.toast && ctx.toast.info) ctx.toast.info(message)
  }

  /* ------------------------------------------------------------------ */
  /* 排除规则                                                            */
  /* ------------------------------------------------------------------ */

  function compileExcludeMatchers(list) {
    const matchers = []
    for (const raw of list || []) {
      const pattern = String(raw ?? '').trim()
      if (!pattern) continue
      if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
        const lastSlash = pattern.lastIndexOf('/')
        try {
          matchers.push({ re: new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1)) })
          continue
        } catch (error) {
          log('排除规则正则无效，按字面量处理', pattern)
        }
      }
      try {
        matchers.push({ re: new RegExp(pattern) })
      } catch {
        matchers.push({ literal: pattern })
      }
    }
    return matchers
  }

  function isExcluded(url) {
    return state.excludeMatchers.some((m) => (m.re ? m.re.test(url) : url.includes(m.literal)))
  }

  /* ------------------------------------------------------------------ */
  /* URL 转换                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 把原始 URL 转成某条线路的加速 URL。
   * gh-proxy：`{域名}/{完整原始 URL}`（只支持 GitHub 系主机）
   * xget    ：`{域名}/{平台前缀}{重写后的路径}`
   */
  function buildAcceleratedUrl(source, rawUrl) {
    if (!source) return null
    const url = parseUrl(rawUrl)
    if (!url) return null
    const base = trimSlash(source.domain)
    if (!base) return null

    if (source.kind === 'ghproxy') {
      if (!isGithubHost(url.hostname)) return null
      return `${base}/${String(rawUrl).trim()}`
    }

    const githubPath = githubFamilyPath(url)
    if (githubPath) return `${base}${githubPath}`

    const prefix = PLATFORM_PREFIX[url.hostname]
    if (!prefix) return null
    return `${base}/${prefix}${url.pathname}${url.search}`
  }

  /* ------------------------------------------------------------------ */
  /* 网络                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * GET 请求。优先使用主进程 Axios（不受 CORS 限制，可覆盖请求头），
   * 不可用时回退到渲染进程 fetch。
   */
  async function httpGet(url, options = {}) {
    const {
      timeoutMs = 8000,
      responseType = 'arrayBuffer',
      maxRedirects = 5,
      maxResponseBytes,
      headers
    } = options

    if (ctx.net && typeof ctx.net.request === 'function') {
      return ctx.net.request({
        url,
        method: 'GET',
        timeoutMs,
        responseType,
        maxRedirects,
        ...(maxResponseBytes ? { maxResponseBytes } : {}),
        ...(headers ? { headers } : {})
      })
    }

    const response = await ctx.net.fetch(url, {
      method: 'GET',
      redirect: maxRedirects > 0 ? 'follow' : 'manual',
      ...(headers ? { headers } : {})
    })
    const data = responseType === 'arrayBuffer' ? await response.arrayBuffer() : await response.text()
    const headerObject = {}
    response.headers.forEach((value, key) => {
      headerObject[key] = value
    })
    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: headerObject,
      data
    }
  }

  function byteLengthOf(data) {
    if (!data) return 0
    if (typeof data.byteLength === 'number') return data.byteLength
    if (typeof data.length === 'number') return data.length
    return 0
  }

  // 插件最多 64 个并发原生请求，这里再保守一点，避免测速把线路打满
  const MAX_CONCURRENCY = 8

  async function runWithConcurrency(items, limit, worker) {
    const safeLimit = Math.max(1, Math.min(limit || 1, MAX_CONCURRENCY, items.length || 1))
    const results = new Array(items.length)
    let cursor = 0
    const runners = Array.from({ length: safeLimit }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= items.length) return
        try {
          results[index] = await worker(items[index], index)
        } catch (error) {
          results[index] = { ok: false, error: describeError(error) }
        }
      }
    })
    await Promise.all(runners)
    return results
  }

  /**
   * 对某条线路做一次「真实下载」测量：通过该线路取一个真实 GitHub 文件，
   * 同时得到可达性、耗时与实际吞吐。这比 ping 站点根目录更贴近真实体验。
   */
  async function measureSource(source, targetUrl, options = {}) {
    const timeoutMs = options.timeoutMs ?? state.settings.timeoutMs
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024
    const accelerated = buildAcceleratedUrl(source, targetUrl)

    if (!accelerated) {
      return { ok: false, error: '该线路不支持此类主机（gh-proxy 仅支持 GitHub）' }
    }

    const startedAt = Date.now()
    try {
      const response = await httpGet(accelerated, {
        timeoutMs,
        responseType: 'arrayBuffer',
        maxRedirects: 5,
        maxResponseBytes: maxBytes
      })
      const elapsedMs = Math.max(1, Date.now() - startedAt)
      const bytes = byteLengthOf(response.data)
      const statusOk = response.status >= 200 && response.status < 400

      if (!statusOk) {
        return { ok: false, elapsedMs, bytes, status: response.status, error: `HTTP ${response.status}` }
      }
      if (bytes <= 0) {
        return { ok: false, elapsedMs, bytes, status: response.status, error: '响应为空' }
      }
      return {
        ok: true,
        elapsedMs,
        bytes,
        status: response.status,
        kbps: bytes / 1024 / (elapsedMs / 1000)
      }
    } catch (error) {
      return { ok: false, elapsedMs: Date.now() - startedAt, error: describeError(error) }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  const state = reactive({
    ready: false,
    settings: { ...DEFAULT_SETTINGS },
    customSources: [],
    excludeMatchers: [],
    stats: { ...EMPTY_STATS },
    results: {}, // sourceId -> { ok, elapsedMs, kbps, bytes, error }
    testing: false,
    testDone: 0,
    testTotal: 0,
    testingIds: {},
    /** 本地桥接（把 gh-proxy 形态 302 到 Xget）运行状态 */
    bridge: { running: false, port: 0, origin: '', busy: false, testing: false, lastError: '' },
    bridgeHits: 0,
    bridgeTest: null,
    /**
     * 在线插件页的「刷新拉取进度」。
     * 宿主没有把进度暴露给插件（无逐插件事件、无字节回调），所以这里的数字是
     * 由 DOM 骨架 + 卡片计数 + 主动探源三路融合「推定」出来的，见 runMarketplaceProbe()。
     */
    mkt: {
      phase: 'idle',
      active: false,
      /** 进度分母：源里的插件总数（探针给出才可信，否则为 0） */
      total: 0,
      /** 是否已有可信分母 */
      totalKnown: false,
      /** 阶段性进度（0-1），用于分母未知时兜底 */
      stageRatio: 0,
      /** DOM 观测到的已渲染卡片数 */
      rendered: 0,
      /** DOM 观测到的骨架卡片数 */
      skeletons: 0,
      /** 最近一次 DOM 快照（响应式，供 computed 读取） */
      dom: { busy: false, skeletons: 0, rendered: 0, mounted: false },
      startedAt: 0,
      endedAt: 0,
      /** 探针发出的请求数与累计字节，用于算真实拉取速率 */
      probeRequests: 0,
      probeBytes: 0,
      probeMs: 0,
      /** 探针是否靠「回落直连」才拿到总数（加速前缀失败时） */
      probeFallback: false,
      /** true 表示本轮是插件自己发的请求（接管模式），进度为精确值 */
      own: false,
      /** 单调递增的心跳：仅用于让「已用时间 / 剩余时间 / 完成后倒计时」持续刷新 UI */
      beat: 0,
      /** 上一次完成的统计，供空闲态展示 */
      last: null,
      error: ''
    },
    activeTab: 'proxy',
    convertInput: '',
    convertOutput: '',
    convertError: '',
    batchInput: '',
    batchOutput: [],
    newName: '',
    newDomain: '',
    newKind: 'ghproxy'
  })

  const allSources = computed(() => [...PRESET_PROXY, ...PRESET_XGET, ...state.customSources])

  const proxySources = computed(() => allSources.value.filter((s) => s.kind === 'ghproxy'))
  const xgetSources = computed(() => allSources.value.filter((s) => s.kind === 'xget'))

  /** EchoMusic 当前的 GitHub 加速地址 */
  const hostProxyUrl = computed(() => {
    const store = ctx.stores?.settings || ctx.settings
    return String(store?.githubProxyUrl ?? '').trim()
  })

  /** 已测速且可用的线路，按吞吐降序、耗时升序 */
  const rankedSources = computed(() => {
    return allSources.value
      .filter((s) => state.results[s.id]?.ok)
      .sort((a, b) => {
        const ra = state.results[a.id]
        const rb = state.results[b.id]
        if (rb.kbps !== ra.kbps) return rb.kbps - ra.kbps
        return ra.elapsedMs - rb.elapsedMs
      })
  })

  const bestProxy = computed(() => rankedSources.value.find((s) => s.kind === 'ghproxy') || null)
  const bestAny = computed(() => rankedSources.value[0] || null)

  /**
   * 选一条 gh-proxy 线路来写入宿主。
   * 默认取实测最快的；开启「负载均衡」时在最快的若干条里随机 —— 公益节点带宽有限，
   * 所有人都固定打同一条会加速其失效（XIU2 的加速脚本也是这个思路）。
   */
  function pickProxySource() {
    const pool = rankedSources.value.filter((s) => s.kind === 'ghproxy')
    if (pool.length === 0) return bestProxy.value
    if (!state.settings.loadBalance) return pool[0]
    const width = Math.min(4, pool.length)
    return pool[Math.floor(Math.random() * width)]
  }

  const applyButtonLabel = computed(() => {
    if (state.settings.loadBalance) return `应用线路（最快 ${Math.min(4, rankedSources.value.filter((s) => s.kind === 'ghproxy').length || 1)} 条随机）`
    return `应用最快线路（${bestProxy.value ? bestProxy.value.name : '—'}）`
  })

  /** 当前用于桥接的 Xget 线路：优先用户指定，其次测速最快的 Xget */
  const xgetPrimary = computed(() => {
    const picked = xgetSources.value.find((s) => s.id === state.settings.xgetPrimaryId)
    if (picked) return picked
    return rankedSources.value.find((s) => s.kind === 'xget') || xgetSources.value[0] || null
  })

  const bridgeOrigin = computed(
    () => state.bridge.origin || `http://127.0.0.1:${Number(state.settings.bridgePort) || DEFAULT_BRIDGE_PORT}`
  )

  /** 宿主的加速地址是否已经指向本地桥 */
  const hostProxyIsBridge = computed(() => {
    const value = trimSlash(hostProxyUrl.value)
    return !!value && value === trimSlash(bridgeOrigin.value)
  })

  const bridgeSupported = computed(() => !!ctx.webServer && typeof ctx.webServer.listen === 'function')

  const hostSettingsStore = () => ctx.stores?.settings || ctx.settings

  /**
   * 宿主的「插件」侧边栏分组是否被折叠。
   * 分组一旦折叠，里面的插件入口会被整组收起 —— 这是「侧边栏入口不见了」最常见的原因。
   */
  const sidebarSectionFolded = computed(() => {
    const map = hostSettingsStore()?.sidebarSectionCollapsed
    return !!(map && typeof map === 'object' && map.plugins === true)
  })

  const hostProxyCompatible = computed(() => {
    const value = hostProxyUrl.value
    if (!value) return { state: 'empty', text: '未设置（走原始 GitHub）' }
    if (hostProxyIsBridge.value) return { state: 'bridge', text: '已指向本地 Xget 桥（Xget 加速已启用）' }
    if (!/^https?:\/\//i.test(value)) return { state: 'invalid', text: '格式无效：需要以 http(s):// 开头' }
    const known = allSources.value.find((s) => s.kind === 'ghproxy' && trimSlash(s.domain) === trimSlash(value))
    if (known) return { state: 'known', text: `已指向「${known.name}」` }
    const xgetLike = allSources.value.find((s) => s.kind === 'xget' && trimSlash(value).startsWith(trimSlash(s.domain)))
    if (xgetLike) return { state: 'incompatible', text: '这是 Xget 形态，宿主会拼成 404 链接' }
    return { state: 'custom', text: '自定义线路' }
  })

  /* ------------------------------------------------------------------ */
  /* 持久化                                                              */
  /* ------------------------------------------------------------------ */

  let saveTimer = null

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist()
    }, 400)
  }

  async function persist() {
    try {
      await ctx.storage.set(STORAGE_KEY, {
        settings: { ...state.settings },
        customSources: state.customSources.map((s) => ({ ...s }))
      })
      await ctx.storage.set(STATS_KEY, { ...state.stats })
    } catch (error) {
      log('持久化失败', error)
    }
  }

  function applyLoaded(settings, customSources, stats) {
    Object.assign(state.settings, DEFAULT_SETTINGS, settings || {})
    state.customSources = Array.isArray(customSources) ? customSources : []
    Object.assign(state.stats, EMPTY_STATS, stats || {})
    state.excludeMatchers = compileExcludeMatchers(state.settings.excludeList)
  }

  /* ------------------------------------------------------------------ */
  /* 业务动作                                                            */
  /* ------------------------------------------------------------------ */

  async function runSpeedTest() {
    if (state.testing) return
    const targets = allSources.value.slice()
    state.testing = true
    state.testDone = 0
    state.testTotal = targets.length
    state.testingIds = {}
    targets.forEach((s) => {
      state.testingIds[s.id] = true
      delete state.results[s.id]
    })

    await runWithConcurrency(targets, state.settings.concurrency, async (source) => {
      const result = await measureSource(source, state.settings.probeUrl, {
        timeoutMs: state.settings.timeoutMs
      })
      state.results[source.id] = result
      delete state.testingIds[source.id]
      state.testDone += 1
      log('测速完成', source.id, result)
    })

    state.testing = false
    state.stats.lastTestAt = Date.now()
    state.stats.lastTestCount = targets.length
    scheduleSave()

    const available = targets.filter((s) => state.results[s.id]?.ok).length
    if (available === 0) {
      toast('warning', '所有线路均不可用，请检查网络或代理设置')
    } else {
      const best = rankedSources.value[0]
      toast('success', `测速完成：${available}/${targets.length} 条可用，最快为 ${best.name}`)
    }
  }

  async function runThroughputTest(source) {
    if (state.testing) return
    state.testing = true
    state.testingIds = { [source.id]: true }
    const limit = Math.max(1, Number(state.settings.throughputLimitMiB) || 12) * 1024 * 1024
    const result = await measureSource(source, state.settings.throughputUrl, {
      timeoutMs: Math.max(state.settings.timeoutMs, 15000),
      maxBytes: limit
    })
    state.results[source.id] = result
    state.testingIds = {}
    state.testing = false
    scheduleSave()

    if (result.ok) {
      toast('success', `${source.name}：${formatKbps(result.kbps)}（${formatBytes(result.bytes)} / ${result.elapsedMs}ms）`)
    } else {
      toast('danger', `${source.name} 吞吐测试失败：${result.error}`)
    }
  }

  /**
   * 把线路写入 EchoMusic 的「GitHub 加速地址」。
   * 写入后立刻回读校验，避免静默失败。
   */
  async function applyToHost(source) {
    if (!source) return { ok: false, error: '没有可用的线路' }
    if (source.kind !== 'ghproxy') {
      return {
        ok: false,
        error:
          'EchoMusic 的加速地址只接受 gh-proxy 形态（前缀 + 完整 GitHub URL）。Xget 是路径重写形态，请使用「复制转换链接」，或部署仓库中的桥接函数后再选 Xget。'
      }
    }

    const store = ctx.stores?.settings || ctx.settings
    if (!store) return { ok: false, error: '未找到 EchoMusic 设置存储，请手动复制到「设置 → GitHub 加速地址」' }

    const value = trimSlash(source.domain)
    try {
      store.githubProxyUrl = value
      if (typeof store.$patch === 'function') store.$patch({ githubProxyUrl: value })
      await flush()
      const readBack = String(store.githubProxyUrl ?? '').trim()
      if (trimSlash(readBack) !== value) {
        return {
          ok: false,
          error: `写入未生效（当前值为「${readBack || '空'}」），请手动粘贴到「设置 → GitHub 加速地址」`
        }
      }
      state.stats.applies += 1
      scheduleSave()
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: `写入失败：${describeError(error)}` }
    }
  }

  async function clearHostProxy() {
    const store = ctx.stores?.settings || ctx.settings
    if (!store) return { ok: false, error: '未找到 EchoMusic 设置存储' }
    try {
      store.githubProxyUrl = ''
      if (typeof store.$patch === 'function') store.$patch({ githubProxyUrl: '' })
      await flush()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  /** 停用当前线路：清空宿主加速地址，并临时跳过该线路 */
  function convert() {
    const raw = String(state.convertInput ?? '').trim()
    state.convertError = ''
    state.convertOutput = ''
    if (!raw) return

    const url = parseUrl(raw)
    if (!url) {
      state.convertError = '请输入完整的 URL（含 https://）'
      return
    }
    if (isExcluded(raw)) {
      state.convertError = '该 URL 命中排除规则，已跳过'
      return
    }
    const source = bestAny.value || proxySources.value[0]
    const output = buildAcceleratedUrl(source, raw)
    if (!output) {
      state.convertError = `「${source ? source.name : '线路'}」无法转换该主机（gh-proxy 仅支持 GitHub 系主机，Xget 支持多平台）`
      state.stats.failed += 1
      state.stats.conversions += 1
      scheduleSave()
      return
    }
    state.convertOutput = output
    state.stats.conversions += 1
    state.stats.succeeded += 1
    scheduleSave()
  }

  function convertBatch() {
    const lines = String(state.batchInput ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const source = bestAny.value || proxySources.value[0]
    state.batchOutput = lines.map((line) => {
      if (isExcluded(line)) return { input: line, output: '', note: '命中排除规则' }
      const output = buildAcceleratedUrl(source, line)
      if (!output) {
        return { input: line, output: '', note: '无法转换（主机不受支持）' }
      }
      return { input: line, output, note: '' }
    })
    const okCount = state.batchOutput.filter((item) => item.output).length
    state.stats.conversions += lines.length
    state.stats.succeeded += okCount
    state.stats.failed += lines.length - okCount
    scheduleSave()
    if (lines.length) toast('info', `批量转换完成：${okCount}/${lines.length} 条成功`)
  }

  async function copyBatchOutput() {
    const text = state.batchOutput
      .map((item) => item.output)
      .filter(Boolean)
      .join('\n')
    if (!text) {
      toast('warning', '没有可复制的结果')
      return
    }
    toast((await copyText(text)) ? 'success' : 'danger', (await copyText(text)) ? '已复制全部转换结果' : '复制失败')
  }

  function addCustomSource() {
    const name = String(state.newName ?? '').trim()
    const rawDomain = String(state.newDomain ?? '').trim()
    if (!name || !rawDomain) {
      toast('warning', '请填写线路名称和域名')
      return
    }
    let domain = rawDomain
    if (!/^https?:\/\//i.test(domain)) domain = `https://${domain}`
    const url = parseUrl(domain)
    if (!url || !url.hostname) {
      toast('danger', '域名格式无效')
      return
    }
    const normalized = `https://${url.hostname}${url.pathname.replace(/\/+$/, '')}`
    if (allSources.value.some((s) => trimSlash(s.domain) === trimSlash(normalized))) {
      toast('warning', '该线路已存在')
      return
    }
    const source = {
      id: `custom-${Date.now()}`,
      name,
      domain: normalized,
      kind: state.newKind === 'xget' ? 'xget' : 'ghproxy',
      prefix: 'gh',
      note: '自定义线路',
      custom: true
    }
    state.customSources.push(source)
    state.newName = ''
    state.newDomain = ''
    scheduleSave()
    toast('success', `已添加线路：${name}`)
  }

  function removeCustomSource(source) {
    state.customSources = state.customSources.filter((s) => s.id !== source.id)
    delete state.results[source.id]
    scheduleSave()
    toast('info', `已删除线路：${source.name}`)
  }

  function resetStats() {
    Object.assign(state.stats, EMPTY_STATS)
    scheduleSave()
    toast('success', '统计数据已重置')
  }

  /** 展开宿主侧边栏的「插件」分组（折叠状态下入口会被藏起来） */
  async function unfoldSidebarSection() {
    const store = hostSettingsStore()
    if (!store) return { ok: false, error: '未找到 EchoMusic 设置存储' }
    try {
      const current =
        store.sidebarSectionCollapsed && typeof store.sidebarSectionCollapsed === 'object'
          ? { ...store.sidebarSectionCollapsed }
          : {}
      current.plugins = false
      store.sidebarSectionCollapsed = current
      if (typeof store.$patch === 'function') store.$patch({ sidebarSectionCollapsed: current })
      await flush()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  /** 修改并持久化一个配置项（页面内开关与设置面板共用） */
  async function updateSetting(key, value) {
    state.settings[key] = value
    if (key === 'excludeList') state.excludeMatchers = compileExcludeMatchers(value)
    if (key === 'showMarketplaceStrip') injectMarketplaceStrip()
    if (key === 'showSidebarEntry') applySidebarEntry(value)
    await persist()
  }

  /* ------------------------------------------------------------------ */
  /* Xget 本地桥接                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * 本地桥的 HTTP 处理器：把宿主拼出的 gh-proxy 形态 URL
   * （`http://127.0.0.1:<port>/https://github.com/...`）302 到 Xget 的规范路径。
   *
   * 为什么用重定向而不是反向代理：宿主对本地服务的单次响应体上限是 8 MB，
   * 而插件 zip 允许到 80 MB，代理必然失败；重定向还能保留 Xget 自己的
   * Range / 缓存 / 重试语义，并且不占用本地带宽。
   * 宿主下载走 session.fetch()，默认跟随 3xx，所以 302 会被正常解析。
   */
  async function bridgeHandler(request) {
    const rawPath = String((request && (request.url || request.path)) || '')
    const asJson = (status, payload) => ({
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify(payload)
    })

    if (rawPath === '/' || rawPath.startsWith('/health')) {
      return asJson(200, {
        ok: true,
        service: 'echomusic-gh-accelerator',
        xget: xgetPrimary.value ? trimSlash(xgetPrimary.value.domain) : null,
        hits: state.bridgeHits
      })
    }

    const original = extractOriginalUrl(rawPath)
    if (!original) {
      return {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        body: '用法：GET http://127.0.0.1:<port>/https://github.com/owner/repo/...'
      }
    }

    const source = xgetPrimary.value
    if (!source) return asJson(503, { ok: false, error: '没有可用的 Xget 线路' })

    const target = buildAcceleratedUrl(source, original)
    if (!target) {
      return asJson(502, {
        ok: false,
        error: '该主机不在 Xget 支持列表内',
        original,
        xget: trimSlash(source.domain)
      })
    }

    state.bridgeHits += 1
    log('bridge →', target)
    return {
      status: 302,
      headers: {
        location: target,
        'cache-control': 'no-store',
        'x-accelerated-by': 'echomusic-gh-accelerator'
      }
    }
  }

  function clampPort(value) {
    const port = Number(value)
    if (!Number.isFinite(port) || port < 1024 || port > 65535) return DEFAULT_BRIDGE_PORT
    return Math.floor(port)
  }

  async function startBridge() {
    if (!bridgeSupported.value) {
      return { ok: false, error: '当前 EchoMusic 版本不支持本地 Web 服务（ctx.webServer），无法启用桥接' }
    }

    const port = clampPort(state.settings.bridgePort)
    if (state.bridge.running && state.bridge.port === port) {
      return { ok: true, origin: state.bridge.origin || `http://127.0.0.1:${port}` }
    }

    state.bridge.busy = true
    state.bridge.lastError = ''
    try {
      const result = await ctx.webServer.listen(bridgeHandler, { port })
      if (!result || !result.ok) {
        state.bridge.running = false
        state.bridge.lastError = String((result && result.error) || `端口 ${port} 无法监听`)
        return { ok: false, error: state.bridge.lastError }
      }
      state.bridge.running = true
      state.bridge.port = Number(result.port) || port
      state.bridge.origin = String(result.origin || `http://127.0.0.1:${state.bridge.port}`)
      log('本地桥已启动', state.bridge.origin)
      return { ok: true, origin: state.bridge.origin }
    } catch (error) {
      state.bridge.running = false
      state.bridge.lastError = describeError(error)
      return { ok: false, error: state.bridge.lastError }
    } finally {
      state.bridge.busy = false
    }
  }

  async function stopBridge() {
    state.bridge.busy = true
    try {
      if (ctx.webServer && typeof ctx.webServer.close === 'function') await ctx.webServer.close()
    } catch (error) {
      log('关闭本地桥失败', error)
    } finally {
      state.bridge.running = false
      state.bridge.busy = false
      log('本地桥已停止')
    }
  }

  /**
   * 启用 Xget 加速：启动本地桥，并把宿主的「GitHub 加速地址」指向它。
   * 传入 source 时会同时把它记为默认桥接线路。
   */
  async function enableXgetAcceleration(source) {
    const target = source || xgetPrimary.value
    if (!target) return { ok: false, error: '没有可用的 Xget 线路' }
    if (target.kind !== 'xget') {
      return { ok: false, error: '本地桥只用于 Xget 线路；gh-proxy 线路可直接写入宿主设置' }
    }

    if (source) state.settings.xgetPrimaryId = target.id

    const started = await startBridge()
    if (!started.ok) return started

    const origin = trimSlash(started.origin)
    const store = ctx.stores?.settings || ctx.settings
    if (!store) return { ok: false, error: '未找到 EchoMusic 设置存储，请手动填写加速地址' }

    try {
      store.githubProxyUrl = origin
      if (typeof store.$patch === 'function') store.$patch({ githubProxyUrl: origin })
      await flush()
      const readBack = trimSlash(String(store.githubProxyUrl ?? ''))
      if (readBack !== origin) {
        return { ok: false, error: `写入未生效（当前值「${readBack || '空'}」），可手动填写 ${origin}` }
      }
      state.stats.applies += 1
      scheduleSave()
      return { ok: true, origin }
    } catch (error) {
      return { ok: false, error: `写入失败：${describeError(error)}` }
    }
  }

  /** 停用 Xget 加速：清空宿主加速地址并关闭本地桥 */
  async function disableXgetAcceleration() {
    const store = ctx.stores?.settings || ctx.settings
    try {
      if (store && hostProxyIsBridge.value) {
        store.githubProxyUrl = ''
        if (typeof store.$patch === 'function') store.$patch({ githubProxyUrl: '' })
        await flush()
      }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
    await stopBridge()
    state.bridgeTest = null
    return { ok: true }
  }

  /** 自检：走本地桥完整链路取一个真实 GitHub 文件（含 302 跳转与 Xget） */
  async function testBridge() {
    if (state.bridge.testing) return state.bridgeTest
    state.bridge.testing = true
    state.bridgeTest = null
    try {
      if (!state.bridge.running) {
        const started = await startBridge()
        if (!started.ok) {
          state.bridgeTest = { ok: false, error: started.error }
          return state.bridgeTest
        }
      }

      const url = `${trimSlash(bridgeOrigin.value)}/${state.settings.probeUrl}`
      const startedAt = Date.now()
      const response = await httpGet(url, {
        timeoutMs: Math.max(state.settings.timeoutMs, 15000),
        responseType: 'arrayBuffer',
        maxRedirects: 5,
        maxResponseBytes: 4 * 1024 * 1024
      })
      const elapsedMs = Date.now() - startedAt
      const bytes = byteLengthOf(response.data)
      const ok = response.status >= 200 && response.status < 400 && bytes > 0
      state.bridgeTest = {
        ok,
        status: response.status,
        elapsedMs,
        bytes,
        kbps: ok ? bytes / 1024 / (elapsedMs / 1000) : 0,
        finalUrl: String(response.url || ''),
        error: ok ? '' : `HTTP ${response.status}`
      }
    } catch (error) {
      state.bridgeTest = { ok: false, error: describeError(error) }
    } finally {
      state.bridge.testing = false
    }
    return state.bridgeTest
  }

  /* ------------------------------------------------------------------ */
  /* 界面片段                                                            */
  /* ------------------------------------------------------------------ */

  const icon = (path, size = 16) =>
    h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        style: 'flex-shrink:0'
      },
      [h('path', { d: path })]
    )

  const ICON_BOLT = 'M13 2 3 14h9l-1 8 10-12h-9l1-8z'
  const ICON_GAUGE = 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M13.4 10.6 19 5'
  const ICON_LINK = 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5'
  const ICON_COPY = 'M8 4h10a2 2 0 0 1 2 2v10 M4 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z'
  const ICON_TRASH = 'M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14'
  const ICON_CHECK = 'M20 6 9 17l-5-5'
  const ICON_UPLOAD = 'M12 19V5 M5 12l7-7 7 7'

  function renderButton(text, onClick, options = {}) {
    const classes = ['gha-btn']
    if (options.primary) classes.push('gha-btn-primary')
    if (options.danger) classes.push('gha-btn-danger')
    if (options.small) classes.push('gha-btn-sm')
    return h(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        disabled: !!options.disabled,
        title: options.title || '',
        onClick
      },
      text
    )
  }

  /** 真实开关控件：轨道 + 滑块，开启时填充主题色，状态一眼可辨 */
  function renderToggle(checked, onToggle, options = {}) {
    const on = !!checked
    const fire = () => {
      if (options.disabled) return
      onToggle(!on)
    }
    return h(
      'span',
      {
        class: 'gha-switch',
        role: 'switch',
        tabindex: '0',
        'aria-checked': on ? 'true' : 'false',
        'data-on': on ? 'true' : 'false',
        title: options.title || (on ? '点击关闭' : '点击开启'),
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          fire()
        },
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            fire()
          }
        }
      },
      [h('span', { class: 'gha-switch-knob' })]
    )
  }

  function renderSwitch(title, desc, checked, onChange) {
    const on = !!checked
    return h('div', { class: `gha-switch-row${on ? ' gha-switch-row-on' : ''}` }, [
      h('div', { class: 'gha-switch-text' }, [
        h('div', { class: 'gha-switch-title' }, [
          h('span', {}, title),
          h('span', { class: `gha-state-chip${on ? ' gha-state-chip-on' : ''}` }, on ? '已开启' : '已关闭')
        ]),
        h('div', { class: 'gha-switch-desc' }, desc)
      ]),
      renderToggle(on, onChange, { title: on ? '点击关闭' : '点击开启' })
    ])
  }

  function renderSourceRow(source) {
    const result = state.results[source.id]
    const isTesting = !!state.testingIds[source.id]
    const isActive =
      source.kind === 'ghproxy' && trimSlash(hostProxyUrl.value) === trimSlash(source.domain)

    const dotClass = isTesting ? 'gha-dot gha-dot-busy' : result ? (result.ok ? 'gha-dot gha-dot-ok' : 'gha-dot gha-dot-bad') : 'gha-dot'

    let metricText = '未测速'
    let metricClass = 'gha-metric'
    if (isTesting) metricText = '测试中…'
    else if (result) {
      if (result.ok) {
        metricText = formatKbps(result.kbps)
        metricClass = 'gha-metric gha-metric-good'
      } else {
        metricText = result.error || '不可用'
        metricClass = 'gha-metric gha-metric-bad'
      }
    }

    const badges = []
    if (source.kind === 'xget') {
      badges.push(
        h('span', { class: 'gha-badge' }, 'Xget 形态'),
        h('span', { class: 'gha-badge gha-badge-primary' }, '可经本地桥加速'),
        state.settings.xgetPrimaryId === source.id ? h('span', { class: 'gha-badge' }, '桥接线路') : null
      )
    } else if (source.region) {
      // gh-proxy 线路已在分组里，不必重复标形态，直接显示节点地区
      badges.push(h('span', { class: 'gha-badge' }, source.region))
    }
    if (source.custom) badges.push(h('span', { class: 'gha-badge' }, '自定义'))

    const isBridgeLine =
      source.kind === 'xget' && xgetPrimary.value && xgetPrimary.value.id === source.id

    return h('div', { class: `gha-row${isActive ? ' gha-row-active' : ''}` }, [
      h('span', { class: dotClass }),
      h('div', { class: 'gha-row-main' }, [
        h('div', { class: 'gha-row-name' }, [
          source.name,
          ...badges,
          isActive ? h('span', { class: 'gha-badge gha-badge-primary' }, '使用中') : null,
          isBridgeLine && state.bridge.running
            ? h('span', { class: 'gha-badge gha-badge-primary' }, '桥已运行')
            : null
        ]),
        h('div', { class: 'gha-row-host' }, trimSlash(source.domain) + (source.note ? ` · ${source.note}` : ''))
      ]),
      h('div', { class: 'gha-row-side' }, [
        h(
          'span',
          {
            class: metricClass,
            title: result && result.ok ? `${formatBytes(result.bytes)} / ${result.elapsedMs}ms` : ''
          },
          metricText
        ),
        renderButton(icon(ICON_GAUGE, 13), () => void runThroughputTest(source), {
          small: true,
          disabled: state.testing,
          title: '用较大的真实文件测一次下载吞吐'
        }),
        ...(source.kind === 'ghproxy'
          ? [
              renderButton(
                isActive ? icon(ICON_CHECK, 13) : icon(ICON_UPLOAD, 13),
                async () => {
                  const outcome = await applyToHost(source)
                  if (outcome.ok) toast('success', `已把「${source.name}」写入 GitHub 加速地址`)
                  else toast('warning', outcome.error)
                },
                {
                  small: true,
                  disabled: isActive,
                  title: '写入 EchoMusic「设置 → GitHub 加速地址」'
                }
              )
            ]
          : [
              renderButton(
                isBridgeLine && state.bridge.running ? icon(ICON_CHECK, 13) : icon(ICON_BOLT, 13),
                async () => {
                  const outcome = await enableXgetAcceleration(source)
                  if (outcome.ok) {
                    toast('success', `Xget 加速已启用：${source.name}（本地桥 ${outcome.origin}）`)
                  } else {
                    toast('warning', outcome.error)
                  }
                },
                {
                  small: true,
                  disabled: state.bridge.busy,
                  title: '用本地桥把该 Xget 线路接入宿主「GitHub 加速地址」'
                }
              ),
              renderButton(
                icon(ICON_LINK, 13),
                async () => {
                  state.convertInput = state.settings.probeUrl
                  convert()
                  if (state.convertOutput) {
                    const ok = await copyText(state.convertOutput)
                    toast(ok ? 'success' : 'danger', ok ? '已复制该线路的加速链接' : '复制失败')
                  } else {
                    toast('warning', state.convertError || '转换失败')
                  }
                },
                { small: true, title: '转换并复制示例链接（不依赖本地桥）' }
              )
            ]),
        source.custom
          ? renderButton(icon(ICON_TRASH, 13), () => removeCustomSource(source), {
              small: true,
              danger: true,
              title: '删除'
            })
          : null
      ])
    ])
  }

  /* ------------------------------------------------------------------ */
  /* 主页面                                                              */
  /* ------------------------------------------------------------------ */

  const AcceleratorPage = defineComponent({
    name: 'GhAcceleratorPage',
    setup() {
      async function handleApplyBest() {
        const target = pickProxySource()
        if (!target) {
          toast('warning', '请先测速，目前没有可用的 gh-proxy 线路')
          return
        }
        const outcome = await applyToHost(target)
        if (outcome.ok) toast('success', `已应用线路：${target.name}`)
        else toast('warning', outcome.error)
      }

      async function handleClear() {
        const outcome = await clearHostProxy()
        toast(outcome.ok ? 'success' : 'warning', outcome.ok ? '已清空 GitHub 加速地址（回退原始 GitHub）' : outcome.error)
      }

      async function handleDisableXget() {
        const outcome = await disableXgetAcceleration()
        toast(outcome.ok ? 'success' : 'warning', outcome.ok ? '已停用 Xget 加速（本地桥已关闭）' : outcome.error)
      }

      async function handleUnfoldSidebar() {
        const outcome = await unfoldSidebarSection()
        toast(outcome.ok ? 'success' : 'warning', outcome.ok ? '已展开侧边栏「插件」分组' : outcome.error)
      }

      onMounted(() => {
        // 5 分钟内已经测过就不再重复跑，避免每次进页面都发一轮请求
        const fresh = Date.now() - state.stats.lastTestAt < 5 * 60 * 1000
        if (state.settings.autoTestOnOpen && !state.testing && !fresh) void runSpeedTest()
      })

      return () =>
        h('div', { class: 'gha' }, [
          /* 顶部 */
          h('header', { class: 'gha-hero' }, [
            h('h1', { class: 'gha-hero-title' }, [icon(ICON_BOLT, 20), 'GitHub 加速器']),
            h(
              'p',
              { class: 'gha-hero-desc' },
              'EchoMusic 的「GitHub 加速地址」用于更新检查和在线插件市场下载。本插件通过真实下载实测比较各条线路，' +
                '把最快的一条写进宿主设置；自建 Xget 可通过本地桥直接接管加速，另提供多平台链接转换。'
            ),
            h('div', { class: 'gha-hero-actions' }, [
              renderButton(state.testing ? '测速中…' : '一键测速', () => void runSpeedTest(), {
                primary: true,
                disabled: state.testing
              }),
              renderButton(applyButtonLabel.value, () => void handleApplyBest(), {
                disabled: state.testing || !bestProxy.value
              }),
              renderButton('清空加速地址', () => void handleClear()),
              h(
                'div',
                {
                  class: 'gha-check',
                  'data-on': state.settings.autoTestOnOpen ? 'true' : 'false',
                  title: '控制进入本页时是否自动跑一次全线路测速'
                },
                [
                  renderToggle(
                    state.settings.autoTestOnOpen,
                    (next) => {
                      void updateSetting('autoTestOnOpen', next)
                      toast('info', next ? '进入本页将自动测速' : '已关闭：进入本页不再自动测速')
                    },
                    { title: '点击切换' }
                  ),
                  h('span', { class: 'gha-check-label' }, '进入本页自动测速'),
                  h(
                    'span',
                    { class: `gha-state-chip${state.settings.autoTestOnOpen ? ' gha-state-chip-on' : ''}` },
                    state.settings.autoTestOnOpen ? '已开启' : '已关闭'
                  )
                ]
              )
            ])
          ]),

          /* Xget 本地加速 */
          h('section', { class: 'gha-card' }, [
            h('div', { class: 'gha-card-head' }, [
              h('h2', { class: 'gha-card-title' }, 'Xget 本地加速'),
              h(
                'span',
                { class: 'gha-card-hint' },
                bridgeSupported.value
                  ? state.bridge.running
                    ? '本地桥运行中'
                    : '本地桥未启动'
                  : '当前 EchoMusic 版本不支持'
              )
            ]),
            h(
              'p',
              { class: 'gha-card-hint' },
              '宿主只认 gh-proxy 形态（前缀 + 完整 URL），Xget 是路径重写形态，直接填会 404。' +
                '本插件在 127.0.0.1 起一个只做 302 跳转的本地桥，把宿主的请求换算成 Xget 规范路径 —— ' +
                '于是自建 Xget 也能直接为宿主加速，且不需要额外部署。'
            ),
            h('div', { class: 'gha-inline' }, [
              h('span', { class: 'gha-label', style: 'flex:0 0 auto' }, '桥接线路'),
              h(
                'select',
                {
                  class: 'gha-select',
                  style: 'flex:1;min-width:200px',
                  value: xgetPrimary.value ? xgetPrimary.value.id : '',
                  onChange: (event) => void updateSetting('xgetPrimaryId', String(event.target.value))
                },
                xgetSources.value.map((source) =>
                  h('option', { key: source.id, value: source.id }, `${source.name} · ${trimSlash(source.domain)}`)
                )
              ),
              h('span', { class: 'gha-label', style: 'flex:0 0 auto;margin-left:6px' }, '端口'),
              h('input', {
                class: 'gha-input',
                style: 'flex:0 0 96px',
                type: 'number',
                min: 1024,
                max: 65535,
                value: state.settings.bridgePort,
                onChange: (event) => void updateSetting('bridgePort', clampPort(event.target.value))
              })
            ]),
            h('div', { class: 'gha-inline' }, [
              h(
                'button',
                {
                  class: `gha-btn${hostProxyIsBridge.value ? '' : ' gha-btn-primary'}`,
                  type: 'button',
                  disabled: !bridgeSupported.value || state.bridge.busy,
                  onClick: async () => {
                    const outcome = await enableXgetAcceleration()
                    if (outcome.ok) toast('success', `Xget 加速已启用：本地桥 ${outcome.origin}`)
                    else toast('warning', outcome.error)
                  }
                },
                hostProxyIsBridge.value && state.bridge.running ? 'Xget 加速已启用' : '启用 Xget 加速'
              ),
              renderButton(
                state.bridge.testing ? '自检中…' : '自检',
                async () => {
                  const result = await testBridge()
                  if (result && result.ok) {
                    toast('success', `自检通过：HTTP ${result.status} · ${formatKbps(result.kbps)} · ${result.elapsedMs}ms`)
                  } else {
                    toast('danger', `自检失败：${(result && result.error) || '未知错误'}`)
                  }
                },
                { disabled: !bridgeSupported.value || state.bridge.testing || state.bridge.busy }
              ),
              renderButton('停用 Xget 加速', () => void handleDisableXget(), {
                disabled: (!hostProxyIsBridge.value && !state.bridge.running) || state.bridge.busy
              })
            ]),
            h('div', { class: 'gha-kv' }, [
              h('span', { class: 'gha-kv-key' }, '本地桥'),
              h(
                'span',
                { class: 'gha-kv-val' },
                state.bridge.running
                  ? `${state.bridge.origin}（已转发 ${state.bridgeHits} 次）`
                  : state.bridge.lastError || '未运行'
              )
            ]),
            h('div', { class: 'gha-kv' }, [
              h('span', { class: 'gha-kv-key' }, '桥接目标'),
              h(
                'span',
                { class: 'gha-kv-val' },
                xgetPrimary.value ? `${xgetPrimary.value.name} · ${trimSlash(xgetPrimary.value.domain)}` : '（无可用 Xget 线路）'
              )
            ]),
            state.bridgeTest
              ? h(
                  'div',
                  { class: `gha-note${state.bridgeTest.ok ? ' gha-note-ok' : ''}` },
                  state.bridgeTest.ok
                    ? `自检通过：HTTP ${state.bridgeTest.status} · 取到 ${formatBytes(state.bridgeTest.bytes)} / ${state.bridgeTest.elapsedMs}ms · ${formatKbps(state.bridgeTest.kbps)}`
                    : `自检失败：${state.bridgeTest.error}`
                )
              : null,
            h('div', { class: 'gha-note' }, [
              h('strong', {}, '注意：'),
              '本地桥随插件生命周期运行，插件被禁用/卸载或 EchoMusic 退出时端口会自动释放；' +
                '届时宿主会按官方逻辑回退到原始 GitHub，不会卡住更新。若要长期稳定生效，可改用仓库 ',
              h('code', {}, 'docs/xget-bridge'),
              ' 里的云端桥（一次部署，插件关掉也生效）。'
            ])
          ]),

          /* 宿主当前状态 */
          h('section', { class: 'gha-card' }, [
            h('div', { class: 'gha-card-head' }, [
              h('h2', { class: 'gha-card-title' }, '宿主当前设置'),
              h('span', { class: 'gha-card-hint' }, `最近测速：${formatTime(state.stats.lastTestAt)}`)
            ]),
            h('div', { class: 'gha-kv' }, [
              h('span', { class: 'gha-kv-key' }, 'GitHub 加速地址'),
              h('span', { class: 'gha-kv-val' }, hostProxyUrl.value || '（空）')
            ]),
            h('div', { class: 'gha-kv' }, [
              h('span', { class: 'gha-kv-key' }, '状态'),
              h('span', { class: 'gha-kv-val' }, hostProxyCompatible.value.text)
            ]),
            h('div', { class: 'gha-kv' }, [
              h('span', { class: 'gha-kv-key' }, '侧边栏入口'),
              h(
                'span',
                { class: 'gha-kv-val' },
                !state.settings.showSidebarEntry
                  ? '已关闭（可在加速器设置里开启）'
                  : sidebarSectionFolded.value
                    ? '已注册，但「插件」分组被折叠'
                    : '已注册并可见'
              )
            ]),
            state.settings.showSidebarEntry && sidebarSectionFolded.value
              ? h('div', { class: 'gha-note' }, [
                  h('strong', {}, '侧边栏入口不见了？'),
                  '宿主把「插件」分组折叠了，组内入口会被整组收起（任务栏歌词等其它插件入口同样看不见）。',
                  h('div', { class: 'gha-inline', style: 'margin-top:8px' }, [
                    renderButton('展开「插件」分组', () => void handleUnfoldSidebar(), {
                      small: true,
                      primary: true
                    })
                  ])
                ])
              : null,
            h(
              'div',
              {
                class: `gha-note${
                  hostProxyCompatible.value.state === 'known' || hostProxyCompatible.value.state === 'bridge'
                    ? ' gha-note-ok'
                    : ''
                }`
              },
              [
                h('strong', {}, '格式提示：'),
                '宿主把该值拼成 ',
                h('code', {}, '前缀 + / + 完整 GitHub URL'),
                '（例如 ',
                h('code', {}, 'https://gh-proxy.com/https://github.com/…'),
                '）。所以只有 gh-proxy 形态可以直填；Xget 的路径重写形态（',
                h('code', {}, '/gh/owner/repo/path'),
                '）直填会 404 —— 这种情况请用上面的「Xget 本地加速」，由本地桥完成换算。'
              ]
            )
          ]),

          /* 测速进度 */
          state.testing
            ? h('section', { class: 'gha-card' }, [
                h('div', { class: 'gha-card-head' }, [
                  h('h2', { class: 'gha-card-title' }, '正在测速'),
                  h('span', { class: 'gha-card-hint' }, `${state.testDone} / ${state.testTotal}`)
                ]),
                h('div', { class: 'gha-progress' }, [
                  h('div', {
                    class: 'gha-progress-bar',
                    style: `width:${state.testTotal ? (state.testDone / state.testTotal) * 100 : 0}%`
                  })
                ])
              ])
            : null,

          /* gh-proxy 线路 */
          h('section', { class: 'gha-card' }, [
            h('div', { class: 'gha-card-head' }, [
              h('h2', { class: 'gha-card-title' }, 'gh-proxy 线路（可直接写入宿主设置）'),
              h('span', { class: 'gha-card-hint' }, `${proxySources.value.length} 条 · 绿色为可用，红色为失败`)
            ]),
            h('div', { class: 'gha-list' }, proxySources.value.map(renderSourceRow))
          ]),

          /* Xget 线路 */
          h('section', { class: 'gha-card' }, [
            h('div', { class: 'gha-card-head' }, [
              h('h2', { class: 'gha-card-title' }, 'Xget 线路（多平台链接转换）'),
              h('span', { class: 'gha-card-hint' }, 'Xget 支持 30+ 平台，但形态与宿主设置不兼容')
            ]),
            h('div', { class: 'gha-list' }, xgetSources.value.map(renderSourceRow))
          ]),

          /* 自定义线路 */
          h('section', { class: 'gha-card' }, [
            h('h2', { class: 'gha-card-title' }, '添加自定义线路'),
            h('div', { class: 'gha-inline' }, [
              h('input', {
                class: 'gha-input',
                style: 'flex:0 0 150px',
                placeholder: '名称，如 我的节点',
                value: state.newName,
                onInput: (event) => {
                  state.newName = event.target.value
                }
              }),
              h('input', {
                class: 'gha-input',
                placeholder: '域名，如 https://gh.example.com',
                value: state.newDomain,
                onInput: (event) => {
                  state.newDomain = event.target.value
                }
              }),
              h(
                'select',
                {
                  class: 'gha-select',
                  style: 'flex:0 0 168px',
                  value: state.newKind,
                  onChange: (event) => {
                    state.newKind = event.target.value
                  }
                },
                [
                  h('option', { value: 'ghproxy' }, 'gh-proxy 形态'),
                  h('option', { value: 'xget' }, 'Xget 形态')
                ]
              ),
              renderButton('添加', addCustomSource, { primary: true })
            ]),
            state.customSources.length
              ? h('div', { class: 'gha-list' }, state.customSources.map(renderSourceRow))
              : h('div', { class: 'gha-placeholder' }, '暂无自定义线路（内置线路已覆盖常用公共加速站）')
          ]),

          /* URL 转换 */
          h('section', { class: 'gha-card' }, [
            h('h2', { class: 'gha-card-title' }, `链接转换（当前线路：${bestAny.value ? bestAny.value.name : '默认线路'}）`),
            h('div', { class: 'gha-inline' }, [
              h('input', {
                class: 'gha-input',
                placeholder: 'https://github.com/owner/repo/archive/refs/heads/main.zip',
                value: state.convertInput,
                onInput: (event) => {
                  state.convertInput = event.target.value
                },
                onKeydown: (event) => {
                  if (event.key === 'Enter') convert()
                }
              }),
              renderButton('转换', convert, { primary: true })
            ]),
            state.convertError
              ? h('div', { class: 'gha-note' }, state.convertError)
              : null,
            state.convertOutput
              ? h('div', [
                  h('div', { class: 'gha-out gha-out-ok' }, state.convertOutput),
                  h('div', { class: 'gha-inline', style: 'margin-top:8px' }, [
                    renderButton(icon(ICON_COPY, 13), async () => {
                      const ok = await copyText(state.convertOutput)
                      toast(ok ? 'success' : 'danger', ok ? '已复制加速链接' : '复制失败')
                    }, { small: true }),
                    h('span', { style: 'font-size:12px' }, '复制'),
                    renderButton(icon(ICON_LINK, 13), () => openExternal(state.convertOutput), { small: true }),
                    h('span', { style: 'font-size:12px' }, '打开')
                  ])
                ])
              : null
          ]),

          /* 批量转换 */
          h('section', { class: 'gha-card' }, [
            h('h2', { class: 'gha-card-title' }, '批量转换'),
            h('textarea', {
              class: 'gha-textarea',
              placeholder: '每行一个 URL…',
              value: state.batchInput,
              onInput: (event) => {
                state.batchInput = event.target.value
              }
            }),
            h('div', { class: 'gha-inline' }, [
              renderButton('批量转换', convertBatch, { primary: true }),
              renderButton('复制全部结果', () => void copyBatchOutput(), { disabled: !state.batchOutput.length }),
              renderButton('清空', () => {
                state.batchInput = ''
                state.batchOutput = []
              })
            ]),
            state.batchOutput.length
              ? h('div', { class: 'gha-out' }, state.batchOutput.map((item, index) =>
                  h('div', { key: index, style: 'margin-bottom:6px' }, [
                    h('div', { style: 'opacity:.65' }, item.input),
                    h('div', {}, item.output ? `→ ${item.output}` : `→ ${item.note}`)
                  ])
                ))
              : null
          ]),

          /* 统计 */
          h('section', { class: 'gha-card' }, [
            h('div', { class: 'gha-card-head' }, [
              h('h2', { class: 'gha-card-title' }, '统计'),
              renderButton('重置', resetStats, { small: true, danger: true })
            ]),
            h('div', { class: 'gha-stats' }, [
              h('div', { class: 'gha-stat' }, [
                h('div', { class: 'gha-stat-num' }, String(state.stats.conversions)),
                h('div', { class: 'gha-stat-cap' }, '转换次数')
              ]),
              h('div', { class: 'gha-stat' }, [
                h('div', { class: 'gha-stat-num' }, String(state.stats.succeeded)),
                h('div', { class: 'gha-stat-cap' }, '成功')
              ]),
              h('div', { class: 'gha-stat' }, [
                h('div', { class: 'gha-stat-num' }, String(state.stats.failed)),
                h('div', { class: 'gha-stat-cap' }, '失败')
              ]),
              h('div', { class: 'gha-stat' }, [
                h('div', { class: 'gha-stat-num' }, String(state.stats.applies)),
                h('div', { class: 'gha-stat-cap' }, '写入宿主')
              ]),
              h('div', { class: 'gha-stat' }, [
                h('div', { class: 'gha-stat-num' }, String(state.stats.lastTestCount)),
                h('div', { class: 'gha-stat-cap' }, '最近测速条数')
              ])
            ])
          ])
        ])
    }
  })

  /* ------------------------------------------------------------------ */
  /* 设置面板                                                            */
  /* ------------------------------------------------------------------ */

  const SettingsPanel = defineComponent({
    name: 'GhAcceleratorSettings',
    setup() {
      const save = updateSetting

      return () =>
        h('div', { class: 'gha-settings' }, [
          renderSwitch('侧边栏入口', '在侧边栏「插件」分组显示加速器入口（切换后立即生效；若分组被折叠需先展开）', state.settings.showSidebarEntry, (v) => void save('showSidebarEntry', v)),
          renderSwitch('打开页面时自动测速', '进入加速器页面后自动跑一次全线路测速（与页面内开关同一个配置；5 分钟内已测过则跳过）', state.settings.autoTestOnOpen, (v) => void save('autoTestOnOpen', v)),
          renderSwitch('显示通知', '测速与写入结果通过应用内提示反馈', state.settings.notify, (v) => void save('notify', v)),
          renderSwitch(
            '在线插件界面显示加速状态条',
            '在「插件管理 → 在线插件」的工具条下方显示当前加速线路、实时速度与快捷操作',
            state.settings.showMarketplaceStrip,
            (v) => void save('showMarketplaceStrip', v)
          ),
          renderSwitch(
            '负载均衡（随机挑线路）',
            '「应用最快线路」时改为在实测最快的 4 条里随机选一条。公益节点带宽有限，固定打同一条会加速其失效',
            state.settings.loadBalance,
            (v) => void save('loadBalance', v)
          ),
          renderSwitch('调试日志', '在开发者控制台输出详细日志', state.settings.debug, (v) => void save('debug', v)),

          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '测速并发数（1–8）'),
            h('input', {
              class: 'gha-input',
              type: 'number',
              min: 1,
              max: 8,
              value: state.settings.concurrency,
              onChange: (event) => {
                const value = Math.max(1, Math.min(8, Number(event.target.value) || 4))
                void save('concurrency', value)
              }
            })
          ]),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '单次请求超时（毫秒）'),
            h('input', {
              class: 'gha-input',
              type: 'number',
              min: 2000,
              max: 60000,
              step: 500,
              value: state.settings.timeoutMs,
              onChange: (event) => {
                const value = Math.max(2000, Math.min(60000, Number(event.target.value) || 8000))
                void save('timeoutMs', value)
              }
            })
          ]),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '连通性测速文件（越小越快，需为 GitHub 系主机）'),
            h('input', {
              class: 'gha-input',
              value: state.settings.probeUrl,
              onChange: (event) => void save('probeUrl', String(event.target.value).trim())
            })
          ]),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '吞吐测速文件（越大越准，注意流量）'),
            h('input', {
              class: 'gha-input',
              value: state.settings.throughputUrl,
              onChange: (event) => void save('throughputUrl', String(event.target.value).trim())
            })
          ]),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '吞吐测速体积上限（MiB）'),
            h('input', {
              class: 'gha-input',
              type: 'number',
              min: 1,
              max: 60,
              value: state.settings.throughputLimitMiB,
              onChange: (event) => {
                const value = Math.max(1, Math.min(60, Number(event.target.value) || 12))
                void save('throughputLimitMiB', value)
              }
            })
          ]),
          renderSwitch(
            '启动时自动恢复本地桥',
            '若宿主加速地址仍指向本地桥，启动插件时自动重新监听端口，避免重启后失效',
            state.settings.bridgeAutoStart,
            (v) => void save('bridgeAutoStart', v)
          ),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '本地桥端口（1024–65535，改动后需重新「启用 Xget 加速」）'),
            h('input', {
              class: 'gha-input',
              type: 'number',
              min: 1024,
              max: 65535,
              value: state.settings.bridgePort,
              onChange: (event) => void save('bridgePort', clampPort(event.target.value))
            })
          ]),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '桥接使用的 Xget 线路'),
            h(
              'select',
              {
                class: 'gha-select',
                value: state.settings.xgetPrimaryId,
                onChange: (event) => void save('xgetPrimaryId', String(event.target.value))
              },
              [
                h('option', { value: '' }, '自动（用测速最快的 Xget）'),
                ...xgetSources.value.map((source) =>
                  h('option', { key: source.id, value: source.id }, `${source.name} · ${trimSlash(source.domain)}`)
                )
              ]
            )
          ]),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '排除规则（每行一条，支持正则，如 /\\.md$/ 或字面量）'),
            h('textarea', {
              class: 'gha-textarea',
              value: (state.settings.excludeList || []).join('\n'),
              onChange: (event) => {
                const list = String(event.target.value)
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean)
                void save('excludeList', list)
              }
            })
          ]),
          h('div', { class: 'gha-section-title' }, '在线插件页 · 拉取进度'),
          renderSwitch(
            '显示刷新进度条',
            '在「在线插件」界面顶部显示刷新时的拉取进度、已拉取数量与拉取速率',
            state.settings.showMarketplaceProgress,
            (v) => void save('showMarketplaceProgress', v)
          ),
          renderSwitch(
            '刷新时探测插件总数（更准的进度分母）',
            '宿主不对外暴露进度，插件会自己预请求一次插件源索引来拿「插件总数」。' +
              '开销极小（一个几 KB 的 JSON），关闭后只能按阶段估算百分比',
            state.settings.probeMarketplaceCount,
            (v) => void save('probeMarketplaceCount', v)
          ),
          h('div', { class: 'gha-field' }, [
            h('span', { class: 'gha-label' }, '探针超时（ms，1 秒–15 秒）'),
            h('input', {
              class: 'gha-input',
              type: 'number',
              min: 1000,
              max: 15000,
              value: state.settings.marketplaceProbeTimeoutMs,
              onChange: (event) => {
                const value = Math.max(1000, Math.min(15000, Number(event.target.value) || 4000))
                void save('marketplaceProbeTimeoutMs', value)
              }
            })
          ]),
          renderSwitch(
            '接管「刷新」按钮（精确进度）',
            '在宿主刷新按钮上层加一个透明命中层，点下去改由插件自己走一遍拉取，' +
              '进度与数量就是真实值而不是推定值。关闭后仍会显示进度，只是精确度略低',
            state.settings.takeoverMarketplaceRefresh,
            (v) => {
              void save('takeoverMarketplaceRefresh', v)
              // 直接调用而不是 nextTick：设置面板可能不在组件上下文里（例如无头测试），
              // nextTick 的回调不保证会被调度；而 save() 已同步写好 state.settings。
              syncRefreshTakeover()
            }
          ),
          h('div', { class: 'gha-note' }, [
            h('strong', {}, '提示：'),
            '本插件只能写入宿主的 GitHub 加速地址，不会修改任何账号数据；写入失败时可在「设置 → 更新 → GitHub 加速地址」手动粘贴。'
          ])
        ])
    }
  })

  /* ------------------------------------------------------------------ */
  /* 在线插件页：刷新时的拉取进度 / 数量 / 速率                            */
  /* ------------------------------------------------------------------ */
  /*                                                                    */
  /* 结论（逆向自 app.asar，详见 docs/）：宿主刷新市场的链路是              */
  /*   按钮 → loadMarketplace(refresh=true) → N_() → D_()                */
  /*   → 每个启用的源并行：① 拉 echo-plugins.json 拿插件总数 N            */
  /*                      ② 并行拉 N 个 manifest                         */
  /*                      ③ 写缓存 + 拉热度统计                          */
  /* 宿主**没有**把任何进度事件暴露给插件，也没有字节回调。                */
  /* 所以这里的进度/数量/速率是三路融合「推定」出来的：                     */
  /*   ① DOM 骨架：.plugin-card-grid[aria-busy="true"] 存在 ⇒ 仍在加载     */
  /*   ② 卡片计数：真实卡片逐个渲染 ⇒ 「已到手」的可见代理                  */
  /*   ③ 主动探针：自己探一次源拿插件总数 N 与真实字节 ⇒ 分母与速率的来源    */
  /* 三路互相校验：有可信分母就用「已到手/总数」，没有就退回阶段权重。       */

  const MKT_POLL_MS = 250
  /** 心跳间隔：驱动「已用 / 约剩」这类时间文案持续刷新 */
  const MKT_BEAT_MS = 500
  /** 刷新完成后进度条继续停留展示的时长 */
  const MKT_RESULT_LINGER_MS = 12000

  /** 当前阶段在整体中的起点与跨度（用于分母未知时的兜底进度） */
  const MKT_STAGE_SPAN = {
    probe: [0, 0.08],
    index: [0.08, 0.17],
    manifests: [0.25, 0.7],
    settle: [0.95, 0.05]
  }
  /** 单源索引地址：`{加速前缀}/{原始 raw URL}` */
  function marketplaceIndexUrl(proxyUrl) {
    const raw = `https://raw.githubusercontent.com/${OFFICIAL_MARKETPLACE_REPO}/HEAD/echo-plugins.json`
    const prefix = trimSlash(proxyUrl)
    if (!prefix || !/^https?:\/\//i.test(prefix)) return raw
    try {
      const parsed = new URL(raw)
      if (!isGithubHost(parsed.hostname)) return raw
      return `${prefix}/${raw}`
    } catch (error) {
      log('拼接索引地址失败', error)
      return raw
    }
  }

  /**
   * 主动探针：拉一次插件索引，拿到「插件总数」与「索引字节数 / 耗时」。
   * 这是进度分母的唯一可信来源 —— 宿主不会告诉我们总数。
   * 走的是与宿主相同的加速前缀，所以速率也贴近宿主的真实体验。
   */
  /**
   * 主动探针：拉一次插件索引，拿到「插件总数」与「索引字节数 / 耗时」。
   * 这是进度分母的唯一可信来源 —— 宿主不会告诉我们总数。
   *
   * 取数语义与宿主保持一致（asar 里索引请求走的就是这条双段策略）：
   *   先打加速前缀，**失败再回落直连原始地址**。
   * 宿主对索引请求正是这么做的，只探加速那一次的话，
   * 镜像偶发抖动 / 返回 HTML 错误页就会让「插件总数」直接丢掉，
   * 进度只能退回阶段估算 —— 而总数正是本功能要给用户看的东西。
   */
  async function probeMarketplaceIndex(proxyUrl) {
    const proxied = marketplaceIndexUrl(proxyUrl)
    const direct = marketplaceIndexUrl('')
    const timeoutMs = state.settings.marketplaceProbeTimeoutMs || DEFAULT_MARKETPLACE_PROBE_TIMEOUT_MS
    // 没有配加速前缀时两者相同，只需探一次
    const attempts = proxied === direct ? [direct] : [proxied, direct]

    let lastError = ''
    let lastUrl = proxied

    for (let index = 0; index < attempts.length; index += 1) {
      const url = attempts[index]
      lastUrl = url
      const startedAt = Date.now()
      try {
        const response = await httpGet(url, { timeoutMs, responseType: 'arrayBuffer' })
        const bytes = byteLengthOf(response?.data)
        const text = response?.data ? await bytesToText(response.data) : ''
        const parsed = text ? safeJsonParse(text) : null
        const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins.length : 0
        const elapsed = Math.max(1, Date.now() - startedAt)

        state.mkt.probeRequests += 1
        state.mkt.probeBytes += bytes
        state.mkt.probeMs += elapsed

        // 拿到了 JSON 但没有插件列表 ⇒ 多半是镜像的错误页，继续回落
        if (plugins <= 0) {
          lastError = parsed ? '索引里没有插件列表' : '索引不是合法 JSON（镜像可能返回了错误页）'
          continue
        }

        return {
          ok: true,
          url,
          /** true 表示加速前缀失败、这一份是直连拿到的 */
          viaFallback: index > 0,
          bytes,
          ms: elapsed,
          kbps: bytes > 0 ? bytes / 1024 / (elapsed / 1000) : 0,
          plugins,
          name: String(parsed?.name ?? ''),
          error: ''
        }
      } catch (error) {
        const elapsed = Math.max(1, Date.now() - startedAt)
        state.mkt.probeRequests += 1
        state.mkt.probeMs += elapsed
        lastError = describeError(error)
      }
    }

    return {
      ok: false,
      url: lastUrl,
      viaFallback: false,
      bytes: 0,
      ms: 0,
      kbps: 0,
      plugins: 0,
      name: '',
      error: lastError
    }
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text)
    } catch (error) {
      return null
    }
  }

  /** ArrayBuffer / Uint8Array → 文本（只用于小体积 JSON） */
  async function bytesToText(data) {
    try {
      if (typeof data === 'string') return data
      if (typeof Blob !== 'undefined' && data instanceof Blob) return await data.text()
      if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(data))
      if (ArrayBuffer.isView(data)) return new TextDecoder('utf-8').decode(data)
    } catch (error) {
      log('解码文本失败', error)
    }
    return ''
  }

  /** 从宿主页面 DOM 里读取骨架屏与真实卡片的数量 */
  function readMarketplaceDom() {
    if (typeof document === 'undefined') return { busy: false, skeletons: 0, rendered: 0, mounted: false }

    const grids = Array.from(document.querySelectorAll('.plugin-card-grid'))
    const toolbar = document.querySelector('.marketplace-toolbar')
    if (!toolbar) return { busy: false, skeletons: 0, rendered: 0, mounted: false }

    let busy = false
    let skeletons = 0
    let rendered = 0
    for (const grid of grids) {
      const isBusy = grid.getAttribute('aria-busy') === 'true'
      const cards = grid.querySelectorAll('.plugin-card')
      if (isBusy) {
        busy = true
        skeletons += cards.length
        continue
      }
      // 非 busy 网格里的 .plugin-card 才是真实卡片；骨架卡也带 .marketplace-card，
      // 因此以 grid 的 aria-busy 区分，而不是看卡片自身。
      rendered += cards.length
    }
    return { busy, skeletons, rendered, mounted: true }
  }

  /** 读宿主标题栏的计数文案（`共 N 个 · ...`），作为分母的兜底来源 */
  function readMarketplaceCountLabel() {
    if (typeof document === 'undefined') return 0
    try {
      const headings = Array.from(document.querySelectorAll('.plugin-content-heading'))
      for (const heading of headings) {
        const span = heading.querySelector('span')
        const text = span ? String(span.textContent || '') : ''
        const match = /(\d+)\s*(?:个|项|款)/.exec(text)
        if (match) return Number(match[1]) || 0
      }
    } catch (error) {
      log('读取市场计数失败', error)
    }
    return 0
  }

  /** 组装给 UI 用的进度快照 */
  const mktProgress = computed(() => {
    const m = state.mkt
    const dom = m.dom
    // 建立对心跳的依赖：时间类字段（已用/剩余/完成后倒计时）本身不是响应式的，
    // 靠 beat 每次递增来驱动这个 computed 重新求值，否则数字会「冻」在第一次的值上。
    void m.beat

    // 分母：优先探针给的可信总数，其次宿主标题计数（宿主渲染后可直接读到）
    const total = m.totalKnown && m.total > 0 ? m.total : readMarketplaceCountLabel() || 0
    const rendered = dom && dom.rendered ? dom.rendered : m.rendered

    let ratio = 0
    let mode = 'stage'
    if (m.active) {
      if (m.own) {
        // 接管模式：阶段由插件自己串行推进，百分比直接用阶段权重（精确到阶段）
        mode = total > 0 && rendered > 0 ? 'count' : 'stage'
        ratio = mode === 'count' ? Math.min(1, rendered / total) : m.stageRatio
      } else if (total > 0 && rendered > 0) {
        mode = 'count'
        ratio = Math.min(1, rendered / total)
      } else {
        ratio = m.stageRatio
      }
    } else if (m.phase === 'done') {
      ratio = 1
      mode = 'done'
    }

    // 速率：优先真实探针字节/耗时（最可信），退化为「卡片吞吐」
    const elapsedMs = m.active && m.startedAt ? Date.now() - m.startedAt : m.last ? m.last.elapsedMs : 0
    let speedKbps = 0
    if (m.probeMs > 0 && m.probeBytes > 0) {
      speedKbps = m.probeBytes / 1024 / (m.probeMs / 1000)
    }
    const cardRate = elapsedMs > 0 && rendered > 0 ? rendered / (elapsedMs / 1000) : 0

    const etaMs =
      m.active && ratio > 0.02 && ratio < 1 && elapsedMs > 0
        ? Math.max(0, (elapsedMs / ratio) * (1 - ratio))
        : 0

    return {
      active: m.active,
      own: m.own,
      phase: m.phase,
      phaseLabel: (MKT_PHASES.find((p) => p.id === m.phase) || MKT_PHASES[0]).label,
      total,
      totalKnown: total > 0,
      rendered,
      skeletons: dom ? dom.skeletons : 0,
      ratio,
      mode,
      elapsedMs,
      etaMs,
      speedKbps,
      cardRate,
      probeBytes: m.probeBytes,
      probeRequests: m.probeRequests,
      probeFallback: m.probeFallback,
      error: m.error,
      last: m.last
    }
  })

  /* ---------------- 刷新进度跟踪器 ---------------- */

  let mktPollTimer = null
  let mktProbeRun = null
  /** 一次刷新里已经结算过的 DOM 峰值，避免卡片因过滤/搜索变动导致进度回退 */
  let mktPeakRendered = 0

  function setMktPhase(phase) {
    if (state.mkt.phase === phase) return
    state.mkt.phase = phase
    const span = MKT_STAGE_SPAN[phase]
    if (span) state.mkt.stageRatio = span[0] + span[1] * 0.5
  }

  /** 开始跟踪一次刷新。`own` 为 true 时表示由插件自己驱动（精确模式） */
  function beginMarketplaceTracking(options = {}) {
    const m = state.mkt
    m.active = true
    m.own = options.own === true
    m.phase = 'probe'
    m.stageRatio = MKT_STAGE_SPAN.probe[0] + MKT_STAGE_SPAN.probe[1] * 0.5
    m.total = 0
    m.totalKnown = false
    m.rendered = 0
    m.skeletons = 0
    m.startedAt = Date.now()
    m.endedAt = 0
    m.probeRequests = 0
    m.probeBytes = 0
    m.probeMs = 0
    m.probeFallback = false
    m.error = ''
    mktPeakRendered = 0
    m.dom = readMarketplaceDom()

    // 接管模式下由 takeoverRefresh 自己串行推进，不开轮询，避免两条管线互相打架
    if (m.own) return

    if (state.settings.probeMarketplaceCount) {
      const proxy = hostProxyUrl.value
      mktProbeRun = probeMarketplaceIndex(proxy).then((result) => {
        if (!state.mkt.active) return result
        if (result.ok && result.plugins > 0) {
          state.mkt.total = result.plugins
          state.mkt.totalKnown = true
          state.mkt.probeFallback = result.viaFallback === true
          if (state.mkt.phase === 'probe') setMktPhase('index')
        } else if (!result.ok) {
          state.mkt.error = result.error
        }
        return result
      })
    } else {
      mktProbeRun = Promise.resolve(null)
    }

    if (mktPollTimer) clearInterval(mktPollTimer)
    mktPollTimer = setInterval(tickMarketplaceTracking, MKT_POLL_MS)
    startMktHeartbeat()
    tickMarketplaceTracking()
  }

  /**
   * 心跳：进度条上的「已用 / 约剩」以及完成后的 12 秒倒计时都依赖当前时间，
   * 而时间是**非响应式**的。没有心跳的话，这些数字只会在其它响应式字段恰好变化时才更新，
   * 表现为「数字卡住不动」。这里用一个独立定时器持续轻推 beat。
   */
  let mktBeatTimer = null
  function startMktHeartbeat() {
    if (mktBeatTimer) return
    mktBeatTimer = setInterval(() => {
      const m = state.mkt
      if (m.active) {
        m.beat += 1
        return
      }
      // 已完成：在 12 秒展示窗口内继续跳动，以便倒计时到期后自动收起
      if (m.last && Date.now() - m.last.at < MKT_RESULT_LINGER_MS) {
        m.beat += 1
        return
      }
      // 窗口过期且没有别的活要干 → 停表，避免空转
      if (mktBeatTimer) {
        clearInterval(mktBeatTimer)
        mktBeatTimer = null
      }
    }, MKT_BEAT_MS)
  }
  function stopMktHeartbeat() {
    if (mktBeatTimer) {
      clearInterval(mktBeatTimer)
      mktBeatTimer = null
    }
  }

  /** 轮询：按 DOM 观测推进阶段与计数 */
  function tickMarketplaceTracking() {
    const m = state.mkt
    const dom = readMarketplaceDom()
    m.dom = dom

    if (!m.active) return

    // 接管模式：宿主按钮没被点、页面上不会有骨架屏，DOM 观测毫无意义。
    // 进度完全由 takeoverRefresh 的分阶段回调驱动，这里直接返回。
    if (m.own) return

    // 卡片数只增不减（同一轮刷新内），防止过滤导致进度倒退
    if (dom.rendered > mktPeakRendered) mktPeakRendered = dom.rendered
    m.rendered = mktPeakRendered

    const elapsed = Date.now() - m.startedAt

    if (dom.busy) {
      // 还在加载：骨架在前段 ⇒ 索引/清单阶段；骨架数减少 ⇒ 已在收尾
      if (m.phase === 'probe' || m.phase === 'idle') setMktPhase('index')
      else if (m.phase === 'index' && dom.skeletons > 0) setMktPhase('manifests')
      else if (m.phase === 'manifests') setMktPhase('settle')
      const span = MKT_STAGE_SPAN[m.phase] || [0, 1]
      // 阶段内按时间做渐近推进，但不超过该阶段上限
      const inner = Math.min(0.95, elapsed / (elapsed + MKT_POLL_MS * 12))
      m.stageRatio = span[0] + span[1] * inner
      return
    }

    // 骨架消失 + 有真实卡片 ⇒ 本轮结束
    if (dom.rendered > 0 || elapsed > 1200) {
      finishMarketplaceTracking(dom.rendered)
    }
  }

  function finishMarketplaceTracking(rendered) {
    const m = state.mkt
    if (!m.active) return
    const elapsed = Math.max(1, Date.now() - m.startedAt)
    m.active = false
    m.phase = 'done'
    m.stageRatio = 1
    m.endedAt = Date.now()
    m.own = false
    m.rendered = Math.max(m.rendered, rendered || 0)
    m.last = {
      at: m.endedAt,
      elapsedMs: elapsed,
      count: m.rendered,
      total: m.totalKnown ? m.total : 0,
      speedKbps: m.probeBytes > 0 && m.probeMs > 0 ? m.probeBytes / 1024 / (m.probeMs / 1000) : 0,
      bytes: m.probeBytes,
      requests: m.probeRequests
    }
    if (mktPollTimer) {
      clearInterval(mktPollTimer)
      mktPollTimer = null
    }
    // 完成后还要在进度条上停留 MKT_RESULT_LINGER_MS 展示结果，靠心跳把倒计时推下去
    startMktHeartbeat()
    state.stats.marketplaceRefreshes = (state.stats.marketplaceRefreshes || 0) + 1
    state.stats.lastMarketplaceMs = elapsed
    scheduleSave()
    log('市场刷新完成', m.last)
  }

  /** 立刻结束并记录一次（用于用户手动结束 / 页面卸载） */
  function abortMarketplaceTracking() {
    if (mktPollTimer) {
      clearInterval(mktPollTimer)
      mktPollTimer = null
    }
    stopMktHeartbeat()
    mktProbeRun = null
    if (state.mkt.active) {
      state.mkt.active = false
      if (state.mkt.phase !== 'done') state.mkt.phase = 'idle'
    }
  }

  /* ------------------------------------------------------------------ */
  /* 在线插件界面（插件市场）里的加速状态条                                */
  /* ------------------------------------------------------------------ */

  const MarketplaceStrip = defineComponent({
    name: 'GhAccelMarketplaceStrip',
    setup() {
      /** 当前真正生效的线路 */
      const activeLine = computed(() => {
        if (hostProxyIsBridge.value) {
          const source = xgetPrimary.value
          if (!source) return null
          return {
            id: source.id,
            name: source.name,
            kind: 'xget',
            detail: `本地桥 ${trimSlash(bridgeOrigin.value)} → ${trimSlash(source.domain)}`
          }
        }
        const value = trimSlash(hostProxyUrl.value)
        if (!value) return null
        const known = allSources.value.find((s) => trimSlash(s.domain) === value)
        return {
          id: known ? known.id : '',
          name: known ? known.name : '自定义线路',
          kind: known ? known.kind : 'custom',
          detail: value
        }
      })

      const status = computed(() => {
        if (!hostProxyUrl.value) {
          return { tone: 'off', text: '未启用加速 · 直连 GitHub', hint: '插件与索引将从原始 GitHub 下载，速度受网络影响' }
        }
        if (hostProxyIsBridge.value && !state.bridge.running) {
          return {
            tone: 'warn',
            text: '加速地址指向本地桥，但本地桥未运行',
            hint: '请到「加速器」页面重新启用，或先关闭加速地址以免每次都先失败再回退'
          }
        }
        return { tone: 'on', text: '加速已启用', hint: '' }
      })

      const activeSpeed = computed(() => {
        const id = activeLine.value && activeLine.value.id
        const result = id ? state.results[id] : null
        return result && result.ok ? formatKbps(result.kbps) : ''
      })

      /** 刷新进度条主体：只在开关打开时渲染，空闲且无历史时不占位 */
      const progressBar = () => {
        if (!state.settings.showMarketplaceProgress) return null
        const p = mktProgress.value
        const show = p.active || (p.last && Date.now() - p.last.at < MKT_RESULT_LINGER_MS)
        if (!show) return null

        const percent = Math.round((p.active ? p.ratio : 1) * 100)
        // 数量文案随阶段变化，避免出现「阶段写索引、文案写信息」这种自相矛盾的组合
        let countText
        if (p.totalKnown) countText = `${p.rendered} / ${p.total} 个`
        else if (p.rendered > 0) countText = `已拉取 ${p.rendered} 个`
        else if (p.phase === 'probe') countText = '正在探测插件源…'
        else if (p.phase === 'index') countText = '正在解析插件索引…'
        else if (p.phase === 'settle' || p.phase === 'done') countText = '正在写入缓存…'
        else countText = '正在拉取插件信息…'

        const pieces = []
        if (p.active && p.own) pieces.push('精确模式')
        pieces.push(countText)
        if (p.speedKbps > 0) pieces.push(formatKbps(p.speedKbps))
        if (p.probeFallback) pieces.push('总数经直连取得')
        if (p.elapsedMs > 0) pieces.push(p.active ? `已用 ${formatDuration(p.elapsedMs)}` : `耗时 ${formatDuration(p.elapsedMs)}`)
        if (p.active && p.etaMs > 400) pieces.push(`约剩 ${formatDuration(p.etaMs)}`)

        return h('div', { class: 'gha-mkt-progress', 'data-active': String(p.active) }, [
          h('div', { class: 'gha-mkt-progress-head' }, [
            h('span', { class: 'gha-mkt-progress-phase' }, [
              p.active ? h('span', { class: 'gha-spin' }) : h('span', { class: 'gha-dot gha-dot-ok' }),
              p.active ? p.phaseLabel : p.phase === 'done' ? '刷新完成' : p.phaseLabel
            ]),
            h('span', { class: 'gha-mkt-progress-pct' }, `${percent}%`)
          ]),
          h('div', { class: 'gha-mkt-bar' }, [
            h('div', {
              class: 'gha-mkt-bar-fill',
              style: { width: `${Math.max(2, Math.min(100, percent))}%` }
            })
          ]),
          h('div', { class: 'gha-mkt-progress-meta' }, [
            ...pieces.map((text, index) => h('span', { key: `p${index}` }, text)),
            p.error ? h('span', { class: 'gha-mkt-progress-err' }, `探针失败：${p.error}`) : null
          ])
        ])
      }

      return () =>
        h('div', { class: `gha-mkt gha-mkt-${status.value.tone}` }, [
          h('span', {
            class: `gha-dot${status.value.tone === 'on' ? ' gha-dot-ok' : status.value.tone === 'warn' ? ' gha-dot-busy' : ''}`
          }),
          h('div', { class: 'gha-mkt-main' }, [
            h('div', { class: 'gha-mkt-title' }, [
              h('span', {}, status.value.text),
              activeSpeed.value ? h('span', { class: 'gha-mkt-speed' }, activeSpeed.value) : null
            ]),
            h(
              'div',
              { class: 'gha-mkt-sub' },
              activeLine.value
                ? `当前线路：${activeLine.value.name}（${activeLine.value.detail}）`
                : status.value.hint
            ),
            progressBar()
          ]),
          h('div', { class: 'gha-mkt-actions' }, [
            renderButton(state.testing ? '测速中…' : '测速', () => void runSpeedTest(), {
              small: true,
              disabled: state.testing
            }),
            hostProxyIsBridge.value && state.bridge.running
              ? null
              : renderButton('启用 Xget 加速', async () => {
                  const outcome = await enableXgetAcceleration()
                  toast(outcome.ok ? 'success' : 'warning', outcome.ok ? `Xget 加速已启用：${outcome.origin}` : outcome.error)
                }, {
                  small: true,
                  primary: true,
                  disabled: !bridgeSupported.value || state.bridge.busy
                }),
            renderButton('打开加速器', () => void openPluginPage(), { small: true })
          ])
        ])
    }
  })

  /* ------------------------------------------------------------------ */
  /* 注册                                                                */
  /* ------------------------------------------------------------------ */

  let settingsDispose = null
  let sidebarDispose = null

  /** 动态增删侧边栏入口；开关切换时立即生效（addItem 返回 disposer） */
  function applySidebarEntry(enabled) {
    if (enabled) {
      if (sidebarDispose) return true
      try {
        const dispose =
          ctx.ui && ctx.ui.sidebar && typeof ctx.ui.sidebar.addItem === 'function'
            ? ctx.ui.sidebar.addItem({
                id: 'gh-accelerator-entry',
                title: '加速器',
                icon: 'tabler:bolt',
                pageId: 'accelerator',
                section: 'plugins',
                sectionTitle: '插件',
                order: 20
              })
            : null
        sidebarDispose = typeof dispose === 'function' ? dispose : () => {}
        log('侧边栏入口已注册')
        return true
      } catch (error) {
        log('注册侧边栏入口失败', error)
        sidebarDispose = null
        return false
      }
    }

    if (typeof sidebarDispose === 'function') {
      try {
        sidebarDispose()
      } catch (error) {
        log('移除侧边栏入口失败', error)
      }
    }
    sidebarDispose = null
    log('侧边栏入口已移除')
    return true
  }

  try {
    const [saved, savedStats] = await Promise.all([
      ctx.storage.get(STORAGE_KEY),
      ctx.storage.get(STATS_KEY)
    ])
    applyLoaded(saved?.settings, saved?.customSources, savedStats)
  } catch (error) {
    log('读取配置失败，使用默认值', error)
    applyLoaded(null, [], null)
  }
  state.ready = true

  // 若宿主的加速地址仍指向本地桥，自动把桥恢复起来，避免主程序重启后失效
  if (state.settings.bridgeAutoStart && hostProxyIsBridge.value) {
    const restored = await startBridge()
    if (restored.ok) {
      log('已自动恢复本地桥', restored.origin)
    } else {
      log('启动时恢复本地桥失败', restored.error)
      try {
        ctx.toast.warning(`GitHub 加速器：本地桥启动失败（${restored.error}），宿主将自动回退到原始 GitHub`)
      } catch (error) {
        log('提示失败', error)
      }
    }
  }

  // 页面本身不带 sidebar：入口改为「可动态增删」，这样设置里开关能立即生效，不用重启主程序
  ctx.ui.addPage({
    id: 'accelerator',
    title: '加速器',
    icon: 'tabler:bolt',
    component: AcceleratorPage
  })

  applySidebarEntry(state.settings.showSidebarEntry)

  settingsDispose = ctx.ui.settings.define({
    title: 'GitHub 加速器 设置',
    description: '线路测速、请求参数与排除规则。',
    component: SettingsPanel
  })

  /* ---------- 把加速状态条挂进「插件管理 → 在线插件」界面 ---------- */

  let stripHost = null
  let stripMountDispose = null
  let stripObserverDispose = null
  let takeoverHost = null
  let takeoverMountDispose = null

  /**
   * 找到宿主的「刷新」按钮。
   * 只在 `.marketplace-toolbar` 内部找，避免误伤其它页面的刷新按钮；
   * 同时排除插件自己注入的按钮（带 gha- 前缀的 class）。
   */
  function findMarketplaceRefreshButton() {
    if (typeof document === 'undefined') return null
    const toolbar = document.querySelector('.marketplace-toolbar')
    if (!toolbar || typeof toolbar.querySelectorAll !== 'function') return null
    let buttons = []
    try {
      buttons = Array.from(toolbar.querySelectorAll('button'))
    } catch (error) {
      return null
    }
    const candidates = buttons.filter((btn) => {
      const cls = typeof btn.className === 'string' ? btn.className : ''
      return !/(^|\s)gha-/.test(cls)
    })
    if (!candidates.length) return null
    // 刷新按钮是工具条里唯一带旋转图标的（宿主在拉取中会给图标加 animate-spin）
    const spinning = candidates.find((btn) => {
      const cls = typeof btn.className === 'string' ? btn.className : ''
      return cls.includes('animate-spin') || String(btn.innerHTML || '').includes('animate-spin')
    })
    if (spinning) return spinning
    // 退而求其次：取最后一个（宿主的工具条里刷新在最右）
    return candidates[candidates.length - 1]
  }

  /** 用插件自己的管线驱动一次刷新，并把进度显示切换为「精确模式」 */
  async function takeoverRefresh() {
    const m = state.mkt
    if (m.own) return
    m.own = true
    beginMarketplaceTracking({ own: true })

    const proxy = hostProxyUrl.value
    let ok = 0
    let failed = 0
    try {
      const probe = await (mktProbeRun || Promise.resolve(null))
      if (probe && probe.ok && probe.plugins > 0) {
        m.total = probe.plugins
        m.totalKnown = true
        m.probeFallback = probe.viaFallback === true
      }
      setMktPhase('manifests')

      // 走宿主同一套 IPC：拿回每个源解析好的 manifest（宿主内部已并行拉取）
      const detail = await ctx.electron.plugins.marketplace.list({ githubProxyUrl: proxy, refresh: true })
      const plugins = Array.isArray(detail?.plugins) ? detail.plugins : []
      ok = plugins.length
      failed = (Array.isArray(detail?.sources) ? detail.sources : []).filter((s) => s && s.lastError).length
      m.rendered = mktPeakRendered = Math.max(mktPeakRendered, ok)
      if (m.totalKnown && ok > m.total) m.total = ok
    } catch (error) {
      m.error = describeError(error)
    } finally {
      setMktPhase('settle')
      m.own = false
      finishMarketplaceTracking(ok)
    }

    log('已接管刷新完成', { ok, failed })
    return { ok: ok > 0 && failed === 0, count: ok, failed }
  }

  function removeMarketplaceStrip() {
    if (typeof stripMountDispose === 'function') {
      try {
        stripMountDispose()
      } catch (error) {
        log('卸载状态条失败', error)
      }
    }
    stripMountDispose = null
    if (stripHost && stripHost.parentNode) stripHost.parentNode.removeChild(stripHost)
    stripHost = null
  }

  function injectMarketplaceStrip() {
    // 宿主重渲染后旧容器可能已脱离文档，先清理再判断
    if (stripHost && !stripHost.isConnected) removeMarketplaceStrip()

    if (!state.settings.showMarketplaceStrip) {
      removeMarketplaceStrip()
      return
    }
    if (document.querySelector('.gha-mkt-strip-host')) return

    const anchor = document.querySelector('.marketplace-toolbar')
    if (!anchor || !anchor.parentNode) return

    const host = document.createElement('div')
    host.className = 'gha-mkt-strip-host'
    anchor.parentNode.insertBefore(host, anchor.nextSibling)
    stripHost = host

    try {
      stripMountDispose = ctx.ui.mount(host, MarketplaceStrip) || null
    } catch (error) {
      log('挂载加速状态条失败', error)
      removeMarketplaceStrip()
    }
  }

  /* ---------- 可选：接管宿主的「刷新」按钮 ---------- */

  /**
   * 接管模式：在宿主刷新按钮上层盖一个透明的「命中层」。
   * 宿主在拉取中会给按钮加 disabled，直接 .click() 会被吞掉，
   * 所以不能靠代理点击，而是在捕获阶段拦下事件、由插件自己驱动刷新。
   * 用盖层而不是替换按钮，是为了完全不动宿主的 DOM，取消接管时零残留。
   */
  function installRefreshTakeover() {
    if (takeoverHost && takeoverHost.isConnected) return
    const button = findMarketplaceRefreshButton()
    if (!button || !button.parentNode) return

    // 宿主按钮的定位上下文必须是 relative，否则盖层会跑到别处
    try {
      const position = typeof getComputedStyle === 'function' ? getComputedStyle(button).position : ''
      if (!position || position === 'static') button.style.position = 'relative'
    } catch (error) {
      /* 拿不到样式就算了，多数情况按钮本身已是 relative */
    }

    const host = document.createElement('div')
    host.className = 'gha-takeover-hit'
    host.setAttribute('title', '刷新插件市场（由 GitHub 加速器接管，可显示精确进度）')
    host.style.cssText = 'position:absolute;inset:0;z-index:5;cursor:pointer;'
    host.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void takeoverRefresh()
    }, true)
    button.appendChild(host)
    takeoverHost = host
  }

  function removeRefreshTakeover() {
    if (takeoverHost && takeoverHost.parentNode) {
      try {
        takeoverHost.parentNode.removeChild(takeoverHost)
      } catch (error) {
        log('移除刷新接管层失败', error)
      }
    }
    takeoverHost = null
    if (typeof takeoverMountDispose === 'function') {
      try {
        takeoverMountDispose()
      } catch (error) {
        log('卸载刷新接管层失败', error)
      }
      takeoverMountDispose = null
    }
    state.mkt.own = false
  }

  function syncRefreshTakeover() {
    if (state.settings.takeoverMarketplaceRefresh) installRefreshTakeover()
    else removeRefreshTakeover()
    syncRefreshTap()
  }

  /**
   * 在宿主的刷新按钮上挂一个**非侵入**的点击监听（捕获阶段，不 preventDefault），
   * 只用来「立刻」开始记进度 —— 万一宿主这次刷新比 250ms 的轮询还快，
   * 光靠轮询会整轮错过；点了就开表，就再也不会漏。
   * 用 passive 监听，绝不影响宿主自己的刷新行为。
   */
  let tapButton = null
  function tapRefreshHandler() {
    if (!state.settings.showMarketplaceProgress) return
    if (state.mkt.active) return
    beginMarketplaceTracking()
  }
  function syncRefreshTap() {
    const button = findMarketplaceRefreshButton()
    if (tapButton === button) return

    // 换按钮了（宿主重渲染）：先摘掉旧的
    if (tapButton && tapButton.__ghaTap) {
      try {
        tapButton.removeEventListener('click', tapRefreshHandler, true)
      } catch (error) {
        /* 节点可能已被丢弃，忽略 */
      }
      tapButton.__ghaTap = false
    }
    tapButton = null

    // 接管模式下点击由盖层自己处理，不需要额外的监听
    if (!button || state.settings.takeoverMarketplaceRefresh) return
    if (!state.settings.showMarketplaceProgress) return
    try {
      button.addEventListener('click', tapRefreshHandler, true)
      button.__ghaTap = true
      tapButton = button
    } catch (error) {
      log('挂载刷新点击监听失败', error)
    }
  }
  function stopRefreshTap() {
    if (tapButton && tapButton.__ghaTap) {
      try {
        tapButton.removeEventListener('click', tapRefreshHandler, true)
      } catch (error) {
        /* ignore */
      }
      tapButton.__ghaTap = false
    }
    tapButton = null
  }

  // 注意：这两个变量必须在下面的 observe 回调之前声明并初始化。
  // observe() 会在注册时同步触发一次回调，而回调里会调用 watchMarketplaceRefresh()，
  // 若声明写在回调之后，就会命中 let 的暂时性死区（TDZ）而抛 ReferenceError。
  let refreshWatcherTimer = null
  let lastBusyState = false

  if (ctx.dom && typeof ctx.dom.observe === 'function') {
    stripObserverDispose = ctx.dom.observe('.marketplace-toolbar', () => {
      injectMarketplaceStrip()
      syncRefreshTakeover()
      watchMarketplaceRefresh()
    })
    // 若打开插件时已经停在插件管理页，observe 不一定立刻触发，主动跑一次
    injectMarketplaceStrip()
    syncRefreshTakeover()
    watchMarketplaceRefresh()
  }

  /* ---------- 刷新进度跟踪的定时器与状态跳变侦测 ---------- */

  /**
   * 宿主的刷新按钮点下去以后，唯一可靠的外部表征就是
   * `.plugin-card-grid[aria-busy="true"]`（骨架屏）从「无」变「有」。
   * 这里用轮询侦测这个跳变：一旦由闲转忙，就开始一轮进度跟踪。
   * 之所以不用 MutationObserver：宿主重渲染会整片替换子树，
   * MutationObserver 会收到大量无意义回调，反而更容易漏判时序。
   */
  function watchMarketplaceRefresh() {
    if (refreshWatcherTimer) return
    refreshWatcherTimer = setInterval(() => {
      if (!state.settings.showMarketplaceProgress) return
      const dom = readMarketplaceDom()
      const busy = dom.busy

      // 闲 → 忙：开启跟踪
      if (busy && !lastBusyState && !state.mkt.active) {
        beginMarketplaceTracking()
      }
      // 忙 → 闲：由 tick 自己收敛，这里只做兜底（页面被切走时）
      if (!busy && lastBusyState && state.mkt.active && dom.rendered > 0) {
        finishMarketplaceTracking(dom.rendered)
      }
      lastBusyState = busy
    }, MKT_POLL_MS)

    // 页面离开时清掉，避免插件停用后定时器还在跑
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', abortMarketplaceTracking)
    }
  }

  function stopMarketplaceRefreshWatcher() {
    if (refreshWatcherTimer) {
      clearInterval(refreshWatcherTimer)
      refreshWatcherTimer = null
    }
    stopRefreshTap()
    abortMarketplaceTracking()
  }

  ctx.commands.register('run-speed-test', () => void runSpeedTest())
  ctx.commands.register('apply-fastest', async () => {
    const target = pickProxySource()
    if (!target) {
      toast('warning', '请先测速')
      return
    }
    const outcome = await applyToHost(target)
    toast(outcome.ok ? 'success' : 'warning', outcome.ok ? `已应用线路：${target.name}` : outcome.error)
  })

  ctx.dispose(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (typeof settingsDispose === 'function') settingsDispose()
    if (typeof sidebarDispose === 'function') sidebarDispose()
    sidebarDispose = null
    if (typeof stripObserverDispose === 'function') stripObserverDispose()
    removeRefreshTakeover()
    stopMarketplaceRefreshWatcher()
    removeMarketplaceStrip()
  })

  log('已启用')
}

export async function deactivate() {
  // 页面、设置面板、命令和样式由宿主统一回收，这里无需额外处理。
}
