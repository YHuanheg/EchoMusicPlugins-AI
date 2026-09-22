/**
 * 推荐电台 (kugou-recommend) 真实网络冒烟测试
 * ---------------------------------------------------------------------------
 * smoke.mjs 用的是夹具数据（验证逻辑正确性）；本脚本用**真实网络**跑一遍
 * 插件自己的代码路径，验证「上游真实响应形态 → 归一化 → 可播放 track」这一环。
 *
 * 只打两个只读接口：
 *   - POST https://gateway.kugou.com/youth/v1/recommend/channel_wander（无需登录）
 *   - 需要登录的本地路由不在这里验证（要跑在 EchoMusic 里才有主进程通道）
 *
 * 运行： node tests/kugou-recommend.live.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_ENTRY = path.join(ROOT, 'kugou-recommend', 'index.js')

const VUE_ESM = process.env.VUE_ESM_PATH || 'D:/Downloads/_wb_echo/vendor/vue.runtime.esm-browser.js'
const V = await import(pathToFileURL(VUE_ESM).href)

const GATEWAY = 'https://gateway.kugou.com/youth/v1/recommend/channel_wander'

const results = []
function check(cond, label, extra) {
  results.push({ ok: !!cond, label, extra })
  return !!cond
}

const netCalls = []
const toasts = []

const ctx = {
  vue: V,
  manifest: { version: '1.0.0', id: 'kugou-recommend' },
  pinia: { state: V.ref({ user: { info: {} }, device: { info: {} } }) },
  storage: {
    async get() {
      return undefined
    },
    async set() {
      return true
    }
  },
  ui: {
    addPage(cfg) {
      ctx.__page = cfg
      return () => {}
    },
    settings: { define: () => () => {} },
    sidebar: { addItem: () => () => {} }
  },
  net: {
    // 真实网络：直接转发到 fetch，但记录调用以便断言请求参数
    async request(cfg) {
      netCalls.push(cfg)
      const res = await fetch(cfg.url, {
        method: cfg.method,
        headers: cfg.headers,
        body: cfg.body
      })
      const text = await res.text()
      let data = null
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
      return { status: res.status, data }
    }
  },
  electron: { api: { request: async () => ({ status: 404, body: null }) } },
  playlist: {
    async replaceAndPlay(list) {
      ctx.__played = list
      return true
    },
    async append() {
      return true
    },
    async playNext() {
      return true
    },
    getQueueSongs() {
      return []
    }
  },
  player: { currentTrack: V.ref(null), isPlaying: V.ref(false), async toggle() {}, setPlayMode() {} },
  stores: { playlist: { activeQueue: { songs: [] } }, player: {} },
  events: { onEnded: () => () => {}, onTrackChange: () => () => {}, onError: () => () => {} },
  kugouVerification: { async request() { return { ok: false } } },
  toast: {
    info: (m) => toasts.push(['info', m]),
    success: (m) => toasts.push(['success', m]),
    warning: (m) => toasts.push(['warning', m]),
    danger: (m) => toasts.push(['danger', m])
  },
  dispose() {
    return () => {}
  }
}

const origWarn = console.warn
console.warn = () => {}

let tracked = null
try {
  const mod = await import(pathToFileURL(PLUGIN_ENTRY).href + '?live=' + Date.now())
  await mod.activate(ctx)

  const page = ctx.__page && ctx.__page.component
  check(!!page && typeof page.setup === 'function', '页面组件已注册')
  const render = page.setup({}, { attrs: {}, slots: {}, emit() {}, expose() {} })
  const tree = render()

  function find(node, pred, out = []) {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const n of node) find(n, pred, out)
      return out
    }
    // 注意：必须在这里过滤，否则返回的是「所有带 props 的节点」，[0] 会是根 div
    if (node.props && pred(node)) out.push(node)
    if (Array.isArray(node.children)) find(node.children, pred, out)
    return out
  }

  const refresh = find(tree, (n) => n.props && n.props['data-action'] === 'refresh')[0]
  check(!!refresh, '页面渲染出「换一批」按钮')
  if (refresh) await refresh.props.onClick()

  // 重新渲染后再点「播放全部」，从 replaceAndPlay 拿到归一化后的 track
  const tree2 = render()
  const playAll = find(tree2, (n) => n.props && n.props['data-action'] === 'play-all')[0]
  check(!!playAll, '页面渲染出「播放全部」按钮')
  if (playAll) await playAll.props.onClick()
} catch (e) {
  check(false, '运行插件代码时未抛异常', e && e.stack ? e.stack : String(e))
} finally {
  console.warn = origWarn
}

// 从「播放全部」拿归一化后的 track（这里直接读插件内部写入的队列）
const tracks = ctx.__played || []

check(netCalls.length === 1, '向频道漫游网关发出 1 次请求', { count: netCalls.length })
check(netCalls[0] && netCalls[0].url === GATEWAY, '请求 URL 正确', netCalls[0] && netCalls[0].url)
check(netCalls[0] && netCalls[0].method === 'POST', '使用 POST')
check(!!(netCalls[0] && netCalls[0].body), '带有 JSON 请求体')

check(tracks.length > 0, '真实响应被解析出歌曲', { count: tracks.length })

if (tracks.length) {
  const t = tracks[0]
  check(typeof t.hash === 'string' && t.hash.length === 32, 'hash 是 32 位（真实酷狗 hash）', { hash: t.hash })
  check(!!t.title && t.title !== '未知歌曲', '歌名解析正确', { title: t.title })
  check(!!t.artist && t.artist !== '未知歌手', '歌手解析正确', { artist: t.artist })
  check(!!t.id, 'id 非空', { id: t.id })
  check(!!t.dedupeKey && t.dedupeKey === t.hash, 'dedupeKey = hash')
  check(!!t.albumAudioId || !!t.mixSongId, '带上了 albumAudioId / mixSongId', {
    albumAudioId: t.albumAudioId,
    mixSongId: t.mixSongId
  })
  check(t.coverUrl === '' || t.coverUrl.startsWith('https://'), '封面 URL 合法（或为空）', { coverUrl: t.coverUrl })
  check(t.coverUrl.indexOf('{size}') === -1, '封面 {size} 占位符已替换')
  check(Array.isArray(t.relateGoods), 'relateGoods 是数组')
  check(t.duration === undefined || (typeof t.duration === 'number' && t.duration > 0 && t.duration < 3600), '时长换算在合理区间', {
    duration: t.duration
  })

  const dupes = new Set(tracks.map((x) => x.dedupeKey))
  check(dupes.size === tracks.length, '同一批内无重复 hash', { total: tracks.length, unique: dupes.size })

  process.stdout.write('\n真实数据样本（归一化后）：\n')
  process.stdout.write(JSON.stringify(t, null, 2) + '\n')
}

const lines = []
lines.push('')
lines.push('='.repeat(66))
lines.push('推荐电台 真实网络冒烟测试')
lines.push('='.repeat(66))
for (const r of results) {
  lines.push('  ' + (r.ok ? '✓' : '✗') + ' ' + r.label + (r.extra === undefined ? '' : '  ' + JSON.stringify(r.extra)))
}
const failed = results.filter((r) => !r.ok).length
lines.push('-' .repeat(66))
lines.push('结果: ' + (results.length - failed) + '/' + results.length + (failed ? '，' + failed + ' 失败' : '，全部通过 ✓'))
lines.push('='.repeat(66))
process.stdout.write(lines.join('\n') + '\n')

process.exit(failed ? 1 : 0)
