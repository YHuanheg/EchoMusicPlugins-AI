/**
 * 歌曲下载 (song-downloader) 无头集成测试
 * ---------------------------------------------------------------------------
 * 静态 `node --check` 抓不到未定义标识符，也证明不了业务流程，所以这里用
 * **真实 Vue 3 ESM 运行时**无头执行插件代码：
 *
 *   1. mock 一个符合宿主契约的 ctx：storage / ui(addPage|sidebar|titlebar|settings)
 *      / toast / commands / dispose / player.currentTrack(ref) / stores.playlist.activeQueue
 *      / electron.api.request（本地路由，返回 /song/url 的载荷）
 *      / net.request（**真实实现 Range 分片语义**的假 CDN）
 *   2. await activate(ctx) → 断言注册项与返回的 api
 *   3. 直接调用组件 setup()() 拿到真实 vnode 树，按 data-action 找按钮，
 *      再真实调用 vnode.props.onClick() 跑完整业务流程（解析 → 分片下载 → 落盘）
 *   4. 断言落到「下载通道」的字节与假 CDN 上的文件**逐字节一致**
 *   5. 覆盖：音质降级、只有 128K、服务端忽略 Range、图片误判、HTTP 502 + error_code、
 *      取消、批量选择、历史持久化、另存为句柄、复制直链、诊断、重启幂等
 *
 * 假 DOM 只实现插件真正用到的那部分（createElement('a'/'textarea') + body + execCommand）。
 * 定时器被包了一层：> 5s 的延时（blob 回收的 30s）压成 0，避免无意义的等待。
 *
 * 运行： node tests/song-downloader.smoke.mjs
 * 变异测试：设 SD_PLUGIN_ENTRY 指向插件改动副本，即可用同一套断言验证「改坏了会红」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_ENTRY = process.env.SD_PLUGIN_ENTRY ? path.resolve(process.env.SD_PLUGIN_ENTRY) : path.join(ROOT, 'song-downloader', 'index.js')
const CACHE_DIR = path.join(ROOT, '.workbuddy', 'tmp')
const CACHE_VUE = path.join(CACHE_DIR, 'vue.runtime.esm-browser.js')
const VUE_CDN = 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.esm-browser.js'

/* ========================================================================== *
 * 断言脚手架
 * ========================================================================== */

let pass = 0
const failures = []
let currentSection = '(root)'

function section(name) {
  currentSection = name
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
  return ok(String(hay === undefined || hay === null ? '' : hay).includes(needle), name, {
    haystack: String(hay === undefined || hay === null ? '' : hay).slice(0, 300),
    needle
  })
}

/* ========================================================================== *
 * Vue 运行时解析
 * ========================================================================== */

async function resolveVue() {
  const candidates = [process.env.VUE_ESM_PATH, CACHE_VUE].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const res = await fetch(VUE_CDN)
  if (!res.ok) throw new Error('无法下载 Vue ESM 构建：HTTP ' + res.status + '（可设 VUE_ESM_PATH 指定本地文件）')
  fs.writeFileSync(CACHE_VUE, await res.text(), 'utf8')
  return CACHE_VUE
}

const V = await import(pathToFileURL(await resolveVue()).href)

/* ========================================================================== *
 * 定时器：> 5s 的延时压成 0（blob 回收 30s 不该让测试挂住）
 * ========================================================================== */

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const longDelays = []
globalThis.setTimeout = (fn, ms, ...rest) => {
  const delay = Number(ms) > 5000 ? 0 : ms
  if (Number(ms) > 5000) longDelays.push(Number(ms))
  return realSetTimeout(fn, delay, ...rest)
}
globalThis.clearTimeout = realClearTimeout

const tick = () => new Promise((r) => realSetTimeout(r, 1))

/** 结果同时落一份到文件：PowerShell 的 stdout 编码会吃掉中文，靠文件读回更稳 */
const REPORT = process.env.SD_REPORT || path.join(CACHE_DIR, 'sd-smoke-report.txt')
const reportLines = []
function say(line) {
  reportLines.push(line)
  console.log(line)
}
function flushReport() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(REPORT, reportLines.join('\n'), 'utf8')
  } catch {
    /* 忽略 */
  }
}

async function waitFor(pred, label, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true
    await tick()
  }
  throw new Error('等待超时：' + label)
}

/* ========================================================================== *
 * 假 DOM（只实现插件用到的那部分）
 * ========================================================================== */

const doc = {
  body: {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
      return node
    },
    removeChild(node) {
      const i = this.children.indexOf(node)
      if (i >= 0) this.children.splice(i, 1)
      node.parentNode = null
      return node
    }
  },
  createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      parentNode: null,
      style: {},
      value: '',
      href: '',
      download: '',
      rel: '',
      clicked: 0,
      focused: false,
      selected: false,
      focus() {
        this.focused = true
      },
      select() {
        this.selected = true
      },
      click() {
        this.clicked += 1
        doc.clicks.push(el)
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this)
      }
    }
    return el
  },
  clicks: [],
  execCommandFails: false,
  execCommands: [],
  execCommand(cmd) {
    if (cmd === 'copy') {
      doc.execCommands.push(cmd)
      return !doc.execCommandFails
    }
    return false
  }
}

const objectUrls = new Map()
let objectUrlSeq = 0
let lastBlob = null

function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false })
  } catch {
    globalThis[name] = value
  }
}

defineGlobal('document', doc)
defineGlobal('window', {}) // 默认没有 showSaveFilePicker
defineGlobal('navigator', {})
globalThis.URL.createObjectURL = (blob) => {
  objectUrlSeq += 1
  lastBlob = blob
  objectUrls.set('blob:test/' + objectUrlSeq, blob)
  return 'blob:test/' + objectUrlSeq
}
globalThis.URL.revokeObjectURL = (url) => {
  objectUrls.delete(url)
}

const clipboard = { text: '', fails: false }
navigator.clipboard = {
  async writeText(text) {
    if (clipboard.fails) throw new Error('clipboard denied')
    clipboard.text = String(text)
  }
}

/* ========================================================================== *
 * 假 CDN（真实实现 Range 语义）
 * ========================================================================== */

function makeBytes(size, seed) {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7 + (seed || 0)) & 0xff
  return buf
}

function abOf(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

function headerOf(headers, name) {
  const want = String(name).toLowerCase()
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === want) return String(v)
  }
  return ''
}

/**
 * mode:
 *   'range'        正常支持 Range（206 + content-range）
 *   'norange'      忽略 Range，任何请求都回 200 + 整包
 *   'range-nototal' 回 206 但不给 content-range
 *   'image'        回图片字节
 *   'empty'        回空内容
 *   'http500'      回 500
 */
const net = {
  mode: 'range',
  file: Buffer.alloc(0),
  calls: [],
  throwOnCall: 0,
  beforeChunk: null,
  notFoundOn: 0,
  async request(opts) {
    const call = { url: opts.url, headers: opts.headers || {}, responseType: opts.responseType, maxResponseBytes: opts.maxResponseBytes }
    net.calls.push(call)
    const index = net.calls.length
    if (net.beforeChunk) await net.beforeChunk(index, call)
    if (net.throwOnCall === index) throw new Error('net::ERR_CONNECTION_RESET')
    if (net.notFoundOn === index) return { status: 404, headers: {}, data: abOf(Buffer.from('not found')) }

    const range = headerOf(opts.headers, 'Range')
    const m = /bytes=(\d+)-(\d+)/.exec(range)

    if (net.mode === 'http500') return { status: 500, headers: {}, data: abOf(Buffer.from('boom')) }
    if (net.mode === 'empty') return { status: 200, headers: { 'content-length': '0' }, data: abOf(Buffer.alloc(0)) }
    if (net.mode === 'image') return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: abOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])) }

    if (net.mode === 'norange') {
      return { status: 200, headers: { 'content-length': String(net.file.length) }, data: abOf(net.file) }
    }
    if (net.mode === 'range-nototal') {
      const start = m ? Number(m[1]) : 0
      const end = m ? Number(m[2]) : net.file.length - 1
      return { status: 206, headers: {}, data: abOf(net.file.subarray(start, end + 1)) }
    }
    // 'range'
    if (range === 'bytes=0-0') {
      return { status: 206, headers: { 'content-range': 'bytes 0-0/' + net.file.length }, data: abOf(net.file.subarray(0, 1)) }
    }
    if (!m) return { status: 200, headers: { 'content-length': String(net.file.length) }, data: abOf(net.file) }
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), net.file.length - 1)
    return {
      status: 206,
      headers: { 'content-range': 'bytes ' + start + '-' + end + '/' + net.file.length },
      data: abOf(net.file.subarray(start, end + 1))
    }
  }
}

/* ========================================================================== *
 * 假本地路由（ctx.electron.api.request）
 * ========================================================================== */

const api = {
  calls: [],
  handler: null,
  async request(req) {
    api.calls.push(req)
    if (api.handler) return api.handler(req)
    return {
      status: 200,
      body: { status: 1, error_code: 0, data: { url: ['https://cdn.test/' + req.params.hash + '.' + (req.params.quality === 'flac' ? 'flac' : 'mp3')] } }
    }
  }
}

function okBody(quality) {
  return {
    status: 200,
    body: {
      status: 1,
      error_code: 0,
      data: { url: ['https://cdn.test/audio.' + (quality === 'flac' ? 'flac' : 'mp3')] }
    }
  }
}

function failBody(errorCode, extra) {
  return { status: 502, body: { status: 0, error_code: errorCode, msg: extra || 'upstream rejected' } }
}

/* ========================================================================== *
 * 插件侧夹具
 * ========================================================================== */

const FLAC_TRACK = {
  id: 'song-1',
  name: '花落叹',
  artist: '涂一乐',
  album: '某专辑',
  hash: 'AAAA1111BBBB2222CCCC3333DDDD4444',
  albumId: '12345',
  duration: 245,
  relateGoods: [
    // 故意把 flac 放在第一位：上游的实际顺序不固定，
    // 这样「128 必须用主 hash」这条规则才会被真正测到（顺序取第一条会拿错文件）
    { hash: 'EEEE0000EEEE0000EEEE0000EEEE0000', quality: 'flac', level: 5 },
    { hash: 'FFFF0000FFFF0000FFFF0000FFFF0000', quality: '320', level: 4 },
    { hash: 'aaaa1111bbbb2222cccc3333dddd4444', quality: '128', level: 1 }
  ]
}

const LOW_TRACK = {
  id: 'song-2',
  name: '只有128的歌',
  artist: '某人',
  hash: '99998888777766665555444433332222',
  duration: 200,
  relateGoods: [{ hash: '99998888777766665555444433332222', quality: '128', level: 1 }]
}

const CLOUD_TRACK = {
  id: 'song-3',
  name: '云盘歌曲',
  artist: '某人',
  hash: 'CLOUDKEY000000000000000000000000',
  source: 'cloud'
}

const NO_HASH_TRACK = { id: 'song-4', name: '没有hash的歌', artist: '某人' }

function makeCtx(options) {
  const o = options || {}
  const storage = o.storage || new Map()
  const records = {
    pages: [],
    sidebar: [],
    toolbar: [],
    settings: [],
    commands: [],
    toasts: [],
    sidebarDisposals: 0,
    toolbarDisposals: 0,
    disposers: []
  }
  const currentTrack = V.ref(o.currentTrack === undefined ? FLAC_TRACK : o.currentTrack)
  // 队列必须放进 ref：宿主那边 activeQueue 是 pinia 响应式对象，
  // 用普通变量模拟的话「队列变化 → 界面更新」这条链路根本触发不了，测不出真问题。
  const queueRef = V.ref(o.queue || [FLAC_TRACK, LOW_TRACK])
  const ctx = {
    manifest: { version: o.version || '1.0.0' },
    vue: V,
    storage: {
      async get(key) {
        return storage.has(key) ? storage.get(key) : null
      },
      async set(key, value) {
        storage.set(key, value)
      }
    },
    ui: {
      addPage(page) {
        records.pages.push(page)
      },
      sidebar: {
        addItem(item) {
          records.sidebar.push(item)
          return () => {
            records.sidebarDisposals += 1
          }
        }
      },
      titlebar: {
        register(item) {
          records.toolbar.push(item)
          return () => {
            records.toolbarDisposals += 1
          }
        }
      },
      settings: {
        define(def) {
          records.settings.push(def)
          return () => {
            records.settingsDisposals = (records.settingsDisposals || 0) + 1
          }
        }
      }
    },
    toast: {
      info(m) {
        records.toasts.push(['info', m])
      },
      success(m) {
        records.toasts.push(['success', m])
      },
      warning(m) {
        records.toasts.push(['warning', m])
      },
      danger(m) {
        records.toasts.push(['danger', m])
      }
    },
    commands: {
      register(id, handler, meta) {
        records.commands.push({ id, handler, meta })
      }
    },
    player: { currentTrack },
    stores: {
      playlist: {
        get activeQueue() {
          return { songs: queueRef.value }
        }
      }
    },
    electron: { platform: 'win32', api },
    net,
    dispose(fn) {
      records.disposers.push(fn)
    }
  }
  records.setQueue = (list) => {
    queueRef.value = list
  }
  records.queueRef = queueRef
  records.storage = storage
  records.currentTrack = currentTrack
  return { ctx, records }
}

/* ========================================================================== *
 * vnode 遍历
 * ========================================================================== */

function walk(node, out = []) {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.props || node.type) out.push(node)
  if (node.children !== undefined && node.children !== null) walk(node.children, out)
  return out
}

function findByProp(tree, prop, value) {
  return walk(tree).find((n) => n.props && n.props[prop] === value) || null
}

function findAllByProp(tree, prop, value) {
  return walk(tree).filter((n) => n.props && n.props[prop] === value)
}

function countByProp(tree, prop, value) {
  return findAllByProp(tree, prop, value).length
}

/** 把树里的纯文本子节点拼起来，用来断言界面文案 */
function textOf(tree) {
  return walk(tree)
    .filter((n) => typeof n.children === 'string')
    .map((n) => n.children)
    .join('|')
}

function propOf(tree, prop, value, read) {
  const n = findByProp(tree, prop, value)
  return n ? n.props[read] : undefined
}

/** 渲染一个 defineComponent 的 setup → vnode 树 */
function renderOf(component) {
  const render = component.setup({}, {})
  return render()
}

/* ========================================================================== *
 * 主流程
 * ========================================================================== */

async function main() {
  const mod = await import(pathToFileURL(PLUGIN_ENTRY).href)
  const I = mod.__internals

  /* ---------------------------------------------------------------- 1. 纯函数 */
  section('1. 纯函数：音质判定与 hash 选择')
  eq(I.qualityMatch({ quality: 'flac' }, 'flac'), true, 'flac 档识别 flac')
  eq(I.qualityMatch({ level: 5 }, 'flac'), true, 'flac 档识别 level 5')
  eq(I.qualityMatch({ quality: 'hq' }, '320'), true, '320 档识别 hq')
  eq(I.qualityMatch({ quality: 'hires' }, 'high'), true, 'high 档识别 hires')
  eq(I.qualityMatch({ quality: 'flac' }, '320'), false, 'flac 不算 320')
  eq(I.qualityMatch({}, '128'), true, '128 恒可用')

  eq(I.availableQualities(FLAC_TRACK.relateGoods).join(','), '128,320,flac', '升序可用音质')
  eq(I.availableQualities([]).join(','), '128', '没有版权信息时只有 128')
  eq(I.candidateQualities(FLAC_TRACK, 'auto').join(','), 'flac,320,128', 'auto = 最高可用并逐级降级')
  eq(I.candidateQualities(FLAC_TRACK, '320').join(','), '320,128', '指定 320 时向下降级')
  eq(I.candidateQualities(LOW_TRACK, 'flac').join(','), 'flac,320,128', '请求 flac 也试得到 128')

  eq(
    I.pickHashForQuality(I.normalizeTrack(FLAC_TRACK), '128'),
    'aaaa1111bbbb2222cccc3333dddd4444',
    '128 必须用轨道主 hash（不能命中 relateGoods 第一条）'
  )
  eq(
    I.pickHashForQuality(I.normalizeTrack(FLAC_TRACK), 'flac'),
    'eeee0000eeee0000eeee0000eeee0000',
    'flac 用该音质自己的 hash'
  )
  eq(I.pickHashForQuality(I.normalizeTrack(FLAC_TRACK), '320'), 'ffff0000ffff0000ffff0000ffff0000', '320 用自己的 hash')

  section('2. 纯函数：载荷解析与文件名')
  const shapes = [
    { data: { url: ['https://a.test/x.mp3'], backup_url: ['https://b.test/x.mp3'] } },
    { data: [{ url: ['https://c.test/x.flac'] }] },
    { data: { info: { urls: 'https://d.test/x.mp3' } } },
    ['https://e.test/x.mp3'],
    { play_url: 'https://f.test/x.mp3', backup_url: ['https://f.test/x.mp3'] }
  ]
  eq(I.extractUrls(shapes[0]).length, 2, 'url + backup_url 都取到')
  eq(I.extractUrls(shapes[1])[0], 'https://c.test/x.flac', '数组里再包一层也能取')
  eq(I.extractUrls(shapes[2])[0], 'https://d.test/x.mp3', 'info.urls 也能取')
  eq(I.extractUrls(shapes[3])[0], 'https://e.test/x.mp3', '裸数组也能取')
  eq(I.extractUrls(shapes[4]).length, 1, '同一地址去重')
  eq(I.extractUrls({ data: { url: ['https://a.test/cover.jpg'], backup_url: ['https://b.test/song.mp3'] } })[0], 'https://b.test/song.mp3', '图片地址被剔除且音频优先')
  eq(I.extractUrls({}).length, 0, '空载荷返回空数组')
  eq(I.extFromUrl('https://x.test/a/b.flac?sign=1'), 'flac', '从 URL 取扩展名（忽略 query）')
  eq(I.pickExt({ data: { extName: 'mp3' } }, 'https://x.test/a.bin'), 'mp3', '优先用上游 extName')
  eq(I.pickExt({}, 'https://x.test/a.flac'), 'flac', '没有 extName 时看 URL')
  eq(I.pickExt({}, 'https://x.test/stream'), '', '都没有时返回空')

  eq(I.sanitizeFileName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i', '非法字符替换')
  eq(I.sanitizeFileName('  末尾点. '), '末尾点', '去掉首尾点与空格')
  eq(I.sanitizeFileName(''), '未知歌曲', '空名兜底')
  eq(I.buildFileName({ artist: 'A', name: 'B', album: 'C' }, 'flac', 'flac', '{artist}-{name}'), 'A-B.flac', '模板占位符')
  eq(I.buildFileName({ artist: 'A', name: 'B' }, '320', 'mp3', '{quality}/{name}'), '320K_B.mp3', '质量占位符里的斜杠被清洗')
  eq(I.parseTotalFromContentRange('bytes 0-0/12345678'), 12345678, '解析 content-range 总长')
  eq(I.parseTotalFromContentRange('bytes 0-0/*'), 0, '未知总长返回 0')
  eq(I.describeFailure({}, 502, 0), 'HTTP 502', 'error_code=0 时不查错误码表（回落成 HTTP 状态）')
  includes(I.describeFailure({ msg: 'boom' }, 502, 0), 'boom', 'error_code=0 用上游原始文本')
  includes(I.describeFailure({}, 502, 20018), '登录状态无效', '非零 error_code 查表')
  includes(I.describeFailure({}, 503, 0), '未就绪', '503 给出宿主服务提示')

  /* ------------------------------------------------------------ 3. activate */
  section('3. activate：注册项与返回值')
  const first = makeCtx({})
  const apiOut = await mod.activate(first.ctx)
  eq(first.records.pages.length, 1, '注册了 1 个页面')
  eq(first.records.pages[0].id, 'download', '页面 id = download')
  eq(typeof first.records.pages[0].component.setup, 'function', '页面组件可用')
  eq(first.records.sidebar.length, 1, '默认注册侧边栏入口')
  eq(first.records.sidebar[0].section, 'plugins', '侧边栏入口在「插件」分组')
  eq(first.records.settings.length, 1, '注册了设置面板')
  eq(first.records.commands.length, 3, '注册了 3 条命令')
  eq(apiOut.state.settings.quality, 'auto', '默认音质 auto')
  eq(apiOut.state.settings.chunked, true, '默认开启分片下载')
  eq(typeof first.records.disposers[0], 'function', '注册了 ctx.dispose 回收函数')

  const page = first.records.pages[0].component
  const settingsPanel = first.records.settings[0].component

  /* -------------------------------------------------- 4. 无歌 / 空队列的降级 */
  section('4. 没有在播歌曲时的降级')
  first.records.currentTrack.value = null
  net.file = makeBytes(1024 * 1024)
  let tree = renderOf(page)
  eq(findByProp(tree, 'data-action', 'download-current'), null, '空态不渲染「下载」按钮')
  eq(findByProp(tree, 'data-role', 'current-card') !== null, true, '仍渲染「当前播放」卡片')
  includes(textOf(tree), '还没有正在播放的歌曲', '给出空态文案')

  await findByProp(tree, 'data-action', 'download-current-top').props.onClick()
  eq(apiOut.state.tasks.length, 0, '没有歌曲时不创建任务')
  includes(JSON.stringify(first.records.toasts), '当前没有正在播放的歌曲', 'toast 提示原因')

  /* ------------------------------------------------ 5. 当前播放下载主流程 */
  section('5. 主流程：FLAC 分片下载 + Blob 落盘')
  first.records.currentTrack.value = FLAC_TRACK
  api.calls.length = 0
  net.calls.length = 0
  net.file = makeBytes(3 * 1024 * 1024 + 777, 3)
  net.mode = 'range'
  lastBlob = null
  doc.clicks.length = 0
  const original = Buffer.from(net.file)

  tree = renderOf(page)
  const dlBtn = findByProp(tree, 'data-action', 'download-current')
  ok(!!dlBtn, '找到「下载」按钮')
  await dlBtn.props.onClick()

  await waitFor(() => apiOut.state.tasks.length === 1, '创建任务')
  await waitFor(() => apiOut.state.tasks[0].status === 'done', '任务完成')
  const task = apiOut.state.tasks[0]
  eq(task.actualQuality, 'flac', '实际音质 = flac')
  eq(task.viaChunked, true, '走了分片下载')
  eq(task.saveMethod, 'downloads', '走主通道（Chromium 下载）')
  eq(task.fileName, '涂一乐 - 花落叹.flac', '文件名按模板生成')
  eq(task.bytes, original.length, '字节数 = 源文件')
  eq(task.loaded, original.length, '进度走到 100%')
  eq(task.error, '', '没有错误')
  eq(task.speed, 0, '完成后速度归零')

  eq(api.calls.length, 1, '只请求了一次 /song/url（最高音质成功就不降级）')
  eq(api.calls[0].url, '/song/url', '走本地路由')
  eq(api.calls[0].method, 'GET', '方法写 GET（宿主会忽略）')
  eq(api.calls[0].params.quality, 'flac', '请求 flac')
  eq(api.calls[0].params.hash, 'eeee0000eeee0000eeee0000eeee0000', '用 flac 档自己的 hash')
  eq(api.calls[0].params.album_id, '12345', '带上 album_id')

  const probe = net.calls[0]
  eq(headerOf(probe.headers, 'Range'), 'bytes=0-0', '第一次是探测请求')
  eq(probe.maxResponseBytes, 0, 'maxResponseBytes=0（否则 32MiB 截断）')
  const ranged = net.calls.filter((c) => headerOf(c.headers, 'Range'))
  ok(ranged.length >= 4, '至少 4 次 Range 请求（探测 + 3 个分片）', { count: ranged.length })

  ok(!!lastBlob, '产生了 Blob')
  eq(lastBlob.size, original.length, 'Blob 大小与源文件一致')
  const assembled = Buffer.from(await lastBlob.arrayBuffer())
  eq(assembled.equals(original), true, '拼装后的字节与源文件逐字节一致')
  eq(doc.clicks.length, 1, '触发了一次 <a> 点击')
  eq(doc.clicks[0].download, '涂一乐 - 花落叹.flac', '<a download> 用了模板文件名')
  ok(String(doc.clicks[0].href).startsWith('blob:'), 'href 是 blob 地址')
  eq(first.records.toasts.filter((t) => t[0] === 'success').length, 1, '完成时弹了成功提示')
  eq(apiOut.state.history.length, 1, '写入历史')
  eq(apiOut.state.history[0].ok, true, '历史标记成功')
  eq(first.records.storage.get('history').length, 1, '历史被持久化')

  /* -------------------------------------------- 6. 音质降级（只有 128K 的歌） */
  section('6. 音质降级：请求 flac 但只有 128K')
  apiOut.state.settings.quality = 'flac'
  api.calls.length = 0
  net.calls.length = 0
  net.file = makeBytes(700 * 1024, 9)
  // 假上游也必须「只给 128」：否则第一档 flac 就成功了，永远测不到降级路径
  api.handler = (req) =>
    req.params.quality === '128' ? okBody('128') : { status: 502, body: { status: 0, error_code: 20010, msg: 'no privilege' } }
  const lowTask = (await apiOut.startDownloads([LOW_TRACK], 'flac'))[0]
  await waitFor(() => lowTask.status === 'done', '低音质任务完成')
  eq(api.calls.length, 3, '依次尝试 flac → 320 → 128')
  eq(api.calls.map((c) => c.params.quality).join(','), 'flac,320,128', '降级顺序正确')
  eq(
    api.calls.map((c) => c.params.hash).every((h) => h === '99998888777766665555444433332222'),
    true,
    '无音质信息时所有档都用主 hash'
  )
  eq(lowTask.actualQuality, '128', '实际音质 = 128')
  includes(lowTask.fileName, '.mp3', '扩展名回退 mp3')
  api.handler = null
  apiOut.state.settings.quality = 'auto'

  /* ------------------------------------------------- 7. 服务端忽略 Range */
  section('7. 服务端忽略 Range（回 200 + 整包）')
  net.mode = 'norange'
  net.file = makeBytes(500 * 1024, 11)
  net.calls.length = 0
  const noRangeTask = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => noRangeTask.status === 'done', '忽略 Range 时也能完成')
  eq(noRangeTask.viaChunked, false, '标记为非分片')
  eq(noRangeTask.bytes, net.file.length, '字节数正确')
  eq(net.calls.length, 1, '探测那一次就拿到了整包')

  section('8. 服务端忽略 Range（中途返回 200）')
  net.mode = 'range'
  net.file = makeBytes(3 * 1024 * 1024, 13)
  net.calls.length = 0
  net.beforeChunk = (index) => {
    if (index === 2) net.mode = 'norange' // 第二个分片时开始忽略 Range
  }
  const midTask = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => midTask.status === 'done' || midTask.status === 'failed', '中途切换 Range 行为')
  eq(midTask.status, 'done', '仍能成功（整包当结果）')
  eq(midTask.viaChunked, false, '降级为整包')
  eq(midTask.bytes, net.file.length, '字节数正确')
  net.beforeChunk = null

  /* --------------------------------------------------------- 9. 错误路径 */
  section('9. 错误路径：上游业务错误 / 空地址 / 图片 / HTTP 500')
  api.handler = () => failBody(20018)
  api.calls.length = 0
  const f1 = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => f1.status === 'failed', '业务错误导致失败')
  includes(f1.error, '登录状态无效', 'error_code 20018 文案')
  eq(api.calls.length, 3, '业务错误也会逐级降级尝试')

  api.handler = () => ({ status: 200, body: { status: 1, error_code: 0, data: { url: [] } } })
  const f2 = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => f2.status === 'failed', '空地址导致失败')
  includes(f2.error, '接口返回失败', '空地址给出兜底文案（不是「成功」）')

  api.handler = () => ({ status: 502, body: { status: 0, error_code: 0, msg: 'net::ERR_CONNECTION_RESET' } })
  const f3 = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => f3.status === 'failed', '连接层错误导致失败')
  includes(f3.error, 'ERR_CONNECTION_RESET', 'error_code=0 时透出真实错误')

  api.handler = null
  eq(first.records.toasts.filter((t) => t[0] === 'danger').length >= 3, true, '失败都弹了 danger 提示')

  net.mode = 'image'
  const f4 = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => f4.status === 'failed', '拿到图片时失败')
  includes(f4.error, '不是音频', '识别出图片字节')

  net.mode = 'http500'
  const f5 = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => f5.status === 'failed', 'HTTP 500 失败')
  includes(f5.error, '500', '错误里带状态码')

  section('10. 重试：网络异常自动重试一次')
  apiOut.state.settings.maxRetries = 1
  net.mode = 'range'
  net.file = makeBytes(600 * 1024, 17)
  net.calls.length = 0
  net.throwOnCall = 1 // 第 1 次请求（探测）抛网络异常
  const r1 = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => r1.status === 'done' || r1.status === 'failed', '重试流程结束')
  eq(r1.status, 'done', '重试后成功')
  eq(net.calls.length >= 2, true, '第一次抛错后确实又发了一次请求', { calls: net.calls.length })
  net.throwOnCall = 0
  apiOut.state.settings.maxRetries = 0

  section('11. 重试按钮')
  const before = api.calls.length
  api.handler = () => failBody(20010)
  const rf = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => rf.status === 'failed', '先失败')
  api.handler = null
  apiOut.retryTask(rf)
  await waitFor(() => rf.status === 'done', '重试后成功')
  eq(rf.error, '', '重试成功清空错误')
  ok(api.calls.length > before, '重试真的又发了请求')

  /* ------------------------------------------------------------ 12. 取消 */
  section('12. 取消：分片之间生效')
  net.mode = 'range'
  net.file = makeBytes(4 * 1024 * 1024, 19)
  net.calls.length = 0 // 必须清零：beforeChunk 用的是 1 基的请求序号
  apiOut.state.settings.chunkSizeMb = 1
  const cancelHolder = { task: null }
  net.beforeChunk = async (index) => {
    if (index === 2 && cancelHolder.task) apiOut.cancelTask(cancelHolder.task)
  }
  const ct = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  cancelHolder.task = ct
  await waitFor(() => ct.status === 'canceled', '任务被取消')
  ok(ct.loaded < ct.total, '取消时没有下完', { loaded: ct.loaded, total: ct.total })
  eq(ct.speed, 0, '取消后速度归零')
  net.beforeChunk = null

  section('13. cancelAll 与清空')
  const c1 = (await apiOut.startDownloads([FLAC_TRACK, LOW_TRACK], 'auto'))[0]
  apiOut.cancelAll()
  await waitFor(() => apiOut.state.tasks.every((t) => t.status === 'canceled' || t.status === 'done' || t.status === 'failed'), '全部任务收敛')
  eq(apiOut.state.tasks.some((t) => t.status === 'canceled'), true, '出现被取消的任务')
  void c1
  const totalBefore = apiOut.state.tasks.length
  apiOut.clearFinished()
  eq(apiOut.state.tasks.length, 0, '清空已完成/失败/取消')
  ok(totalBefore > 0, '清空前确实有任务')

  /* ------------------------------------------------------- 14. 队列与批量 */
  section('14. 队列：勾选、批量下载、不可下载的歌')
  net.file = makeBytes(300 * 1024, 23)

  // 先测「队列变化 → 同一次渲染就更新」（reactive 容器踩过的坑：拿到非代理引用会渲染旧值）
  {
    const render = page.setup({}, {})
    const counts = []
    const stop = V.watchEffect(() => {
      counts.push(countByProp(render(), 'data-action', 'download-row'))
    })
    await tick()
    first.records.setQueue([FLAC_TRACK, LOW_TRACK, CLOUD_TRACK, NO_HASH_TRACK])
    await tick()
    eq(counts[counts.length - 1], 4, '队列从 2 首变 4 首后，同一次渲染就显示 4 行')
    stop()
  }

  tree = renderOf(page)
  const rows = findAllByProp(tree, 'data-action', 'toggle-row')
  eq(rows.length, 4, '队列 4 行')
  eq(findByProp(tree, 'data-row', FLAC_TRACK.hash.toLowerCase()) !== null, true, '普通歌曲的行键用 hash')

  const cloudToggle = findByProp(tree, 'data-key', CLOUD_TRACK.hash.toLowerCase())
  eq(cloudToggle.props['data-action'], 'toggle-row', '同一 data-key 下第一个是勾选框')
  eq(cloudToggle.props.disabled, true, '云盘歌曲的勾选框被禁用')
  eq(findByProp(tree, 'data-key', NO_HASH_TRACK.id).props.disabled, true, '没有 hash 的歌也被禁用')
  includes(textOf(tree), '云盘歌曲暂不支持下载', '给出云盘歌曲的原因')
  includes(textOf(tree), '这首歌没有 hash', '给出没有 hash 的原因')

  findByProp(tree, 'data-action', 'select-all').props.onClick()
  tree = renderOf(page)
  eq(propOf(tree, 'data-action', 'toggle-row', 'aria-checked'), 'true', '全选后第一行被勾上')
  eq(propOf(tree, 'data-action', 'download-selected', 'disabled'), false, '有选择时批量按钮可用')
  const tasksBefore = apiOut.state.tasks.length
  findByProp(tree, 'data-action', 'download-selected').props.onClick()
  await waitFor(() => apiOut.state.tasks.length === tasksBefore + 2, '批量下载创建 2 个任务（跳过 2 首不可下载的）')
  await waitFor(() => apiOut.state.tasks.filter((t) => t.status === 'done').length >= 2, '批量任务完成')
  tree = renderOf(page)
  eq(propOf(tree, 'data-action', 'download-selected', 'disabled'), true, '下载后清空选择')

  const singleBtn = findAllByProp(tree, 'data-action', 'download-row')[0]
  const tasksBefore2 = apiOut.state.tasks.length
  await singleBtn.props.onClick()
  await waitFor(() => apiOut.state.tasks.length === tasksBefore2 + 1, '单行下载创建任务')

  /* ------------------------------------------------ 13b. 任务状态的响应式 */
  section('13b. 任务状态必须真的驱动界面（patch 走响应式代理）')
  {
    await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '先等前面收敛')
    const render = page.setup({}, {})
    const seen = []
    const stop = V.watchEffect(() => {
      seen.push(
        walk(render())
          .filter((n) => n.props && n.props['data-role'] === 'status')
          .map((n) => n.children)
          .join('|')
      )
    })
    await tick()
    net.mode = 'range'
    net.file = makeBytes(2 * 1024 * 1024, 41)
    const rsTask = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
    await waitFor(() => rsTask.status === 'done', '响应式用例里的任务完成')
    await tick()
    stop()
    const joined = seen.join('#')
    // 注意：不assert「排队中」—— pending 是同步立刻转 resolving 的瞬态，观察不到是正常的
    includes(joined, '解析地址…', '观察到了「解析地址…」')
    includes(joined, '下载中', '观察到了「下载中」（说明每次状态变更都触发了渲染）')
    ok(seen.length >= 3, '状态变化确实引发了多次重渲染', { renders: seen.length })
  }

  /* ---------------------------------------------------------- 15. 另存为 */
  section('15. 另存为…（File System Access API）')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '先让前面的任务跑完')
  const written = []
  let pickerCalls = 0
  window.showSaveFilePicker = async (opts) => {
    pickerCalls += 1
    window.__lastPickerOptions = opts
    return {
      name: opts.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            written.push(Buffer.from(await blob.arrayBuffer()))
          },
          async close() {}
        }
      }
    }
  }
  net.mode = 'range'
  net.file = makeBytes(800 * 1024, 29)
  const before15 = apiOut.state.tasks.length
  const asTask = await apiOut.downloadCurrentAs()
  await waitFor(() => asTask && asTask.status === 'done', '另存为任务完成')
  eq(pickerCalls, 1, '调用了保存对话框')
  includes(window.__lastPickerOptions.suggestedName, '涂一乐 - 花落叹', '对话框预填文件名')
  eq(written.length, 1, '写入了 1 次')
  eq(written[0].equals(net.file), true, '写入的字节与源文件一致')
  eq(asTask.saveMethod, 'picker', '标记为 picker 落盘')
  eq(asTask.fileName, window.__lastPickerOptions.suggestedName, '文件名用对话框返回的名字')
  eq(apiOut.state.tasks.length, before15 + 1, '只创建一个任务')

  window.showSaveFilePicker = async () => {
    const err = new Error('user aborted')
    err.name = 'AbortError'
    throw err
  }
  const beforeCancel = apiOut.state.tasks.length
  const canceledAs = await apiOut.downloadCurrentAs()
  eq(canceledAs, null, '取消对话框不创建任务')
  eq(apiOut.state.tasks.length, beforeCancel, '任务数不变')
  includes(JSON.stringify(first.records.toasts), '已取消保存', '提示已取消')

  delete window.showSaveFilePicker
  const fallbackTask = await apiOut.downloadCurrentAs()
  await waitFor(() => fallbackTask && fallbackTask.status === 'done', '内核不支持时降级到下载目录')
  eq(fallbackTask.saveMethod, 'downloads', '降级后走主通道')

  /* -------------------------------------------------------- 16. 复制直链 */
  section('16. 复制直链与诊断')
  clipboard.text = ''
  api.calls.length = 0
  tree = renderOf(page)
  await findByProp(tree, 'data-action', 'copy-current-link').props.onClick()
  await tick()
  includes(clipboard.text, 'https://cdn.test/', '直链进了剪贴板')
  eq(apiOut.state.resolved !== null, true, '记录了最近一次解析结果')
  eq(apiOut.state.resolved.count >= 1, true, '记录候选地址数量')
  tree = renderOf(page)
  includes(
    walk(tree)
      .filter((n) => typeof n.children === 'string')
      .map((n) => n.children)
      .join('|'),
    '已解析',
    '页面上显示最近解析结果'
  )

  const diag = JSON.parse(apiOut.copyDiagnostics())
  eq(diag.plugin, 'song-downloader', '诊断里带插件 id')
  eq(typeof diag.settings.quality, 'string', '诊断里带设置')
  ok(Array.isArray(diag.tasks) && diag.tasks.length > 0, '诊断里带任务快照')
  ok(Array.isArray(diag.history), '诊断里带历史')

  doc.execCommandFails = true
  clipboard.fails = true
  await findByProp(renderOf(page), 'data-action', 'copy-diagnostics').props.onClick()
  await tick()
  includes(JSON.stringify(first.records.toasts), '复制失败', '剪贴板与兜底都失败时有提示')
  doc.execCommandFails = false
  clipboard.fails = false

  /* ------------------------------------------------------------ 17. 历史 */
  section('17. 历史记录与清空')
  tree = renderOf(page)
  const historyRows = walk(tree).filter((n) => n.props && n.props['data-history'])
  eq(historyRows.length > 0, true, '历史行渲染出来了')
  eq(historyRows.length, Math.min(60, apiOut.state.history.length), '历史行数与数据一致')
  const historyLink = findByProp(tree, 'data-action', 'history-link')
  if (historyLink && !historyLink.props.disabled) {
    clipboard.text = ''
    await historyLink.props.onClick()
    await tick()
    includes(clipboard.text, 'https://cdn.test/', '历史里的直链可复制')
  }
  findByProp(tree, 'data-action', 'clear-history').props.onClick()
  eq(apiOut.state.history.length, 0, '清空历史')
  eq(first.records.storage.get('history').length, 0, '清空也写回存储')
  tree = renderOf(page)
  includes(
    walk(tree)
      .filter((n) => typeof n.children === 'string')
      .map((n) => n.children)
      .join('|'),
    '还没有下载记录',
    '空历史给出空态'
  )

  /* ---------------------------------------------------------- 18. 设置面板 */
  section('18. 设置面板：开关与持久化')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '任务清空')
  let sTree = renderOf(settingsPanel)
  eq(findByProp(sTree, 'data-setting', 'chunked') !== null, true, '有分片开关')
  eq(findByProp(sTree, 'data-setting', 'quality') !== null, true, '有音质选项')
  eq(findByProp(sTree, 'data-setting', 'fileNameTemplate') !== null, true, '有文件名模板输入')
  eq(countByProp(sTree, 'role', 'switch'), 5, '5 个开关（分片/完成提示/侧边栏/工具栏/调试）')

  const chunkSwitch = findByProp(sTree, 'data-setting', 'chunked')
  const innerSwitch = walk(chunkSwitch).find((n) => n.props && n.props.role === 'switch')
  eq(innerSwitch.props['aria-checked'], 'true', '分片开关初始为开')
  innerSwitch.props.onClick()
  eq(apiOut.state.settings.chunked, false, '点击后关闭')
  eq(first.records.storage.get('settings').chunked, false, '写回了存储')
  sTree = renderOf(settingsPanel)
  eq(
    walk(findByProp(sTree, 'data-setting', 'chunked')).find((n) => n.props && n.props.role === 'switch').props['data-on'],
    'false',
    '重渲染后状态同步'
  )

  const sidebarSwitch = walk(findByProp(sTree, 'data-setting', 'sidebarEntry')).find((n) => n.props && n.props.role === 'switch')
  const sidebarBefore = first.records.sidebar.length
  sidebarSwitch.props.onClick()
  eq(first.records.sidebarDisposals, 1, '关掉侧边栏入口时调用了 disposer')
  eq(apiOut.state.settings.sidebarEntry, false, '设置已更新')
  const sidebarSwitch2 = walk(findByProp(renderOf(settingsPanel), 'data-setting', 'sidebarEntry')).find(
    (n) => n.props && n.props.role === 'switch'
  )
  sidebarSwitch2.props.onClick()
  eq(first.records.sidebar.length, sidebarBefore + 1, '再打开时重新注册（立即生效）')

  const concurrency = walk(findByProp(sTree, 'data-setting', 'concurrency')).find((n) => n.props && n.props.type === 'number')
  concurrency.props.onChange({ target: { value: '9' } })
  eq(apiOut.state.settings.concurrency, 2, '并发数被夹到上限 2')
  const retries = walk(findByProp(renderOf(settingsPanel), 'data-setting', 'maxRetries')).find((n) => n.props && n.props.type === 'number')
  retries.props.onChange({ target: { value: '-3' } })
  eq(apiOut.state.settings.maxRetries, 0, '重试次数被夹到下限 0')
  apiOut.state.settings.concurrency = 1

  /* ------------------------------------------------------ 19. 设置恢复 */
  section('19. 重启后恢复设置与历史')
  const storage2 = new Map(first.records.storage)
  storage2.set('settings', { quality: '320', chunkSizeMb: 4, concurrency: 2, sidebarEntry: false, toolbarEntry: true })
  storage2.set('history', [{ id: 'old', name: '旧记录', artist: 'A', quality: '320', bytes: 1234, at: 1, ok: true, url: '' }])
  const second = makeCtx({ storage: storage2 })
  const apiOut2 = await mod.activate(second.ctx)
  eq(apiOut2.state.settings.quality, '320', '恢复音质设置')
  eq(apiOut2.state.settings.chunkSizeMb, 4, '恢复分片大小')
  eq(apiOut2.state.settings.sidebarEntry, false, '恢复侧边栏开关（不注册入口）')
  eq(second.records.sidebar.length, 0, '开关关闭时不注册侧边栏')
  eq(second.records.toolbar.length, 1, '工具栏开关打开时注册入口')
  eq(apiOut2.state.history.length, 1, '恢复历史')
  const third = makeCtx({ storage: new Map([['settings', { quality: 'ломать', chunkSizeMb: 99, concurrency: -5 }]]) })
  const apiOut3 = await mod.activate(third.ctx)
  eq(apiOut3.state.settings.quality, 'auto', '非法音质回落到 auto')
  eq(apiOut3.state.settings.chunkSizeMb, 8, '分片大小被夹到上限 8')
  eq(apiOut3.state.settings.concurrency, 1, '并发数被夹到下限 1')

  /* -------------------------------------------------------- 20. 命令入口 */
  section('20. 命令、dispose 回收')
  const cmd = first.records.commands.find((c) => c.id === 'download-current')
  ok(!!cmd, '注册了下载当前歌曲的命令')
  eq(cmd.meta.title, '下载当前播放的歌曲', '命令有标题')
  first.records.currentTrack.value = FLAC_TRACK
  net.mode = 'range'
  net.file = makeBytes(200 * 1024, 31)
  const beforeCmd = apiOut.state.tasks.length
  cmd.handler()
  await waitFor(() => apiOut.state.tasks.length === beforeCmd + 1, '命令创建了任务')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '命令任务完成')

  // dispose 必须真正中断在跑的任务（用一个大文件确保 dispose 时任务还在跑）
  net.file = makeBytes(3 * 1024 * 1024, 37)
  const preDispose = await apiOut.startDownloads([FLAC_TRACK], 'auto')
  first.records.disposers[0]()
  await waitFor(() => preDispose[0].status === 'canceled' || preDispose[0].status === 'done', 'dispose 后任务收敛')
  eq(preDispose[0].status, 'canceled', 'dispose 把在跑的任务标记为取消')

  await mod.deactivate()
  eq(typeof mod.deactivate, 'function', 'deactivate 可调用')

  /* ------------------------------------------------------------ 21. 长延时压缩 */
  ok(longDelays.length > 0, '确实出现过长延时（已压成 0）', { longDelays })

  /* ------------------------------------------------------------- 收尾 */
  say('\n===== 歌曲下载 smoke =====')
  say('通过：' + pass)
  if (failures.length) {
    say('失败：' + failures.length)
    for (const f of failures) say('  ✗ ' + f)
    process.exitCode = 1
  } else {
    say('全部通过 ✓')
  }
  flushReport()
}

main().catch((e) => {
  say('测试进程异常：' + (e && e.stack ? e.stack : String(e)))
  flushReport()
  process.exitCode = 1
})
