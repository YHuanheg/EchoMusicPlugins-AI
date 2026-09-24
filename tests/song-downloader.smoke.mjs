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

/** DOM 节点带 parentNode 循环引用，直接 JSON.stringify 会炸 —— 断言里可能比较节点，所以兜一层 */
function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '[' + (value && value.constructor ? value.constructor.name : typeof value) + ']'
  }
}

function ok(cond, name, extra) {
  if (cond) {
    pass++
    return true
  }
  failures.push('[' + currentSection + '] ' + name + (extra === undefined ? '' : ' :: ' + safeJson(extra).slice(0, 500)))
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

/** 看门狗：任何环节挂死时也要把已有结果落盘（否则只能被外部 SIGTERM，什么都看不到） */
function startWatchdog(seconds) {
  const t = realSetTimeout(() => {
    say('看门狗触发：流程卡住超过 ' + seconds + 's')
    say('通过：' + pass)
    if (failures.length) {
      say('失败：' + failures.length)
      for (const f of failures) say('  ✗ ' + f)
    }
    flushReport()
    process.exit(1)
  }, seconds * 1000)
  if (t && typeof t.unref === 'function') t.unref()
}

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
 * --------------------------------------------------------------------------
 * 插件真正碰过的 DOM 能力：createElement('a'/'textarea') + body + execCommand
 * （落盘与剪贴板），以及播放栏按钮要用的 querySelector / classList。
 * 这套假 DOM 存在的意义是让「按钮有没有被真的挂上去、被抹掉后会不会补回来」
 * 这类问题能在无头环境里被测到。
 * ========================================================================== */

class FEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this._classes = new Set()
    this.style = {}
    this.dataset = {}
    this._attrs = new Map()
    this._text = ''
    this.value = ''
    this.href = ''
    this.download = ''
    this.rel = ''
    this.disabled = false
    this.clicked = 0
    this.focused = false
    this.selected = false
  }

  get className() {
    return Array.from(this._classes).join(' ')
  }

  set className(value) {
    this._classes = new Set(
      String(value || '')
        .split(/\s+/)
        .filter(Boolean)
    )
  }

  get classList() {
    const self = this
    return {
      add: (...names) => names.forEach((n) => self._classes.add(String(n))),
      remove: (...names) => names.forEach((n) => self._classes.delete(String(n))),
      contains: (n) => self._classes.has(String(n)),
      toggle: (n, force) => {
        const has = self._classes.has(String(n))
        const want = force === undefined ? !has : !!force
        if (want) self._classes.add(String(n))
        else self._classes.delete(String(n))
        return want
      }
    }
  }

  setAttribute(name, value) {
    this._attrs.set(String(name), String(value))
    if (String(name).startsWith('data-')) {
      this.dataset[String(name).slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(value)
    }
  }

  getAttribute(name) {
    return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    this.children.push(child)
    child.parentNode = this
    return child
  }

  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }

  /** 支持 `.cls` 与后代选择器 `.a .b`（插件用到的就这两种） */
  querySelectorAll(selector) {
    const parts = String(selector)
      .trim()
      .split(/\s+/)
      .map((p) => p.replace(/^\./, ''))
      .filter(Boolean)
    if (!parts.length) return []
    let candidates = [this]
    for (const cls of parts) {
      const next = []
      for (const node of candidates) {
        for (const el of descendantsOf(node)) {
          if (el._classes && el._classes.has(cls)) next.push(el)
        }
      }
      if (!next.length) return []
      candidates = next
    }
    return candidates
  }

  get textContent() {
    let out = this._text || ''
    for (const child of this.children) out += child.textContent
    return out
  }

  set textContent(value) {
    this._text = String(value === undefined || value === null ? '' : value)
  }

  focus() {
    this.focused = true
  }

  select() {
    this.selected = true
  }

  click() {
    this.clicked += 1
    doc.clicks.push(this)
  }
}

function descendantsOf(node, out = []) {
  for (const child of node.children || []) {
    out.push(child)
    descendantsOf(child, out)
  }
  return out
}

const doc = {
  body: new FEl('body'),
  head: new FEl('head'),
  documentElement: new FEl('html'),
  clicks: [],
  execCommandFails: false,
  execCommands: [],
  keyHandlers: [],
  createElement(tag) {
    return new FEl(tag)
  },
  querySelector(selector) {
    return doc.body.querySelector(selector)
  },
  querySelectorAll(selector) {
    return doc.body.querySelectorAll(selector)
  },
  addEventListener(type, fn) {
    if (type === 'keydown') doc.keyHandlers.push(fn)
  },
  removeEventListener(type, fn) {
    if (type === 'keydown') {
      const i = doc.keyHandlers.indexOf(fn)
      if (i >= 0) doc.keyHandlers.splice(i, 1)
    }
  },
  /** 模拟按下按键（走插件注册的全局 keydown 监听） */
  pressKey(key, extra) {
    const ev = { key, ctrlKey: false, metaKey: false, prevented: 0, stopped: 0, preventDefault() { this.prevented += 1 }, stopPropagation() { this.stopped += 1 }, ...(extra || {}) }
    for (const fn of doc.keyHandlers.slice()) fn(ev)
    return ev
  },
  execCommand(cmd) {
    if (cmd === 'copy') {
      doc.execCommands.push(cmd)
      return !doc.execCommandFails
    }
    return false
  }
}

/** MutationObserver 替身：记录实例，测试里手动触发回调 */
const observers = []
class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb
    this.active = false
    this.options = null
    this.target = null
    observers.push(this)
  }
  observe(target, options) {
    this.active = true
    this.target = target
    this.options = options
  }
  disconnect() {
    this.active = false
  }
  trigger() {
    if (this.active) this.cb([], this)
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
defineGlobal('MutationObserver', FakeMutationObserver)

// 插件在 activate 里会起轮询（心跳 500ms / 播放栏 1.5s），全部记账，收尾时统一清掉，
// 否则进程会一直挂着不退出。
const liveIntervals = []
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, ms, ...rest) => {
  const id = realSetInterval(fn, ms, ...rest)
  liveIntervals.push(id)
  return id
}
globalThis.clearInterval = (id) => {
  const i = liveIntervals.indexOf(id)
  if (i >= 0) liveIntervals.splice(i, 1)
  return realClearInterval(id)
}
function clearAllIntervals() {
  for (const id of liveIntervals.splice(0)) realClearInterval(id)
}

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
  failPattern: null, // 命中该正则的 URL 直接 500（用来测「宿主地址失效 → 回退 /song/url」）
  async request(opts) {
    const call = { url: opts.url, headers: opts.headers || {}, responseType: opts.responseType, maxResponseBytes: opts.maxResponseBytes }
    net.calls.push(call)
    const index = net.calls.length
    if (net.failPattern && net.failPattern.test(String(opts.url))) return { status: 500, headers: {}, data: abOf(Buffer.from('host stale')) }
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

/** 宿主「任务中心」的条目句柄（照抄真实语义：start 只能从 pending 进、finish 只写状态、dismiss 置为失效） */
function makeTaskHandle(def, records) {
  const calls = { start: [], update: [], finish: [], dismiss: 0 }
  const handle = {
    def,
    calls,
    active: true,
    entry: { ...def, generation: ++records.taskGens },
    start(patch) {
      if (handle.entry.status !== 'pending') return false
      calls.start.push(patch || {})
      Object.assign(handle.entry, patch || {}, { status: 'running' })
      return true
    },
    update(patch) {
      if (!handle.active) return false
      calls.update.push(patch || {})
      Object.assign(handle.entry, patch || {})
      return true
    },
    finish(status, patch) {
      calls.finish.push({ status, patch: patch || {} })
      Object.assign(handle.entry, patch || {}, { status })
      return true
    },
    dismiss() {
      calls.dismiss += 1
      handle.active = false
    },
    cancel() {
      handle.active = false
      return true
    }
  }
  return handle
}

/**
 * 宿主的任务定义校验（与 asar 里的实现等价）：
 * - id 不能为空、不能以 `echo:` 开头（保留给内置任务）
 * - status 必须是那五个之一（否则宿主内部读 terminalPolicy[status] 会炸）
 * - **retention 必填**：'transient' / 'action-required' / 每个终止态各写 {mode,delayMs}
 * 把校验写进 mock 是有意的 —— 不然「漏了 retention」这种真机会直接抛错的 bug 测不出来。
 */
function validateTaskDef(def) {
  if (!def || typeof def !== 'object') throw new TypeError('任务定义无效')
  if (!def.id) throw new TypeError('任务 ID 不能为空')
  if (String(def.id).startsWith('echo:')) throw new Error('插件不能注册保留任务 ID: ' + def.id)
  if (!['pending', 'running', 'completed', 'error', 'aborted'].includes(def.status)) throw new TypeError('任务状态无效: ' + def.status)
  const r = def.retention
  if (r === 'transient' || r === 'action-required') return
  for (const t of ['completed', 'error', 'aborted']) {
    const v = r && r[t]
    if (v && v.mode === 'manual') continue
    if (!v || v.mode !== 'auto' || !Number.isFinite(v.delayMs) || v.delayMs < 0) throw new TypeError('任务 ' + t + ' 保留策略无效')
  }
}

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
    teleports: [],
    teleportDisposals: 0,
    mounts: [],
    mountDisposals: 0,
    observes: [],
    verifyCalls: [],
    verifyMode: 'ok',
    resolveCalls: [],
    resolveResult: null,
    resolveThrows: false,
    taskDefs: [],
    taskHandles: [],
    taskGens: 0,
    sidebarDisposals: 0,
    toolbarDisposals: 0,
    disposers: []
  }
  const currentTrack = V.ref(o.currentTrack === undefined ? FLAC_TRACK : o.currentTrack)
  // 播放器 store：宿主把「当前曲目已解析好的播放地址」放在这里（currentAudioUrl 等）。
  // 默认留空 —— 这样老用例走的还是「自己请求 /song/url」那条路；要测「复用宿主地址」再显式设置。
  const playerState = {
    currentTrackId: '',
    currentAudioUrl: '',
    currentAudioCandidateUrls: [],
    currentResolvedAudioQuality: null
  }
  /** 宿主播放器 store 上的纯解析器（只解析、不播放）：插件可以借它拿到可播地址 */
  playerState.resolveAudioUrl = async (track, options) => {
    records.resolveCalls.push({ track, options })
    if (records.resolveThrows) throw new Error('宿主解析炸了')
    return records.resolveResult
  }
  // 播放栏容器（宿主那边是 `.player-actions` 右侧动作区）。
  // 默认**不**建：真实场景里它是后出现的，插件必须先等宿主把页面渲染出来。
  if (o.withBarHost) {
    const host = doc.createElement('div')
    host.className = 'player-actions'
    doc.body.appendChild(host)
    records.barHost = host
  }
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
      },
      /** 宿主把浮层组件挂到 document.body（.echo-plugin-teleport） */
      teleport(component, options) {
        const entry = { component, options, disposed: false }
        records.teleports.push(entry)
        // 真实宿主会用独立 app 实例渲染到 body；这里塞一个占位节点表示「已挂载」
        const holder = doc.createElement('div')
        holder.className = 'echo-plugin-teleport'
        doc.body.appendChild(holder)
        return () => {
          entry.disposed = true
          records.teleportDisposals += 1
          holder.remove()
        }
      },
      /** 宿主把组件挂进某个 DOM 容器（.player-actions 等） */
      mount(host, component, options) {
        const entry = { host, component, options }
        const marker = doc.createElement('div')
        marker.className = 'sd-bar-btn'
        host.appendChild(marker)
        entry.marker = marker
        try {
          entry.vnode = component.setup({}, {})()
        } catch (e) {
          entry.renderError = e
        }
        records.mounts.push(entry)
        return () => {
          entry.disposed = true
          records.mountDisposals += 1
          marker.remove()
        }
      }
    },
    dom: {
      observe(selector, cb) {
        const entry = { selector, cb, disposed: false }
        records.observes.push(entry)
        return () => {
          entry.disposed = true
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
      get player() {
        return playerState
      },
      playlist: {
        get activeQueue() {
          return { songs: queueRef.value }
        }
      }
    },
    electron: { platform: 'win32', api },
    tasks: {
      register(def) {
        validateTaskDef(def)
        const handle = makeTaskHandle(def, records)
        records.taskDefs.push(def)
        records.taskHandles.push(handle)
        return handle
      }
    },
    kugouVerification: o.noVerifyApi
      ? undefined
      : {
          async request(eventId) {
            records.verifyCalls.push(String(eventId))
            const mode = records.verifyMode
            if (mode === 'throw') throw new Error('安全验证通道异常')
            if (mode === 'cancel') return { ok: false, error: '已取消安全验证', canceled: true }
            if (mode === 'fail') return { ok: false, error: '验证码错误' }
            return { ok: true, eventId: String(eventId) }
          }
        },
    net,
    dispose(fn) {
      records.disposers.push(fn)
    }
  }
  records.setQueue = (list) => {
    queueRef.value = list
  }
  records.playerState = playerState
  records.setPlayerState = (patch) => Object.assign(playerState, patch)
  records.resetPlayerState = () =>
    Object.assign(playerState, { currentTrackId: '', currentAudioUrl: '', currentAudioCandidateUrls: [], currentResolvedAudioQuality: null })
  records.queueRef = queueRef
  records.storage = storage
  records.currentTrack = currentTrack
  records.ctx = ctx
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

/** 按 data-group + data-value 找选项 chip（音质 / 保存位置） */
function findOption(tree, group, value) {
  return walk(tree).find((n) => n.props && n.props['data-group'] === group && n.props['data-value'] === value) || null
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
  startWatchdog(60)
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
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'song-downloader', 'manifest.json'), 'utf8'))
    eq(manifest.capabilities.kugouVerification, true, 'manifest 声明了酷狗安全验证能力（否则 ctx 直接抛错）')
    eq(manifest.capabilities.unrestrictedNetwork, true, 'manifest 声明了原生网络能力')
  }

  const page = first.records.pages[0].component
  const settingsPanel = first.records.settings[0].component
  const dialogComponent = first.records.teleports[0] && first.records.teleports[0].component
  eq(!!dialogComponent, true, '下载确认框已 teleport 到 body')
  eq(first.records.teleports[0].options.className, 'sd-teleport', 'teleport 带了插件自己的类名')

  section('3b. 播放栏按钮：主栏 / 歌词页 / 挂载时机与去重')
  eq(first.records.observes.length >= 1, true, '监听了播放栏容器')
  eq(first.records.observes[0].selector, '.player-actions', '监听的是播放栏右侧动作区')
  eq(
    first.records.observes.map((o) => o.selector).includes('.lyric-bar'),
    true,
    '也监听了歌词页底栏（歌词页打开时才出现）'
  )
  eq(first.records.mounts.length, 0, '宿主页面还没出现时不会盲目挂载')
  const barHost = doc.createElement('div')
  barHost.className = 'player-actions'
  doc.body.appendChild(barHost)
  first.records.barHost = barHost
  first.records.observes[0].cb()
  eq(first.records.mounts.length, 1, '宿主出现后挂上按钮')
  eq(first.records.mounts[0].host, first.records.barHost, '挂进的是 .player-actions')
  eq(first.records.barHost.querySelector('.sd-bar-btn') !== null, true, '宿主容器里能看到按钮节点')
  first.records.observes[0].cb()
  eq(first.records.mounts.length, 1, '重复回调不会挂第二个（去重）')

  // 歌词页底栏：挂进 .lyric-bar .bar-right（宿主样式会把里面的 button 刷成白色）
  const lyricBar = doc.createElement('div')
  lyricBar.className = 'lyric-bar'
  const lyricRight = doc.createElement('div')
  lyricRight.className = 'bar-right'
  lyricBar.appendChild(lyricRight)
  doc.body.appendChild(lyricBar)
  await first.records.observes.find((o) => o.selector === '.lyric-bar').cb()
  eq(first.records.mounts.length, 2, '歌词页底栏也挂上了按钮')
  eq(first.records.mounts[1].host, lyricRight, '挂在 .lyric-bar .bar-right 里（不是整个歌词栏）')
  eq(lyricRight.querySelector('.sd-bar-btn') !== null, true, '歌词页底栏能看到按钮')
  await first.records.observes.find((o) => o.selector === '.lyric-bar').cb()
  eq(first.records.mounts.length, 2, '歌词页重复回调也只挂一个')

  // 歌词页关掉（容器消失）→ 按钮跟着收掉
  const mountsBeforeClose = first.records.mounts.length
  const disposalsBefore = first.records.mountDisposals
  lyricBar.remove()
  await first.records.observes.find((o) => o.selector === '.lyric-bar').cb()
  eq(first.records.mountDisposals, disposalsBefore + 1, '歌词页关闭时卸载了那一组按钮')
  eq(first.records.mounts.length, mountsBeforeClose, '不会再往不存在的主机里挂')
  doc.body.appendChild(lyricBar)

  // 宿主原地重渲会把节点抹掉：MutationObserver 兜底要能补回来
  first.records.mounts[0].marker.remove()
  eq(first.records.barHost.querySelector('.sd-bar-btn'), null, '模拟宿主把按钮抹掉')
  const barObserver = observers.find((o) => o.active && o.options && o.options.subtree)
  ok(!!barObserver, '注册了 MutationObserver 兜底')
  barObserver.trigger()
  await new Promise((r) => realSetTimeout(r, 260))
  ok(first.records.mounts.length >= mountsBeforeClose, '节点被抹掉后自动补挂', { mounts: first.records.mounts.length })
  eq(first.records.barHost.querySelector('.sd-bar-btn') !== null, true, '主栏按钮回来了')
  eq(lyricRight.querySelector('.sd-bar-btn') !== null, true, '歌词页按钮也在位')

  /* -------------------------------------------------- 4. 无歌 / 空队列的降级 */
  section('4. 没有在播歌曲时的降级')
  // 后面的下载流程要先关掉确认框（它默认是开的，会拦住所有一键下载）。
  // 确认框本身在第 22 段单独测。
  apiOut.state.settings.confirmBeforeDownload = false
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
  eq(countByProp(sTree, 'role', 'switch'), 9, '9 个开关（确认框/宿主地址/任务中心/分片/完成提示/侧边栏/工具栏/播放栏/调试）')

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

  // 注意：dispose 会摘掉全局 keydown 监听，所以「回收」放到最后一段再测（见 25）
  const runsBeforeDispose = apiOut.state.tasks.length
  ok(runsBeforeDispose > 0, 'dispose 之前累积了任务', { count: runsBeforeDispose })

  /* ------------------------------------------------------------ 21. 长延时压缩 */
  ok(longDelays.length > 0, '确实出现过长延时（已压成 0）', { longDelays })

  /* -------------------------------------------------- 21. 设置页滚动契约 */
  section('21. 设置页必须交给宿主滚动（CSS 契约）')
  {
    const cssPath = process.env.SD_CSS_ENTRY ? path.resolve(process.env.SD_CSS_ENTRY) : path.join(ROOT, 'song-downloader', 'style.css')
    const css = fs.readFileSync(cssPath, 'utf8')
    const blockOf = (selector) => {
      const i = css.indexOf('\n' + selector + ' {')
      if (i < 0) return null
      const end = css.indexOf('}', i)
      return css.slice(i, end)
    }
    const settings = blockOf('.sd-settings')
    const pageBlock = blockOf('.sd-page')
    ok(!!settings, '找得到 .sd-settings 规则')
    ok(!!pageBlock, '找得到 .sd-page 规则')
    // 这就是 1.0.0 的 bug：设置根节点自带 height:100% + overflow-y:auto，
    // 在宿主的弹窗滚动容器里会变成「自己高度=内容高度 → 谁也不滚」。
    eq(/height\s*:\s*100%/.test(settings), false, '设置根节点不能写 height:100%（否则宿主弹窗里整页滚不动）')
    eq(/overflow-y\s*:\s*auto/.test(settings), false, '设置根节点不能自带纵向滚动')
    eq(/overflow\s*:\s*(auto|scroll)/.test(settings), false, '设置根节点不能自带滚动')
    eq(/height\s*:\s*100%/.test(pageBlock), true, '插件页仍要按宿主约定自己滚（.plugin-page-host 有确定高度）')
    eq(/overflow-y\s*:\s*auto/.test(pageBlock), true, '插件页自己当滚动容器')
    includes(css, '.plugin-page-host', 'CSS 里写明了宿主容器语义（防止后人又合并这两条规则）')
  }

  /* -------------------------------------------------- 22. 下载确认框 */
  section('22. 下载确认框：内容、选项与开关')
  apiOut.state.settings.confirmBeforeDownload = true
  apiOut.state.settings.quality = 'auto'
  first.records.currentTrack.value = FLAC_TRACK
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '先等任务收敛')
  const tasksBeforeDlg = apiOut.state.tasks.length

  tree = renderOf(page)
  await findByProp(tree, 'data-action', 'download-current').props.onClick()
  eq(apiOut.state.tasks.length, tasksBeforeDlg, '弹确认框时不直接开下')
  eq(apiOut.dlg.open, true, '确认框已打开')
  eq(apiOut.dlg.tracks.length, 1, '带上了 1 首歌')

  let dTree = renderOf(dialogComponent)
  eq(findByProp(dTree, 'data-role', 'download-dialog') !== null, true, '渲染出遮罩 + 弹窗')
  includes(textOf(dTree), '下载歌曲', '标题为「下载歌曲」')
  includes(textOf(dTree), '涂一乐', '显示了歌手')
  includes(
    walk(dTree)
      .filter((n) => n.props && n.props['data-group'] === 'quality')
      .map((n) => n.children)
      .join('|'),
    '自动（最优可用）',
    '音质选项里有「自动」'
  )
  eq(findAllByProp(dTree, 'data-group', 'quality').length, 6, '6 档音质')
  eq(findAllByProp(dTree, 'data-group', 'dest').length, 2, '2 个保存位置选项')
  eq(findByProp(dTree, 'data-role', 'dlg-preview') !== null, true, '渲染了文件名预览')
  includes(textOf(dTree), '将保存为：', '预览文案')
  includes(textOf(dTree), '涂一乐 - 花落叹', '预览里是模板生成的文件名')
  includes(textOf(dTree), '系统下载目录', '说明保存位置')
  eq(propOf(dTree, 'data-action', 'dlg-remember', 'aria-checked'), 'true', '「记住这些选项」默认勾选')

  // 换音质 → 预览的扩展名跟着变
  await findOption(dTree, 'quality', '320').props.onClick()
  eq(apiOut.dlg.quality, '320', '音质切到 320')
  dTree = renderOf(dialogComponent)
  includes(textOf(dTree), '.mp3', '预览扩展名跟着音质变')
  await findOption(dTree, 'quality', 'flac').props.onClick()
  eq(apiOut.dlg.quality, 'flac', '音质切回 flac')

  // 「选择位置…」→ 走系统保存对话框（单曲）
  const writtenDlg = []
  window.showSaveFilePicker = async (opts) => {
    pickerCalls += 1
    window.__dlgPicker = opts
    return {
      name: 'D:/音乐/' + opts.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            writtenDlg.push(Buffer.from(await blob.arrayBuffer()))
          },
          async close() {}
        }
      }
    }
  }
  net.mode = 'range'
  net.file = makeBytes(420 * 1024, 43)
  pickerCalls = 0
  await findOption(renderOf(dialogComponent), 'dest', 'picker').props.onClick()
  eq(apiOut.dlg.destination, 'picker', '切到「选择位置」')
  eq(pickerCalls, 0, '此刻**不**弹系统对话框（否则解析失败会留下 0 KB 空文件）')
  dTree = renderOf(dialogComponent)
  includes(textOf(dTree), '先解析播放地址', '界面写明了「先解析、再弹对话框」的顺序')

  // 开始下载：先解析 → 再弹保存对话框 → 复用解析结果下载（不重复请求）
  api.calls.length = 0
  await findByProp(dTree, 'data-action', 'dlg-confirm').props.onClick()
  await waitFor(() => apiOut.state.tasks.length === tasksBeforeDlg + 1, '创建了任务')
  eq(pickerCalls, 1, '点确认时才弹系统保存对话框')
  eq(apiOut.dlg.open, false, '确认后关闭弹窗')
  eq(api.calls.length, 1, '确认阶段解析了一次，执行任务时复用（省掉重复请求）')
  eq(api.calls[0].params.quality, 'flac', '用弹窗里选的音质请求地址')
  const dlgTask = apiOut.state.tasks[apiOut.state.tasks.length - 1]
  await waitFor(() => dlgTask.status === 'done', '弹窗发起的任务完成')
  eq(dlgTask.saveMethod, 'picker', '用弹窗里选的保存位置落盘')
  eq(writtenDlg.length, 1, '写入到用户选的位置')
  eq(writtenDlg[0].equals(net.file), true, '写入字节正确')
  eq(apiOut.state.settings.quality, 'flac', '「记住这些选项」把音质写回了设置')
  eq(first.records.storage.get('settings').quality, 'flac', '并持久化')
  delete window.showSaveFilePicker

  // 取消：不产生任何任务
  const beforeCancel2 = apiOut.state.tasks.length
  tree = renderOf(page)
  await findByProp(tree, 'data-action', 'download-current').props.onClick()
  dTree = renderOf(dialogComponent)
  await findByProp(dTree, 'data-action', 'dlg-cancel').props.onClick()
  eq(apiOut.dlg.open, false, '取消后关闭')
  eq(apiOut.state.tasks.length, beforeCancel2, '取消不创建任务')

  // Esc / Ctrl+Enter / 点遮罩
  await findByProp(renderOf(page), 'data-action', 'download-current').props.onClick()
  eq(apiOut.dlg.open, true, '再次打开')
  const escEv = doc.pressKey('Escape')
  eq(apiOut.dlg.open, false, 'Esc 关闭确认框')
  eq(escEv.prevented, 1, 'Esc 被 preventDefault')
  await findByProp(renderOf(page), 'data-action', 'download-current').props.onClick()
  const beforeEscTask = apiOut.state.tasks.length
  doc.pressKey('Enter', { ctrlKey: true })
  eq(apiOut.dlg.open, false, 'Ctrl+Enter 直接开始下载')
  eq(apiOut.state.tasks.length, beforeEscTask + 1, 'Ctrl+Enter 创建了任务')
  await findByProp(renderOf(page), 'data-action', 'download-current').props.onClick()
  dTree = renderOf(dialogComponent)
  const mask = findByProp(dTree, 'data-role', 'download-dialog')
  mask.props.onClick({ target: mask, currentTarget: mask })
  eq(apiOut.dlg.open, false, '点遮罩关闭')
  eq(first.records.teleportDisposals >= 0, true, 'teleport 有卸载入口')

  // 关掉「记住」就不写回设置
  apiOut.state.settings.quality = 'auto'
  tree = renderOf(page)
  await findByProp(tree, 'data-action', 'download-current').props.onClick()
  dTree = renderOf(dialogComponent)
  await findOption(dTree, 'quality', '128').props.onClick()
  await findByProp(renderOf(dialogComponent), 'data-action', 'dlg-remember').props.onClick()
  await findByProp(renderOf(dialogComponent), 'data-action', 'dlg-confirm').props.onClick()
  eq(apiOut.state.settings.quality, 'auto', '关掉「记住」后设置不被改写')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '任务收敛')

  // 批量：带多首歌 + 「选择位置」不可用
  first.records.setQueue([FLAC_TRACK, LOW_TRACK])
  await tick()
  const multi = apiOut.openDownloadDialog([FLAC_TRACK, LOW_TRACK])
  eq(multi.tracks.length, 2, '批量带 2 首')
  dTree = renderOf(dialogComponent)
  includes(textOf(dTree), '下载 2 首歌', '标题显示数量')
  eq(findOption(dTree, 'dest', 'picker').props.disabled, true, '批量下载时「选择位置」被禁用')
  eq(findOption(dTree, 'dest', 'downloads').props['aria-checked'], 'true', '默认落在系统下载目录')
  eq(findAllByProp(dTree, 'data-action', 'dlg-confirm')[0].children, '开始下载（2）', '按钮显示数量')
  apiOut.closeDownloadDialog()
  eq(apiOut.dlg.open, false, 'closeDownloadDialog 可关闭')

  // 上游不支持时（云盘歌）直接提示、不弹框
  first.records.currentTrack.value = CLOUD_TRACK
  const toastsBefore = first.records.toasts.length
  await apiOut.downloadCurrent()
  eq(apiOut.dlg.open, false, '云盘歌曲不弹确认框')
  ok(first.records.toasts.length > toastsBefore, '给出原因提示')
  first.records.currentTrack.value = FLAC_TRACK

  /* -------------------------------------------------- 23. 播放栏按钮行为 */
  section('23. 播放栏按钮：点击 / 置灰 / 开关')
  const barEntry = first.records.mounts[first.records.mounts.length - 1]
  const barTree = barEntry.vnode
  const barBtn = findByProp(barTree, 'data-action', 'download-current-bar')
  ok(!!barBtn, '按钮 vnode 找得到')
  eq(barBtn.props.disabled, false, '有歌在播时可点')
  eq(typeof barBtn.props.title, 'string', '带 tooltip')
  const barSvg = walk(barTree).filter((n) => n.type === 'svg')
  eq(barSvg.length >= 1, true, '用了内联 SVG 图标（不依赖宿主 icons）')

  apiOut.state.settings.confirmBeforeDownload = true
  await barBtn.props.onClick({ stopPropagation() {} })
  eq(apiOut.dlg.open, true, '点播放栏按钮会拉起确认框')
  apiOut.closeDownloadDialog()

  first.records.currentTrack.value = null
  const barTree2 = barEntry.component.setup({}, {})()
  eq(findByProp(barTree2, 'data-action', 'download-current-bar').props.disabled, true, '没歌在播时置灰')
  includes(String(findByProp(barTree2, 'data-action', 'download-current-bar').props.title), '没有正在播放', '置灰时说明原因')
  first.records.currentTrack.value = FLAC_TRACK

  const mountsBefore = first.records.mounts.length
  apiOut.state.settings.confirmBeforeDownload = false
  const panelTree = renderOf(settingsPanel)
  const barSwitch = walk(findByProp(panelTree, 'data-setting', 'playerBarButton')).find((n) => n.props && n.props.role === 'switch')
  eq(!!barSwitch, true, '设置里有播放栏开关')
  barSwitch.props.onClick()
  eq(apiOut.state.settings.playerBarButton, false, '关掉播放栏按钮')
  eq(first.records.barHost.querySelector('.sd-bar-btn'), null, '节点被移除')
  eq(first.records.mountDisposals >= 1, true, '调用了卸载函数')
  const switch2 = walk(findByProp(renderOf(settingsPanel), 'data-setting', 'playerBarButton')).find((n) => n.props && n.props.role === 'switch')
  switch2.props.onClick()
  eq(apiOut.state.settings.playerBarButton, true, '再打开')
  await tick()
  ok(first.records.mounts.length >= mountsBefore + 1, '重新挂载', { mounts: first.records.mounts.length, mountsBefore })
  eq(first.records.barHost.querySelector('.sd-bar-btn') !== null, true, '主播放栏按钮又回来了')
  eq(doc.querySelector('.lyric-bar .bar-right').querySelector('.sd-bar-btn') !== null, true, '歌词页底栏按钮也回来了')
  // 恢复默认值，下一段要验「确认框默认开启」
  apiOut.state.settings.confirmBeforeDownload = true

  /* -------------------------------------------------- 24. 确认框开关生效 */
  section('24. 设置里的「下载前弹确认框」真的生效')
  const confirmSwitch = walk(findByProp(renderOf(settingsPanel), 'data-setting', 'confirmBeforeDownload')).find(
    (n) => n.props && n.props.role === 'switch'
  )
  ok(!!confirmSwitch, '设置里有确认框开关')
  eq(confirmSwitch.props['aria-checked'], 'true', '默认开启')
  confirmSwitch.props.onClick()
  eq(apiOut.state.settings.confirmBeforeDownload, false, '关掉确认框')
  tree = renderOf(page)
  const beforeNoDlg = apiOut.state.tasks.length
  await findByProp(tree, 'data-action', 'download-current').props.onClick()
  eq(apiOut.dlg.open, false, '关掉后不再弹框')
  eq(apiOut.state.tasks.length, beforeNoDlg + 1, '直接开始下载')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '任务收敛')

  /* -------------------------------------------------- 26. 酷狗安全验证 */
  section('26. 安全验证：唤起验证弹窗 → 重试')
  eq(I.verificationEventId({ body: { ssaCode: 'EV1', error_code: 20028, status: 0 } }), 'EV1', 'body.ssaCode + 20028 → 需要验证')
  eq(I.verificationEventId({ body: { ssaCode: 'EV1', status: 0 } }), 'EV1', 'status=0 也算请求失败')
  eq(I.verificationEventId({ body: { ssaCode: 'EV1', status: 1, error_code: 0 } }), '', '成功响应里的 ssaCode 不触发验证')
  eq(I.verificationEventId({ headers: { 'ssa-code': 'EV2' }, body: { status: 0 } }), 'EV2', '响应头 ssa-code 也认')
  eq(I.verificationEventId({ body: { status: 0, data: { event_id: 'EV3' } } }), 'EV3', 'body.data.event_id 兜底')
  eq(I.verificationEventId({ body: { status: 0 } }), '', '没有事件标识就不弹窗')
  includes(I.describeFailure({ msg: '本次请求需要验证' }, 502, 0), '安全验证弹窗', '风控文案给出下一步指引')

  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '先等任务收敛')
  net.mode = 'range'
  net.file = makeBytes(320 * 1024, 47)
  first.records.currentTrack.value = FLAC_TRACK
  first.records.verifyCalls.length = 0
  first.records.verifyMode = 'ok'
  let verifyPhase = 0
  api.handler = () => {
    verifyPhase += 1
    if (verifyPhase === 1) {
      return { status: 502, body: { status: 0, error_code: 20028, ssaCode: 'EV-FLOW', msg: '本次请求需要验证' } }
    }
    return okBody('flac')
  }
  api.calls.length = 0
  const vTask = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => vTask.status === 'done' || vTask.status === 'failed', '验证流程结束')
  eq(vTask.status, 'done', '验证通过后原样重试成功')
  eq(first.records.verifyCalls.join(','), 'EV-FLOW', '用响应里的事件标识唤起验证')
  eq(api.calls.length >= 2, true, '验证后确实重试了请求', { calls: api.calls.length })
  eq(vTask.needsVerify, false, '成功后不标记需要验证')

  // 取消验证 → 明确失败，并标记 needsVerify（界面会提示「点重试会再唤起验证」）
  api.handler = () => ({ status: 502, body: { status: 0, error_code: 20028, ssaCode: 'EV-CANCEL', msg: '本次请求需要验证' } })
  first.records.verifyMode = 'cancel'
  first.records.verifyCalls.length = 0
  const vCancel = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => vCancel.status === 'failed', '取消验证后失败')
  includes(vCancel.error, '已取消安全验证', '取消文案明确')
  eq(vCancel.needsVerify, true, '任务被标记为需要验证')
  eq(vCancel.attempts, 3, '三档音质都试过（attempts 被记录，便于诊断）')
  eq(first.records.verifyCalls.length, 1, '同一轮只弹一次验证弹窗（不会每档音质都弹）')
  tree = renderOf(page)
  eq(findByProp(tree, 'data-role', 'needs-verify') !== null, true, '任务行显示「需要安全验证」提示')

  // 宿主没有验证能力 → 直接说明原因，不要静默失败
  first.records.verifyMode = 'ok'
  const savedVerifyApi = first.ctx.kugouVerification
  delete first.ctx.kugouVerification
  const vNoApi = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => vNoApi.status === 'failed', '没有验证能力时失败')
  includes(vNoApi.error, '未提供安全验证通道', '提示宿主能力缺失')
  first.ctx.kugouVerification = savedVerifyApi

  // 验证通过后仍被要求验证 → 不重复弹窗
  first.records.verifyCalls.length = 0
  api.handler = () => ({ status: 502, body: { status: 0, error_code: 20028, ssaCode: 'EV-AGAIN', msg: '本次请求需要验证' } })
  const vAgain = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => vAgain.status === 'failed', '反复要求验证时失败')
  eq(first.records.verifyCalls.length, 1, '同一轮只弹一次验证')
  includes(vAgain.error, '仍要求验证', '文案说明已验过仍被拦')
  api.handler = null

  /* -------------------------------------------------- 27. 失败不留 0 KB 空文件 */
  section('27. 失败不留 0 KB 空文件')
  const removed = { count: 0 }
  window.showSaveFilePicker = async (opts) => {
    pickerCalls += 1
    return {
      name: 'D:/音乐/' + opts.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            void blob
          },
          async close() {}
        }
      },
      async remove() {
        removed.count += 1
      }
    }
  }

  // ① 「另存为…」：解析失败 → 根本不弹保存对话框
  pickerCalls = 0
  api.handler = () => failBody(20010)
  const asFail = await apiOut.downloadCurrentAs()
  eq(asFail, null, '解析失败时不创建任务')
  eq(pickerCalls, 0, '解析失败时不弹保存对话框（所以不会留下空文件）')
  includes(JSON.stringify(first.records.toasts), '没有创建任何文件', '明确告诉用户没创建文件')

  // ② 确认框里选「选择位置」+ 解析失败 → 不弹对话框、弹窗留着报错
  apiOut.state.settings.confirmBeforeDownload = true
  tree = renderOf(page)
  await findByProp(tree, 'data-action', 'download-current').props.onClick()
  eq(apiOut.dlg.open, true, '确认框打开')
  pickerCalls = 0
  await findOption(renderOf(dialogComponent), 'dest', 'picker').props.onClick()
  const before2 = apiOut.state.tasks.length
  await findByProp(renderOf(dialogComponent), 'data-action', 'dlg-confirm').props.onClick()
  await waitFor(() => String(apiOut.dlg.error).includes('解析失败'), '弹窗里出现解析失败')
  eq(pickerCalls, 0, '解析失败时不弹保存对话框')
  eq(apiOut.dlg.open, true, '弹窗留着，让用户改完设置再试')
  eq(apiOut.dlg.busy, false, '失败后 busy 复位')
  eq(apiOut.state.tasks.length, before2, '没有创建任务')
  apiOut.closeDownloadDialog()

  // ③ 解析成功、下载却失败 → 把 picker 已经建出来的空文件删掉
  pickerCalls = 0
  removed.count = 0
  api.handler = () => okBody('flac')
  net.mode = 'http500'
  const asClean = await apiOut.downloadCurrentAs()
  await waitFor(() => asClean && (asClean.status === 'failed' || asClean.status === 'done'), '失败流程收敛')
  eq(pickerCalls, 1, '解析成功后正常弹了保存对话框')
  eq(asClean.status, 'failed', '下载失败')
  eq(removed.count, 1, '失败时删掉了 picker 建出的空文件')
  includes(asClean.error, '已清理失败留下的空文件', '任务行说明已清理')
  net.mode = 'range'
  api.handler = null

  // ④ 成功路径不能误删文件
  removed.count = 0
  net.file = makeBytes(200 * 1024, 53)
  const asOk = await apiOut.downloadCurrentAs()
  await waitFor(() => asOk && asOk.status === 'done', '成功路径')
  eq(removed.count, 0, '成功时不动用户的文件')
  eq(asOk.saveMethod, 'picker', '仍然写进用户选的位置')
  delete window.showSaveFilePicker
  apiOut.state.settings.confirmBeforeDownload = false

  /* -------------------------------------------------- 28. 复用宿主已解析地址 */
  section('28. 复用宿主已解析的播放地址（避开风控）')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '先等任务收敛')
  first.records.currentTrack.value = FLAC_TRACK
  apiOut.state.settings.confirmBeforeDownload = false
  apiOut.state.settings.preferHostUrl = true
  apiOut.state.settings.quality = 'auto'
  api.handler = null
  net.mode = 'range'
  net.failPattern = null
  net.file = makeBytes(360 * 1024, 59)

  // 播放器 store 里就是宿主已经解析好的地址
  first.records.setPlayerState({
    currentTrackId: String(FLAC_TRACK.id),
    currentAudioUrl: 'https://cdn.test/host-stream.flac',
    currentAudioCandidateUrls: ['https://cdn.test/host-backup.flac'],
    currentResolvedAudioQuality: 'flac'
  })

  api.calls.length = 0
  net.calls.length = 0
  tree = renderOf(page)
  await findByProp(tree, 'data-action', 'download-current').props.onClick()
  await waitFor(() => apiOut.state.tasks.length > 0 && apiOut.state.tasks[apiOut.state.tasks.length - 1].status === 'done', '走宿主地址的任务完成')
  const hostTask = apiOut.state.tasks[apiOut.state.tasks.length - 1]
  eq(api.calls.length, 0, '完全不请求 /song/url（所以也不会碰风控）')
  eq(hostTask.source, 'host', '标记音源 = 宿主地址')
  eq(hostTask.actualQuality, 'flac', '音质取宿主已解析的那档')
  eq(hostTask.bytes, net.file.length, '字节数正确')
  eq(String(hostTask.directUrl).startsWith('https://cdn.test/host-stream'), true, '用的就是播放器正在播的地址')
  eq(net.calls.length >= 1, true, '直接从 CDN 取字节')
  includes(String(net.calls[0].url), 'host-stream', '第一次请求就是宿主地址')
  tree = renderOf(page)
  includes(textOf(tree), '音源：宿主播放器已解析的地址', '任务行写明了音源')
  eq(findByProp(tree, 'data-role', 'task-source') !== null, true, '任务行有音源标记')

  // 关掉这个开关 → 回到自己请求 /song/url
  apiOut.state.settings.preferHostUrl = false
  api.calls.length = 0
  const apiTask = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => apiTask.status === 'done', '关掉开关后走接口')
  eq(api.calls.length >= 1, true, '关掉后重新请求 /song/url')
  eq(apiTask.source, 'api', '音源标记回 api')
  apiOut.state.settings.preferHostUrl = true

  // 请求的音质比宿主已解析的更高 → 不能偷懒，老老实实去请求
  first.records.setPlayerState({ currentResolvedAudioQuality: '320' })
  api.calls.length = 0
  const higherTask = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => higherTask.status === 'done', '高音质请求完成')
  eq(api.calls.length >= 1, true, '要 FLAC 而宿主只有 320K 时仍然去请求上游')
  eq(higherTask.source, 'api', '音源标记 api')

  // 宿主地址失效（比如早就过期）→ 自动回退到 /song/url
  first.records.setPlayerState({ currentResolvedAudioQuality: 'flac' })
  net.failPattern = /host-stream|host-backup/
  api.calls.length = 0
  const hostFailTask = (await apiOut.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => hostFailTask.status === 'done' || hostFailTask.status === 'failed', '宿主地址失效后收敛')
  eq(hostFailTask.status, 'done', '宿主地址失效也能下下来')
  eq(hostFailTask.source, 'api', '回退后音源变成 api')
  eq(api.calls.length >= 1, true, '回退时确实请求了 /song/url')
  net.failPattern = null

  // 非当前曲目：上游风控失败时，用曲目上残留的宿主地址兜底
  first.records.resetPlayerState()
  const playedBefore = { ...LOW_TRACK, audioUrl: 'https://cdn.test/stale-stream.mp3' }
  first.records.currentTrack.value = FLAC_TRACK // 当前播的是别的歌
  api.handler = () => ({ status: 502, body: { status: 0, error_code: 20028, msg: '本次请求需要验证' } })
  const staleTask = (await apiOut.startDownloads([playedBefore], 'auto'))[0]
  await waitFor(() => staleTask.status === 'done' || staleTask.status === 'failed', '残留地址兜底收敛')
  eq(staleTask.status, 'done', '上游失败但靠残留的宿主地址救回来了')
  eq(staleTask.source, 'stale', '标记音源 = 残留地址')
  includes(String(staleTask.directUrl), 'stale-stream', '用的是曲目上残留的地址')
  api.handler = null

  // 确认框里会提前说明「这首正在播，直接用宿主地址」
  first.records.currentTrack.value = FLAC_TRACK
  first.records.setPlayerState({
    currentTrackId: String(FLAC_TRACK.id),
    currentAudioUrl: 'https://cdn.test/host-stream.flac',
    currentAudioCandidateUrls: [],
    currentResolvedAudioQuality: 'flac'
  })
  apiOut.state.settings.confirmBeforeDownload = true
  tree = renderOf(page)
  await findByProp(tree, 'data-action', 'download-current').props.onClick()
  dTree = renderOf(dialogComponent)
  eq(findByProp(dTree, 'data-role', 'dlg-host-hint') !== null, true, '确认框里提示会复用宿主地址')
  includes(textOf(dTree), '不会触发风控', '说明了这样做的原因')
  apiOut.closeDownloadDialog()
  first.records.resetPlayerState()

  /* -------------------------------------------------- 29. 标题栏「任务中心」 */
  section('29. 同步到标题栏任务中心（进度 / 操作 / 保留策略）')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '先等任务收敛')
  first.records.currentTrack.value = FLAC_TRACK
  first.records.resetPlayerState()
  apiOut.state.settings.confirmBeforeDownload = false
  apiOut.state.settings.preferHostUrl = false
  apiOut.state.settings.quality = 'auto'
  api.handler = null
  net.mode = 'range'
  net.failPattern = null
  net.file = makeBytes(2 * 1024 * 1024, 61)

  // 开一个新的 ctx，专门测任务中心（避免前面几百条断言留下的任务干扰计数）
  const center = makeCtx({ storage: new Map(), currentTrack: FLAC_TRACK })
  const centerApi = await mod.activate(center.ctx)
  eq(center.records.taskDefs.length, 0, '刚启用时不动任务中心')
  eq(typeof centerApi.applyTaskCenter, 'function', '暴露了任务中心同步入口')

  net.file = makeBytes(2 * 1024 * 1024, 61)
  const centerTask = (await centerApi.startDownloads([FLAC_TRACK], 'auto'))[0]
  eq(center.records.taskDefs.length, 1, '入队即注册一行（排队中）')
  const def0 = center.records.taskDefs[0]
  eq(String(def0.id).startsWith('echo:'), false, 'id 不能占用宿主保留前缀 echo:')
  includes(def0.id, 'song-downloader:', 'id 用 <插件id>:<任务id>')
  eq(def0.name, '花落叹 · 涂一乐', '标题是「歌名 · 歌手」')
  eq(def0.status, 'pending', '入队时状态 = pending（宿主显示「待操作」）')
  eq(typeof def0.progress.percent, 'number', '带百分比（面板画进度条用）')
  eq(def0.progress.label, '排队中', 'label 显示排队中')
  eq(Array.isArray(def0.actions), true, '带操作按钮')
  eq(def0.actions.some((a) => a.id === 'cancel'), true, '运行中给「停止」')
  eq(def0.retention.completed.mode, 'auto', '完成后可自动收起')
  eq(def0.retention.error.mode, 'manual', '失败要留在面板上等处理')
  eq(typeof def0.retention.completed.delayMs, 'number', '自动收起带 delayMs（漏了宿主会直接抛错）')

  const handle = center.records.taskHandles[0]
  await waitFor(() => centerTask.status === 'done', '任务完成')
  eq(handle.calls.start.length >= 1, true, '进入运行态用了 start()（宿主只允许 pending→running）')
  eq(handle.calls.update.length >= 1, true, '运行期间用 update() 持续刷进度')
  const percents = handle.calls.update.map((p) => (p.progress ? p.progress.percent : -1))
  ok(percents.length >= 1 && percents[percents.length - 1] > 0, '进度百分比在涨', { percents })
  ok(
    handle.calls.update.some((p) => p.progress && String(p.progress.label).includes('下载中')),
    'label 里出现过「下载中」',
    { labels: handle.calls.update.map((p) => (p.progress ? p.progress.label : '')) }
  )
  eq(handle.calls.finish.length, 1, '收尾只 finish 一次')
  eq(handle.calls.finish[0].status, 'completed', '完成态 = completed')
  eq(handle.calls.finish[0].patch.progress.percent, 100, '完成时进度 100%')
  eq(handle.calls.finish[0].patch.actions.some((a) => a.id === 'copy'), true, '完成后给「复制直链」')
  eq(handle.calls.finish[0].patch.actions.some((a) => a.id === 'cancel'), false, '完成后不再给「停止」')
  eq(handle.entry.status, 'completed', '面板上那一行最终是完成态')

  // 失败 → error 态 + 错误文案 + 重试按钮
  api.handler = (req) => (req.params.quality === 'auto' || req.params.quality === 'flac' ? failBody(20010) : failBody(20010))
  const failTask = (await centerApi.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => failTask.status === 'failed', '失败任务收敛')
  const failHandle = center.records.taskHandles[center.records.taskHandles.length - 1]
  eq(failHandle.calls.finish.length, 1, '失败也 finish 一次')
  eq(failHandle.calls.finish[0].status, 'error', '失败态 = error')
  eq(failHandle.calls.finish[0].patch.error, failTask.error, '错误文案原样带进面板')
  eq(failHandle.calls.finish[0].patch.actions.some((a) => a.id === 'retry'), true, '失败给「重试」')
  api.handler = null

  // 中止 → aborted 态（宿主会 3 秒后自动收起）
  net.file = makeBytes(4 * 1024 * 1024, 67)
  const cancelHolder2 = { task: null }
  net.calls.length = 0
  net.beforeChunk = async (index) => {
    if (index === 2 && cancelHolder2.task) centerApi.cancelTask(cancelHolder2.task)
  }
  const abortedTask = (await centerApi.startDownloads([FLAC_TRACK], 'auto'))[0]
  cancelHolder2.task = abortedTask
  await waitFor(() => abortedTask.status === 'canceled', '中止任务收敛')
  const abortedHandle = center.records.taskHandles[center.records.taskHandles.length - 1]
  eq(abortedHandle.calls.finish[0].status, 'aborted', '取消态 = aborted')
  net.beforeChunk = null

  // 面板上的操作按钮要真的能回调插件（宿主用 runAction 包装，这里直接调）
  const retryAction = failHandle.calls.finish[0].patch.actions.find((a) => a.id === 'retry')
  net.file = makeBytes(200 * 1024, 71)
  const beforeRetry = failTask.status
  retryAction.onClick()
  await waitFor(() => failTask.status !== beforeRetry || failTask.status === 'done', '按钮回调生效')
  await waitFor(() => failTask.status === 'done' || failTask.status === 'failed', '重试收敛')

  // 移除任务 / 清空已完成 → 面板条目也要摘掉
  const dismissBefore = handle.calls.dismiss
  centerApi.removeTask(centerTask)
  eq(handle.calls.dismiss, dismissBefore + 1, '移除任务时同步摘掉面板条目')
  const activeHandles = center.records.taskHandles.filter((h) => h.active)
  centerApi.clearFinished()
  eq(center.records.taskHandles.every((h) => !h.active) || activeHandles.length === 0, true, '清空已完成后面板不再留条目')

  // 关掉开关 → 现有条目全摘掉，之后不再注册
  const defsBefore = center.records.taskDefs.length
  centerApi.state.settings.taskCenter = false
  centerApi.applyTaskCenter(false)
  eq(center.records.taskHandles.every((h) => !h.active), true, '关掉开关时把已有条目全摘掉')
  const offTask = (await centerApi.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => offTask.status === 'done', '关掉后仍能下载')
  eq(center.records.taskDefs.length, defsBefore, '关掉后不再往任务中心注册')

  // 打开开关 → 把当前任务补一遍
  centerApi.applyTaskCenter(true)
  eq(center.records.taskDefs.length > defsBefore, true, '重新打开时把已有任务补进面板')

  // 宿主没有 ctx.tasks（老版本）时要静默降级，而不是报错
  const noTasks = makeCtx({ storage: new Map() })
  delete noTasks.ctx.tasks
  const noTasksApi = await mod.activate(noTasks.ctx)
  const legacyTask = (await noTasksApi.startDownloads([FLAC_TRACK], 'auto'))[0]
  await waitFor(() => legacyTask.status === 'done' || legacyTask.status === 'failed', '没有任务中心也能正常下载')
  eq(legacyTask.status, 'done', '宿主没有任务中心时下载照常')
  eq(noTasks.records.taskDefs.length, 0, '没有 ctx.tasks 时不会崩，也不会有条目')

  /* -------------------------------------------------- 30. 借宿主的解析通道 */
  section('30. 借宿主解析通道（模拟播放请求但不真的播放）')
  await waitFor(() => apiOut.state.tasks.every((t) => t.status !== 'downloading' && t.status !== 'resolving' && t.status !== 'saving'), '先等任务收敛')
  first.records.currentTrack.value = FLAC_TRACK
  first.records.resetPlayerState() // 当前没有播放缓存地址 → 走「请宿主解析」
  apiOut.state.settings.confirmBeforeDownload = false
  apiOut.state.settings.preferHostUrl = true
  apiOut.state.settings.quality = 'auto'
  api.handler = null
  net.mode = 'range'
  net.failPattern = null
  net.file = makeBytes(320 * 1024, 73)

  // ① auto + 非当前曲目 → 请宿主解析，完全不打自己的 /song/url
  first.records.resolveCalls.length = 0
  first.records.resolveResult = {
    url: 'https://cdn.test/host-resolved.flac',
    urls: ['https://cdn.test/host-resolved.flac', 'https://cdn.test/host-resolved-backup.mp3'],
    quality: 'flac'
  }
  api.calls.length = 0
  const hostResolvedTask = (await apiOut.startDownloads([LOW_TRACK], 'auto'))[0]
  await waitFor(() => hostResolvedTask.status === 'done' || hostResolvedTask.status === 'failed', '宿主解析流程收敛')
  eq(first.records.resolveCalls.length, 1, '确实请了宿主解析')
  eq(api.calls.length, 0, '没有自己去打 /song/url')
  eq(hostResolvedTask.status, 'done', '宿主解析的地址能下下来')
  eq(hostResolvedTask.source, 'host-resolve', '音源标记 = 宿主解析通道')
  eq(hostResolvedTask.actualQuality, 'flac', '音质取宿主给的')
  includes(String(hostResolvedTask.directUrl), 'host-resolved', '用的就是宿主给的地址')
  eq(first.records.resolveCalls[0].track.hash, LOW_TRACK.hash, '请求里带上曲目 hash')
  eq(Array.isArray(first.records.resolveCalls[0].track.relateGoods), true, '带上 relateGoods（省宿主一次反查）')
  tree = renderOf(page)
  includes(textOf(tree), '宿主解析通道', '任务行写明了音源')

  // ② 宿主解析器炸了 → 静默回退到自己请求
  first.records.resolveThrows = true
  api.calls.length = 0
  const fallbackAfterThrow = (await apiOut.startDownloads([LOW_TRACK], 'auto'))[0]
  await waitFor(() => fallbackAfterThrow.status === 'done' || fallbackAfterThrow.status === 'failed', '解析器异常后收敛')
  first.records.resolveThrows = false
  eq(fallbackAfterThrow.status, 'done', '宿主解析器异常也能下下来')
  eq(fallbackAfterThrow.source, 'api', '回退到自己请求')
  eq(api.calls.length >= 1, true, '回退时确实打了 /song/url')

  // ③ 宿主解析没给出可用地址 → 同样回退
  first.records.resolveResult = { url: '', urls: [] }
  api.calls.length = 0
  const fallbackAfterEmpty = (await apiOut.startDownloads([LOW_TRACK], 'auto'))[0]
  await waitFor(() => fallbackAfterEmpty.status === 'done' || fallbackAfterEmpty.status === 'failed', '空结果后收敛')
  eq(fallbackAfterEmpty.source, 'api', '宿主没解析出地址时回退自己请求')

  // ④ 显式要高音质 → 先自己请求（尊重用户选的档位），不打宿主解析
  first.records.resolveResult = { url: 'https://cdn.test/host-resolved.flac', urls: ['https://cdn.test/host-resolved.flac'], quality: '320' }
  first.records.resolveCalls.length = 0
  api.calls.length = 0
  const explicitTask = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => explicitTask.status === 'done', '显式音质任务完成')
  eq(api.calls.length >= 1, true, '显式音质时自己请求（不被宿主的低音质糊弄）')
  eq(first.records.resolveCalls.length, 0, '此时不动用宿主解析')
  eq(explicitTask.source, 'api', '音源 = 自己请求')

  // ⑤ 但自己请求被风控拦下（且用户没取消验证）→ 再借宿主解析通道救一把
  api.handler = () => ({ status: 502, body: { status: 0, error_code: 20028, ssaCode: 'EV-HOST', msg: '本次请求需要验证' } })
  first.records.verifyMode = 'fail' // 验证没通过（不是用户取消）→ 允许再走宿主
  first.records.resolveCalls.length = 0
  const rescuedTask = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => rescuedTask.status === 'done' || rescuedTask.status === 'failed', '风控后借用宿主收敛')
  eq(rescuedTask.status, 'done', '自己请求被风控拦下后靠宿主通道救回来了')
  eq(rescuedTask.source, 'host-resolve', '音源 = 宿主解析通道')
  eq(first.records.resolveCalls.length, 1, '确实请了宿主解析')
  api.handler = null
  first.records.verifyMode = 'ok'

  // ⑥ 用户主动取消验证时不再去打扰（不弹宿主的验证窗）
  api.handler = () => ({ status: 502, body: { status: 0, error_code: 20028, ssaCode: 'EV-CANCEL2', msg: '本次请求需要验证' } })
  first.records.verifyMode = 'cancel'
  first.records.resolveCalls.length = 0
  const canceledTask = (await apiOut.startDownloads([FLAC_TRACK], 'flac'))[0]
  await waitFor(() => canceledTask.status === 'failed', '取消验证后失败')
  eq(first.records.resolveCalls.length, 0, '用户取消了验证就不再弹宿主的验证窗')
  api.handler = null
  first.records.verifyMode = 'ok'

  // ⑦ 设置里关掉「借宿主通道」→ auto 也直接自己请求
  apiOut.state.settings.preferHostUrl = false
  first.records.resolveCalls.length = 0
  api.calls.length = 0
  const selfOnly = (await apiOut.startDownloads([LOW_TRACK], 'auto'))[0]
  await waitFor(() => selfOnly.status === 'done', '关掉宿主通道后自己请求')
  eq(first.records.resolveCalls.length, 0, '关掉后不请宿主解析')
  eq(api.calls.length >= 1, true, '改走自己的 /song/url')
  eq(selfOnly.source, 'api', '音源 = 自己请求')

  // ⑧ 老宿主没有解析器 → 静默降级
  apiOut.state.settings.preferHostUrl = true
  const savedResolve = first.records.playerState.resolveAudioUrl
  delete first.records.playerState.resolveAudioUrl
  const noResolver = (await apiOut.startDownloads([LOW_TRACK], 'auto'))[0]
  await waitFor(() => noResolver.status === 'done' || noResolver.status === 'failed', '没有解析器时收敛')
  eq(noResolver.status, 'done', '宿主没有解析器也能下')
  eq(noResolver.source, 'api', '降级到自己请求')
  first.records.playerState.resolveAudioUrl = savedResolve
  first.records.resolveResult = null

  /* -------------------------------------------------- 25. dispose 回收 */
  section('25. dispose 回收在跑的任务与全局监听')
  net.mode = 'range'
  net.file = makeBytes(3 * 1024 * 1024, 37)
  const preDispose = await apiOut.startDownloads([FLAC_TRACK], 'auto')
  const handlersBefore = doc.keyHandlers.length
  first.records.disposers[0]()
  ok(doc.keyHandlers.length < handlersBefore, 'dispose 摘掉了全局 keydown 监听')
  await waitFor(() => preDispose[0].status === 'canceled' || preDispose[0].status === 'done', 'dispose 后任务收敛')
  eq(preDispose[0].status, 'canceled', 'dispose 把在跑的任务标记为取消')

  await mod.deactivate()
  eq(typeof mod.deactivate, 'function', 'deactivate 可调用')

  /* ------------------------------------------------------------- 收尾 */
  clearAllIntervals()
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
