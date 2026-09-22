/**
 * 推荐电台 (kugou-recommend) 无头集成测试
 * ---------------------------------------------------------------------------
 * 静态 `node --check` 抓不到未定义标识符，所以这里用**真实 Vue 3 ESM 运行时**
 * 无头执行插件代码：
 *   1. mock 一个符合宿主契约的 ctx（storage / ui / net / playlist / player / events …）
 *   2. await activate(ctx)  → 断言注册项正确
 *   3. 直接调用组件 setup()() 拿到真实 vnode 树，递归 walk() 找到按钮，
 *      再真实调用 vnode.props.onClick() 跑完整业务流程
 *
 * 运行： node tests/kugou-recommend.smoke.mjs
 * 依赖： 一份 Vue 浏览器 ESM 构建（见下方 resolveVue 的查找顺序）
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// 允许指向别处的插件副本：用来做「变异测试」——故意把某处改坏，确认测试真的会失败
const PLUGIN_ENTRY = process.env.KR_PLUGIN_ENTRY
  ? path.resolve(process.env.KR_PLUGIN_ENTRY)
  : path.join(ROOT, 'kugou-recommend', 'index.js')
const CACHE_DIR = path.join(ROOT, '.workbuddy', 'tmp')
const CACHE_VUE = path.join(CACHE_DIR, 'vue.runtime.esm-browser.js')
const VUE_CDN = 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.esm-browser.js'

const GATEWAY = 'https://gateway.kugou.com/youth/v1/recommend/channel_wander'

/* ========================================================================== *
 * 断言脚手架
 * ========================================================================== */

let pass = 0
const failures = []
const sectionResults = []
let currentSection = '(root)'

function section(name) {
  currentSection = name
  sectionResults.push({ name, before: pass })
}

function ok(cond, name, extra) {
  if (cond) {
    pass++
    return true
  }
  failures.push('[' + currentSection + '] ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500)))
  return false
}

function eq(actual, expected, name) {
  return ok(actual === expected, name, { actual, expected })
}

function includes(hay, needle, name) {
  return ok(String(hay || '').includes(needle), name, { haystack: String(hay || '').slice(0, 300), needle })
}

/* ========================================================================== *
 * Vue 运行时解析
 * ========================================================================== */

async function resolveVue() {
  const candidates = [
    process.env.VUE_ESM_PATH,
    'D:/Downloads/_wb_echo/vendor/vue.runtime.esm-browser.js',
    path.join(process.env.APPDATA || '', 'echo-music', 'plugins', 'gh-accelerator', 'vue.runtime.esm-browser.js'),
    CACHE_VUE
  ].filter(Boolean)

  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const res = await fetch(VUE_CDN)
  if (!res.ok) throw new Error('无法下载 Vue ESM 构建：HTTP ' + res.status + '（可设 VUE_ESM_PATH 指定本地文件）')
  fs.writeFileSync(CACHE_VUE, await res.text(), 'utf8')
  return CACHE_VUE
}

const vuePath = await resolveVue()
const V = await import(pathToFileURL(vuePath).href)

/* ========================================================================== *
 * vnode 工具
 * ========================================================================== */

function collect(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out)
    return out
  }
  const isVNode = node.type !== undefined || node.props !== undefined
  if (isVNode) out.push(node)
  if (Array.isArray(node.children)) collect(node.children, out)
  else if (isVNode && node.children && typeof node.children === 'object') collect(node.children, out)
  return out
}

function findAll(node, pred) {
  return collect(node, []).filter(pred)
}

function byProp(node, key, value) {
  return findAll(node, (n) => n.props && n.props[key] === value)[0]
}

function withClass(node, cls) {
  return findAll(node, (n) => n.props && String(n.props.class || '').includes(cls))
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  let s = ''
  if (Array.isArray(node.children)) s += textOf(node.children)
  else if (typeof node.children === 'string') s += node.children
  return s
}

function renderComponent(comp) {
  if (!comp || typeof comp.setup !== 'function') throw new Error('组件缺少 setup()')
  const render = comp.setup({}, { attrs: {}, slots: {}, emit() {}, expose() {} })
  if (typeof render !== 'function') throw new Error('setup() 未返回 render 函数')
  return render()
}

/* ========================================================================== *
 * 上游响应样本（形态刻意做成各不相同，用来验证归一化层的鲁棒性）
 * ========================================================================== */

/**
 * 确定性 hash（32 位 hex，与酷狗真实 hash 长度一致）。
 * 注意：第一版用了自写的 LCG，低位周期只有 16，导致 5 首歌里就出现重复 hash，
 * 被去重逻辑吃掉 —— 这类「测试夹具自己的 bug」最容易误判成插件 bug，一律用 md5。
 */
function hashOf(seed, len) {
  const hex = createHash('md5').update('kugou-fixture-' + seed).digest('hex')
  return len ? hex.slice(0, len) : hex
}

/** 频道漫游形态：data[].song.{base,audio_info,album_info} */
function channelBody(count, seedBase) {
  const n = count === undefined ? 5 : count
  const seed = seedBase === undefined ? 1 : seedBase
  const data = []
  for (let i = 0; i < n; i++) {
    const s = seed + i
    data.push({
      song: {
        base: {
          wide_audio_id: '9000' + s,
          audio_id: 7000 + s,
          album_audio_id: '8000' + s,
          album_id: '6000' + s,
          songname: '漫游歌曲' + s,
          album_name: '漫游专辑' + s,
          author_name: '歌手甲' + s,
          authors: [{ author_id: 11 + s, author_name: '歌手甲' + s }, { author_id: 12 + s, author_name: '歌手乙' + s }],
          timelength: 245000
        },
        audio_info: { hash: hashOf(s), hash_320: hashOf(s + 100), hash_flac: hashOf(s + 200) },
        album_info: { cover: 'http://imge.kugou.com/album/{size}/cover' + s + '.jpg' }
      }
    })
  }
  return { status: 1, error_code: 0, data }
}

/** 每日推荐形态：data.song_list[]，字段平铺、无 audio_info；hash 故意给大写 */
function everydayBody(count, seedBase) {
  const n = count === undefined ? 6 : count
  const seed = seedBase === undefined ? 500 : seedBase
  const song_list = []
  for (let i = 0; i < n; i++) {
    const s = seed + i
    song_list.push({
      hash: hashOf(s).toUpperCase(), // ← 真实酷狗接口确实有大写 hash，用来验证归一化
      songname: '每日歌曲' + s,
      author_name: '日常歌手' + s,
      album_id: 3000 + s,
      album_name: '日常专辑' + s,
      album_audio_id: '4000' + s,
      mixsongid: 4000 + s,
      timelength: 198000,
      trans_param: { union_cover: 'https://imge.kugou.com/union/{size}/pic' + s + '.jpg' }
    })
  }
  return { status: 1, error_code: 0, data: { song_list, total: n } }
}

/**
 * 猜你喜欢形态：data 直接是数组。
 * ⚠️ 这里只给 audio_info.hash_320（模拟真实接口没有 hash 字段的情况），
 * 归一化时会被当成主 hash —— 所以 seed 偏移必须**远离其它夹具的取值区间**，
 * 否则会和别的源的歌撞 hash，被插件的去重逻辑正确滤掉，看起来却像插件 bug。
 * （踩过两次：先是自写 LCG 撞，再是这里 hashOf(s+300)=1200 撞上 topSongBody 的 1200。）
 */
function fmBody(count, seedBase) {
  const n = count === undefined ? 4 : count
  const seed = seedBase === undefined ? 900 : seedBase
  const data = []
  for (let i = 0; i < n; i++) {
    const s = seed + i
    data.push({
      hash: hashOf(s),
      filename: '猜你喜欢' + s + ' - FM歌手' + s,
      singername: 'FM歌手' + s,
      album_id: 5000 + s,
      timelength: 221000,
      audio_info: { hash_320: hashOf(s + 5000) }
    })
  }
  return { status: 1, error_code: 0, data }
}

function topSongBody(count, seedBase) {
  const n = count === undefined ? 3 : count
  const seed = seedBase === undefined ? 1200 : seedBase
  const data = []
  for (let i = 0; i < n; i++) {
    const s = seed + i
    data.push({
      hash: hashOf(s),
      audio_name: '新歌' + s,
      author_name: '新歌手' + s,
      timelength: 187000,
      album_info: { cover: 'https://imge.kugou.com/new/{size}/c' + s + '.jpg' }
    })
  }
  return { status: 1, error_code: 0, data }
}

/* ========================================================================== *
 * ctx 夹具
 * ========================================================================== */

async function makeCtx(options) {
  const o = options || {}
  const storageMap = new Map(Object.entries(o.storage || {}))
  const pages = []
  const sidebarItems = []
  const toasts = []
  const apiCalls = []
  const netCalls = []
  const netFetchCalls = []
  const playCalls = []
  const disposers = []
  const verifyCalls = []
  const endedHandlers = []
  const trackChangeHandlers = []

  let queue = []
  const currentTrack = V.ref(null)
  const isPlaying = V.ref(false)

  const router = o.router || defaultRouter

  async function apiRequest(config) {
    apiCalls.push(config)
    const route = String(config.url || '')
    const r = router(route, config.params || {}, config.headers || {}, apiCalls.length)
    if (r && typeof r.then === 'function') return r
    return r
  }

  const ctx = {
    vue: V,
    manifest: { version: '1.0.0', id: 'kugou-recommend' },
    descriptor: { directory: path.join(ROOT, 'kugou-recommend') },
    pinia: {
      state: V.ref({
        user: {
          info: o.loggedOut
            ? {}
            : { token: 'TOKEN_ABC', userid: '99001', t1: 'T1VAL', nickname: '测试用户' }
        },
        device: { info: { dfid: 'DFID123', mid: 'MID456', uuid: 'UUID789', guid: 'GUID000', mac: 'MACX' } }
      })
    },
    storage: {
      async get(key) {
        return storageMap.has(key) ? storageMap.get(key) : undefined
      },
      async set(key, value) {
        storageMap.set(key, JSON.parse(JSON.stringify(value)))
        return true
      }
    },
    ui: {
      addPage(cfg) {
        pages.push(cfg)
        return () => {}
      },
      settings: {
        define(cfg) {
          sidebarItems.push({ kind: 'settings', cfg })
          return () => {}
        }
      },
      sidebar: {
        addItem(cfg) {
          sidebarItems.push({ kind: 'sidebar', cfg })
          return () => {}
        }
      }
    },
    net: {
      async request(cfg) {
        netCalls.push(cfg)
        const r = o.gateway ? o.gateway(cfg, netCalls.length) : { status: 200, data: channelBody(5, 1) }
        if (r && typeof r.then === 'function') return r
        return r
      },
      async fetch(url, init) {
        netFetchCalls.push({ url, init })
        const body = o.gatewayFetchBody ? o.gatewayFetchBody(url, init) : channelBody(5, 1)
        return {
          status: 200,
          ok: true,
          async text() {
            return JSON.stringify(body)
          },
          async json() {
            return body
          }
        }
      }
    },
    electron: {
      api: { request: apiRequest },
      share: { async copy() { return true } }
    },
    playlist: {
      async replaceAndPlay(list, opts) {
        playCalls.push({ fn: 'replaceAndPlay', list: (list || []).slice(), opts })
        queue = (list || []).slice()
        currentTrack.value = (opts && opts.requestedSong) || queue[0] || null
        isPlaying.value = true
        return true
      },
      async append(list) {
        playCalls.push({ fn: 'append', list: (list || []).slice() })
        queue = queue.concat(list || [])
        return true
      },
      async playNext(track) {
        playCalls.push({ fn: 'playNext', track })
        return true
      },
      getQueueSongs() {
        return queue.slice()
      }
    },
    player: {
      currentTrack,
      isPlaying,
      playMode: V.ref('list'),
      async toggle() {
        isPlaying.value = !isPlaying.value
      },
      setPlayMode() {}
    },
    stores: {
      playlist: {
        get activeQueue() {
          return { songs: queue }
        }
      },
      player: { playMode: 'list' }
    },
    events: {
      onEnded(fn) {
        endedHandlers.push(fn)
        return () => {}
      },
      onTrackChange(fn) {
        trackChangeHandlers.push(fn)
        return () => {}
      },
      onError(fn) {
        return () => {}
      }
    },
    kugouVerification: {
      async request(eventId) {
        verifyCalls.push(eventId)
        return { ok: true, eventId }
      }
    },
    toast: {
      info: (m) => toasts.push({ type: 'info', m }),
      success: (m) => toasts.push({ type: 'success', m }),
      warning: (m) => toasts.push({ type: 'warning', m }),
      danger: (m) => toasts.push({ type: 'danger', m })
    },
    dispose(fn) {
      disposers.push(fn)
      return () => {}
    }
  }

  return {
    ctx,
    storageMap,
    pages,
    sidebarItems,
    toasts,
    apiCalls,
    netCalls,
    netFetchCalls,
    playCalls,
    disposers,
    verifyCalls,
    endedHandlers,
    trackChangeHandlers,
    currentTrack,
    isPlaying,
    setQueue(list) {
      queue = (list || []).slice()
    },
    getQueue() {
      return queue.slice()
    }
  }
}

/** 默认路由表：覆盖插件会打到的全部本地路由 */
function defaultRouter(route, params, headers, callIndex) {
  const map = {
    '/everyday/recommend': () => ({ status: 200, body: everydayBody(6, 500) }),
    '/personal/fm': () => ({ status: 200, body: fmBody(4, 900) }),
    '/everyday/style/recommend': () => ({ status: 200, body: everydayBody(5, 700) }),
    '/ai/recommend/song': () => ({ status: 200, body: everydayBody(7, 800) }),
    '/top/song': () => ({ status: 200, body: topSongBody(3, 1200) }),
    '/everyday/history': () => ({ status: 200, body: everydayBody(4, 1400) }),
    '/user/history': () => ({ status: 200, body: everydayBody(3, 1600) })
  }
  const fn = map[route]
  if (fn) return fn()
  return { status: 404, body: { status: 0, error_code: 404, error: '未知路由 ' + route } }
}

/* ========================================================================== *
 * 加载插件（每次刷新模块实例，模拟宿主重新加载）
 * ========================================================================== */

async function loadPlugin() {
  const url = pathToFileURL(PLUGIN_ENTRY).href + '?t=' + Date.now() + Math.random()
  return import(url)
}

/* ========================================================================== *
 * 主流程
 * ========================================================================== */

const origWarn = console.warn
const origError = console.error
const suppressed = []
console.warn = (...a) => suppressed.push(a.join(' '))
console.error = (...a) => suppressed.push(a.join(' '))

let mod = null
let H = null

try {
  /* ---------------- 1. 注册 ---------------- */
  section('1. activate 与注册')
  H = await makeCtx()
  mod = await loadPlugin()
  const activated = await mod.activate(H.ctx)
  ok(activated && activated.ok === true, 'activate() 返回 { ok: true }')
  eq(H.pages.length, 1, 'ctx.ui.addPage 被调用一次')
  eq(H.pages[0] && H.pages[0].id, 'recommend', '页面 id = recommend')
  eq(typeof (H.pages[0] && H.pages[0].component), 'object', '页面注册了组件')
  ok(!H.pages[0].sidebar, '页面未内联 sidebar（改用 sidebar.addItem 以便即时生效）')
  const sidebarReg = H.sidebarItems.find((i) => i.kind === 'sidebar')
  ok(!!sidebarReg, '注册了侧边栏入口')
  eq(sidebarReg && sidebarReg.cfg.pageId, 'recommend', '侧边栏入口指向 recommend 页')
  eq(sidebarReg && sidebarReg.cfg.section, 'plugins', '侧边栏入口落在 plugins 分组')
  const settingsReg = H.sidebarItems.find((i) => i.kind === 'settings')
  ok(!!settingsReg, '注册了设置面板')
  eq(H.disposers.length, 1, '注册了 ctx.dispose 回收器')

  /* ---------------- 2. 首次渲染 ---------------- */
  section('2. 页面首屏渲染')
  const page = H.pages[0].component
  let tree = renderComponent(page)
  ok(!!byProp(tree, 'data-action', 'refresh'), '渲染出「换一批」')
  ok(!!byProp(tree, 'data-action', 'play-all'), '渲染出「播放全部」')
  ok(!!byProp(tree, 'data-action', 'radio'), '渲染出「开启电台」')
  ok(!!byProp(tree, 'data-action', 'view-liked'), '渲染出「我喜欢」入口')
  ok(!!byProp(tree, 'data-action', 'health'), '渲染出「源健康检查」')
  ok(!!byProp(tree, 'data-action', 'copy-diag'), '渲染出「复制诊断」')
  const chips = findAll(tree, (n) => n.props && n.props['data-source'])
  eq(chips.length, 8, '渲染出 8 个推荐源 chip')
  eq(withClass(tree, 'kr-empty').length, 1, '空列表时展示空状态而非空白')

  /* ---------------- 3. 频道漫游（网关直连源） ---------------- */
  section('3. 频道漫游取数（网关直连）')
  await byProp(tree, 'data-action', 'refresh').props.onClick()
  eq(H.netCalls.length, 1, '网关请求发出一次')
  eq(H.netCalls[0].url, GATEWAY, '请求打到概念版 channel_wander 网关')
  eq(H.netCalls[0].method, 'POST', '使用 POST')
  eq(JSON.parse(String(H.netCalls[0].body)).tags, '', '默认 tags 为空串')
  eq(H.apiCalls.length, 0, '频道漫游不经过本地路由通道（无本地模块）')

  tree = renderComponent(page)
  const rows = withClass(tree, 'kr-row')
  eq(rows.length, 5, '列表渲染出 5 行')
  ok(!withClass(tree, 'kr-empty').length, '有数据后不再显示空状态')
  const rowText = textOf(rows[0])
  includes(rowText, '漫游歌曲1', '行内显示歌名')
  includes(rowText, '歌手甲1、歌手乙1', '多歌手用顿号连接')
  includes(rowText, '漫游专辑1', '行内显示专辑')
  includes(rowText, 'FLAC', '显示音质标签')
  includes(rowText, '频道漫游', '显示来源徽标')
  includes(rowText, '4:05', '毫秒时长换算为 4:05')

  /* ---------------- 4. 播放全部 → 归一化字段断言 ---------------- */
  section('4. 播放全部与字段归一化')
  await byProp(tree, 'data-action', 'play-all').props.onClick()
  const played = H.playCalls.find((c) => c.fn === 'replaceAndPlay')
  ok(!!played, '调用 playlist.replaceAndPlay')
  eq(played.list.length, 5, '整列表进入播放队列')
  const t0 = played.list[0]
  ok(!!t0, '拿到归一化后的 track')
  eq(t0.hash, hashOf(1), 'hash 归一化正确')
  eq(t0.title, '漫游歌曲1', 'title 取 songname')
  eq(t0.name, '漫游歌曲1', 'name 与 title 同步（宿主列表用 name）')
  eq(t0.artist, '歌手甲1、歌手乙1', 'artist 由 authors 聚合')
  eq(t0.artists.length, 2, 'artists 数组保留两位歌手')
  eq(t0.albumName, '漫游专辑1', 'albumName 归一化')
  eq(t0.albumId, '60001', 'albumId 归一化')
  eq(t0.albumAudioId, '80001', 'albumAudioId 归一化')
  eq(t0.id, '90001', 'id 取自 wide_audio_id')
  eq(t0.dedupeKey, t0.hash, 'dedupeKey 用 hash（跨源稳定）')
  eq(t0.duration, 245, 'timelength 毫秒 → 秒')
  eq(t0.qualityLabel, 'FLAC', '有 hash_flac → FLAC')
  eq(t0.relateGoods.length, 2, 'relateGoods 收录 320 与 flac 两条')
  eq(t0.audioUrl, '', 'audioUrl 交给宿主自行解析')
  ok(t0.coverUrl.indexOf('{size}') === -1, '封面 {size} 占位符已替换', t0.coverUrl)
  ok(t0.coverUrl.startsWith('https://'), 'http 封面升级为 https', t0.coverUrl)

  /* ---------------- 5. 单曲播放（列表轮转 + requestedSong） ---------------- */
  section('5. 单曲播放')
  H.playCalls.length = 0
  tree = renderComponent(page)
  const playButtons = findAll(tree, (n) => n.props && n.props['data-action'] === 'play')
  eq(playButtons.length, 5, '每行一个播放按钮')
  await playButtons[2].props.onClick()
  const single = H.playCalls.find((c) => c.fn === 'replaceAndPlay')
  ok(!!single, '单曲播放也走 replaceAndPlay')
  eq(single.opts && single.opts.requestedSong && single.opts.requestedSong.hash, hashOf(3), 'requestedSong 指向被点的第 3 首')
  eq(single.list.length, 5, '轮转后仍是完整列表')
  eq(single.list[0].hash, hashOf(3), '被点的歌被轮转到队首')
  eq(single.list[1].hash, hashOf(4), '后续顺序保持原序')

  /* ---------------- 6. 下一首播放 ---------------- */
  section('6. 下一首播放')
  tree = renderComponent(page)
  const nextButtons = findAll(tree, (n) => n.props && n.props['data-action'] === 'next')
  await nextButtons[1].props.onClick()
  const nextCall = H.playCalls.find((c) => c.fn === 'playNext')
  ok(!!nextCall, '调用 playlist.playNext')
  eq(nextCall.track.hash, hashOf(2), '传入了第 2 首')

  /* ---------------- 7. 喜欢 / 我喜欢视图 ---------------- */
  section('7. 喜欢与本地收藏')
  H.playCalls.length = 0
  tree = renderComponent(page)
  const likeButtons = findAll(tree, (n) => n.props && n.props['data-action'] === 'like')
  eq(likeButtons.length, 5, '每行一个喜欢按钮')
  await likeButtons[0].props.onClick()
  const marks = H.storageMap.get('marks')
  ok(!!marks, '喜欢状态已落盘')
  eq(marks.liked.length, 1, '收藏列表有 1 首')
  eq(marks.liked[0].hash, hashOf(1), '收藏的是被点的那首')

  tree = renderComponent(page)
  includes(textOf(byProp(tree, 'data-action', 'view-liked')), '我喜欢 1', '「我喜欢」计数更新为 1')
  await byProp(tree, 'data-action', 'view-liked').props.onClick()
  tree = renderComponent(page)
  eq(withClass(tree, 'kr-row').length, 1, '切到「我喜欢」视图只显示收藏的 1 首')
  eq(textOf(byProp(tree, 'data-action', 'view-liked')).trim(), '我喜欢 1'.replace(' 1', ' ' + 1), '视图按钮文案稳定')

  H.playCalls.length = 0
  await byProp(tree, 'data-action', 'play-all').props.onClick()
  const likedPlay = H.playCalls.find((c) => c.fn === 'replaceAndPlay')
  eq(likedPlay.list.length, 1, '收藏视图可播放')
  eq(likedPlay.list[0].hash, hashOf(1), '播放的是收藏的那首')

  tree = renderComponent(page)
  await byProp(tree, 'data-action', 'like').props.onClick()
  eq(H.storageMap.get('marks').liked.length, 0, '再点一次取消喜欢并落盘')
  await byProp(tree, 'data-action', 'view-feed').props.onClick()
  tree = renderComponent(page)
  eq(withClass(tree, 'kr-row').length, 5, '切回推荐视图恢复 5 首')

  /* ---------------- 8. 不感兴趣 ---------------- */
  section('8. 不感兴趣与过滤')
  tree = renderComponent(page)
  const blockButtons = findAll(tree, (n) => n.props && n.props['data-action'] === 'block')
  await blockButtons[0].props.onClick()
  tree = renderComponent(page)
  eq(withClass(tree, 'kr-row').length, 4, '被屏蔽的歌立即从列表移除')
  const marks2 = H.storageMap.get('marks')
  eq(marks2.blocked.length, 1, '屏蔽 key 已落盘')
  eq(marks2.blocked[0], hashOf(1), '屏蔽的是被点的那首的 hash')

  // 再取一批（同一份 fixture）→ 被屏蔽的那首不应回来
  await byProp(tree, 'data-action', 'refresh').props.onClick()
  tree = renderComponent(page)
  const afterBlock = withClass(tree, 'kr-row')
  eq(afterBlock.length, 4, '重新取数后被屏蔽的歌没有回来')
  ok(!textOf(afterBlock).includes('漫游歌曲1'), '被屏蔽的具体曲目不再出现')

  /* ---------------- 9. 无限流去重 ---------------- */
  section('9. 去重（同一份数据再取一次）')
  // fixture 每次都返回同一批（seed 不变）→ 全部命中 seen，应给出提示
  tree = renderComponent(page)
  await byProp(tree, 'data-action', 'refresh').props.onClick()
  tree = renderComponent(page)
  ok(!!byProp(tree, 'data-role', 'notice'), '给出「全部命中去重规则」提示')
  includes(textOf(byProp(tree, 'data-role', 'notice')), '去重', '提示文案提到去重')
  includes(textOf(byProp(tree, 'data-role', 'notice')), '换一批', '提示引导用户再点一次')

  // 清空去重记录后又能拉回来
  await byProp(tree, 'data-action', 'clear-seen').props.onClick()
  tree = renderComponent(page)
  await byProp(tree, 'data-action', 'refresh').props.onClick()
  tree = renderComponent(page)
  eq(withClass(tree, 'kr-row').length, 4, '清空去重记录后重新拉到 4 首（1 首仍被屏蔽）')

  /* ---------------- 10. 本地路由源与鉴权头 ---------------- */
  section('10. 切源：本地路由 + Authorization')
  H.apiCalls.length = 0
  const gatewayBefore = H.netCalls.length
  tree = renderComponent(page)
  await byProp(tree, 'data-source', 'everyday').props.onClick()
  eq(H.apiCalls.length, 1, '走本地路由通道一次')
  eq(H.apiCalls[0].url, '/everyday/recommend', '路由 /everyday/recommend（下划线 → 斜杠）')
  eq(H.apiCalls[0].method, 'GET', 'method 一律 GET（宿主自行决定上游方法）')
  eq(H.apiCalls[0].params.platform, 'ios', '透传 platform=ios')
  includes(H.apiCalls[0].headers.Authorization, 'token=TOKEN_ABC', 'Authorization 带 token')
  includes(H.apiCalls[0].headers.Authorization, 'userid=99001', 'Authorization 带 userid')
  includes(H.apiCalls[0].headers.Authorization, 'dfid=DFID123', 'Authorization 带设备 dfid')
  eq(H.netCalls.length, gatewayBefore, '切到本地路由源后不再打网关')

  tree = renderComponent(page)
  const everydayRows = withClass(tree, 'kr-row')
  eq(everydayRows.length, 6, '每日推荐解析出 6 首（嵌套 song_list 形态）')
  includes(textOf(everydayRows[0]), '每日歌曲500', '平铺字段形态的歌名正确')
  includes(textOf(everydayRows[0]), '3:18', '198000ms → 3:18')
  eq(withClass(tree, 'kr-tag-presets').length, 0, '每日推荐不显示曲风快捷标签')

  // 上游给的是大写 hash，归一化后必须是小写，否则跨源去重会失效
  H.playCalls.length = 0
  await byProp(tree, 'data-action', 'play-all').props.onClick()
  const edPlayed = H.playCalls.find((c) => c.fn === 'replaceAndPlay')
  eq(edPlayed.list[0].hash, hashOf(500), '大写 hash 被归一化为小写')
  eq(edPlayed.list[0].dedupeKey, hashOf(500), 'dedupeKey 同步为小写')

  /* ---------------- 11. 曲风推荐：标签与快捷标签 ---------------- */
  section('11. 曲风推荐标签')
  H.apiCalls.length = 0
  tree = renderComponent(page)
  await byProp(tree, 'data-source', 'style').props.onClick()
  // 必须重新渲染再取 vnode：vnode 会「捕获」渲染时的状态
  tree = renderComponent(page)
  eq(withClass(tree, 'kr-tag-presets').length, 1, '曲风源显示快捷标签区')
  const tagChips = findAll(tree, (n) => n.props && n.props['data-tag'])
  eq(tagChips.length, 8, '8 个曲风快捷标签')
  H.apiCalls.length = 0
  await tagChips[0].props.onClick()
  eq(H.apiCalls[0].url, '/everyday/style/recommend', '路由 /everyday/style/recommend')
  eq(String(H.apiCalls[0].params.tagids), '1', '点快捷标签后 tagids=1')

  /* ---------------- 12. 登录失效分支 ---------------- */
  section('12. 登录失效与错误提示')
  const H2 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        return { status: 502, body: { status: 0, error_code: 20018, error: '登录已过期' } }
      }
      return defaultRouter(route)
    }
  })
  const mod2 = await loadPlugin()
  await mod2.activate(H2.ctx)
  const page2 = H2.pages[0].component
  let tree2 = renderComponent(page2)
  await byProp(tree2, 'data-source', 'listen').props.onClick()
  tree2 = renderComponent(page2)
  const errBanner = byProp(tree2, 'data-role', 'error')
  ok(!!errBanner, '失败时渲染错误提示条')
  includes(textOf(errBanner), '登录状态无效', '错误码 20018 映射为可读文案')
  includes(textOf(errBanner), '需要登录', '提示该源需要登录')

  /* ---------------- 13. 账号风控 → 安全验证兜底 ---------------- */
  section('13. 安全验证兜底')
  let fmCall = 0
  const H3 = await makeCtx({
    router(route) {
      if (route === '/personal/fm') {
        fmCall++
        if (fmCall === 1) {
          return { status: 502, body: { status: 0, error_code: 20028, ssaCode: 'EV-9527' }, headers: {} }
        }
        return { status: 200, body: fmBody(4, 900) }
      }
      return defaultRouter(route)
    }
  })
  const mod3 = await loadPlugin()
  await mod3.activate(H3.ctx)
  const page3 = H3.pages[0].component
  let tree3 = renderComponent(page3)
  await byProp(tree3, 'data-source', 'fm').props.onClick()
  eq(H3.verifyCalls.length, 1, '检测到 ssaCode 后唤起安全验证一次')
  eq(H3.verifyCalls[0], 'EV-9527', '把 eventId 传给宿主')
  eq(fmCall, 2, '验证通过后原请求重试一次')
  tree3 = renderComponent(page3)
  eq(withClass(tree3, 'kr-row').length, 4, '重试成功并渲染出 4 首')
  ok(!byProp(tree3, 'data-role', 'error'), '重试成功后不再显示错误')

  /* ---------------- 14. 源健康检查 ---------------- */
  section('14. 源健康检查')
  const H4 = await makeCtx({
    router(route) {
      if (route === '/top/song') return { status: 502, body: { status: 0, error_code: 21001, error: '参数有误' } }
      if (route === '/ai/recommend/song') return { status: 200, body: { status: 1, error_code: 0, data: [] } }
      return defaultRouter(route)
    }
  })
  const mod4 = await loadPlugin()
  await mod4.activate(H4.ctx)
  const page4 = H4.pages[0].component
  let tree4 = renderComponent(page4)
  ok(!byProp(tree4, 'data-role', 'health'), '未检查时不渲染健康检查表')
  await byProp(tree4, 'data-action', 'health').props.onClick()
  tree4 = renderComponent(page4)
  const healthRows = findAll(tree4, (n) => n.props && n.props['data-health'])
  eq(healthRows.length, 8, '健康检查覆盖全部 8 个推荐源')
  const topRow = byProp(tree4, 'data-health', 'newsong')
  ok(!!topRow, '新歌速递出现在结果里')
  eq(topRow.props['data-ok'], '0', '失败的源标记为 data-ok=0')
  const okRows = findAll(tree4, (n) => n.props && n.props['data-ok'] === '1')
  ok(okRows.length >= 5, '多数源自检可用', { okCount: okRows.length })
  const badText = textOf(byProp(tree4, 'data-role', 'health'))
  includes(badText, '不可用', '失败源展示为「不可用」')
  includes(badText, '空结果', '空结果源单独标注')
  includes(badText, '参数有误', '错误码 21001 映射为可读文案')
  eq(H4.apiCalls.length + H4.netCalls.length >= 8, true, '至少发起 8 次探测请求')

  /* ---------------- 15. 设置项 ---------------- */
  section('15. 设置面板与持久化')
  const settingsComp = H4.sidebarItems.find((i) => i.kind === 'settings').cfg.component
  let stree = renderComponent(settingsComp)
  const settingKeys = findAll(stree, (n) => n.props && n.props['data-setting']).map((n) => n.props['data-setting'])
  ok(settingKeys.length >= 14, '设置项数量合理', { count: settingKeys.length })
  for (const k of ['defaultSource', 'batchSize', 'autoRadio', 'refillThreshold', 'dedupe', 'filterBlocked', 'sidebarEntry', 'showQuality', 'debug']) {
    ok(settingKeys.includes(k), '包含设置项 ' + k)
  }

  function controlOf(key, tree) {
    const row = findAll(tree, (n) => n.props && n.props['data-setting'] === key)[0]
    if (!row) return null
    const nodes = collect(row, [])
    return nodes.find((n) => n.type === 'button' || n.type === 'select' || n.type === 'input') || null
  }

  // 开关：dedupe 默认 true → 点一下变 false 并落盘
  let ctl = controlOf('dedupe', stree)
  ok(!!ctl, '找到 dedupe 开关')
  eq(ctl.props['data-on'], '1', 'dedupe 默认开启')
  eq(ctl.props.role, 'switch', '开关使用 role=switch（状态更明显）')
  await ctl.props.onClick()
  ok(H4.storageMap.get('settings'), '设置已落盘')
  eq(H4.storageMap.get('settings').dedupe, false, 'dedupe 关闭已持久化')
  stree = renderComponent(settingsComp)
  eq(controlOf('dedupe', stree).props['data-on'], '0', '重新渲染后开关状态同步')

  // 数值钳制：batchSize 最大 100
  ctl = controlOf('batchSize', stree)
  ctl.props.onChange({ target: { value: '999' } })
  eq(H4.storageMap.get('settings').batchSize, 100, 'batchSize 上溢被钳制到 100')
  stree = renderComponent(settingsComp)
  ctl = controlOf('batchSize', stree)
  ctl.props.onChange({ target: { value: '1' } })
  eq(H4.storageMap.get('settings').batchSize, 5, 'batchSize 下溢被钳制到 5')

  ctl = controlOf('refillThreshold', stree)
  ctl.props.onChange({ target: { value: '99' } })
  eq(H4.storageMap.get('settings').refillThreshold, 10, 'refillThreshold 钳制到 10')

  // defaultSource 选择
  ctl = controlOf('defaultSource', stree)
  ctl.props.onChange({ target: { value: 'newsong' } })
  eq(H4.storageMap.get('settings').defaultSource, 'newsong', '默认源写入存储')

  // 侧边栏开关：关掉应调用 disposer（立即生效，无需重启）
  const sidebarDisposersBefore = H4.sidebarItems.length
  stree = renderComponent(settingsComp)
  ctl = controlOf('sidebarEntry', stree)
  eq(ctl.props['data-on'], '1', '侧边栏入口默认开启')
  await ctl.props.onClick()
  eq(H4.storageMap.get('settings').sidebarEntry, false, '侧边栏开关已持久化')
  eq(H4.sidebarItems.length, sidebarDisposersBefore, '关闭侧边栏入口走 disposer 而非重复注册')

  /* ---------------- 16. 电台模式自动续杯 ---------------- */
  section('16. 电台模式与自动续杯')
  let gatewayRound = 0
  const H5 = await makeCtx({
    gateway(cfg, n) {
      gatewayRound = n
      // 每批给不同的 seed，模拟真实推荐流不断出新
      return { status: 200, data: channelBody(5, 1 + (n - 1) * 100) }
    }
  })
  const mod5 = await loadPlugin()
  await mod5.activate(H5.ctx)
  const page5 = H5.pages[0].component
  let tree5 = renderComponent(page5)
  await byProp(tree5, 'data-action', 'refresh').props.onClick()
  eq(H5.endedHandlers.length >= 1, true, '注册了播放结束回调')

  tree5 = renderComponent(page5)
  await byProp(tree5, 'data-action', 'radio').props.onClick()
  tree5 = renderComponent(page5)
  eq(tree5.props['data-radio'], '1', '页面进入电台中状态')
  ok(!!byProp(tree5, 'data-role', 'radio'), '渲染出电台进行中提示条')
  const radioPlay = H5.playCalls.find((c) => c.fn === 'replaceAndPlay')
  ok(!!radioPlay, '开启电台会立即播放首批')
  eq(H5.getQueue().length, 5, '队列里有 5 首')

  // 模拟播放到队列尾部 → 触发续杯
  const priorHashes = new Set(
    H5.getQueue()
      .concat(H5.playCalls.filter((c) => c.fn === 'replaceAndPlay').reduce((acc, c) => acc.concat(c.list), []))
      .map((t) => t.hash)
  )
  const callsBeforeRefill = H5.netCalls.length
  H5.setQueue(H5.getQueue().slice(-1))
  const appendBefore = H5.playCalls.filter((c) => c.fn === 'append').length
  await H5.endedHandlers[0]()
  const appends = H5.playCalls.filter((c) => c.fn === 'append')
  eq(appends.length, appendBefore + 1, '触发一次自动续杯（append）')
  const lastAppend = appends[appends.length - 1]
  ok(lastAppend.list.length > 0, '续杯内容非空')
  eq(H5.netCalls.length, callsBeforeRefill + 1, '续杯发起了一次新的取数请求（不是复用旧数据）')
  // mock 每被调用一次就换一批（seed = 1 + (调用序号-1) * 100），所以期望值由实际调用次数推出
  const expectedSeed = 1 + (H5.netCalls.length - 1) * 100
  eq(lastAppend.list[0].hash, hashOf(expectedSeed), '续杯拉到的是最新一批（seed 随调用递增）')
  ok(
    !lastAppend.list.some((t) => priorHashes.has(t.hash)),
    '续杯内容与之前已出现过的歌完全不重复'
  )
  ok(H5.getQueue().length > 1, '队列被补长')

  // 关闭电台
  tree5 = renderComponent(page5)
  await byProp(tree5, 'data-action', 'radio').props.onClick()
  tree5 = renderComponent(page5)
  eq(tree5.props['data-radio'], '0', '再次点击关闭电台')
  ok(!byProp(tree5, 'data-role', 'radio'), '关闭后不显示进行中提示')

  /* ---------------- 17. 非无限流不提供「再来一批」 ---------------- */
  section('17. 非无限流行为')
  const H6 = await makeCtx()
  const mod6 = await loadPlugin()
  await mod6.activate(H6.ctx)
  const page6 = H6.pages[0].component
  let tree6 = renderComponent(page6)
  await byProp(tree6, 'data-source', 'everyday').props.onClick()
  tree6 = renderComponent(page6)
  const moreBtn = byProp(tree6, 'data-action', 'more')
  eq(moreBtn.props.disabled, true, '有限流源禁用「再来一批」')
  tree6 = renderComponent(page6)
  await byProp(tree6, 'data-source', 'newsong').props.onClick()
  tree6 = renderComponent(page6)
  eq(byProp(tree6, 'data-action', 'more').props.disabled, false, '无限流源启用「再来一批」')

  /* ---------------- 18. 未登录时仍可用无登录源 ---------------- */
  section('18. 未登录兜底')
  const H7 = await makeCtx({ loggedOut: true })
  const mod7 = await loadPlugin()
  await mod7.activate(H7.ctx)
  const page7 = H7.pages[0].component
  let tree7 = renderComponent(page7)
  await byProp(tree7, 'data-action', 'refresh').props.onClick()
  tree7 = renderComponent(page7)
  eq(withClass(tree7, 'kr-row').length, 5, '未登录也能从频道漫游拿到推荐')
  eq(H7.apiCalls.length, 0, '未登录时不发本地路由请求')
  includes(textOf(tree7), '不需要登录', '文案说明该源不需要登录')

  /* ---------------- 19. 重启幂等 + 停用回收 ---------------- */
  section('19. 幂等与资源回收')
  const H8 = await makeCtx({ storage: { settings: { defaultSource: 'newsong', batchSize: 7, dedupe: false } } })
  const mod8 = await loadPlugin()
  await mod8.activate(H8.ctx)
  eq(H8.pages[0].id, 'recommend', '重启后重新注册页面')
  const p8 = H8.pages[0].component
  let tree8 = renderComponent(p8)
  await byProp(tree8, 'data-action', 'refresh').props.onClick()
  eq(H8.apiCalls[0].url, '/top/song', '读取持久化的默认源 newsong')
  eq(H8.apiCalls[0].params.pagesize, 7, '读取持久化的 batchSize')

  // 再 activate 一次（宿主热重载）不应抛错
  let twiceOk = true
  try {
    await mod8.activate(H8.ctx)
  } catch (e) {
    twiceOk = false
    failures.push('[19. 幂等与资源回收] 二次 activate 抛错 :: ' + e.message)
  }
  ok(twiceOk, '二次 activate 不抛错')

  await mod8.deactivate()
  const H9 = await makeCtx()
  const mod9 = await loadPlugin()
  await mod9.activate(H9.ctx)
  const disposes = H9.disposers
  eq(disposes.length, 1, 'activate 注册了一个回收器')
  let disposeOk = true
  try {
    for (const fn of disposes) fn()
    for (const fn of disposes) fn()
  } catch (e) {
    disposeOk = false
    failures.push('[19. 幂等与资源回收] dispose 抛错 :: ' + e.message)
  }
  ok(disposeOk, 'dispose 可重复执行且不抛错')
  let deactivateOk = true
  try {
    await mod9.deactivate()
    await mod9.deactivate()
  } catch (e) {
    deactivateOk = false
    failures.push('[19. 幂等与资源回收] deactivate 抛错 :: ' + e.message)
  }
  ok(deactivateOk, 'deactivate 幂等')

  /* ---------------- 20. 网络能力缺失的降级 ---------------- */
  section('20. 能力缺失降级')
  const H10 = await makeCtx()
  delete H10.ctx.net.request
  const mod10 = await loadPlugin()
  await mod10.activate(H10.ctx)
  const page10 = H10.pages[0].component
  let tree10 = renderComponent(page10)
  await byProp(tree10, 'data-action', 'refresh').props.onClick()
  eq(H10.netFetchCalls.length, 1, 'ctx.net.request 缺失时回退到 ctx.net.fetch')
  eq(H10.netFetchCalls[0].url, GATEWAY, '回退后 URL 不变')
  tree10 = renderComponent(page10)
  eq(withClass(tree10, 'kr-row').length, 5, '回退通道同样能拿到数据')

  const H11 = await makeCtx()
  delete H11.ctx.net.request
  delete H11.ctx.net.fetch
  const mod11 = await loadPlugin()
  await mod11.activate(H11.ctx)
  const page11 = H11.pages[0].component
  let tree11 = renderComponent(page11)
  await byProp(tree11, 'data-action', 'refresh').props.onClick()
  tree11 = renderComponent(page11)
  const err11 = byProp(tree11, 'data-role', 'error')
  ok(!!err11, '两条网络通道都缺失时给出错误条而非崩溃')
  includes(textOf(err11), '网络能力', '提示宿主未提供网络能力')

  /* ---------------- 21. AI 推荐回退链 ---------------- */
  section('21. AI 推荐回退链')
  const aiRoutes = []
  const H12 = await makeCtx({
    router(route) {
      if (route === '/ai/recommend/song') {
        aiRoutes.push(route)
        return { status: 502, body: { status: 0, error_code: 20010 } }
      }
      if (route === '/ai/recommend') {
        aiRoutes.push(route)
        return { status: 200, body: everydayBody(4, 2200) }
      }
      return defaultRouter(route)
    }
  })
  const mod12 = await loadPlugin()
  await mod12.activate(H12.ctx)
  const page12 = H12.pages[0].component
  let tree12 = renderComponent(page12)
  await byProp(tree12, 'data-source', 'ai').props.onClick()
  eq(aiRoutes.join('|'), '/ai/recommend/song|/ai/recommend', '主路（concepts 版）失败后回退到 songlistairec 版')
  tree12 = renderComponent(page12)
  eq(withClass(tree12, 'kr-row').length, 4, '回退成功后拿到 4 首')
  ok(!byProp(tree12, 'data-role', 'error'), '回退成功就不该显示错误条')

  const H13 = await makeCtx({
    router(route) {
      if (route.startsWith('/ai/recommend')) return { status: 502, body: { status: 0, error_code: 20010 } }
      return defaultRouter(route)
    }
  })
  const mod13 = await loadPlugin()
  await mod13.activate(H13.ctx)
  const page13 = H13.pages[0].component
  let tree13 = renderComponent(page13)
  await byProp(tree13, 'data-source', 'ai').props.onClick()
  tree13 = renderComponent(page13)
  const err13 = byProp(tree13, 'data-role', 'error')
  ok(!!err13, '两条 AI 路都失败时给出错误条')
  const err13Text = textOf(err13)
  includes(err13Text, 'concepts', '错误信息点出主路（concepts）')
  includes(err13Text, 'songlistairec', '错误信息点出回退路（songlistairec）')
  includes(err13Text, '20010', '错误信息带上真实 error_code')
  includes(err13Text, '参数或权限', '20010 映射为可读文案')

  /* ---------------- 22. 上游字段名/嵌套层不一致的兜底 ---------------- */
  section('22. 字段名兜底与未识别提示')
  const H14 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: {
              info: [
                {
                  hash: hashOf(3001),
                  audio_info: { hash: hashOf(3001) },
                  song_info: { song_name: '深藏的歌名', singer_name: '深藏的歌手' }
                },
                {
                  hash: hashOf(3002),
                  audio_info: { hash: hashOf(3002) },
                  song_info: { song_name: '第二首', singer_name: '第二位' }
                }
              ]
            }
          }
        }
      }
      return defaultRouter(route)
    }
  })
  const mod14 = await loadPlugin()
  await mod14.activate(H14.ctx)
  const page14 = H14.pages[0].component
  let tree14 = renderComponent(page14)
  await byProp(tree14, 'data-source', 'listen').props.onClick()
  tree14 = renderComponent(page14)
  const rows14 = withClass(tree14, 'kr-row')
  eq(rows14.length, 2, '嵌套在 song_info 里的源也能解析出 2 首')
  includes(textOf(rows14[0]), '深藏的歌名', '深层 song_name 被 BFS 兜底认出来')
  includes(textOf(rows14[0]), '深藏的歌手', '深层 singer_name 被 BFS 兜底认出来')
  ok(!textOf(tree14).includes('未知歌曲'), '不再退化成「未知歌曲」')

  const H15 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: { info: [{ hash: hashOf(3101), misc: { foo: 'bar' } }, { hash: hashOf(3102), misc: { foo: 'baz' } }] }
          }
        }
      }
      return defaultRouter(route)
    }
  })
  const mod15 = await loadPlugin()
  await mod15.activate(H15.ctx)
  const page15 = H15.pages[0].component
  let tree15 = renderComponent(page15)
  await byProp(tree15, 'data-source', 'listen').props.onClick()
  tree15 = renderComponent(page15)
  eq(withClass(tree15, 'kr-row').length, 2, '完全认不出歌名时仍能列出（不崩、不丢条目）')
  includes(textOf(tree15), '未知歌曲', '认不出时按「未知歌曲」降级展示')

  await byProp(tree15, 'data-action', 'health').props.onClick()
  tree15 = renderComponent(page15)
  const warnBadge = byProp(tree15, 'data-warn', 'listen')
  ok(!!warnBadge, '健康检查给「未识别」警告徽标')
  includes(textOf(warnBadge), '未识别', '徽标文案正确')
  const listenRow = byProp(tree15, 'data-health', 'listen')
  const rawCell = findAll(listenRow, (n) => n.props && n.props['data-raw-keys'])[0]
  ok(!!rawCell, '健康检查行里带出上游原始键名')
  includes(rawCell.props['data-raw-keys'], 'misc', '原始键名可用于精确校准（能看到 misc）')
  includes(rawCell.props['data-raw-keys'], 'hash', '原始键名里能看到 hash')
  includes(String(rawCell.props.title), '原始首条', 'tooltip 里带原始 JSON 片段')

  /* ---------------- 23. 每日历史 mode 切换 ---------------- */
  section('23. 每日历史 mode 切换')
  const H16 = await makeCtx()
  const mod16 = await loadPlugin()
  await mod16.activate(H16.ctx)
  const page16 = H16.pages[0].component
  let tree16 = renderComponent(page16)
  await byProp(tree16, 'data-source', 'history').props.onClick()
  eq(H16.apiCalls[0].url, '/everyday/history', '路由 /everyday/history')
  eq(H16.apiCalls[0].params.mode, 'list', '未填日期时用 mode=list')
  tree16 = renderComponent(page16)
  const dateInput = byProp(tree16, 'data-role', 'history-date')
  ok(!!dateInput, '历史源渲染出日期输入框')
  dateInput.props.onInput({ target: { value: '2026-09-01' } })
  tree16 = renderComponent(page16)
  H16.apiCalls.length = 0
  await byProp(tree16, 'data-action', 'refresh').props.onClick()
  eq(H16.apiCalls[0].params.mode, 'song', '填了日期后改用 mode=song（才是「按日期取歌」）')
  eq(H16.apiCalls[0].params.date, '2026-09-01', '日期被透传')
  H16.apiCalls.length = 0
  await byProp(tree16, 'data-source', 'newsong').props.onClick()
  eq(H16.apiCalls[0].url, '/top/song', '切到新歌速递回到本地路由源')

  /* ---------------- 24. 每个源各自保留列表 + 切源自动刷新 ---------------- */
  section('24. 各源独立列表缓存 + 切源自动刷新')
  const H17 = await makeCtx()
  const mod17 = await loadPlugin()
  await mod17.activate(H17.ctx)
  const page17 = H17.pages[0].component
  let tree17 = renderComponent(page17)

  eq(byProp(tree17, 'data-action', 'toggle-auto-refresh').props['data-on'], '1', '切源自动刷新默认开启')
  includes(textOf(byProp(tree17, 'data-action', 'toggle-auto-refresh')), '开', '按钮文案显示「开」')
  eq(byProp(tree17, 'data-source', 'channel').props['data-cache'], '0', '初始时各源都没有缓存')

  // 1) 首次切到某个源（无缓存 + 自动刷新开）→ 立即拉取
  await byProp(tree17, 'data-source', 'everyday').props.onClick()
  eq(H17.apiCalls.length, 1, '首次切到该源会立即拉取')
  tree17 = renderComponent(page17)
  eq(withClass(tree17, 'kr-row').length, 6, '拿到「每日推荐」的 6 首')
  eq(byProp(tree17, 'data-source', 'everyday').props['data-cache'], '6', '「每日推荐」缓存了 6 首')

  // 2) 再切到另一个没缓存的源 → 也会拉取，且不影响上一个源的缓存
  H17.apiCalls.length = 0
  await byProp(tree17, 'data-source', 'fm').props.onClick()
  eq(H17.apiCalls.length, 1, '切到另一个没缓存的源也会拉取')
  tree17 = renderComponent(page17)
  eq(withClass(tree17, 'kr-row').length, 4, '显示「猜你喜欢」的 4 首')
  eq(byProp(tree17, 'data-source', 'everyday').props['data-cache'], '6', '「每日推荐」的缓存仍在（互不干扰）')
  eq(byProp(tree17, 'data-source', 'fm').props['data-cache'], '4', '「猜你喜欢」缓存了 4 首')

  // 3) 切回已有列表的源 → 命中缓存，不请求，恢复它自己的列表
  H17.apiCalls.length = 0
  H17.netCalls.length = 0
  await byProp(tree17, 'data-source', 'everyday').props.onClick()
  eq(H17.apiCalls.length + H17.netCalls.length, 0, '切回已有列表的源不再发任何请求')
  tree17 = renderComponent(page17)
  eq(withClass(tree17, 'kr-row').length, 6, '恢复的是「每日推荐」自己的 6 首，而不是 fm 的 4 首')
  const noticeCache = textOf(byProp(tree17, 'data-role', 'notice'))
  includes(noticeCache, '恢复上次的 6 首', '提示说明是恢复缓存')
  includes(noticeCache, '换一批', '提示可以用「换一批」刷新')
  eq(H17.storageMap.get('settings').defaultSource, 'everyday', '切源结果被记住')

  // 4) 再切回 fm：内容仍是它自己的那批（两者不串）
  await byProp(tree17, 'data-source', 'fm').props.onClick()
  tree17 = renderComponent(page17)
  eq(withClass(tree17, 'kr-row').length, 4, '再切回「猜你喜欢」仍是它自己的 4 首')
  includes(textOf(tree17), '猜你喜欢900', '内容确实是「猜你喜欢」那批')

  // 5) 关掉自动刷新：切到「还没有列表」的源 → 不请求 + 空状态 + 提示
  await byProp(tree17, 'data-action', 'toggle-auto-refresh').props.onClick()
  eq(H17.storageMap.get('settings').autoRefreshOnSwitch, false, '关闭状态已落盘')
  tree17 = renderComponent(page17)
  eq(byProp(tree17, 'data-action', 'toggle-auto-refresh').props['data-on'], '0', '按钮切到关闭态')
  H17.apiCalls.length = 0
  H17.netCalls.length = 0
  await byProp(tree17, 'data-source', 'newsong').props.onClick()
  eq(H17.apiCalls.length + H17.netCalls.length, 0, '关闭后切到没缓存的源也不会自动请求')
  tree17 = renderComponent(page17)
  eq(withClass(tree17, 'kr-row').length, 0, '该源还没列表 → 显示空状态')
  eq(byProp(tree17, 'data-source', 'newsong').props['data-cache'], '0', '新歌速递仍无缓存')
  includes(textOf(byProp(tree17, 'data-role', 'notice')), '还没有列表', '提示引导手动加载')

  // 6) 手动「换一批」→ 按当前源加载
  H17.apiCalls.length = 0
  await byProp(tree17, 'data-action', 'refresh').props.onClick()
  eq(H17.apiCalls.length, 1, '手动「换一批」按当前源发请求')
  eq(H17.apiCalls[0].url, '/top/song', '用的是当前选中的源（新歌速递）')
  tree17 = renderComponent(page17)
  eq(withClass(tree17, 'kr-row').length, 3, '拿到新歌速递的 3 首')

  // 7) 关着自动刷新也能恢复缓存
  H17.apiCalls.length = 0
  await byProp(tree17, 'data-source', 'everyday').props.onClick()
  eq(H17.apiCalls.length, 0, '关闭自动刷新时切回有缓存的源同样不请求')
  tree17 = renderComponent(page17)
  eq(withClass(tree17, 'kr-row').length, 6, '恢复缓存的 6 首')

  // 8) 重复点当前源（开着自动刷新）= 刷新
  await byProp(tree17, 'data-action', 'toggle-auto-refresh').props.onClick()
  tree17 = renderComponent(page17)
  H17.apiCalls.length = 0
  await byProp(tree17, 'data-source', 'everyday').props.onClick()
  eq(H17.apiCalls.length, 1, '开着自动刷新时重复点当前源会刷新')

  // 9) 清空各源缓存
  await byProp(tree17, 'data-action', 'clear-caches').props.onClick()
  tree17 = renderComponent(page17)
  eq(byProp(tree17, 'data-source', 'everyday').props['data-cache'], '0', '清空后缓存归零')
  eq(byProp(tree17, 'data-source', 'fm').props['data-cache'], '0', '所有源缓存都归零')
  eq(withClass(tree17, 'kr-row').length, 0, '清空缓存后当前列表也空了')

  const settingsComp17 = H17.sidebarItems.find((i) => i.kind === 'settings').cfg.component
  const stree17 = renderComponent(settingsComp17)
  const arRow = findAll(stree17, (n) => n.props && n.props['data-setting'] === 'autoRefreshOnSwitch')[0]
  ok(!!arRow, '设置面板里也暴露「切源自动刷新」')

  // 重启后读取持久化的关闭态
  const H20 = await makeCtx({ storage: { settings: { autoRefreshOnSwitch: false, defaultSource: 'everyday' } } })
  const mod20 = await loadPlugin()
  await mod20.activate(H20.ctx)
  const page20 = H20.pages[0].component
  const tree20 = renderComponent(page20)
  eq(byProp(tree20, 'data-action', 'toggle-auto-refresh').props['data-on'], '0', '重启后开关状态来自存储')

  /* ---------------- 25. 网络临时失败自动重试 ---------------- */
  section('25. 网络临时失败自动重试')
  let listenCall = 0
  const H18 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        listenCall++
        if (listenCall === 1) {
          // 与真机一致：502 + error_code 0 + net:: 前缀（连接被重置，不是业务错误）
          return { status: 502, body: { status: 0, error_code: 0, error: 'net::ERR_CONNECTION_RESET' } }
        }
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: { info: [{ hash: hashOf(4001), songname: '重试成功', author_name: '重试歌手' }] }
          }
        }
      }
      return defaultRouter(route)
    }
  })
  const mod18 = await loadPlugin()
  await mod18.activate(H18.ctx)
  const page18 = H18.pages[0].component
  let tree18 = renderComponent(page18)
  await byProp(tree18, 'data-source', 'listen').props.onClick()
  eq(listenCall, 2, '连接被重置后自动重试了一次')
  tree18 = renderComponent(page18)
  eq(withClass(tree18, 'kr-row').length, 1, '重试后成功拿到数据')
  ok(!byProp(tree18, 'data-role', 'error'), '重试成功就不显示错误条')

  // 业务错误绝不重试（重试也无效，还徒增风控风险）
  let topCall = 0
  const H19 = await makeCtx({
    router(route) {
      if (route === '/top/song') {
        topCall++
        return { status: 502, body: { status: 0, error_code: 21001, error: '' } }
      }
      return defaultRouter(route)
    }
  })
  const mod19 = await loadPlugin()
  await mod19.activate(H19.ctx)
  const page19 = H19.pages[0].component
  let tree19 = renderComponent(page19)
  await byProp(tree19, 'data-source', 'newsong').props.onClick()
  eq(topCall, 1, '业务错误（21001）不重试')
  tree19 = renderComponent(page19)
  includes(textOf(byProp(tree19, 'data-role', 'error')), '参数有误', '仍给出可读错误文案')

  // 502 + error_code 0 的文案不能是「成功」
  let listenCall2 = 0
  const H21 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        listenCall2++
        return { status: 502, body: { status: 0, error_code: 0, error: 'net::ERR_CONNECTION_RESET' } }
      }
      return defaultRouter(route)
    }
  })
  const mod21 = await loadPlugin()
  await mod21.activate(H21.ctx)
  const page21 = H21.pages[0].component
  let tree21 = renderComponent(page21)
  await byProp(tree21, 'data-source', 'listen').props.onClick()
  eq(listenCall2, 2, '一直重置时重试一次后放弃')
  tree21 = renderComponent(page21)
  const err21 = textOf(byProp(tree21, 'data-role', 'error'))
  includes(err21, 'ERR_CONNECTION_RESET', '错误文案带上真实网络错误')
  ok(!err21.includes('成功'), 'error_code=0 时绝不会把失败写成「成功」')
  ok(!err21.includes('需要登录'), '网络层失败不会被误报成「需要登录」')

  /* ---------------- 26. 主 hash 优先级 ---------------- */
  section('26. 主 hash 优先级（不要拿 hash_320 当主 hash）')
  const H22 = await makeCtx({
    router(route) {
      if (route === '/personal/fm') {
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: [
              { hash: hashOf(7001), songname: '有主hash', author_name: '甲', audio_info: { hash_320: hashOf(7101) } },
              { songname: '只有320', author_name: '乙', audio_info: { hash_320: hashOf(7102) } }
            ]
          }
        }
      }
      return defaultRouter(route)
    }
  })
  const mod22 = await loadPlugin()
  await mod22.activate(H22.ctx)
  const page22 = H22.pages[0].component
  let tree22 = renderComponent(page22)
  await byProp(tree22, 'data-source', 'fm').props.onClick()
  tree22 = renderComponent(page22)
  H22.playCalls.length = 0
  await byProp(tree22, 'data-action', 'play-all').props.onClick()
  const played22 = H22.playCalls.find((c) => c.fn === 'replaceAndPlay')
  eq(played22.list.length, 2, '两条都能归一化（完全没主 hash 时用 320 兜底）')
  eq(played22.list[0].hash, hashOf(7001), '有规范 hash 时优先用它，而不是 hash_320')
  eq(played22.list[0].relateGoods[0].hash, hashOf(7101), '320 的 hash 归入 relateGoods')
  eq(played22.list[1].hash, hashOf(7102), '确实没有主 hash 才退回 hash_320')

  /* ---------------- 27. 纯 hash 接口的按 hash 反查 ---------------- */
  section('27. 纯 hash 记录（听歌排行）按 hash 反查歌曲信息')
  // 真机形态：/user/history 只给 { hash,size,bitrate,privilege,level }，没有任何名称字段
  const ENRICH_HASH = hashOf(5001).toUpperCase()
  const enrichCalls = []
  const H23 = await makeCtx({
    router(route, params) {
      if (route === '/user/history') {
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: {
              info: [
                { hash: ENRICH_HASH, size: 3219835, bitrate: 128, privilege: 10, level: 2 },
                { hash: hashOf(5002).toUpperCase(), size: 2222222, bitrate: 320, privilege: 10, level: 3 }
              ]
            }
          }
        }
      }
      if (route === '/privilege/lite') {
        enrichCalls.push(params)
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: [
              {
                hash: hashOf(5001), // 反查结果给的是小写，正好也验证大小写不敏感配对
                songname: '反查到的歌名',
                author_name: '反查到的歌手',
                album_name: '反查到的专辑',
                album_id: '123',
                album_audio_id: '456',
                timelength: 201000,
                audio_info: { hash: hashOf(5001), hash_flac: hashOf(5201) }
              },
              { hash: hashOf(5002), songname: '第二首反查', author_name: '第二位' }
            ]
          }
        }
      }
      return defaultRouter(route)
    }
  })
  const mod23 = await loadPlugin()
  await mod23.activate(H23.ctx)
  const page23 = H23.pages[0].component
  let tree23 = renderComponent(page23)
  await byProp(tree23, 'data-source', 'listen').props.onClick()

  eq(enrichCalls.length, 1, '对没有名称信息的记录发起了 1 次按 hash 反查')
  includes(enrichCalls[0].hash, ENRICH_HASH, '反查请求带上原始 hash')
  includes(enrichCalls[0].hash, ',', '多个 hash 用逗号批量拼在一个请求里')

  tree23 = renderComponent(page23)
  const rows23 = withClass(tree23, 'kr-row')
  eq(rows23.length, 2, '两条记录都在')
  includes(textOf(rows23[0]), '反查到的歌名', '歌名来自反查结果')
  includes(textOf(rows23[0]), '反查到的歌手', '歌手来自反查结果')
  includes(textOf(rows23[0]), '反查到的专辑', '专辑来自反查结果')
  includes(textOf(rows23[0]), '3:21', '时长来自反查结果（201000ms → 3:21）')
  includes(textOf(rows23[0]), 'FLAC', '音质标签来自反查结果')
  ok(!textOf(tree23).includes('未知歌曲'), '不再整列「未知歌曲」')

  H23.playCalls.length = 0
  await byProp(tree23, 'data-action', 'play-all').props.onClick()
  const played23 = H23.playCalls.find((c) => c.fn === 'replaceAndPlay')
  eq(played23.list[0].hash, hashOf(5001), '反查后 hash 仍是小写规范形式')
  eq(played23.list[0].albumAudioId, '456', '反查补上的 albumAudioId 生效')

  // 反查失败时：降级展示但不崩、不丢条目，并在健康检查里点名原因
  const H24 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        return {
          status: 200,
          body: { status: 1, error_code: 0, data: { info: [{ hash: hashOf(6001), size: 1, bitrate: 128, privilege: 10, level: 2 }] } }
        }
      }
      if (route === '/privilege/lite') {
        return { status: 502, body: { status: 0, error_code: 20010, error: '反查被拒' } }
      }
      return defaultRouter(route)
    }
  })
  const mod24 = await loadPlugin()
  await mod24.activate(H24.ctx)
  const page24 = H24.pages[0].component
  let tree24 = renderComponent(page24)
  await byProp(tree24, 'data-source', 'listen').props.onClick()
  tree24 = renderComponent(page24)
  eq(withClass(tree24, 'kr-row').length, 1, '反查失败时条目照常列出（不丢数据）')
  includes(textOf(tree24), '未知歌曲', '反查失败时按「未知歌曲」降级')

  await byProp(tree24, 'data-action', 'health').props.onClick()
  tree24 = renderComponent(page24)
  const listenCell = findAll(byProp(tree24, 'data-health', 'listen'), (n) => n.props && n.props['data-debug'])[0]
  ok(!!listenCell, '健康检查行里带出反查诊断')
  const dbg = JSON.parse(listenCell.props['data-debug'])
  eq(dbg.route, '/privilege/lite', '诊断里写明用的反查路由')
  eq(dbg.matched, 0, '诊断里命中数为 0')
  eq(dbg.filled, 0, '诊断里补全数为 0')
  // tooltip 里带的是「反查失败」的完整说明（错误码会走错误码表映射成可读文案）
  const tip = String(listenCell.props.title)
  includes(tip, '反查 /privilege/lite', 'tooltip 里写明反查路由')
  includes(tip, '命中 0', 'tooltip 里写明命中 0')
  includes(tip, '上游拒绝了该请求', 'tooltip 里给出可读的失败原因（20010 走错误码表）')
  includes(tip, '原始首条', 'tooltip 里仍带原始首条记录，便于校准')

  /* ---------------- 28. 兄弟数组：hash 列表 + 完整信息列表 ---------------- */
  section('28. 同一响应里同时有 hash 列表与完整信息列表')
  const H25 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: {
              // 「信息更全」的数组排在后面：挑数组时不能被光秃秃的 hash 列表带偏
              info: [
                { hash: hashOf(8001), size: 1, bitrate: 128, privilege: 10, level: 2 },
                { hash: hashOf(8002), size: 1, bitrate: 128, privilege: 10, level: 2 }
              ],
              song_list: [
                { hash: hashOf(8001), songname: '完整信息一', author_name: '甲' },
                { hash: hashOf(8002), songname: '完整信息二', author_name: '乙' }
              ]
            }
          }
        }
      }
      return defaultRouter(route)
    }
  })
  const mod25 = await loadPlugin()
  await mod25.activate(H25.ctx)
  const page25 = H25.pages[0].component
  let tree25 = renderComponent(page25)
  await byProp(tree25, 'data-source', 'listen').props.onClick()
  tree25 = renderComponent(page25)
  const rows25 = withClass(tree25, 'kr-row')
  eq(rows25.length, 2, '两个候选数组里挑到了带名称信息的那个')
  includes(textOf(rows25[0]), '完整信息一', '直接用了完整信息，不需要反查')
  ok(!textOf(tree25).includes('未知歌曲'), '没有退化')

  /* ---------------- 29. 响应式回归：换一批后必须自动刷新 ---------------- */
  section('29. 响应式回归：换一批后无需切源就应显示新列表')
  const H26 = await makeCtx()
  const mod26 = await loadPlugin()
  await mod26.activate(H26.ctx)
  const page26 = H26.pages[0].component

  // 关键：**只 setup 一次**，复用同一个 render 与它内部的 computed。
  // 之前每步都重新 setup 会新建 computed，恰好掩盖了「写原始对象绕过 Proxy →
  // computed 缓存旧值 → 界面不更新，要切源才刷新」这个真机上出现过的 bug。
  const render26 = page26.setup({}, { attrs: {}, slots: {}, emit() {}, expose() {} })
  const snaps = []
  const stop26 = V.watchEffect(() => {
    snaps.push(withClass(render26(), 'kr-row').length)
  })
  const base26 = snaps.length

  eq(snaps[snaps.length - 1], 0, '首屏还没有数据')

  let tree26 = render26()
  await byProp(tree26, 'data-action', 'refresh').props.onClick()
  ok(snaps.length > base26, '取数过程中发生过重渲染')
  eq(snaps[snaps.length - 1], 5, '最后一次渲染已显示新拉到的 5 首（不需要切源）')

  // 切到另一个源也要能自动更新（缓存路径同样要响应式）
  tree26 = render26()
  await byProp(tree26, 'data-source', 'everyday').props.onClick()
  eq(snaps[snaps.length - 1], 6, '切源后自动显示该源列表')
  tree26 = render26()
  await byProp(tree26, 'data-source', 'channel').props.onClick()
  eq(snaps[snaps.length - 1], 5, '切回缓存源也自动刷新视图')
  stop26()

  /* ---------------- 30. 同一首歌的多个 hash 变体只留一条 ---------------- */
  section('30. 同一首歌的多个 hash 变体塌成一条')
  const H27 = await makeCtx({
    router(route) {
      if (route === '/user/history') {
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: {
              info: [
                { hash: hashOf(9001), size: 1, bitrate: 128, privilege: 10, level: 2 },
                { hash: hashOf(9002), size: 2, bitrate: 320, privilege: 10, level: 2 },
                { hash: hashOf(9003), size: 3, bitrate: 999, privilege: 10, level: 2 },
                { hash: hashOf(9004), size: 4, bitrate: 128, privilege: 10, level: 2 }
              ]
            }
          }
        }
      }
      if (route === '/privilege/lite') {
        // 前 3 条是同一首歌的不同音质（album_audio_id 相同）；第 4 条是另一首歌。
        // name 是「歌手 - 歌名」复合串（实测 /privilege/lite 就是这样）。
        return {
          status: 200,
          body: {
            status: 1,
            error_code: 0,
            data: [
              { hash: hashOf(9001), album_audio_id: '777', name: '同一个歌手 - 同一首歌', singername: '同一个歌手', albumname: '同一张专辑' },
              { hash: hashOf(9002), album_audio_id: '777', name: '同一个歌手 - 同一首歌', singername: '同一个歌手' },
              { hash: hashOf(9003), album_audio_id: '777', name: '同一个歌手 - 同一首歌', singername: '同一个歌手' },
              { hash: hashOf(9004), album_audio_id: '888', name: '另一个歌手 - 另一首歌', singername: '另一个歌手' }
            ]
          }
        }
      }
      return defaultRouter(route)
    }
  })
  const mod27 = await loadPlugin()
  await mod27.activate(H27.ctx)
  const page27 = H27.pages[0].component
  let tree27 = renderComponent(page27)
  await byProp(tree27, 'data-source', 'listen').props.onClick()
  tree27 = renderComponent(page27)
  const rows27 = withClass(tree27, 'kr-row')
  eq(rows27.length, 2, '3 个同歌变体塌成 1 条 + 另 1 首 = 共 2 条')
  includes(textOf(rows27[0]), '同一首歌', '显示的是剥掉歌手前缀的纯歌名')
  includes(textOf(rows27[0]), '同一个歌手', '歌手单独显示')
  ok(
    !textOf(rows27[0]).includes('同一个歌手 - 同一首歌'),
    '不再显示成「歌手 - 歌名 - 歌手」那种重复的复合串'
  )
  includes(textOf(rows27[1]), '另一首歌', 'album_audio_id 不同的另一首歌不会被误合并')
  includes(textOf(rows27[1]), '另一个歌手', '另一首的歌手也对')
} catch (e) {
  failures.push('[FATAL] ' + (e && e.stack ? e.stack : e))
} finally {
  console.warn = origWarn
  console.error = origError
}

/* ========================================================================== *
 * 报告
 * ========================================================================== */

const total = pass + failures.length
const lines = []
lines.push('')
lines.push('='.repeat(66))
lines.push('推荐电台 (kugou-recommend) 无头集成测试')
lines.push('Vue 运行时: ' + vuePath)
lines.push('='.repeat(66))
for (const s of sectionResults) {
  lines.push('  ' + s.name)
}
lines.push('-' .repeat(66))
if (failures.length) {
  lines.push('FAILED 断言：')
  for (const f of failures) lines.push('  ✗ ' + f)
  lines.push('')
}
lines.push('结果: ' + pass + '/' + total + ' 通过' + (failures.length ? '，' + failures.length + ' 失败' : '，全部通过 ✓'))
if (suppressed.length) lines.push('（宿主/运行时告警 ' + suppressed.length + ' 条已静默，例如 onMounted 无实例）')
lines.push('='.repeat(66))
console.log(lines.join('\n'))

process.exit(failures.length ? 1 : 0)
