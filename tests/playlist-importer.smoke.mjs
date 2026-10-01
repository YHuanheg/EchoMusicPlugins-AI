/**
 * 歌单导入增强 (playlist-importer) 无头集成测试
 * ===========================================================================
 * 为什么必须这么测：静态 `node --check` **抓不到未定义标识符** ——
 * 本仓库历史上出现过「函数被调用但从未定义」这种只有真跑一遍才会暴露的 bug。
 * 所以这里用**真实 Vue 3 ESM 运行时**无头执行插件代码：
 *   1. mock 一个符合宿主契约的 ctx（storage / ui / tasks / electron.api / net / pinia / kugouVerification）
 *   2. `await activate(ctx)` → 断言注册项、任务中心 retention、页面 vnode 树
 *   3. 直接 `component.setup()()` 拿真实 vnode 树，找 `data-*` 钩子并**真实调用 onClick()**
 *   4. 用脚本化的本地路由驱动「匹配预演 → 人工改选 → 分批导入」完整链路
 *
 * 运行： node tests/playlist-importer.smoke.mjs
 * 变异测试：设 PI_PLUGIN_ENTRY / PI_CSS_ENTRY 指向改动副本，即可验证「改坏了会红」。
 *
 * 夹具纪律（踩过的坑，别改回去）：
 *   - hash 必须**确定性且种子区间互不重叠**，否则会出现"插件正确地当成重复、测试却报错"；
 *   - 每个用例开头重设自己的 `script.handlers`，避免上个用例的残留污染；
 *   - 定时器全部受控（searchGapMs / addBatchIntervalMs / retryDelayMs 预置为 0），整套测试不需要 sleep。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_ENTRY = process.env.PI_PLUGIN_ENTRY
  ? path.resolve(process.env.PI_PLUGIN_ENTRY)
  : path.join(ROOT, 'playlist-importer', 'index.js')
const CSS_ENTRY = process.env.PI_CSS_ENTRY
  ? path.resolve(process.env.PI_CSS_ENTRY)
  : path.join(ROOT, 'playlist-importer', 'style.css')
const CACHE_DIR = path.join(ROOT, '.workbuddy', 'tmp')
const CACHE_VUE = path.join(CACHE_DIR, 'vue.runtime.esm-browser.js')
const VUE_CDN = 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.esm-browser.js'
const REPORT_FILE = process.env.PI_REPORT_FILE
  ? path.resolve(process.env.PI_REPORT_FILE)
  : path.join(CACHE_DIR, 'playlist-importer-smoke-report.txt')

/* ========================================================================== *
 * 断言脚手架（结果落文件：PowerShell 会吞 stdout）
 * ========================================================================== */

let pass = 0
const failures = []
const sectionNames = []
let currentSection = '(root)'

function section(name) {
  currentSection = name
  sectionNames.push(name)
}

function ok(cond, name, extra) {
  if (cond) {
    pass++
    return true
  }
  failures.push(
    '[' + currentSection + '] ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))
  )
  return false
}

function eq(actual, expected, name) {
  return ok(actual === expected, name, { actual, expected })
}

function neq(actual, expected, name) {
  return ok(actual !== expected, name, { actual, expected })
}

function deepEq(actual, expected, name) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  return ok(a === b, name, { actual, expected })
}

function near(actual, expected, eps, name) {
  const a = Number(actual)
  const b = Number(expected)
  return ok(Number.isFinite(a) && Math.abs(a - b) <= eps, name, { actual, expected, eps })
}

function includes(hay, needle, name) {
  return ok(String(hay === null || hay === undefined ? '' : hay).includes(needle), name, {
    haystack: String(hay || '').slice(0, 300),
    needle
  })
}

function notIncludes(hay, needle, name) {
  return ok(!String(hay === null || hay === undefined ? '' : hay).includes(needle), name, {
    haystack: String(hay || '').slice(0, 300),
    needle
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
}

/* --------------------------------------------------------------------------
 * 定时器哨兵
 * 插件 activate 里如果起了 setInterval（轮询 / 倒计时 / 刷新守护），在无头环境里
 * 没人清理它，事件循环永不空闲 → `node tests/x.smoke.mjs` 一直挂着不退出。
 * 这个插件**不应该**有任何 interval（它用批事件与可中断 sleep，不需要心跳），
 * 所以这里装个哨兵把它变成一条断言。
 * ------------------------------------------------------------------------ */

const TIMER_SPY = { created: 0, active: 0 }
const ORIG_SET_INTERVAL = globalThis.setInterval
const ORIG_CLEAR_INTERVAL = globalThis.clearInterval
globalThis.setInterval = (...args) => {
  TIMER_SPY.created++
  TIMER_SPY.active++
  return ORIG_SET_INTERVAL(...args)
}
globalThis.clearInterval = (handle) => {
  if (handle) TIMER_SPY.active--
  return ORIG_CLEAR_INTERVAL(handle)
}
function restoreTimers() {
  globalThis.setInterval = ORIG_SET_INTERVAL
  globalThis.clearInterval = ORIG_CLEAR_INTERVAL
}

/* ========================================================================== *
 * Vue 运行时
 * ========================================================================== */

async function resolveVue() {
  const candidates = [process.env.VUE_ESM_PATH, CACHE_VUE].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const res = await fetch(VUE_CDN)
  if (!res.ok) throw new Error('无法下载 Vue ESM 构建：HTTP ' + res.status + '（可设 VUE_ESM_PATH）')
  fs.writeFileSync(CACHE_VUE, await res.text(), 'utf8')
  return CACHE_VUE
}

const V = await import(pathToFileURL(await resolveVue()).href)

/* ========================================================================== *
 * vnode 遍历（就地实现，保证测试可移植、不依赖仓库外文件）
 * ========================================================================== */

const isVNode = (n) => !!n && typeof n === 'object' && n.__v_isVNode

function walk(node, visit) {
  const visitAll = (n) => {
    if (n === null || n === undefined || n === false || n === true || n === '') return
    if (Array.isArray(n)) {
      n.forEach(visitAll)
      return
    }
    if (typeof n === 'string' || typeof n === 'number') {
      visit({ __textVNode: true, text: String(n) })
      return
    }
    if (!isVNode(n)) return
    visit(n)
    const c = n.children
    if (Array.isArray(c)) c.forEach(visitAll)
    else if (typeof c === 'string' || typeof c === 'number') visitAll(c)
    else if (c && typeof c === 'object') {
      for (const key of Object.keys(c)) {
        const v = c[key]
        if (typeof v !== 'function' || key === '_ctx' || key === '_') continue
        try {
          visitAll(v())
        } catch {
          /* 插槽执行失败忽略 */
        }
      }
    }
  }
  visitAll(node)
}

function findAll(tree, pred) {
  const out = []
  walk(tree, (n) => {
    if (pred(n)) out.push(n)
  })
  return out
}

const findByProp = (tree, prop, value) => findAll(tree, (n) => !n.__textVNode && n.props && n.props[prop] === value)

const findByRole = (tree, role) => findByProp(tree, 'data-role', role)

function textOf(tree) {
  const parts = []
  walk(tree, (n) => {
    if (n.__textVNode) parts.push(n.text)
  })
  return parts.join(' ')
}

async function setupRender(component, props = {}) {
  if (!component || typeof component.setup !== 'function') throw new Error('setupRender: 组件没有 setup()')
  const raw = component.setup(props, { expose() {}, emit() {}, slots: {}, attrs: {} })
  const resolved = await Promise.resolve(raw)
  if (typeof resolved === 'function') return resolved
  if (resolved && typeof resolved.render === 'function') return resolved.render
  throw new Error('setupRender: setup() 没有返回 render')
}

async function click(tree, prop, value) {
  const node = findByProp(tree, prop, value)[0]
  if (!node) throw new Error('click: 找不到 ' + prop + '=' + value)
  const fn = node.props.onClick
  if (typeof fn !== 'function') throw new Error('click: ' + prop + '=' + value + ' 没有 onClick')
  await fn()
  return node
}

/* ========================================================================== *
 * 夹具
 * ========================================================================== */

/** 确定性 hash（32 位十六进制）。各用例的种子区间必须互不重叠 —— 见文件头夹具纪律 */
function hashOf(seed) {
  return crypto.createHash('md5').update('pi-fixture-' + String(seed)).digest('hex')
}

/** 酷狗搜索返回的一条（字段名照宿主自己的解析器核对过：FileHash / SongName / SingerName / MixSongID） */
function searchItem(seed, name, singer, extra = {}) {
  return {
    FileHash: extra.hash || hashOf(seed),
    SongName: name,
    SingerName: singer,
    AlbumName: extra.album || ('专辑' + seed),
    AlbumID: extra.albumId === undefined ? 100000 + seed : extra.albumId,
    MixSongID: extra.mixSongId === undefined ? 900000 + seed : extra.mixSongId,
    Duration: extra.durationMs === undefined ? 240000 : extra.durationMs,
    Audioid: 700000 + seed
  }
}

/** 搜索返回的**载荷**（body 层）。宿主本地路由返回的是 `{status, headers, body}` 信封，别搞混。 */
function searchBody(items) {
  return { status: 1, error_code: 0, lists: items }
}

/** 包成宿主本地路由的返回信封 */
function envelope(payload, status) {
  return { status: status === undefined ? 200 : status, headers: {}, body: payload }
}

/** 网络层临时失败（HTTP 502 + error_code 0）—— 应当重试 */
const transientFail = () => ({ status: 502, headers: {}, body: { status: 0, error_code: 0 } })

/** 业务拒绝（非零 error_code）—— **不该**重试 */
const bizFail = (code = 20010, msg = '参数错误') => ({
  status: 200,
  headers: {},
  body: { status: 0, error_code: code, error: msg }
})

/** 风控（20028）—— 应当唤起验证并重试一次 */
const riskFail = (eventId) => ({
  status: 502,
  headers: { 'ssa-code': eventId },
  body: { status: 0, error_code: 20028, ssaCode: eventId, error: '本次请求需要验证' }
})

const okBody = (data) => ({ status: 1, error_code: 0, data: data === undefined ? {} : data })

/* ------------------------------------------------------------------ ctx */

function makeCtx(opts = {}) {
  const store = Object.assign(
    {
      settings: {
        // 让整套测试不需要真实等待：间隔全 0
        accept: 0.72,
        candidates: 4,
        concurrency: 2,
        searchGapMs: 0,
        retryDelayMs: 0,
        addBatchSize: 50,
        addBatchIntervalMs: 0,
        existingMaxPages: 4,
        renderLimit: 60,
        acceptLow: false,
        skipExisting: true,
        dedupeBatch: true
      }
    },
    opts.storage || {}
  )

  const pages = []
  const sidebarItems = []
  const settingsDefs = []
  const toasts = []
  const disposers = []
  const localCalls = []
  const netCalls = []
  const taskRegisters = []
  const logLines = []

  const script = opts.script || {}
  script.calls = localCalls
  script.handlers = script.handlers || {}

  const ctx = {
    vue: V,
    log: (...a) => logLines.push(a.map(String).join(' ')),
    storage: {
      get: (k) => store[k],
      set: (k, v) => {
        store[k] = v
      }
    },
    electron: {
      platform: 'win32',
      api: {
        async request(config) {
          localCalls.push({ url: config.url, params: config.params, data: config.data })
          if (typeof script.onCall === 'function') {
            const r = await script.onCall(config, localCalls.length - 1)
            if (r) return r
          }
          const h = script.handlers[config.url]
          if (typeof h === 'function') return await h(config, localCalls.length - 1)
          if (Array.isArray(h)) {
            const i = localCalls.filter((c) => c.url === config.url).length - 1
            return h[Math.min(i, h.length - 1)]
          }
          return { status: 200, headers: {}, body: okBody() }
        }
      }
    },
    net: {
      async request(config) {
        netCalls.push(config)
        if (typeof opts.netRequest === 'function') return await opts.netRequest(config, netCalls.length - 1)
        return { url: config.url, status: 200, statusText: 'OK', headers: {}, data: '' }
      },
      async fetch(url, init) {
        netCalls.push({ url, init, via: 'fetch' })
        return { ok: true, status: 200, url, text: async () => '', json: async () => ({}) }
      }
    },
    pinia: opts.pinia === undefined ? { state: { value: { user: { info: { userid: '91108302', token: 'tk' } }, device: { info: { dfid: 'd1' } } } } } : opts.pinia,
    toast: {
      info: (m) => toasts.push({ level: 'info', m }),
      success: (m) => toasts.push({ level: 'success', m }),
      warning: (m) => toasts.push({ level: 'warning', m }),
      danger: (m) => toasts.push({ level: 'danger', m })
    },
    kugouVerification: opts.kugouVerification,
    tasks: {
      register(def) {
        const rec = { def, updates: [], finishes: [], cancelled: false, dismissed: false, started: false }
        taskRegisters.push(rec)
        return {
          active: true,
          signal: { aborted: false },
          start(patch) {
            rec.started = true
            rec.startPatch = patch
            return true
          },
          update(patch) {
            rec.updates.push(patch)
            return true
          },
          finish(status, patch) {
            rec.finishes.push({ status, patch })
            return true
          },
          cancel() {
            rec.cancelled = true
          },
          dismiss() {
            rec.dismissed = true
          }
        }
      }
    },
    ui: {
      addPage: (def) => {
        pages.push(def)
        return () => {}
      },
      sidebar: {
        addItem: (def) => {
          sidebarItems.push(def)
          return () => {
            const i = sidebarItems.indexOf(def)
            if (i >= 0) sidebarItems.splice(i, 1)
          }
        }
      },
      settings: {
        define: (def) => {
          settingsDefs.push(def)
          return () => {}
        }
      },
      components: {}
    },
    dispose: (fn) => {
      disposers.push(fn)
      return fn
    }
  }

  return {
    ctx,
    store,
    pages,
    sidebarItems,
    settingsDefs,
    toasts,
    localCalls,
    netCalls,
    taskRegisters,
    logLines,
    runDisposers() {
      disposers.splice(0).forEach((fn) => {
        try {
          fn()
        } catch (e) {
          logLines.push('dispose 抛错：' + e.message)
        }
      })
    }
  }
}

/**
 * 加载插件（也用于变异测试往副本里注入改动）。
 *
 * ⚠️ 临时副本必须写到 `.workbuddy/tmp/` 下，**不要写在插件目录里**。
 * 理由：Windows 上 ESM 模块缓存持有文件句柄，副本删不掉（EBUSY）；
 * 而发布脚本会把**插件目录整个**镜像到远端 —— 残留在插件目录里的副本会被真的发出去。
 * 插件的单文件 ESM 没有任何相对 `import`，所以副本放在哪里都能正常加载。
 */
async function loadPlugin(entryPath) {
  const src = fs.readFileSync(entryPath, 'utf8')
  const dir = path.join(ROOT, '.workbuddy', 'tmp', 'pi-load')
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, 'pi-load-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs')
  fs.writeFileSync(tmp, src, 'utf8')
  return await import(pathToFileURL(tmp).href + '?t=' + Date.now())
}

/* ========================================================================== *
 * 引擎 / 匹配 用的轻量 deps
 * ========================================================================== */

function depsFromSeq(responses) {
  const calls = []
  return {
    calls,
    deps: {
      route: async (c, url, params) => {
        calls.push({ url, params })
        const i = calls.length - 1
        const r = responses[Math.min(i, responses.length - 1)]
        if (typeof r === 'function') return await r({ url, params })
        return r
      },
      isAborted: () => false,
      gapMs: 0,
      retryDelayMs: 0
    }
  }
}

function depsFromHandlers(handlers) {
  const calls = []
  return {
    calls,
    deps: {
      route: async (c, url, params, data) => {
        calls.push({ url, params, data })
        const h = handlers[url]
        if (typeof h === 'function') return await h({ url, params, data })
        return { status: 200, headers: {}, body: okBody() }
      },
      isAborted: () => false,
      gapMs: 0,
      retryDelayMs: 0,
      stats: { total: 0, byRoute: {}, retry: 0 }
    }
  }
}

function cand(hash, mixSongId, title, artist, albumId) {
  return {
    hash,
    title,
    artist,
    album: '专辑',
    duration: 240,
    albumId: albumId === undefined ? 100001 : albumId,
    mixSongId: mixSongId === undefined ? 900001 : mixSongId,
    audioId: 700001,
    privilege: 0,
    score: 0.95
  }
}

function rowOf(index, extTitle, extArtist, chosen, tier, score) {
  // tier 省略时按 chosen 推断：给了候选就是已匹配，没给就是未匹配。
  // 显式传 null 仍表示「未匹配」，别被默认值吃掉。
  const finalTier = tier === undefined ? (chosen ? 'success' : null) : tier
  return {
    index,
    external: { index, title: extTitle, artist: extArtist, album: '', duration: 240, externalId: '' },
    status: finalTier || 'unmatched',
    tier: finalTier,
    candidates: chosen ? [chosen] : [],
    chosen: chosen || null,
    score: score === undefined ? (chosen ? 0.95 : null) : score,
    keywords: [],
    searchError: '',
    manual: false,
    manualSkip: false,
    importStatus: '',
    importReason: ''
  }
}

/* ========================================================================== *
 * 测试主体
 * ========================================================================== */

const mod = await loadPlugin(PLUGIN_ENTRY)

/* ------------------------------------------------------- 1. 模块导出面 */

section('1. 模块导出面与常量')
for (const name of [
  'activate', 'deactivate', 'normalizeText', 'dice', 'scoreTitle', 'scoreArtist', 'scoreDuration',
  'scoreCandidate', 'matchTierOf', 'buildKeywords', 'splitArtists', 'durationSeconds', 'parsePlaylistText',
  'detectFormat', 'parseLabelLine', 'toCsv', 'resultRows', 'buildAddPayload', 'sanitizeField', 'chunkArray',
  'planImport', 'runImportEngine', 'matchOne', 'runPool', 'normalizeSearchItem', 'normalizeUserPlaylist',
  'pickMainHash', 'pickTrackArray', 'rawShape', 'cleanupTitle', 'normalizeCover', 'isTransientError',
  'verificationEventId', 'findFieldDeep', 'scalarOf', 'joinNames', 'artistOf', 'albumOf',
  'normalizeExternalTrack', 'findExternalTrackArray', 'findObjectDeep', 'extractJsonByBrace',
  'extractPayloadFromHtml', 'detectProvider', 'providerById', 'resolveLink', 'makePlaylist', 'songKeyOf',
  'candidateValue', 'candidateLabel', 'formatDuration', 'fmtScore', 'formatBytes', 'routeErrorText'
]) {
  ok(typeof mod[name] === 'function', '导出函数 ' + name)
}
eq(mod.PLUGIN_VERSION, '1.0.0', 'PLUGIN_VERSION 与 manifest 一致')
near(mod.DEFAULT_ACCEPT, 0.72, 1e-9, '默认接受阈值 0.72（对齐宿主实现）')
near(mod.LOW_SCORE, 0.55, 1e-9, '低置信下界 0.55')
eq(mod.ADD_BATCH_SIZE, 50, '加歌批大小 50（上游模块上限）')
eq(Array.isArray(mod.PROVIDERS), true, 'PROVIDERS 是数组')
eq(mod.PROVIDERS.length, 6, '注册了 6 个来源平台')
deepEq(
  mod.PROVIDERS.map((p) => p.id),
  ['netease', 'qqmusic', 'kuwo', 'kugou', 'spotify', 'qishui'],
  '平台 id 顺序稳定'
)

/* ------------------------------------------- 2. 文本归一化与相似度 */

section('2. 文本归一化与相似度')
eq(mod.normalizeText('告白气球 (Live版)'), '告白气球', '去括号内容')
eq(mod.normalizeText('Ｃｉｔｙ　Ｏｆ　Ｓｔａｒｓ'), 'city of stars', '全角转半角 + 全角空格')
eq(mod.normalizeText('起风了 feat. 某某'), '起风了 某某', '去掉 feat. 介词（随行人名留下，交给包含关系打分）')
eq(mod.normalizeText('光年之外（电影《太空旅客》推广曲）'), '光年之外', '去中文书名号括号')
eq(mod.normalizeText('Hello, World!'), 'hello world', '标点统一成空格')
eq(mod.normalizeText('  '), '', '空白归一为空串')

near(mod.dice('', ''), 0, 1e-9, 'dice 空串为 0')
near(mod.dice('abc', 'abc'), 1, 1e-9, 'dice 完全相同为 1')
ok(mod.dice('告白气球', '告白气球x') > 0.7, 'dice 高相似', { v: mod.dice('告白气球', '告白气球x') })
ok(mod.dice('告白气球', '完全不相干') < 0.2, 'dice 低相似', { v: mod.dice('告白气球', '完全不相干') })

  near(mod.scoreTitle('告白气球', '告白气球'), 1, 1e-9, '歌名完全相同 → 1')
  near(mod.scoreTitle('告白气球 (Live)', '告白气球'), 1, 1e-9, '括号后缀被归一掉 → 1')
  near(
    mod.scoreTitle('告白气球', mod.cleanupTitle('周杰伦 - 告白气球', '周杰伦')),
    1,
    1e-9,
    '「歌手 - 歌名」复合串先剥前缀 → 1（这是真实流水线：/privilege/lite 返回的就是这种）'
  )
  ok(mod.scoreTitle('告白气球', '告白气球 独唱') >= 0.92, '短标题被长标题包含且占比 ≥ 0.6 → 0.92 下限', {
    v: mod.scoreTitle('告白气球', '告白气球 独唱')
  })
  ok(mod.scoreTitle('告白气球', '告白气球 周杰伦 特别版') < 0.92, '包含但占比过低时不给下限', {
    v: mod.scoreTitle('告白气球', '告白气球 周杰伦 特别版')
  })
  ok(mod.scoreTitle('', '告白气球') === 0, '缺标题 → 0')

deepEq(mod.splitArtists('周杰伦 / 费玉清'), ['周杰伦', '费玉清'], '斜杠拆分歌手')
deepEq(mod.splitArtists('A、B & C'), ['a', 'b', 'c'], '顿号与 & 拆分并归一化')
eq(mod.splitArtists('').length, 0, '空歌手拆出空数组')

near(mod.scoreArtist('周杰伦', '周杰伦'), 1, 1e-9, '歌手完全相同 → 1')
near(mod.scoreArtist('周杰伦 / 费玉清', '费玉清'), 1, 1e-9, '多歌手里命中其一 → 1')
near(mod.scoreArtist('未知歌手', '周杰伦'), 0.5, 1e-9, '未知歌手给中性 0.5（不是 0）')
near(mod.scoreArtist('', '周杰伦'), 0.5, 1e-9, '歌手缺失给中性 0.5')
ok(mod.scoreArtist('周杰伦', '周杰伦 Jay') >= 0.85, '包含关系给 0.85 下限', {
  v: mod.scoreArtist('周杰伦', '周杰伦 Jay')
})

near(mod.scoreDuration(240, 240), 1, 1e-9, '时长相同 → 1')
near(mod.scoreDuration(240, 243), 1, 1e-9, '差 3 秒 → 1')
near(mod.scoreDuration(240, 247), 0.85, 1e-9, '差 7 秒 → 0.85')
near(mod.scoreDuration(240, 252), 0.55, 1e-9, '差 12 秒 → 0.55')
near(mod.scoreDuration(240, 268), 0.2, 1e-9, '差 28 秒 → 0.2')
near(mod.scoreDuration(240, 400), 0, 1e-9, '差太多 → 0')
eq(mod.scoreDuration(0, 240), null, '任一时长未知 → null（不当 0 分）')

/* --------------------------------------------- 3. 打分与档位 */

section('3. 三因子打分与档位')
{
  const ext = { title: '告白气球', artist: '周杰伦', duration: 215 }
  const exact = mod.scoreCandidate(ext, { title: '告白气球', artist: '周杰伦', duration: 215 })
  near(exact.total, 1, 1e-9, '完全一致 → 1.0')
  near(exact.title, 1, 1e-9, '标题分 1')
  near(exact.artist, 1, 1e-9, '歌手分 1')
  near(exact.duration, 1, 1e-9, '时长分 1')

  const noDuration = mod.scoreCandidate({ title: '告白气球', artist: '周杰伦', duration: 0 }, { title: '告白气球', artist: '周杰伦', duration: 215 })
  near(noDuration.total, 1, 1e-9, '时长未知时按剩余权重重归一化 → 仍为 1')
  eq(noDuration.duration, null, '未知时长在分解里是 null')

  // 时长未知不该把好的匹配打到阈值以下（权重重新归一化的意义）
  const partial = mod.scoreCandidate({ title: '告白气球', artist: '周杰伦', duration: 0 }, { title: '告白气球', artist: '别人', duration: 215 })
  ok(partial.total > 0.6, '时长未知 + 歌手不对 → 仍高于 0.6', { v: partial.total })

  const mismatch = mod.scoreCandidate(ext, { title: '完全不相干的歌', artist: '另一个人', duration: 100 })
  ok(mismatch.total < 0.4, '完全不相关 → 低于 0.4', { v: mismatch.total })

  eq(mod.matchTierOf(0.9, 0.72), 'success', '0.9 → success')
  eq(mod.matchTierOf(0.72, 0.72), 'success', '恰好等于阈值 → success')
  eq(mod.matchTierOf(0.7199, 0.72), 'low', '略低于阈值 → low')
  eq(mod.matchTierOf(0.55, 0.72), 'low', '等于低置信下界 → low')
  eq(mod.matchTierOf(0.5499, 0.72), null, '低于低置信下界 → 未匹配')
  eq(mod.matchTierOf(null, 0.72), null, 'null 分数 → 未匹配')
}

/* --------------------------------------------- 4. 关键词生成 */

section('4. 关键词生成（最多 3 个，按信息量排序）')
{
  const k = mod.buildKeywords({ title: '告白气球 (Live)', artist: '周杰伦 / 袁咏琳' })
  eq(k.length, 3, '最多 3 个关键词')
  eq(k[0], '告白气球 (Live) 周杰伦', '第一个 = 原标题 + 首位歌手')
  eq(k[1], '告白气球 周杰伦', '第二个 = 去括号标题 + 首位歌手')
  eq(k[2], '告白气球 (Live)', '第三个退化成只搜歌名')

  const k2 = mod.buildKeywords({ title: '起风了', artist: '' })
  deepEq(k2, ['起风了'], '无歌手时只搜歌名')

  const k3 = mod.buildKeywords({ title: '', artist: '周杰伦' })
  deepEq(k3, [], '无歌名时不生成关键词')

  const k4 = mod.buildKeywords({ title: 'A', artist: 'B feat. C' })
  eq(k4[0], 'A B', 'feat. 之后的歌手不进入首位')
}

/* --------------------------------------------- 5. 上游归一化 */

section('5. 上游归一化')
{
  eq(mod.durationSeconds(240000), 240, '毫秒 → 秒（>60000 判为毫秒）')
  eq(mod.durationSeconds(240), 240, '秒保持秒')
  eq(mod.durationSeconds(0), 0, '0 保持 0')
  eq(mod.durationSeconds('300'), 300, '字符串秒')
  eq(mod.durationSeconds(3600000), 3600, '一小时（3600000ms）→ 3600 秒')

  eq(mod.cleanupTitle('周杰伦 - 告白气球', '周杰伦'), '告白气球', '剥「歌手 - 歌名」前缀')
  eq(mod.cleanupTitle('A - B', 'A'), 'B', '恰好匹配才剥')
  eq(mod.cleanupTitle('A - B', 'C'), 'A - B', '歌手不一致不剥（避免误伤带连字符的歌名）')
  eq(mod.cleanupTitle('未知歌曲', '周杰伦'), '未知歌曲', '不误伤')

  eq(mod.normalizeCover('http://img.x/{size}.jpg'), 'https://img.x/400.jpg', '封面占位符替换 + http 升 https')
  eq(mod.normalizeCover(''), '', '空封面')

  // 酷狗搜索条目（大写字段名）
  const s = mod.normalizeSearchItem(
    searchItem(1, '告白气球', '周杰伦', { hash: 'ABCDEF0123456789ABCDEF0123456789' })
  )
  eq(s.hash, 'abcdef0123456789abcdef0123456789', 'hash 小写归一化（跨源去重的前提）')
  eq(s.title, '告白气球', '搜索条目歌名')
  eq(s.artist, '周杰伦', '搜索条目歌手')
  eq(s.albumId, 100001, 'albumId')
  eq(s.mixSongId, 900001, 'mixSongId')
  eq(s.duration, 240, 'Duration 毫秒 → 240 秒')
  ok(!mod.normalizeSearchItem({ SongName: 'x' }), '没有 hash 的条目被丢掉')

  // 嵌套在 song_info 里的歌名（精确键名 → 限深 BFS 兜底）
  const nested = mod.normalizeExternalTrack({ id: 7, song_info: { song_name: '嵌套歌名', author_name: '嵌套歌手' } })
  eq(nested.title, '嵌套歌名', '嵌套 song_name 被 BFS 兜底认出来')
  eq(nested.artist, '嵌套歌手', '嵌套 author_name 被认出来')

  // name 是对象时不能变成 [object Object]
  const arrArtist = mod.normalizeExternalTrack({ name: '歌', ar: [{ name: '甲' }, { name: '乙' }] })
  eq(arrArtist.artist, '甲 / 乙', 'ar 数组拼歌手')
  const objName = mod.normalizeExternalTrack({ name: '歌', album: { name: '专辑名' } })
  eq(objName.album, '专辑名', 'album 是对象时取 name，不产生 [object Object]')
  notIncludes(objName.title, '[object', '歌名里没有 [object Object]')

  // 时长/album 缺失
  const bare = mod.normalizeExternalTrack({ title: '只有歌名' })
  eq(bare.duration, 0, '缺时长 → 0（未知，不硬塞）')
  eq(bare.artist, '未知歌手', '缺歌手 → 未知歌手')

  // 原始形态上报
  const shape = mod.rawShape([{ SongName: 'A', SingerName: 'B' }])
  includes(shape.rawKeys, 'SongName', 'rawShape 报出原始键名')
  includes(shape.rawSnippet, 'SongName', 'rawShape 带截断 JSON')
  deepEq(mod.rawShape([]), { rawKeys: '', songKeys: '', rawSnippet: '' }, '空数组的 rawShape')

  // 数组挑选：带名称信息的数组优先于纯 hash 数组
  const picked = mod.pickTrackArray({
    data: {
      hashes: [{ hash: hashOf(11) }, { hash: hashOf(12) }],
      info: [searchItem(21, 'A', 'B'), searchItem(22, 'C', 'D')]
    }
  })
  eq(picked.length, 2, '挑到 2 条')
  eq(picked[0].SongName, 'A', '挑到的是带名称信息的那一份（不是纯 hash 列表）')

  // 主 hash 顺序
  eq(
    mod.pickMainHash({ hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', hash_320: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '主 hash 取 hash 而非 hash_320'
  )
  eq(mod.pickMainHash({ FileHash: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }), 'cccccccccccccccccccccccccccccccc', '回退到 FileHash')

  // 临时失败判别
  eq(mod.isTransientError('HTTP 502', 502, 0), true, '502 + error_code=0 判为临时失败')
  eq(mod.isTransientError('参数错误', 200, 20010), false, '业务错误不重试')
  eq(mod.isTransientError('net::ERR_CONNECTION_RESET', 502, 0), true, 'ERR_CONNECTION_RESET 判为临时失败')
  eq(mod.isTransientError('未匹配', 0, 0), false, '普通文案不是临时失败')
}

/* --------------------------------------------- 6. 本地文件解析 */

section('6. 本地文件解析（宿主不支持的那块缺口）')
{
  eq(mod.detectFormat('a.json', ''), 'json', '按扩展名 .json')
  eq(mod.detectFormat('a.m3u8', ''), 'm3u', '按扩展名 .m3u8')
  eq(mod.detectFormat('a.csv', ''), 'csv', '按扩展名 .csv')
  eq(mod.detectFormat('a.txt', ''), 'txt', '按扩展名 .txt')
  eq(mod.detectFormat('', '[{"name":"x"}]'), 'json', '无扩展名时靠内容嗅探 JSON')
  eq(mod.detectFormat('', '#EXTM3U\n#EXTINF:1,A - B'), 'm3u', '无扩展名时靠 #EXTM3U 嗅探')
  eq(mod.detectFormat('', '歌名,歌手\nA,B'), 'csv', '无扩展名时靠逗号嗅探 CSV')
  eq(mod.detectFormat('', '告白气球 - 周杰伦\n起风了 - 买辣椒也用券'), 'txt', '纯文本')

  // ---- 网易云导出（playlist.tracks，ar/al/dt）
  const neteaseExport = JSON.stringify({
    playlist: {
      name: '我喜欢的音乐',
      creator: { nickname: '某某' },
      coverImgUrl: 'http://p1.music.126.net/x.jpg',
      tracks: [
        { id: 3342319503, name: '明知故犯', ar: [{ name: 'Max李玄' }], al: { name: '失温' }, dt: 236000 },
        { id: 111, name: '第二首', ar: [{ name: '甲' }, { name: '乙' }], al: { name: '专辑二' }, dt: 200000 }
      ]
    }
  })
  const ne = mod.parsePlaylistText(neteaseExport, 'wo.json')
  eq(ne.sourceName, '本地文件', '文件导入来源名')
  eq(ne.name, '我喜欢的音乐', '网易云导出歌单名')
  eq(ne.creator, '某某', '网易云导出创建者')
  eq(ne.tracks.length, 2, '网易云导出 2 首')
  eq(ne.tracks[0].title, '明知故犯', '第一首歌名')
  eq(ne.tracks[0].artist, 'Max李玄', '第一首歌手')
  eq(ne.tracks[0].album, '失温', '第一首专辑')
  eq(ne.tracks[0].duration, 236, 'dt 毫秒 → 236 秒')
  eq(ne.tracks[1].artist, '甲 / 乙', '多歌手拼接')
  eq(ne.tracks[0].index, 1, '序号从 1 开始')
  includes(ne.coverUrl, 'https://', '封面 http 升 https')

  // ---- QQ 音乐导出（cdlist[0].songlist，singer/interval）
  const qqExport = JSON.stringify({
    cdlist: [
      {
        dissname: 'QQ歌单',
        nickname: '某人',
        logo: 'http://y.qq.com/x.jpg',
        songlist: [
          { songmid: 'abc', songname: '第一', singer: [{ name: 'A' }], albumname: '专辑A', interval: 245 },
          { songmid: 'def', songname: '第二', singer: [{ name: 'B' }], albumname: '专辑B', interval: 180 }
        ]
      }
    ]
  })
  const qq = mod.parsePlaylistText(qqExport, 'qq.json')
  eq(qq.name, 'QQ歌单', 'QQ 导出歌单名')
  eq(qq.tracks.length, 2, 'QQ 导出 2 首')
  eq(qq.tracks[0].title, '第一', 'QQ 歌名')
  eq(qq.tracks[0].artist, 'A', 'QQ 歌手')
  eq(qq.tracks[0].duration, 245, 'interval 是秒，不做换算')
  eq(qq.tracks[0].externalId, 'abc', 'QQ songmid 作为 externalId')

  // ---- 通用数组
  const generic = mod.parsePlaylistText(JSON.stringify([{ name: 'A', artist: 'B' }, { name: 'C', artist: 'D' }]), 'g.json')
  eq(generic.tracks.length, 2, '通用数组 2 首')
  eq(generic.name, 'g', '无歌单名时回退文件名')

  // ---- CSV 带表头
  const csv = '歌曲名,歌手,专辑,时长\n告白气球,周杰伦,周杰伦的床边故事,215\n起风了,买辣椒也用券,,325\n'
  const c1 = mod.parsePlaylistText(csv, 'x.csv')
  eq(c1.tracks.length, 2, 'CSV 带表头 2 首')
  eq(c1.tracks[0].title, '告白气球', 'CSV 表头映射歌名')
  eq(c1.tracks[0].artist, '周杰伦', 'CSV 表头映射歌手')
  eq(c1.tracks[0].album, '周杰伦的床边故事', 'CSV 表头映射专辑')
  eq(c1.tracks[0].duration, 215, 'CSV 时长')
  eq(c1.tracks[1].album, '', 'CSV 空单元格')

  // ---- CSV 英文表头 + 引号
  const csv2 = 'title,artist\n"歌, 带逗号","歌手"\n'
  const c2 = mod.parsePlaylistText(csv2, 'x.csv')
  eq(c2.tracks.length, 1, 'CSV 引号内逗号不当分隔符')
  eq(c2.tracks[0].title, '歌, 带逗号', 'CSV 引号内容保留')

  // ---- CSV 无表头
  const c3 = mod.parsePlaylistText('告白气球,周杰伦\n起风了,买辣椒也用券', 'x.csv')
  eq(c3.tracks.length, 2, 'CSV 无表头按「歌名, 歌手」处理')

  // ---- TXT
  const t1 = mod.parsePlaylistText('告白气球 - 周杰伦\n起风了 - 买辣椒也用券\n3. 光年之外 - 邓紫棋\n只写歌名', 'x.txt')
  eq(t1.tracks.length, 4, 'TXT 4 行 4 首')
  eq(t1.tracks[0].title, '告白气球', 'TXT 歌名')
  eq(t1.tracks[0].artist, '周杰伦', 'TXT 歌手')
  eq(t1.tracks[2].title, '光年之外', 'TXT 去掉序号前缀')
  eq(t1.tracks[3].artist, '未知歌手', '仅歌名时歌手回退为「未知歌手」（打分时按中性处理）')

  // ---- M3U
  const m3u = '#EXTM3U\n#EXTINF:215,周杰伦 - 告白气球\n/foo/bar.mp3\n#EXTINF:325,买辣椒也用券 - 起风了\n/baz.mp3\n'
  const m1 = mod.parsePlaylistText(m3u, 'x.m3u')
  eq(m1.tracks.length, 2, 'M3U 2 首')
  eq(m1.tracks[0].title, '周杰伦', 'M3U 约定「歌手 - 歌名」→ 左歌手右歌名')
  eq(m1.tracks[0].artist, '告白气球', 'M3U 右侧作为歌手')
  eq(m1.tracks[0].duration, 215, 'M3U #EXTINF 时长')

  // ---- 边界与错误
  ok(
    (() => {
      try {
        mod.parsePlaylistText('', '')
        return false
      } catch (e) {
        return /内容为空/.test(e.message)
      }
    })(),
    '空内容报「内容为空」'
  )
  ok(
    (() => {
      try {
        mod.parsePlaylistText('{bad json', 'x.json')
        return false
      } catch (e) {
        return /JSON 解析失败/.test(e.message)
      }
    })(),
    '坏 JSON 给出可读错误'
  )
  ok(
    (() => {
      try {
        mod.parsePlaylistText('{"a":1}', 'x.json')
        return false
      } catch (e) {
        return /没找到歌曲数组/.test(e.message)
      }
    })(),
    'JSON 里没有歌曲数组时给出可读错误'
  )

  deepEq(mod.parseLabelLine('A - B'), { title: 'A', artist: 'B' }, 'parseLabelLine 常规')
  deepEq(mod.parseLabelLine('只有歌名'), { title: '只有歌名', artist: '' }, 'parseLabelLine 无分隔符')
  deepEq(mod.parseLabelLine(' - B'), { title: '- B', artist: '' }, '分隔符在开头不当分隔符用（且整体 trim）')
}

/* --------------------------------------------- 7. 平台识别与链接解析 */

section('7. 平台识别与链接解析')
{
  eq((mod.detectProvider('https://music.163.com/#/playlist?id=1') || {}).id, 'netease', '识别网易云链接')
  eq((mod.detectProvider('https://y.qq.com/n/ryqq/playlist/123') || {}).id, 'qqmusic', '识别 QQ 音乐链接')
  eq((mod.detectProvider('https://www.kuwo.cn/playlist_detail/123') || {}).id, 'kuwo', '识别酷我链接')
  eq((mod.detectProvider('https://www.kugou.com/yy/special/single/123.html') || {}).id, 'kugou', '识别酷狗链接')
  eq((mod.detectProvider('https://open.spotify.com/playlist/abc') || {}).id, 'spotify', '识别 Spotify 链接')
  eq((mod.detectProvider('https://qishui.douyin.com/x') || {}).id, 'qishui', '识别汽水链接')
  eq(mod.detectProvider('https://example.com/x'), null, '不认识的链接返回 null')
  eq(mod.providerById('auto'), null, 'auto 不映射到具体平台')
  eq((mod.providerById('netease') || {}).id, 'netease', 'providerById 命中')

  // 未识别链接给出可操作文案
  const badCtx = makeCtx().ctx
  const r0 = await mod.resolveLink(badCtx, 'https://example.com/x', 'auto', {})
  eq(r0.ok, false, '未识别链接解析失败')
  includes(r0.error, '手动选择平台', '提示用户手动选平台')
  includes(r0.error, '网易云', '错误文案里列出支持的平台')

  // 空输入
  const r1 = await mod.resolveLink(badCtx, '', 'auto', {})
  eq(r1.ok, false, '空链接失败')
  includes(r1.error, '请先填入', '空链接文案')

  // 网易云（走 mock 网络，夹具结构照真实接口）
  const neScript = makeCtx({
    netRequest: async () => ({
      url: 'x',
      status: 200,
      headers: {},
      data: JSON.stringify({
        playlist: {
          id: 3778678,
          name: '热歌榜',
          creator: { nickname: '网易云音乐' },
          coverImgUrl: 'http://p1.music.126.net/c.jpg',
          tracks: [
            { id: 1, name: '歌一', ar: [{ name: '歌手一' }], al: { name: '专辑一' }, dt: 200000 },
            { id: 2, name: '歌二', ar: [{ name: '歌手二' }], al: { name: '专辑二' }, dt: 180000 }
          ],
          trackIds: [{ id: 1 }, { id: 2 }]
        }
      })
    })
  })
  const neRes = await mod.resolveLink(neScript.ctx, 'https://music.163.com/#/playlist?id=3778678', 'auto', {})
  eq(neRes.ok, true, '网易云链接解析成功')
  eq(neRes.providerId, 'netease', '命中 netease')
  eq(neRes.playlist.name, '热歌榜', '歌单名')
  eq(neRes.playlist.creator, '网易云音乐', '创建者')
  eq(neRes.playlist.tracks.length, 2, '2 首')
  eq(neRes.playlist.tracks[0].duration, 200, 'dt 换算成秒')
  eq(neScript.netCalls.length, 1, '只发了一次网络请求（trackIds 不超长时不需要补详情）')
  includes(neScript.netCalls[0].url, 'music.163.com', '请求打到网易云')

  // 网易云 tracks 被截断时用 trackIds 补详情
  const truncCtx = makeCtx({
    netRequest: async (config) => {
      if (/song\/detail/.test(config.url)) {
        return {
          url: config.url,
          status: 200,
          headers: {},
          data: JSON.stringify({ songs: [{ id: 9, name: '补回来的歌', ar: [{ name: 'X' }], al: { name: 'A' }, dt: 100000 }] })
        }
      }
      return {
        url: config.url,
        status: 200,
        headers: {},
        data: JSON.stringify({
          playlist: { name: '截断歌单', tracks: [], trackIds: [{ id: 9 }, { id: 10 }] }
        })
      }
    }
  })
  const trunc = await mod.resolveLink(truncCtx.ctx, 'https://music.163.com/playlist?id=1', 'netease', {})
  eq(trunc.ok, true, '截断歌单解析成功')
  eq(truncCtx.netCalls.length, 2, 'tracks 截断时补了一次 song/detail')
  includes(truncCtx.netCalls[1].url, 'song/detail', '补详情走 /api/v3/song/detail')
  includes(String(truncCtx.netCalls[1].body), 'c=', '补详情用表单提交 c=')

  // 私密/不存在
  const emptyCtx = makeCtx({ netRequest: async () => ({ url: 'x', status: 200, headers: {}, data: '{"playlist":null}' }) })
  const emptyRes = await mod.resolveLink(emptyCtx.ctx, 'https://music.163.com/playlist?id=1', 'netease', {})
  eq(emptyRes.ok, false, '空 playlist 判失败')
  includes(emptyRes.error, '私密歌单', '空 playlist 文案')

  // 酷我分页（两页，第二页不足 100 条即停）
  let kuwoPage = 0
  const kuwoCtx = makeCtx({
    netRequest: async () => {
      kuwoPage++
      const list =
        kuwoPage === 1
          ? Array.from({ length: 2 }, (_, i) => ({ rid: 100 + i, name: '酷我歌' + i, artist: '歌手', album: '专辑', duration: '200' }))
          : []
      return {
        url: 'x',
        status: 200,
        headers: {},
        data: JSON.stringify({ code: 200, data: { name: '酷我歌单', nickname: '某人', total: 2, musicList: list } })
      }
    }
  })
  const kuwoRes = await mod.resolveLink(kuwoCtx.ctx, 'https://www.kuwo.cn/playlist_detail/123', 'kuwo', {})
  eq(kuwoRes.ok, true, '酷我解析成功')
  eq(kuwoRes.playlist.name, '酷我歌单', '酷我歌单名')
  eq(kuwoRes.playlist.tracks.length, 2, '酷我 2 首')
  eq(kuwoRes.playlist.tracks[0].duration, 200, '酷我 duration 是秒')

  // 酷我 code != 200
  const kuwoBad = makeCtx({
    netRequest: async () => ({ url: 'x', status: 200, headers: {}, data: '{"code":-1,"msg":"未获取到歌单详情"}' })
  })
  const kuwoBadRes = await mod.resolveLink(kuwoBad.ctx, 'https://www.kuwo.cn/playlist_detail/1', 'kuwo', {})
  eq(kuwoBadRes.ok, false, '酷我 code!=200 判失败')
  includes(kuwoBadRes.error, '未获取到歌单详情', '带出上游原始文案')

  // 手动指定平台失败 → 报错里同时带上另一路的信息
  const multi = makeCtx({ netRequest: async () => ({ url: 'x', status: 200, headers: {}, data: '{"playlist":null}' }) })
  const multiRes = await mod.resolveLink(multi.ctx, 'https://music.163.com/playlist?id=1', 'qqmusic', {})
  eq(multiRes.ok, false, '手选错平台时失败')
  includes(multiRes.error, 'QQ 音乐', '错误里含手选的那一路')
  includes(multiRes.error, '网易云', '错误里也含自动识别出的那一路')

  // 没有网络通道时给明确文案
  const noNet = makeCtx()
  delete noNet.ctx.net.request
  const noNetRes = await mod.resolveLink(noNet.ctx, 'https://music.163.com/playlist?id=1', 'netease', {})
  eq(noNetRes.ok, false, '无网络通道时失败')
  includes(noNetRes.error, 'unrestrictedNetwork', '文案点名能力声明')

  // 汽水/Spotify 页面结构变更时给出可读错误
  const htmlCtx = makeCtx({ netRequest: async () => ({ url: 'x', status: 200, headers: {}, data: '<html><body>nothing</body></html>' }) })
  const htmlRes = await mod.resolveLink(htmlCtx.ctx, 'https://open.spotify.com/playlist/' + 'a'.repeat(22), 'spotify', {})
  eq(htmlRes.ok, false, '页面里没有 JSON 时报错')
  includes(htmlRes.error, '页面结构可能已变更', '文案点明页面结构变更')

  // extractJsonByBrace 要能跳过字符串里的花括号
  const braces = 'xx{"a":"}{","b":1}yy'
  const start = braces.indexOf('{')
  eq(mod.extractJsonByBrace(braces, start), '{"a":"}{","b":1}', '花括号配对跳过字符串内的括号')
}

/* --------------------------------------------- 8. 加歌 payload */

section('8. 加歌 payload 与字段清洗')
{
  eq(mod.sanitizeField('A,B'), 'A B', '逗号被清洗（否则会破坏复合串格式）')
  eq(mod.sanitizeField('A|B'), 'A B', '竖线被清洗')
  eq(mod.sanitizeField('  A   B  '), 'A B', '多余空白折成一个空格')
  eq(mod.sanitizeField('', 0), '', '空串')

  const payload = mod.buildAddPayload([
    { name: '告白气球', hash: 'h1', albumId: 11, mixSongId: 22 },
    { name: '起风了', hash: 'h2', albumId: 0, mixSongId: 33 }
  ])
  eq(payload, '告白气球|h1|11|22,起风了|h2|0|33', '复合串格式 name|hash|albumId|mixSongId，逗号分隔')
  eq(mod.buildAddPayload([]), '', '空列表空串')
  eq(mod.buildAddPayload([{ name: '缺字段', hash: 'h3' }]), '缺字段|h3|0|0', '缺 albumId/mixSongId 补 0')
  eq(mod.buildAddPayload([{ name: '', hash: 'h4', albumId: 1, mixSongId: 2 }]), '未知歌曲|h4|1|2', '空歌名兜底')

  deepEq(mod.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'chunkArray 分块')
  deepEq(mod.chunkArray([], 10), [], '空数组分块')
  eq(mod.chunkArray([1, 2, 3], 0).length, 3, '批大小 0 时退化为 1')

  // 55 首 → 50 + 5
  const big = Array.from({ length: 55 }, (_, i) => ({ name: 's' + i, hash: hashOf(500 + i), albumId: 1, mixSongId: 1 }))
  deepEq(mod.chunkArray(big, 50).map((b) => b.length), [50, 5], '55 首按 50 切成 2 批')
}

/* --------------------------------------------- 8b. 展示与导出格式 */

section('8b. 展示与导出格式')
{
  eq(mod.formatDuration(0), '', '时长为 0 显示空（不要显示 0:00）')
  eq(mod.formatDuration(65), '1:05', '秒补零')
  eq(mod.formatDuration(240), '4:00', '整分钟')
  eq(mod.formatDuration(3600), '60:00', '超过一小时按分钟累计')
  eq(mod.fmtScore(0.91234), '0.91', '分数保留 2 位')
  eq(mod.fmtScore(null), '-', 'null 分数显示 -')
  eq(mod.formatBytes(0), '0 B', '0 字节')
  eq(mod.formatBytes(512), '512 B', 'B 不进位')
  eq(mod.formatBytes(2048), '2.0 KB', 'KB 保留 1 位')
  eq(mod.formatBytes(9 * 1024 * 1024), '9.0 MB', 'MB')

  eq(mod.candidateValue({ hash: 'AB', mixSongId: 9 }), 'AB|9', '候选下拉值 = hash|mixSongId')
  includes(mod.candidateLabel({ score: 0.93, title: '告白气球', artist: '周杰伦', duration: 215 }), '0.93', '候选标签带分数')
  includes(mod.candidateLabel({ score: 0.93, title: '告白气球', artist: '周杰伦', duration: 215 }), '告白气球', '候选标签带歌名')
  includes(mod.candidateLabel({ score: 0.93, title: '告白气球', artist: '周杰伦', duration: 215 }), '3:35', '候选标签带时长')

  // resultRows 的字段投影
  const rr = mod.resultRows([
    {
      index: 1,
      external: { title: '外歌', artist: '外手', album: '外专', duration: 200 },
      chosen: { title: '内歌', artist: '内手', album: '内专' },
      score: 0.9512,
      tier: 'success',
      importStatus: 'added',
      importReason: ''
    }
  ])
  eq(rr.length, 1, 'resultRows 一行')
  eq(rr[0].externalTitle, '外歌', '外部歌名')
  eq(rr[0].externalDuration, '3:20', '外部时长已格式化')
  eq(rr[0].matchedTitle, '内歌', '匹配歌名')
  eq(rr[0].score, '0.951', '分数 3 位小数')
  eq(rr[0].tier, 'success', '档位')

  // CSV：BOM + 表头 + 转义
  const csv = mod.toCsv([
    {
      index: 1,
      external: { title: 'A, B', artist: 'C" D', album: '', duration: 0 },
      chosen: { title: '正常', artist: '正常', album: '' },
      score: 0.9,
      tier: 'success',
      importStatus: 'added',
      importReason: ''
    }
  ])
  ok(csv.charCodeAt(0) === 0xfeff, 'CSV 带 BOM（Excel 打开中文不乱码）')
  includes(csv, '序号,外部歌名,外部歌手,外部专辑,时长,匹配歌名,匹配歌手,匹配专辑,分数,档位,导入状态,原因', 'CSV 表头')
  includes(csv, '"A, B"', 'CSV 逗号字段被引号包裹')
  includes(csv, '"C"" D"', 'CSV 双引号转义成两个')
  includes(csv, '0.900', 'CSV 分数 3 位小数')
  eq(csv.split('\r\n').length, 2, 'CSV 表头 + 1 行（CRLF）')
  eq(mod.toCsv([]).split('\r\n').length, 1, '空结果只有表头')
}


/* --------------------------------------------- 9. 去重计划 */

section('9. 去重计划 planImport')
{
  const h1 = hashOf(601)
  const h2 = hashOf(602)
  const h3 = hashOf(603)

  // 全部成功
  {
    const rows = [
      rowOf(1, 'A', 'a', cand(h1, 901)),
      rowOf(2, 'B', 'b', cand(h2, 902))
    ]
    const plan = mod.planImport(rows, { acceptLow: false, skipExisting: true, dedupeBatch: true }, new Set())
    eq(plan.addable.length, 2, '两首都可导入')
    eq(plan.skipped, 0, '没有跳过')
  }

  // 批内重复（同一 mixSongId）—— 只留第一条，第二条给出"与第 N 首相同"
  {
    const rows = [
      rowOf(1, 'A', 'a', cand(h1, 901)),
      rowOf(2, 'A 重复', 'a', cand(h2, 901)),
      rowOf(3, 'B', 'b', cand(h3, 903))
    ]
    const plan = mod.planImport(rows, { dedupeBatch: true, acceptLow: false, skipExisting: false }, new Set())
    eq(plan.addable.length, 2, '批内重复折叠后 2 首')
    eq(plan.dupInBatch, 1, '记 1 条批内重复')
    eq(rows[1].importStatus, 'skipped', '被折叠的那条标 skipped')
    includes(rows[1].importReason, '与第 1 首', '原因里点出与第几首重复')
  }

  // 关掉批内去重就该全进
  {
    const rows = [rowOf(1, 'A', 'a', cand(h1, 901)), rowOf(2, 'A2', 'a', cand(h2, 901))]
    const plan = mod.planImport(rows, { dedupeBatch: false, acceptLow: false, skipExisting: false }, new Set())
    eq(plan.addable.length, 2, '关掉批内去重后两首都进')
  }

  // 目标歌单已有
  {
    const rows = [rowOf(1, 'A', 'a', cand(h1, 901)), rowOf(2, 'B', 'b', cand(h2, 902))]
    const plan = mod.planImport(rows, { skipExisting: true, dedupeBatch: true, acceptLow: false }, new Set([h1]))
    eq(plan.addable.length, 1, '目标歌单已有 1 首，只剩 1 首可导入')
    eq(plan.dupExisting, 1, '记 1 条目标已有')
    includes(rows[0].importReason, '已经有这首', '原因文案')
  }

  // 未匹配 / 低置信 / 手动跳过
  {
    const rows = [
      rowOf(1, '未匹配', 'a', null, null),
      rowOf(2, '低置信', 'a', cand(h1, 901), 'low', 0.6),
      rowOf(3, '手动跳过', 'a', cand(h2, 902), 'success'),
      rowOf(4, '正常', 'a', cand(h3, 903), 'success')
    ]
    rows[2].manualSkip = true
    const plan = mod.planImport(rows, { acceptLow: false, skipExisting: false, dedupeBatch: true }, new Set())
    eq(plan.addable.length, 1, '只有正常那条进')
    eq(plan.addable[0].index, 4, '进的是第 4 条')
    eq(rows[0].importStatus, 'skipped', '未匹配标 skipped')
    includes(rows[0].importReason, '未匹配', '未匹配原因')
    eq(rows[1].importStatus, 'skipped', '低置信默认不导入')
    includes(rows[1].importReason, '低置信', '低置信原因带分数')
    includes(rows[1].importReason, '0.60', '低置信原因里带实际分数')
    includes(rows[2].importReason, '手动跳过', '手动跳过原因')
  }

  // 勾了低置信就该进
  {
    const rows = [rowOf(1, '低置信', 'a', cand(h1, 901), 'low', 0.6)]
    const plan = mod.planImport(rows, { acceptLow: true, skipExisting: false, dedupeBatch: true }, new Set())
    eq(plan.addable.length, 1, '勾了「包含低置信」后低置信也导入')
  }

  // 搜索失败
  {
    const rows = [rowOf(1, 'X', 'a', null, null)]
    rows[0].searchError = '本次请求需要验证'
    const plan = mod.planImport(rows, { acceptLow: true, skipExisting: false, dedupeBatch: true }, new Set())
    eq(plan.addable.length, 0, '搜索失败的不导入')
    includes(rows[0].importReason, '本次请求需要验证', '把上游错误带进原因')
  }

  // 匹配结果缺 hash
  {
    const rows = [rowOf(1, 'X', 'a', { hash: '', mixSongId: 1, title: 'x', artist: 'y' }, 'success')]
    const plan = mod.planImport(rows, { acceptLow: true, skipExisting: false, dedupeBatch: true }, new Set())
    eq(plan.addable.length, 0, '缺 hash 的不导入')
    includes(rows[0].importReason, 'hash', '缺 hash 的原因')
  }

  // songKeyOf：歌曲级身份优先用 mixSongId
  eq(mod.songKeyOf({ mixSongId: 42, hash: h1 }), 'm42', 'songKey 优先 mixSongId')
  eq(mod.songKeyOf({ mixSongId: 0, hash: 'AB' }), 'hAB'.toLowerCase(), '没有 mixSongId 时用 hash')
  eq(mod.songKeyOf({ mixSongId: 0, hash: h1 }), 'h' + h1, 'hash 保持原样（调用方已小写归一）')
}

/* --------------------------------------------- 10. 导入引擎（端到端） */

section('10. 导入引擎（mock 本地路由）')
{
  const engineCtx = { electron: { api: { request: async () => ({ status: 200, body: okBody() }) } } }
  const h = {
    '/playlist/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0, data: { listid: 555 } } }),
    '/playlist/tracks/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0 } }),
    '/playlist/track/all/new': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0, data: { info: [] } } }),
    '/user/playlist': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0, data: [] } })
  }

  // 基本：新建歌单 + 一批写 2 首
  {
    const { calls, deps } = depsFromHandlers(h)
    const rows = [rowOf(1, 'A', 'a', cand(hashOf(701), 901)), rowOf(2, 'B', 'b', cand(hashOf(702), 902))]
    const events = []
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      playlistName: '我的导入',
      target: { mode: 'new', name: '我的导入', listid: 0, gid: '' },
      options: { acceptLow: false, skipExisting: false, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0 },
      deps,
      onEvent: (e) => events.push(e)
    })
    eq(res.ok, true, '引擎返回 ok')
    eq(res.phase, 'done', '阶段 done')
    eq(res.summary.added, 2, '写入 2 首')
    eq(res.summary.targetName, '我的导入', '目标歌单名回填')
    eq(res.summary.listid, 555, '回填新建歌单 id')
    eq(calls.filter((c) => c.url === '/playlist/add').length, 1, '建歌单请求 1 次')
    const addCalls = calls.filter((c) => c.url === '/playlist/tracks/add')
    eq(addCalls.length, 1, '加歌请求 1 次')
    eq(addCalls[0].params.listid, 555, '加歌带正确 listid')
    includes(addCalls[0].params.data, '|', '加歌 data 是复合串')
    eq(rows[0].importStatus, 'added', '第 1 行标 added')
    eq(rows[1].importStatus, 'added', '第 2 行标 added')
    ok(events.some((e) => e.type === 'phase' && e.phase === 'target'), '有 target 阶段事件')
    ok(events.some((e) => e.type === 'target' && e.listid === 555), '有 target 事件')
    ok(events.some((e) => e.type === 'planned'), '有 planned 事件')
    ok(events.some((e) => e.type === 'progress' && e.done === 2), '有 done=2 的进度事件')
    ok(res.summary.elapsedMs >= 0, '带耗时')
  }

  // 55 首跨批
  {
    const { calls, deps } = depsFromHandlers(h)
    const rows = Array.from({ length: 55 }, (_, i) => rowOf(i + 1, 'S' + i, 'a', cand(hashOf(710 + i), 1000 + i)))
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      target: { mode: 'new', name: '大批', listid: 0, gid: '' },
      options: { skipExisting: false, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0 },
      deps
    })
    eq(res.summary.added, 55, '55 首全部写入')
    const addCalls = calls.filter((c) => c.url === '/playlist/tracks/add')
    eq(addCalls.length, 2, '按 50 切成 2 批')
    eq(addCalls[0].params.data.split(',').length, 50, '第一批 50 首')
    eq(addCalls[1].params.data.split(',').length, 5, '第二批 5 首')
  }

  // 已有歌曲去重
  {
    const existingHash = hashOf(720)
    const hh = Object.assign({}, h, {
      '/playlist/track/all/new': () => ({
        status: 200,
        headers: {},
        body: { status: 1, error_code: 0, data: { info: [{ hash: existingHash }] } }
      })
    })
    const { calls, deps } = depsFromHandlers(hh)
    const rows = [rowOf(1, 'A', 'a', cand(existingHash, 901)), rowOf(2, 'B', 'b', cand(hashOf(721), 902))]
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      target: { mode: 'new', name: 'X', listid: 0, gid: '' },
      options: { skipExisting: true, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0, existingMaxPages: 4 },
      deps
    })
    eq(res.summary.added, 1, '已有的那首没重复写')
    eq(res.summary.dupExisting, 1, '记 1 条目标已有')
    eq(rows[0].importStatus, 'skipped', '已有那首标 skipped')
    ok(calls.some((c) => c.url === '/playlist/track/all/new'), '去重时读了目标歌单歌曲')
  }

  // 写入失败 → 整批标 failed 且带原因
  {
    const hh = Object.assign({}, h, {
      '/playlist/tracks/add': () => ({ status: 502, headers: {}, body: { status: 0, error_code: 20010, error: '服务繁忙' } })
    })
    const { deps } = depsFromHandlers(hh)
    const rows = [rowOf(1, 'A', 'a', cand(hashOf(730), 901))]
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      target: { mode: 'new', name: 'X', listid: 0, gid: '' },
      options: { skipExisting: false, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0 },
      deps
    })
    eq(res.summary.failed, 1, '失败计数 1')
    eq(rows[0].importStatus, 'failed', '行标 failed')
    includes(rows[0].importReason, '服务繁忙', '失败原因带上游文案')
  }

  // 建歌单失败 → 直接返回错误，不做加歌
  {
    const hh = Object.assign({}, h, {
      '/playlist/add': () => ({ status: 502, headers: {}, body: { status: 0, error_code: 20010, error: '歌单数量已达上限' } })
    })
    const { calls, deps } = depsFromHandlers(hh)
    const rows = [rowOf(1, 'A', 'a', cand(hashOf(731), 901))]
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      target: { mode: 'new', name: 'X', listid: 0, gid: '' },
      options: { skipExisting: false, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0 },
      deps
    })
    eq(res.ok, false, '建歌单失败时 ok=false')
    includes(res.summary.error, '创建歌单失败', '错误文案')
    includes(res.summary.error, '歌单数量已达上限', '带上游文案')
    eq(calls.filter((c) => c.url === '/playlist/tracks/add').length, 0, '建歌单失败后不加歌')
  }

  // 没有可导入的 → 不建歌单也不加歌
  {
    const { calls, deps } = depsFromHandlers(h)
    const rows = [rowOf(1, '未匹配', 'a', null, null)]
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      target: { mode: 'new', name: '空', listid: 0, gid: '' },
      options: { skipExisting: false, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0 },
      deps
    })
    eq(res.ok, true, '没有可导入时仍算成功')
    eq(res.summary.added, 0, '写入 0 首')
    eq(calls.filter((c) => c.url === '/playlist/tracks/add').length, 0, '没有可导入时不加歌')
  }

  // 已有歌单目标
  {
    const { calls, deps } = depsFromHandlers(h)
    const rows = [rowOf(1, 'A', 'a', cand(hashOf(740), 901))]
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      target: { mode: 'existing', name: '我喜欢的音乐', listid: 88, gid: '' },
      options: { skipExisting: false, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0 },
      deps
    })
    eq(res.summary.added, 1, '导入到已有歌单')
    eq(calls.filter((c) => c.url === '/playlist/add').length, 0, '导入到已有歌单时不新建')
    const addCalls = calls.filter((c) => c.url === '/playlist/tracks/add')
    eq(addCalls[0].params.listid, 88, '写到指定的 listid')
  }

  // 中止：在加歌前中止 → 不写任何东西
  {
    const { calls, deps } = depsFromHandlers(h)
    const rows = [rowOf(1, 'A', 'a', cand(hashOf(750), 901))]
    const res = await mod.runImportEngine({
      ctx: engineCtx,
      rows,
      target: { mode: 'existing', name: 'X', listid: 88, gid: '' },
      options: { skipExisting: false, dedupeBatch: true, addBatchSize: 50, addBatchIntervalMs: 0 },
      deps,
      isAborted: () => true
    })
    eq(res.phase, 'aborted', '中止时 phase=aborted')
    eq(calls.filter((c) => c.url === '/playlist/tracks/add').length, 0, '中止后没有写库')
  }

  // 没有本地路由时给明确文案
  {
    const { deps } = depsFromHandlers(h)
    const res = await mod.runImportEngine({
      ctx: {},
      rows: [],
      target: { mode: 'new', name: 'X', listid: 0, gid: '' },
      options: {},
      deps
    })
    eq(res.ok, false, '没有本地路由时失败')
    includes(res.summary.error, '本地路由', '文案点明本地路由')
  }

  // routeErrorText 的三条判别式
  eq(mod.routeErrorText({ error_code: 0 }, { status: 502 }), 'HTTP 502', 'error_code=0 时不查错误码表，退回 HTTP 状态')
  eq(mod.routeErrorText({ error_code: 20018, msg: '' }, { status: 200 }), '酷狗返回错误码 20018', '有错误码且无文案时用错误码')
  eq(mod.routeErrorText({ error_code: 20018, error: 'token 失效' }, { status: 200 }), 'token 失效', '上游文案优先')
}

/* --------------------------------------------- 11. 重试与风控判定 */

section('11. 搜索重试与风控判定')
{
  // 临时失败 → 重试一次；重试成功
  {
    const seq = depsFromSeq([transientFail(), envelope(searchBody([searchItem(1, '告白气球', '周杰伦')]))])
    seq.deps.stats = { total: 0, byRoute: {}, retry: 0 }
    const r = await mod.matchOne(
      {},
      { title: '告白气球', artist: '周杰伦', duration: 240 },
      { accept: 0.72, pageSize: 3 },
      seq.deps
    )
    eq(seq.calls.length, 2, '临时失败后重试了一次（共 2 次请求）')
    eq(seq.deps.stats.retry, 1, '重试计数 1')
    eq(r.tier, 'success', '重试后匹配成功')
    eq(seq.calls[0].params.keywords, '告白气球 周杰伦', '第一个关键词')
    eq(seq.calls[0].params.type, 'song', 'search 路由带 type=song')
  }

  // 业务错误 → 不重试（每个关键词各请求一次）
  {
    const seq = depsFromSeq([() => bizFail(20010, '参数错误')])
    seq.deps.stats = { total: 0, byRoute: {}, retry: 0 }
    const r = await mod.matchOne({}, { title: 'x', artist: 'y', duration: 0 }, { accept: 0.72, pageSize: 3 }, seq.deps)
    eq(seq.calls.length, 2, '业务错误不重试：「x y」和「x」两个关键词各一次（不重试）')
    eq(seq.deps.stats.retry, 0, '没有发生重试')
    eq(r.tier, null, '业务错误时判定未匹配')
    eq(r.keywords.length, 2, '无括号的歌名只生成 2 个关键词')
    includes(r.error, '参数错误', '把上游错误文案带出来')
  }

  // 提前收手：第一个关键词就够好就不再搜后面
  {
    const seq = depsFromSeq([envelope(searchBody([searchItem(1, '告白气球', '周杰伦')]))])
    const r = await mod.matchOne(
      {},
      { title: '告白气球', artist: '周杰伦', duration: 240 },
      { accept: 0.72, pageSize: 3 },
      seq.deps
    )
    eq(seq.calls.length, 1, '达到阈值就提前收手（shouldStopEarly）')
    eq(r.keywords.length, 2, '无括号歌名生成 2 个关键词，并完整汇报')
    eq(r.tried.length, 1, '实际只试了 1 个关键词')
    eq(r.candidates.length, 1, '候选池 1 个')
    eq(r.chosen.hash, hashOf(1), '选中正确的候选')
  }

  // 低置信：分数在 0.55~阈值之间
  {
    const seq = depsFromSeq([
      envelope(
        searchBody([searchItem(2, '告白气球（翻自 周杰伦）', '别人的翻唱', { durationMs: 300000, albumId: 5, mixSongId: 6 })])
      )
    ])
    const r = await mod.matchOne(
      {},
      { title: '告白气球', artist: '周杰伦', duration: 240 },
      { accept: 0.72, pageSize: 3 },
      seq.deps
    )
    eq(r.tier, 'low', '相似但不完全一致 → 低置信')
    ok(r.score >= 0.55 && r.score < 0.72, '分数落在低置信区间', { score: r.score })
  }

  // 风控 eventId 判定（KG-07 的两个易错细节）
  eq(
    mod.verificationEventId({ headers: { 'ssa-code': 'ev1' }, body: { status: 0, error_code: 20028 } }),
    'ev1',
    '失败 + 20028 → 返回 eventId'
  )
  eq(
    mod.verificationEventId({ headers: {}, body: { detail: 1, status: 0, error_code: 20028, ssaCode: 'ev2' } }),
    'ev2',
    '从 body.ssaCode 取 eventId'
  )
  eq(
    mod.verificationEventId({ headers: {}, body: { status: 0, data: { event_id: 'ev3' } } }),
    'ev3',
    '从 body.data.event_id 取 eventId'
  )
  eq(
    mod.verificationEventId({ headers: { 'ssa-code': 'ev1' }, body: { status: 1, error_code: 0 } }),
    '',
    '成功响应里带 ssa-code **不**弹窗（只是提示二次验证）'
  )
  eq(mod.verificationEventId({ headers: {}, body: { status: 0, error_code: 20010 } }), '', '非 20028 且有错码 → 不弹窗')
  eq(mod.verificationEventId(null), '', 'null 安全')
  eq(mod.verificationEventId({ headers: {}, body: {} }), '', '无事件 → 空')
}

/* --------------------------------------------- 12. activate 与任务中心 */

section('12. activate 注册项与任务中心')
{
  const hh = {
    '/search': (c) => {
      const kw = String((c.params && c.params.keywords) || '')
      if (kw.includes('告白气球')) return { status: 200, headers: {}, body: searchBody([searchItem(1, '告白气球', '周杰伦')]) }
      if (kw.includes('起风了')) return { status: 200, headers: {}, body: searchBody([searchItem(2, '起风了', '买辣椒也用券')]) }
      return { status: 200, headers: {}, body: searchBody([]) }
    },
    '/playlist/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0, data: { listid: 777 } } }),
    '/playlist/tracks/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0 } }),
    '/playlist/track/all/new': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0, data: { info: [] } } }),
    '/user/playlist': () => ({
      status: 200,
      headers: {},
      body: { status: 1, error_code: 0, data: [{ listid: 11, name: '我喜欢的音乐', count: 5, source: 0 }] }
    })
  }

  const t = makeCtx({ script: { handlers: hh } })
  const inst = await mod.activate(t.ctx)

  eq(t.pages.length, 1, '注册了 1 个页面')
  eq(t.pages[0].id, 'main', '页面 id 是 main')
  eq(t.pages[0].title, '歌单导入增强', '页面标题')
  eq(t.sidebarItems.length, 1, '注册了 1 个侧边栏入口')
  eq(t.sidebarItems[0].pageId, 'main', '入口指向 main 页')
  eq(t.sidebarItems[0].section, 'plugins', '入口落在 plugins 分组')
  eq(t.settingsDefs.length, 1, '注册了 1 个设置面板')
  ok(!!inst._internals, 'activate 返回内部句柄（供测试驱动）')

  const render = await setupRender(t.pages[0].component)
  let tree = render()
  eq(findByRole(tree, 'page').length, 1, '页面根节点存在')
  eq(textOf(findByRole(tree, 'version')[0]), 'v' + mod.PLUGIN_VERSION, '页面显示版本号')
  eq(findByRole(tree, 'tab').length, 3, '三个来源 tab')
  eq(findByRole(tree, 'platform').length, 7, '平台 chip 数 = 自动识别 + 6 个平台')
  ok(!!findByRole(tree, 'playlist-empty')[0], '未读歌单时显示空状态')
  ok(!!findByRole(tree, 'preview-empty')[0], '未匹配时显示空状态')

  // --- 走一遍完整流程：粘贴 → 解析 → 匹配预演 → 导入
  const readTree = () => render()

  // 默认在「链接」tab，先切到「粘贴文本」（vnode 会捕获渲染时的状态，必须切完再取）
  await findByRole(readTree(), 'tab').find((n) => n.props['data-mode'] === 'paste').props.onClick()
  await settle()

  const pasteNode = findByRole(readTree(), 'paste-input')[0]
  eq(pasteNode.props['data-role'], 'paste-input', '找到粘贴输入框')
  pasteNode.props.onInput({ target: { value: '告白气球 - 周杰伦\n起风了 - 买辣椒也用券\n不存在的歌 - 无人' } })
  await settle()

  await click(readTree(), 'data-action', 'parse-text')
  await settle()
  tree = readTree()
  eq(textOf(findByRole(tree, 'playlist-count')[0]), '3', '解析出 3 首')
  includes(textOf(findByRole(tree, 'playlist-name')[0]), '粘贴的歌单', '歌单名回退为「粘贴的歌单」')
  eq(t.localCalls.length, 0, '解析本地文本不发任何请求')

  // 匹配预演
  await click(readTree(), 'data-action', 'match')
  await settle()
  tree = readTree()
  const rows = findByRole(tree, 'row')
  eq(rows.length, 3, '预演表 3 行')
  eq(t.localCalls.filter((c) => c.url === '/search').length, 4, '搜索请求数：前两首各 1 次 + 第三首试 3 个关键词共 4 次')
  includes(textOf(findByRole(tree, 'plan-stats')[0]), '已匹配 2', '汇总显示已匹配 2 首')
  includes(textOf(findByRole(tree, 'plan-stats')[0]), '未匹配 1', '汇总显示未匹配 1 首')
  eq(rows[0].props['data-status'], 'success', '第 1 行状态 success')
  eq(rows[1].props['data-status'], 'success', '第 2 行状态 success')
  eq(rows[2].props['data-status'], 'unmatched', '第 3 行状态 unmatched')
  eq(findByRole(tree, 'row-select').length, 3, '每行一个候选下拉')

  // 第 1 行的下拉里应有「（不导入）」「候选」「跳过这首」
  const sel0 = findByRole(tree, 'row-select')[0]
  const opts = findAll(sel0, (n) => !n.__textVNode && typeof n.type === 'string' && n.type === 'option')
  ok(opts.length >= 3, '下拉至少 3 个选项', { n: opts.length })

  // 人工改选：把第 1 首改成「跳过这首」
  const selNode = findByRole(readTree(), 'row-select')[0]
  await selNode.props.onChange({ target: { value: '__skip__' } })
  await settle()
  tree = readTree()
  eq(findByRole(tree, 'row')[0].props['data-status'], 'skipped', '手动跳过后该行变 skipped')

  // 改回来（选回原候选），否则后面导入只剩 1 首
  const selNode2 = findByRole(readTree(), 'row-select')[0]
  const backValue = mod.candidateValue(inst._internals.state.rows[0].candidates[0])
  await selNode2.props.onChange({ target: { value: backValue } })
  await settle()
  tree = readTree()
  eq(findByRole(tree, 'row')[0].props['data-status'], 'success', '人工改选候选后状态回到 success')

  // --- 开始导入
  await click(readTree(), 'data-action', 'start-import')
  await settle()
  tree = readTree()
  eq(t.localCalls.filter((c) => c.url === '/playlist/add').length, 1, '建了 1 个歌单')
  const addCalls = t.localCalls.filter((c) => c.url === '/playlist/tracks/add')
  eq(addCalls.length, 1, '加歌 1 批')
  eq(addCalls[0].params.listid, 777, '写到新建的 listid')
  includes(addCalls[0].params.data, '告白气球', 'payload 含第一首')
  includes(addCalls[0].params.data, '起风了', 'payload 含第二首')
  notIncludes(addCalls[0].params.data, '不存在的歌', '未匹配的那首没被写进去')
  eq(addCalls[0].params.data.split(',').length, 2, 'payload 是 2 条')

  const summaryText = textOf(findByRole(tree, 'summary')[0])
  includes(summaryText, '2', '汇总里有成功数')
  eq(inst._internals.state.summary.added, 2, 'summary.added = 2')
  eq(inst._internals.state.summary.skipped, 1, 'summary.skipped = 1')
  ok(t.toasts.some((x) => x.level === 'success'), '成功 toast')

  // --- 任务中心
  eq(t.taskRegisters.length, 1, '注册了 1 个任务中心条目')
  const taskDef = t.taskRegisters[0].def
  eq(taskDef.id, 'playlist-importer:import', '任务 id')
  ok(!String(taskDef.id).startsWith('echo:'), '任务 id 不以 echo: 开头（宿主保留前缀）')
  includes(taskDef.name, '导入歌单', '任务标题')
  ok(!!taskDef.retention, 'retention 必填（漏了宿主会抛「保留策略无效」）')
  ok(!!taskDef.retention.completed && !!taskDef.retention.error && !!taskDef.retention.aborted, 'retention 三段都给了')
  eq(taskDef.retention.completed.mode, 'auto', 'completed 自动收起')
  eq(taskDef.retention.error.mode, 'manual', 'error 常驻等用户关')
  eq(taskDef.retention.aborted.mode, 'auto', 'aborted 自动收起')
  ok(Array.isArray(taskDef.actions) && taskDef.actions.length >= 1, '任务带操作按钮')
  eq(taskDef.actions[0].id, 'cancel', '任务带「停止」')
  eq(t.taskRegisters[0].started, true, '任务被 start 过')
  ok(t.taskRegisters[0].updates.length >= 1, '任务进度被 update 过')
  eq(t.taskRegisters[0].finishes.length, 1, '任务被 finish 一次')
  eq(t.taskRegisters[0].finishes[0].status, 'completed', '任务以 completed 收尾')

  // --- 用户歌单列表
  await click(readTree(), 'data-action', 'refresh-playlists')
  await settle()
  eq(inst._internals.state.playlists.length, 1, '拉到 1 个用户歌单')
  eq(inst._internals.state.playlists[0].name, '我喜欢的音乐', '歌单名')

  // --- 目标改成已有歌单
  const modeBtns = findByRole(readTree(), 'target-mode')
  eq(modeBtns.length, 2, '两个目标模式按钮')
  await modeBtns.find((n) => n.props['data-target'] === 'existing').props.onClick()
  await settle()
  tree = readTree()
  ok(!!findByRole(tree, 'target-playlist')[0], '切到已有歌单后出现目标下拉')
  await findByRole(readTree(), 'target-playlist')[0].props.onChange({ target: { value: '11' } })
  await settle()
  eq(inst._internals.state.target.listid, 11, '选中目标歌单 listid')
  // 切回新建并验证重名提示
  await findByRole(readTree(), 'target-mode').find((n) => n.props['data-target'] === 'new').props.onClick()
  await settle()
  const nameInput = findByRole(readTree(), 'new-name')[0]
  await nameInput.props.onInput({ target: { value: '我喜欢的音乐' } })
  await settle()
  ok(!!findByRole(readTree(), 'name-conflict')[0], '启用重名提示')

  // --- 诊断
  const diag = findByRole(readTree(), 'diag')[0]
  const diagText = textOf(diag)
  includes(diagText, 'playlist-importer', '诊断含插件 id')
  includes(diagText, 'accept', '诊断含匹配阈值')
  includes(diagText, 'hasHostApi', '诊断含环境探测结果')
  ok(!!findByProp(readTree(), 'data-action', 'copy-diag')[0], '有复制诊断按钮')

  // --- 设置面板
  const sTree = (await setupRender(t.settingsDefs[0].component))()
  const numFields = findAll(sTree, (n) => !n.__textVNode && n.props && n.props.type === 'number')
  eq(numFields.length, 9, '设置面板 9 个数字项')
  ok(!!findByProp(sTree, 'data-setting', 'accept')[0], '有匹配阈值设置')
  ok(!!findByProp(sTree, 'data-setting', 'acceptLow')[0], '有「包含低置信」开关')
  // 设置面板与页面快捷开关联动
  await findByProp(sTree, 'data-setting', 'acceptLow')[0].props.onClick()
  await settle()
  eq(inst._internals.settings.acceptLow, true, '设置面板开了开关')
  eq(inst._internals.state.options.acceptLow, true, '页面快捷开关同步')
  eq(t.store.settings.acceptLow, true, '落到 ctx.storage')

  // 数值设置越界会被夹住
  await findByProp(sTree, 'data-setting', 'addBatchSize')[0].props.onChange({ target: { value: '999' } })
  await settle()
  eq(inst._internals.settings.addBatchSize, 50, '批大小夹到上限 50')
  await findByProp(sTree, 'data-setting', 'accept')[0].props.onChange({ target: { value: '0.1' } })
  await settle()
  eq(inst._internals.settings.accept, 0.5, '阈值夹到下限 0.5')

  // 页面上的开关也写回设置
  await click(readTree(), 'data-action', 'dedupeBatch')
  await settle()
  eq(inst._internals.settings.dedupeBatch, false, '页面开关写回设置')
  await click(readTree(), 'data-action', 'dedupeBatch')
  await settle()
  eq(inst._internals.settings.dedupeBatch, true, '再点一次恢复')

  // --- 导出（stub 掉 DOM 三件套，验证真的触发了下载）
  {
    const origDoc = globalThis.document
    const origURL = globalThis.URL
    const origBlob = globalThis.Blob
    const clicked = []
    globalThis.Blob = class {
      constructor(parts) {
        this.parts = parts
      }
    }
    globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
    globalThis.document = {
      createElement: () => ({
        style: {},
        set download(v) {
          this._d = v
        },
        get download() {
          return this._d
        },
        click() {
          clicked.push(this._d)
        },
        remove() {}
      }),
      body: { appendChild: () => {} }
    }
    await click(readTree(), 'data-action', 'export-csv')
    await settle()
    ok(clicked.length === 1, '点了导出 → 触发一次下载', { clicked })
    includes(clicked[0], '.csv', 'CSV 文件名')
    await click(readTree(), 'data-action', 'export-json')
    await settle()
    eq(clicked.length, 2, '导出 JSON 再触发一次')
    includes(clicked[1], '.json', 'JSON 文件名')
    globalThis.document = origDoc
    globalThis.URL = origURL
    globalThis.Blob = origBlob
  }

  // --- 只重试失败项
  inst._internals.state.rows[1].importStatus = 'failed'
  await click(readTree(), 'data-action', 'retry-failed')
  await settle()
  eq(inst._internals.state.rows[0].manualSkip, true, '重试失败项时把成功项标成跳过')
  eq(inst._internals.state.rows[1].manualSkip, false, '失败项保持可导入')

  // --- 文件导入（先切到「本地文件」tab，文件输入框只在那个面板里渲染）
  {
    await findByRole(readTree(), 'tab').find((n) => n.props['data-mode'] === 'file').props.onClick()
    await settle()
    const file = {
      name: '我的歌单.json',
      size: 200,
      text: async () =>
        JSON.stringify({ playlist: { name: '文件歌单', tracks: [{ id: 1, name: '文件歌一', ar: [{ name: 'A' }], al: { name: 'B' }, dt: 100000 }] } })
    }
    const fileInput = findByRole(readTree(), 'file-input')[0]
    ok(!!fileInput, '存在文件输入')
    await fileInput.props.onChange({ target: { files: [file] } })
    await settle()
    eq(inst._internals.state.fileName, '我的歌单.json', '记录文件名')
    eq(inst._internals.state.playlist.tracks.length, 1, '文件解析出 1 首')
    eq(inst._internals.state.playlist.tracks[0].title, '文件歌一', '文件歌名')
    eq(inst._internals.state.playlist.name, '文件歌单', '文件里的歌单名')
    eq(inst._internals.state.mode, 'file', '停留在文件模式')
  }

  // --- 文件过大
  {
    const big = { name: 'big.json', size: 9 * 1024 * 1024, text: async () => '{}' }
    await findByRole(readTree(), 'file-input')[0].props.onChange({ target: { files: [big] } })
    await settle()
    includes(textOf(findByRole(readTree(), 'notice')[0]), '超过 8 MB', '超大文件给出提示')
    eq(inst._internals.state.fileName, '我的歌单.json', '超大文件不会被当成有效输入')
  }

  // --- 未登录时拒绝导入
  {
    const t2 = makeCtx({ script: { handlers: hh }, pinia: { state: { value: { user: { info: {} }, device: { info: {} } } } } })
    const i2 = await mod.activate(t2.ctx)
    const r2 = await setupRender(t2.pages[0].component)
    await findByRole(r2(), 'tab').find((n) => n.props['data-mode'] === 'paste').props.onClick()
    await settle()
    await findByRole(r2(), 'paste-input')[0].props.onInput({ target: { value: 'A - B' } })
    await settle()
    await click(r2(), 'data-action', 'parse-text')
    await settle()
    await click(r2(), 'data-action', 'match')
    await settle()
    await click(r2(), 'data-action', 'start-import')
    await settle()
    const okFlag = i2._internals.state.busy === false
    ok(okFlag, '未登录时不会卡在 busy')
    includes(textOf(findByRole(r2(), 'notice')[0]), '登录', '未登录时提示先登录')
    eq(t2.localCalls.filter((c) => c.url === '/playlist/add').length, 0, '未登录时不建歌单')
  }

  // --- 清理
  t.runDisposers()
  eq(inst._internals.state.abortAll, true, 'dispose 后置 abortAll（正在跑的任务会被中止）')
  eq(t.sidebarItems.length, 0, 'dispose 后侧边栏入口被摘掉')
}

/* --------------------------------------------- 13. 风控兜底（完整链路） */

section('13. 风控兜底（走真实链路）')
{
  const verifyCalls = []
  let searchCount = 0
  const hh = {
    '/search': () => {
      searchCount++
      // 前两次都回风控；用户通过验证后不该重复弹窗，而应直接把失败报上来
      if (searchCount <= 2) return riskFail('ev-' + searchCount)
      return { status: 200, headers: {}, body: searchBody([searchItem(1, '告白气球', '周杰伦')]) }
    },
    '/playlist/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0, data: { listid: 999 } } }),
    '/playlist/tracks/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0 } })
  }
  const t = makeCtx({
    script: { handlers: hh },
    kugouVerification: {
      request: async (id) => {
        verifyCalls.push(id)
        return { ok: true }
      }
    }
  })
  const inst = await mod.activate(t.ctx)
  const render = await setupRender(t.pages[0].component)

  await findByRole(render(), 'tab').find((n) => n.props['data-mode'] === 'paste').props.onClick()
  await settle()
  await findByRole(render(), 'paste-input')[0].props.onInput({ target: { value: '告白气球 - 周杰伦' } })
  await settle()
  await click(render(), 'data-action', 'parse-text')
  await settle()
  await click(render(), 'data-action', 'match')
  await settle()

  eq(verifyCalls.length, 1, '整轮只弹一次验证窗（不是每个关键词/每首都弹）')
  eq(verifyCalls[0], 'ev-1', '用第一个事件的 id 唤起验证')
  eq(searchCount, 3, '第一次被风控 → 验证通过后重试一次并成功（共 3 次请求：2 次风控 + 1 次成功）')
  eq(inst._internals.state.rows[0].tier, 'success', '验证后成功匹配')
  ok(t.localCalls.some((c) => c.url === '/search'), '确实发出了搜索请求')

  // 验证被取消时不该算成功
  const cancelCalls = []
  let n2 = 0
  const t3 = makeCtx({
    script: {
      handlers: {
        '/search': () => {
          n2++
          return riskFail('ev-' + n2)
        }
      }
    },
    kugouVerification: {
      request: async (id) => {
        cancelCalls.push(id)
        return { ok: false, canceled: true, error: '用户取消了验证' }
      }
    }
  })
  const i3 = await mod.activate(t3.ctx)
  const r3 = await setupRender(t3.pages[0].component)
  await findByRole(r3(), 'tab').find((n) => n.props['data-mode'] === 'paste').props.onClick()
  await settle()
  await findByRole(r3(), 'paste-input')[0].props.onInput({ target: { value: 'X - Y' } })
  await settle()
  await click(r3(), 'data-action', 'parse-text')
  await settle()
  await click(r3(), 'data-action', 'match')
  await settle()
  eq(cancelCalls.length, 1, '取消的场景同样只弹一次')
  eq(i3._internals.state.rows[0].tier, null, '验证取消后不判定匹配成功')
  includes(i3._internals.state.rows[0].searchError, '验证', '把验证失败带进行内原因')
}

/* --------------------------------------------- 14. 中止与停止 */

section('14. 停止匹配 / 停止导入')
{
  const hh = {
    '/search': () => ({ status: 200, headers: {}, body: searchBody([searchItem(1, '告白气球', '周杰伦')]) }),
    '/playlist/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0, data: { listid: 321 } } }),
    '/playlist/tracks/add': () => ({ status: 200, headers: {}, body: { status: 1, error_code: 0 } })
  }
  const t = makeCtx({ script: { handlers: hh } })
  const inst = await mod.activate(t.ctx)
  const render = await setupRender(t.pages[0].component)
  await findByRole(render(), 'tab').find((n) => n.props['data-mode'] === 'paste').props.onClick()
  await settle()
  await findByRole(render(), 'paste-input')[0].props.onInput({ target: { value: 'A - B\nC - D' } })
  await settle()
  await click(render(), 'data-action', 'parse-text')
  await settle()
  await click(render(), 'data-action', 'match')
  await settle()
  eq(inst._internals.state.importRunning, false, '匹配完不处于导入态')
  // 停止匹配按钮只在匹配中才渲染
  eq(findByRole(render(), 'data-action') && findByProp(render(), 'data-action', 'stop-preview').length, 0, '不在匹配中时不渲染停止匹配')
  // 停止按钮只在导入中才渲染
  eq(findByProp(render(), 'data-action', 'cancel-import').length, 0, '不在导入中时不渲染停止导入')
}

/* --------------------------------------------- 15. 响应式（只 setup 一次） */

section('15. 响应式：界面在最后一次渲染就已更新')
{
  const hh = {
    '/search': () => ({ status: 200, headers: {}, body: searchBody([searchItem(1, '告白气球', '周杰伦')]) })
  }
  const t = makeCtx({ script: { handlers: hh } })
  await mod.activate(t.ctx)
  const render = await setupRender(t.pages[0].component)
  await findByRole(render(), 'tab').find((n) => n.props['data-mode'] === 'paste').props.onClick()
  await settle()
  await findByRole(render(), 'paste-input')[0].props.onInput({ target: { value: 'A - B\nC - D' } })
  await settle()

  const snaps = []
  const stop = V.watchEffect(() => {
    snaps.push(findByRole(render(), 'row').length)
  })
  await click(render(), 'data-action', 'parse-text')
  await settle()
  await click(render(), 'data-action', 'match')
  await settle()
  stop()
  // 关键：不需要"切到别的页再切回来"就已经显示出来（真机上那个 bug 就是这么漏掉的）
  ok(snaps[snaps.length - 1] === 2, '最后一次渲染就已经显示 2 行（没有 computed 缓存旧值）', {
    last: snaps[snaps.length - 1],
    seq: snaps.join(',')
  })
  ok(snaps.some((n) => n > 0), '快照序列里出现过行')
}

/* --------------------------------------------- 16. CSS 契约 */

section('16. CSS 契约（三种容器的滚动约定）')
{
  // ⚠️ 断言前必须剥掉注释 —— 文件里的中文注释会写「不要 flex-direction: column」
  //    「绝不能写 height:100%」这类**反例描述**，直接搜会被自己的注释误判成违规。
  const css = fs.readFileSync(CSS_ENTRY, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
    const m = css.match(re)
    return m ? m[1] : ''
  }

  const pageRule = rule('.pi-page')
  ok(pageRule.length > 0, '有 .pi-page 规则')
  includes(pageRule, 'height: 100%', '插件页根节点撑满父级（父级 .plugin-page-host 是 h-full）')
  includes(pageRule, 'overflow-y: auto', '插件页自己滚')
  includes(pageRule, 'min-height: 0', '插件页 min-height: 0')
  notIncludes(pageRule, 'display: flex', '插件页不能用 flex column（子项会被压扁而不是溢出）')
  notIncludes(pageRule, 'flex-direction: column', '插件页不能是纵向 flex')
  includes(pageRule, 'box-sizing: border-box', '插件页 border-box')

  const settingsRule = rule('.pi-settings')
  ok(settingsRule.length > 0, '有 .pi-settings 规则')
  notIncludes(settingsRule, 'height', '设置面板根节点绝不能写 height（否则自己高度=内容高度 → 谁也滚不了）')
  notIncludes(settingsRule, 'overflow', '设置面板根节点绝不能写 overflow（宿主负责滚）')
  includes(settingsRule, 'display: block', '设置面板只做流式布局')

  // 每个 CSS 变量都必须带兜底值（宿主换主题/变量缺失时不至于变黑）
  const noFallback = css.match(/var\(\s*--[a-zA-Z0-9-]+\s*\)/g) || []
  eq(noFallback.length, 0, '每个 var(--x) 都带兜底值')

  // 进度条用 linear + 与心跳同周期（ENG-11）
  includes(rule('.pi-progress-bar'), 'transition: width 200ms linear', '进度条 transition 是 linear')

  // 拿不到总数时的「不确定进度条」必须存在
  includes(css, 'data-indeterminate', '有不确定进度条规则')
  includes(css, 'pi-sweep', '有来回扫的动画')

  // 插件前缀一致，避免污染宿主
  notIncludes(css.replace(/pi-/g, ''), 'myp-', '没有残留模板前缀')

  // 插件页里不能出现写死的深色底（不跟随主题）
  notIncludes(css, 'background: #1', '没有写死的深色背景')
}

/* --------------------------------------------- 17. 收尾 */

section('17. 收尾')
{
  // 插件没有任何 setInterval：无头环境不会被定时器挂住，真机也不会偷偷轮询
  eq(TIMER_SPY.created, 0, '插件没有创建任何 setInterval（无头测试不会被挂住）')
  eq(TIMER_SPY.active, 0, '没有遗留的 interval')

  // 页面/设置/入口的注册项数量精确（多余的注册会污染宿主 UI）
  const t = makeCtx({ script: { handlers: {} } })
  await mod.activate(t.ctx)
  eq(t.pages.length, 1, '只注册 1 个页面')
  eq(t.settingsDefs.length, 1, '只注册 1 个设置面板')
  eq(t.sidebarItems.length, 1, '只注册 1 个侧边栏入口')
  ok(t.logLines.some((l) => l.includes('activated')), 'activate 有日志')
}

/* ---------------------------------------------------------------- 汇总 */

restoreTimers()

const summary =
  (failures.length ? '✗ ' : '✓ ') +
  'playlist-importer 无头集成测试：' +
  pass +
  ' 通过 / ' +
  failures.length +
  ' 失败（' +
  sectionNames.length +
  ' 组）'

const lines = ['', '── 分组：' + sectionNames.join(' | '), '', summary]
if (failures.length) {
  lines.push('', '失败明细：')
  failures.forEach((f, i) => lines.push('  ' + (i + 1) + '. ' + f))
}
fs.mkdirSync(CACHE_DIR, { recursive: true })
fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8')

// 不用 process.exit（会抢在 writeFileSync 落盘前执行）
process.exitCode = failures.length ? 1 : 0
