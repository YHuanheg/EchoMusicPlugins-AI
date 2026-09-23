/**
 * 插件标签筛选 (tag-filter) 无头集成测试
 * ---------------------------------------------------------------------------
 * 静态 `node --check` 抓不到未定义标识符，所以这里用**真实 Vue 3 ESM 运行时**
 * 无头执行插件代码：
 *   1. 造一份**仿真宿主 DOM**（复刻 app.asar 里插件管理页的真实结构）
 *   2. mock 一个符合宿主契约的 ctx（storage / ui.mount / ui.addPage / settings / toast / commands）
 *   3. await activate(ctx)  → 断言注册项、注入位置、筛选条挂载
 *   4. 直接调用组件 setup()() 拿到真实 vnode 树，找 chip / 按钮，
 *      再真实调用 vnode.props.onClick() 跑完整业务流程
 *   5. 断言卡片元素的**行内 display**（插件就是靠它隐藏卡片的）
 *
 * 定时器与 MutationObserver 都是受控替身，所以整套测试不需要 sleep。
 *
 * 运行： node tests/tag-filter.smoke.mjs
 * 依赖： 一份 Vue 浏览器 ESM 构建（见 resolveVue 的查找顺序）
 *
 * 变异测试：设 TF_PLUGIN_ENTRY 指向插件的改动副本，即可用同一套断言验证「改坏了会红」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_ENTRY = process.env.TF_PLUGIN_ENTRY
  ? path.resolve(process.env.TF_PLUGIN_ENTRY)
  : path.join(ROOT, 'tag-filter', 'index.js')
const CACHE_DIR = path.join(ROOT, '.workbuddy', 'tmp')
const CACHE_VUE = path.join(CACHE_DIR, 'vue.runtime.esm-browser.js')
const VUE_CDN = 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.esm-browser.js'

/* ========================================================================== *
 * 断言脚手架
 * ========================================================================== */

let pass = 0
const failures = []
const sectionResults = []
let currentSection = '(root)'

function section(name) {
  currentSection = name
  sectionResults.push({ name, at: pass })
}

function ok(cond, name, extra) {
  if (cond) {
    pass++
    return true
  }
  failures.push(
    '[' + currentSection + '] ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))
  )
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
    CACHE_VUE
  ].filter(Boolean)

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
 * 假 DOM —— 只实现插件真正用到的那部分选择器语义
 * ========================================================================== */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this._classes = new Set()
    this._attrs = new Map()
    this._text = ''
    this.style = {}
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

  setAttribute(name, value) {
    this._attrs.set(String(name), String(value))
  }

  getAttribute(name) {
    return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null
  }

  appendChild(child) {
    return this.insertBefore(child, null)
  }

  insertBefore(node, ref) {
    if (!node) return node
    if (node.parentNode) node.parentNode.removeChild(node)
    const index = ref ? this.children.indexOf(ref) : -1
    if (index >= 0) this.children.splice(index, 0, node)
    else this.children.push(node)
    node.parentNode = this
    return node
  }

  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    node.parentNode = null
    return node
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  get nextSibling() {
    if (!this.parentNode) return null
    const index = this.parentNode.children.indexOf(this)
    return index < 0 ? null : this.parentNode.children[index + 1] || null
  }

  get isConnected() {
    let node = this
    while (node.parentNode) node = node.parentNode
    return node === doc.documentElement
  }

  get textContent() {
    let out = this._text || ''
    for (const child of this.children) out += child.textContent
    return out
  }

  set textContent(value) {
    this._text = String(value == null ? '' : value)
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null
  }

  querySelectorAll(selector) {
    return queryAll(this, selector)
  }
}

function descendantsOf(node, out = []) {
  for (const child of node.children) {
    out.push(child)
    descendantsOf(child, out)
  }
  return out
}

function matchSimple(el, part) {
  if (!part) return false
  if (part.startsWith('.')) return el._classes.has(part.slice(1))
  if (part.startsWith('[')) {
    const m = /^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(part)
    if (!m) return false
    const value = el.getAttribute(m[1])
    return m[2] === undefined ? value !== null : String(value) === m[2]
  }
  return el.tagName === part.toUpperCase()
}

/** 只支持「后代选择器」（空格分隔的简单选择器），插件只用到这些 */
function queryAll(root, selector) {
  const parts = String(selector || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return []
  let scope = [root]
  for (const part of parts) {
    const next = []
    for (const node of scope) {
      for (const child of descendantsOf(node)) if (matchSimple(child, part)) next.push(child)
    }
    scope = next
  }
  return scope
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeEl('html')
    this.body = new FakeEl('body')
    this.documentElement.appendChild(this.body)
  }

  createElement(tag) {
    return new FakeEl(tag)
  }

  querySelector(selector) {
    return queryAll(this.documentElement, selector)[0] || null
  }

  querySelectorAll(selector) {
    return queryAll(this.documentElement, selector)
  }
}

const doc = new FakeDocument()

/* ---------- 定时器与 MutationObserver 替身 ---------- */

const timers = { timeouts: new Map(), intervals: new Map(), nextId: 1 }

globalThis.document = doc
globalThis.setTimeout = (fn) => {
  const id = timers.nextId++
  timers.timeouts.set(id, fn)
  return id
}
globalThis.clearTimeout = (id) => timers.timeouts.delete(id)
globalThis.setInterval = (fn) => {
  const id = timers.nextId++
  timers.intervals.set(id, fn)
  return id
}
globalThis.clearInterval = (id) => timers.intervals.delete(id)

const observers = []
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    observers.push(this)
  }

  observe(target, options) {
    this.targets.push({ target, options })
  }

  disconnect() {
    this.targets = []
  }
}
globalThis.MutationObserver = FakeMutationObserver

function flushTimeouts() {
  let guard = 0
  while (timers.timeouts.size && guard++ < 50) {
    const pending = Array.from(timers.timeouts.values())
    timers.timeouts.clear()
    for (const fn of pending) fn()
  }
}

/** 模拟宿主机内重渲染：触发观察回调 + 跑一次兜底轮询 */
function hostRerender() {
  for (const observer of observers) {
    if (observer.targets.length) observer.callback([], observer)
  }
  flushTimeouts()
  for (const fn of Array.from(timers.intervals.values())) fn()
  flushTimeouts()
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/* ========================================================================== *
 * 仿真宿主 DOM：复刻 app.asar 里插件管理页的真实结构
 * ========================================================================== */

function el(tag, className, text) {
  const node = new FakeEl(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = text
  return node
}

/**
 * 一张插件卡片（结构照抄 InstalledPluginCard / MarketplacePluginCard 的渲染结果）：
 *   article.plugin-card
 *     └ .plugin-card-main > .plugin-card-summary > .plugin-card-header > h3.plugin-card-name
 *     └ .marketplace-tags > span*      ← 目录标签（本插件读这里）
 *     └ .plugin-feature-tags > span*   ← 能力标签（可选纳入）
 *     └ .plugin-card-details > .plugin-card-id  「ID: <id>」
 */
function makeCard({ id, name, tags = [], featureTags = [] }) {
  const card = el('article', 'plugin-card')
  const main = el('div', 'plugin-card-main')
  const summary = el('div', 'plugin-card-summary')
  const header = el('div', 'plugin-card-header')
  header.appendChild(el('h3', 'plugin-card-name', name))
  summary.appendChild(header)
  main.appendChild(summary)
  card.appendChild(main)

  if (tags.length) {
    const box = el('div', 'marketplace-tags')
    for (const tag of tags) box.appendChild(el('span', null, tag))
    card.appendChild(box)
  }
  if (featureTags.length) {
    const box = el('div', 'plugin-feature-tags')
    for (const tag of featureTags) box.appendChild(el('span', null, tag))
    card.appendChild(box)
  }
  if (id) {
    const details = el('div', 'plugin-card-details')
    details.appendChild(el('div', 'plugin-card-id', `ID: ${id}`))
    card.appendChild(details)
  }
  return card
}

/**
 * 在线插件卡片（MarketplacePluginCard）：根节点多一个 marketplace-card，
 * 状态靠 .plugin-status-badge 的文案（已安装 / 未安装 / 可更新 / 版本要求）。
 */
function makeMarketplaceCard({ id, name, tags = [], status = '未安装', installLabel }) {
  const card = el('article', 'plugin-card marketplace-card')
  card.setAttribute('data-marketplace-plugin-key', `src:${id}`)
  const main = el('div', 'plugin-card-main')
  const summary = el('div', 'plugin-card-summary')
  const header = el('div', 'plugin-card-header')
  header.appendChild(el('h3', 'plugin-card-name', name))
  header.appendChild(el('span', 'plugin-status-badge', status))
  summary.appendChild(header)
  main.appendChild(summary)
  card.appendChild(main)

  if (tags.length) {
    const box = el('div', 'marketplace-tags')
    for (const tag of tags) box.appendChild(el('span', null, tag))
    card.appendChild(box)
  }
  if (id) {
    const details = el('div', 'plugin-card-details')
    details.appendChild(el('div', 'plugin-card-id', `ID: ${id}`))
    card.appendChild(details)
  }

  const actions = el('div', 'plugin-card-actions')
  const button = el('button', 'marketplace-install-btn')
  button.textContent =
    installLabel === undefined ? (status === '未安装' ? '安装' : status === '可更新' ? '更新' : '已安装') : installLabel
  actions.appendChild(button)
  card.appendChild(actions)
  return card
}

/** 把已安装卡片标成「未在跑」（宿主：!enabled || invalid || !compatible） */
function markDisabled(card) {
  card.className = `${card.className} is-disabled`
  return card
}

/** 造一个独立的插件管理页（可指定卡片集合），返回 { content, grid } */
function buildPageWith(cards) {
  const content = el('div', 'plugin-content px-6 pb-6')
  const heading = el('div', 'plugin-content-heading')
  heading.appendChild(el('span', null, `共 ${cards.length} 个`))
  content.appendChild(heading)
  const grid = el('div', 'plugin-card-grid')
  for (const card of cards) grid.appendChild(card)
  content.appendChild(grid)
  doc.body.appendChild(content)
  return { content, grid }
}

/** 夹具：7 张卡片 / 12 个目录标签 + 1 个「未标注」（标签取自本机真实安装的插件） */
const FIXTURE = [
  { id: 'kugou-recommend', name: '推荐电台', tags: ['kugou', 'recommend', 'discover', 'radio'], featureTags: ['网络'] },
  { id: 'taskbar-lyric', name: '任务栏歌词', tags: ['floating-window', 'lyrics'], featureTags: ['网络'] },
  { id: 'mouse-gesture', name: '鼠标手势', tags: ['gesture', 'mouse', 'productivity'] },
  { id: 'echo-local-simple', name: '简单本地音乐', tags: ['local'] },
  { id: 'gh-accelerator', name: 'GitHub 加速器', tags: [] },
  { id: 'player-frontend', name: '播放器前端', tags: ['player', 'lyrics'] },
  { id: null, name: '无名工具', tags: ['toolkit'] }
]

const TAG_COUNT = 12
const CARD_COUNT = FIXTURE.length
const N_LYRICS = 2
const N_LOCAL = 1
const N_KUGOU = 1

function buildPluginPage() {
  const content = el('div', 'plugin-content px-6 pb-6')
  const heading = el('div', 'plugin-content-heading')
  heading.appendChild(el('h2', null, '已安装插件'))
  heading.appendChild(el('span', null, `共 ${CARD_COUNT} 个`))
  content.appendChild(heading)

  const grid = el('div', 'plugin-card-grid')
  for (const item of FIXTURE) grid.appendChild(makeCard(item))
  content.appendChild(grid)

  doc.body.appendChild(content)
  return { content, heading, grid }
}

function resetDom() {
  for (const node of doc.body.children.splice(0)) node.parentNode = null
}

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
  return out
}

function findAll(node, pred) {
  return collect(node, []).filter(pred)
}

function byProp(node, key, value) {
  return findAll(node, (n) => n.props && n.props[key] === value)[0]
}

function textOfNode(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOfNode).join('')
  let out = ''
  if (Array.isArray(node.children)) out += textOfNode(node.children)
  else if (typeof node.children === 'string') out += node.children
  return out
}

/** 只 setup 一次、复用同一个 render —— 否则会绕过「computed 缓存旧值」这类失效模式 */
function renderComponent(comp) {
  if (!comp || typeof comp.setup !== 'function') throw new Error('组件缺少 setup()')
  const render = comp.setup({}, { attrs: {}, slots: {}, emit() {}, expose() {} })
  if (typeof render !== 'function') throw new Error('组件 setup 没有返回渲染函数')
  return render
}

/** 筛选条 / 页面上所有标签 chip（按 data-tag 精确匹配，不会把 etf-chip-lg 混进来） */
const chipsOf = (tree) => findAll(tree, (n) => n.props && n.props['data-tag'] !== undefined)
const chipByTag = (tree, tag) => chipsOf(tree).find((n) => n.props['data-tag'] === tag)
const chipTags = (tree) => chipsOf(tree).map((n) => n.props['data-tag'])
const clickChip = (tree, tag) => chipByTag(tree, tag).props.onClick()

/* ========================================================================== *
 * mock ctx
 * ========================================================================== */

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

function makeCtx(sharedStore) {
  const store = sharedStore || new Map()
  const record = {
    store,
    mounts: [],
    pages: [],
    settingsDefs: [],
    sidebarItems: [],
    commands: new Map(),
    toasts: [],
    disposers: []
  }

  const ctx = {
    vue: V,
    storage: {
      async get(key) {
        return store.has(key) ? clone(store.get(key)) : null
      },
      async set(key, value) {
        store.set(key, clone(value))
      }
    },
    ui: {
      addPage(config) {
        record.pages.push(config)
        return () => {}
      },
      settings: {
        define(config) {
          record.settingsDefs.push(config)
          return () => {}
        }
      },
      sidebar: {
        addItem(config) {
          record.sidebarItems.push(config)
          return () => {
            const index = record.sidebarItems.indexOf(config)
            if (index >= 0) record.sidebarItems.splice(index, 1)
          }
        }
      },
      mount(host, component) {
        record.mounts.push({ host, component })
        return () => {}
      },
      components: {}
    },
    toast: {
      info: (m) => record.toasts.push(['info', m]),
      success: (m) => record.toasts.push(['success', m]),
      warning: (m) => record.toasts.push(['warning', m]),
      danger: (m) => record.toasts.push(['danger', m])
    },
    commands: {
      register(id, handler) {
        record.commands.set(id, handler)
      },
      async execute(id, ...args) {
        const handler = record.commands.get(id)
        return handler ? handler(...args) : undefined
      }
    },
    dispose(fn) {
      record.disposers.push(fn)
    }
  }

  return { ctx, record }
}

function disposeAll(record) {
  for (const fn of record.disposers.splice(0)) {
    try {
      fn()
    } catch (error) {
      failures.push('[dispose] 抛错 :: ' + String((error && error.message) || error))
    }
  }
}

const toastText = (record) => record.toasts.map((item) => item[1]).join(' | ')

/* ========================================================================== *
 * 加载插件模块：读原文件内容 + 追加导出 → 测的是**真实文件**而不是复制品
 * ========================================================================== */

const PROBE_EXPORT = `
export {
  DEFAULT_SETTINGS, MATCH_MODES, UNTAGGED_KEY, DOM, FACET_DEFS, GROUP_TITLES,
  normalizeText, normalizeTag, tagKeyOf, stripIdPrefix, isBusyGrid, textOf, hasClass,
  matchesSelection, pickEntityKey, readCardTags, readCardFacets, readInstallState,
  mergeRecords, entitiesFromSnapshot,
  emptySelection, normalizeSelection, selectionCount, pickFacet, matchesFacetValue, matchesEntity,
  isFacetValue, normalizeGroups, groupSelectionState, toggleGroupTags,
  matchStats, matchStatsFor, buildChips, buildFacetChips, buildGroupChips, buildGroups,
  sameChips, sameGroups
}
`

async function loadProbe() {
  const source = fs.readFileSync(PLUGIN_ENTRY, 'utf8')
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const target = path.join(CACHE_DIR, `tag-filter.probe.${process.pid}.mjs`)
  fs.writeFileSync(target, source + PROBE_EXPORT, 'utf8')
  return import(pathToFileURL(target).href)
}

const mod = await loadProbe()

/* ========================================================================== *
 * 1. 纯函数（不含 DOM，先把语义钉死）
 * ========================================================================== */

section('纯函数')

eq(mod.normalizeTag('  Kugou \n Lyrics '), 'Kugou Lyrics', '标签归一化：压空白、去首尾')
eq(mod.normalizeTag('x'.repeat(80)).length, 40, '标签超长截断到 40 字符')
eq(mod.tagKeyOf('Lyrics'), 'lyrics', '标签键大小写不敏感')
eq(mod.stripIdPrefix('ID: kugou-recommend'), 'kugou-recommend', '去掉「ID:」前缀')
eq(mod.stripIdPrefix('ID：kugou-recommend'), 'kugou-recommend', '兼容全角冒号')
eq(mod.stripIdPrefix('  id :  spaced  '), 'spaced', '兼容大小写与多余空格')
eq(mod.stripIdPrefix('没有前缀'), '没有前缀', '没有前缀时原样返回')

const keySet = (...keys) => new Set(keys)
ok(mod.matchesSelection(keySet('a'), [], 'any'), '空选择 → 全部命中')
ok(mod.matchesSelection(keySet('a', 'b'), ['a'], 'any'), '任一模式：含 a 即命中')
ok(!mod.matchesSelection(keySet('b'), ['a'], 'any'), '任一模式：不含 a 不命中')
ok(mod.matchesSelection(keySet('a', 'b'), ['a', 'b'], 'all'), '全部模式：同时含 a b 才命中')
ok(!mod.matchesSelection(keySet('a'), ['a', 'b'], 'all'), '全部模式：缺一个就不命中')
ok(mod.matchesSelection(keySet('a'), new Set(['a']), 'any'), '选择集合传 Set 也能用')

{
  const merged = mod.mergeRecords([
    { el: 'E1', id: 'p1', name: '插件一', tags: [{ key: 'a', label: 'a' }] },
    { el: 'E2', id: 'p1', name: '插件一', tags: [] },
    { el: 'E3', id: '', name: '只有名字', tags: [] },
    { el: 'E4', id: '', name: '', tags: [] }
  ])
  eq(merged.length, 2, '同一插件出现两次只算一个实体，无身份的记录被丢弃')
  eq(merged[0].elements.length, 2, '同一实体的两个 DOM 元素都记下来（双挂载一起过滤）')
  eq(merged[0].tags.length, 1, '空的标签集合不会覆盖非空的')
  eq(merged[1].key, 'name:只有名字', '没有 id 时用显示名当身份')
  eq(merged[1].tags[0].key, mod.UNTAGGED_KEY, '没有任何标签的实体获得「未标注」伪标签')
}

{
  const snapshot = mod.entitiesFromSnapshot([
    { id: 'p1', name: '插件一', tags: ['a', 'A', ' b '] },
    { id: '', name: '', tags: ['x'] }
  ])
  eq(snapshot.length, 1, '快照重建：无身份的条目被丢弃')
  eq(snapshot[0].tags.length, 2, '快照重建：标签去重（a 与 A 是同一个），b 保留')
  eq(snapshot[0].elements.length, 0, '快照实体没有 DOM 元素')
}

{
  /* 去重是统计正确的前提：同一个 key 出现两次会让 chip 计数翻倍 */
  const dup = mod.mergeRecords([
    {
      el: null,
      id: 'p',
      name: 'p',
      tags: [
        { key: 'a', label: 'a' },
        { key: 'a', label: 'A' },
        { key: 'b', label: 'b' }
      ]
    }
  ])
  eq(dup[0].tags.length, 2, '实体内的重复标签被去掉')
  eq(mod.buildChips(dup, [], 'any', null).find((c) => c.key === 'a').count, 1, '去重后 chip 计数不会翻倍')
}

const sampleEntities = [
  { key: 'id:a', id: 'a', tagKeys: keySet('kugou', 'vip') },
  { key: 'id:b', id: 'b', tagKeys: keySet('kugou') },
  { key: 'id:c', id: 'c', tagKeys: keySet(mod.UNTAGGED_KEY) }
]
{
  const statsAny = mod.matchStats(sampleEntities, ['kugou'], 'any')
  eq(statsAny.matched, 2, '统计：任一模式下 kugou 命中 2 个')
  eq(statsAny.hidden, 1, '统计：隐藏 1 个')
  eq(mod.matchStats(sampleEntities, ['kugou', 'vip'], 'all').matched, 1, '统计：全部模式下 kugou+vip 命中 1 个')
  eq(mod.matchStats(sampleEntities, [], 'any').hidden, 0, '统计：没有选择时隐藏 0 个')
}

{
  /* 生产里实体一定带 tagKeys（mergeRecords 负责生成），夹具照production形态给 */
  const tagged = (...keys) => ({ tagKeys: new Set(keys) })
  const chipEntities = [
    {
      key: 'id:a',
      tags: [{ key: 'kugou', label: 'kugou' }, { key: 'vip', label: 'vip' }],
      ...tagged('kugou', 'vip')
    },
    { key: 'id:b', tags: [{ key: 'kugou', label: 'kugou' }], ...tagged('kugou') },
    { key: 'id:c', tags: [{ key: 'lyrics', label: 'lyrics' }], ...tagged('lyrics') }
  ]
  const chips = mod.buildChips(chipEntities, [], 'any', null)
  eq(chips.length, 3, 'chip：3 个标签')
  eq(chips[0].key, 'kugou', 'chip 按出现次数降序')
  eq(chips[0].count, 2, 'chip 计数 = 带该标签的插件数')
  eq(chips[0].alive, 2, 'chip alive = 选中后的匹配数')
  ok(!chips[0].dead, 'chip 未选中且能匹配，不算 dead')

  const withSelection = mod.buildChips(chipEntities, ['kugou'], 'all', null)
  const kugouChip = withSelection.find((c) => c.key === 'kugou')
  const lyricsChip = withSelection.find((c) => c.key === 'lyrics')
  eq(kugouChip.count, 2, '已选 chip 的计数不随选择变化（稳定值）')
  eq(kugouChip.alive, 2, '已选 chip 的 alive = 当前匹配数')
  eq(lyricsChip.alive, 0, '全部模式下 lyrics 与 kugou 无交集 → alive 0')
  ok(lyricsChip.dead, 'alive 0 且未选中 → 标记 dead')
  ok(!kugouChip.dead, '已选中的 chip 不标记 dead')

  const order1 = mod.buildChips(chipEntities, [], 'any', null).map((c) => c.key).join(',')
  const order2 = mod.buildChips(chipEntities, ['lyrics'], 'any', null).map((c) => c.key).join(',')
  eq(order1, order2, 'chip 顺序不随选择变化（否则光标下的标签会跳走）')

  const missing = mod.buildChips(chipEntities, ['gone'], 'any', new Map([['gone', '已有的标签']]))
  const goneChip = missing.find((c) => c.key === 'gone')
  ok(!!goneChip, '当前视图里不存在的已选标签也会列出（否则无法取消）')
  eq(goneChip.label, '已有的标签', '不存在的已选标签沿用记住的展示名')
  eq(goneChip.count, 0, '不存在的已选标签计数为 0')

  const untaggedChips = mod.buildChips(
    [
      {
        key: 'id:x',
        tags: [{ key: mod.UNTAGGED_KEY, label: '未标注', untagged: true }],
        tagKeys: new Set([mod.UNTAGGED_KEY])
      }
    ],
    [],
    'any',
    null
  )
  eq(untaggedChips.length, 1, '「未标注」也会成为一个 chip')
  eq(untaggedChips[0].alive, 1, '「未标注」chip 选中后能匹配到那 1 个无标签插件')
  ok(untaggedChips[0].untagged, '「未标注」chip 带 untagged 标记')
}

{
  const chip = (key, extra = {}) => ({
    key,
    label: key,
    count: 1,
    alive: 1,
    selected: false,
    dead: false,
    ...extra
  })
  ok(mod.sameChips([], []), 'sameChips：两个空列表等价')
  ok(!mod.sameChips([chip('a')], []), 'sameChips：长度不同不等价')
  ok(mod.sameChips([chip('a')], [chip('a')]), 'sameChips：内容一致时等价（避免每秒重渲染）')
  ok(!mod.sameChips([chip('a')], [chip('a', { selected: true })]), 'sameChips：选中态变化要算不等价')
  ok(!mod.sameChips([chip('a')], [chip('a', { count: 2 })]), 'sameChips：计数变化要算不等价')
}

/* ========================================================================== *
 * 1b. 纯函数：状态维度、分组、自定义组
 * ========================================================================== */

section('纯函数·维度与分组')

{
  const empty = mod.emptySelection()
  eq(empty.tags.length + empty.install.length + empty.enabled.length, 0, '空选择三个维度都是空数组')
  eq(mod.selectionCount(empty), 0, '空选择的条件数为 0')

  const migrated = mod.normalizeSelection(['kugou', 'kugou', ' vip '])
  eq(migrated.tags.length, 2, '旧格式（纯标签数组）能迁移，并去重去空白')
  eq(mod.selectionCount(migrated), 2, '迁移后的条件数正确')

  const cleaned = mod.normalizeSelection({ tags: ['a'], install: ['installed', 'bogus'], enabled: ['on', 'nope'] })
  eq(cleaned.install.join(','), 'installed', '非法安装状态被丢弃')
  eq(cleaned.enabled.join(','), 'on', '非法启用状态被丢弃')
  eq(mod.selectionCount(cleaned), 3, '三个维度合计 3 个条件')

  ok(mod.isFacetValue('install', 'update'), 'isFacetValue 认得合法值')
  ok(!mod.isFacetValue('install', 'archived'), 'isFacetValue 拒绝非法值')
  ok(!mod.isFacetValue('nope', 'installed'), 'isFacetValue 拒绝未知维度')

  const entity = {
    key: 'id:a',
    tagKeys: keySet('kugou'),
    facets: { install: 'installed', enabled: 'off' },
    tags: []
  }
  eq(mod.pickFacet(entity, 'install'), 'installed', 'pickFacet 取到安装状态')
  eq(mod.pickFacet(entity, 'enabled'), 'off', 'pickFacet 取到启用状态')
  eq(mod.pickFacet({ key: 'id:b' }, 'install'), null, '没有 facets 时返回 null')

  ok(mod.matchesFacetValue('installed', []), '维度没选 → 放行')
  ok(mod.matchesFacetValue('installed', ['installed', 'missing']), '维度内部是 OR')
  ok(!mod.matchesFacetValue('missing', ['installed']), '值不在选中集合里 → 不匹配')
  ok(!mod.matchesFacetValue(null, ['installed']), '卡片不暴露该维度且用户选了这个维度 → 不匹配（宁严勿松）')
  ok(mod.matchesFacetValue(null, []), '卡片不暴露该维度但没筛它 → 放行')

  ok(mod.matchesEntity(entity, mod.emptySelection(), 'any'), '无条件 → 命中')
  ok(mod.matchesEntity(entity, { tags: [], install: ['installed'], enabled: [] }, 'any'), '维度命中')
  ok(!mod.matchesEntity(entity, { tags: [], install: ['missing'], enabled: [] }, 'any'), '维度不命中')
  ok(!mod.matchesEntity(entity, { tags: [], install: [], enabled: ['on'] }, 'any'), '启用状态也是 AND 的一环')
  ok(
    mod.matchesEntity(entity, { tags: ['kugou'], install: ['installed'], enabled: ['off'] }, 'any'),
    '三个维度同时满足才命中'
  )
  ok(
    !mod.matchesEntity(entity, { tags: ['nope'], install: ['installed'], enabled: ['off'] }, 'any'),
    '标签维度不满足 → 整体不命中'
  )

  const facetEntities = [
    { key: 'p1', tagKeys: keySet('a'), facets: { install: 'installed', enabled: 'on' }, tags: [] },
    { key: 'p2', tagKeys: keySet('a'), facets: { install: 'missing', enabled: null }, tags: [] },
    { key: 'p3', tagKeys: keySet('b'), facets: { install: 'installed', enabled: 'off' }, tags: [] }
  ]
  eq(mod.matchStatsFor(facetEntities, { tags: [], install: ['installed'], enabled: [] }, 'any').matched, 2, '统计：已安装 2 个')
  eq(mod.matchStatsFor(facetEntities, { tags: [], install: [], enabled: ['off'] }, 'any').matched, 1, '统计：未启用 1 个')
  eq(
    mod.matchStatsFor(facetEntities, { tags: ['a'], install: ['installed'], enabled: [] }, 'any').matched,
    1,
    '统计：标签与维度之间是 AND'
  )

  const installChips = mod.buildFacetChips('install', facetEntities, mod.emptySelection(), 'any')
  eq(installChips.length, 2, '安装状态只列出视图里真实出现过的值')
  eq(installChips.map((c) => c.value).join(','), 'installed,missing', '值的顺序按定义顺序')
  eq(installChips[0].count, 2, '已安装计数 2')
  eq(installChips[0].alive, 2, '选中「已安装」后会匹配 2 个')
  eq(installChips[1].key, 'install:missing', 'chip key 带维度前缀')
  eq(mod.buildFacetChips('enabled', facetEntities, mod.emptySelection(), 'any').length, 2, '启用状态 2 个取值')

  const withSelection = mod.buildFacetChips('install', facetEntities, { tags: [], install: ['missing'], enabled: [] }, 'any')
  eq(
    withSelection.find((c) => c.value === 'installed').alive,
    3,
    '未选中值：给出「加上它以后」的匹配数（维度内部 OR → 3 个都有安装状态）'
  )
  eq(withSelection.find((c) => c.value === 'missing').selected, true, '已选值标记 selected')
  eq(withSelection.find((c) => c.value === 'missing').count, 1, '已选值的 count 仍是稳定值')

  const missingOnly = [
    { key: 'p1', tagKeys: keySet('a'), facets: { install: 'installed', enabled: null }, tags: [] }
  ]
  const noMissing = mod.buildFacetChips('install', missingOnly, { tags: [], install: ['missing'], enabled: [] }, 'any')
  const missingChip = noMissing.find((c) => c.value === 'missing')
  ok(!!missingChip, '已选但当前视图里不存在的维度值也要列出（否则取消不掉）')
  eq(missingChip.count, 0, '不存在的维度值计数为 0')
  eq(missingChip.dead, false, '已选中的 chip 不标记 dead')
}

{
  /* 分组：只在维度真的有两种以上取值时才成组 */
  const grouped = [
    { key: 'p1', tagKeys: keySet('a'), facets: { install: 'installed', enabled: 'on' }, tags: [{ key: 'a', label: 'a' }] },
    { key: 'p2', tagKeys: keySet('b'), facets: { install: 'missing', enabled: null }, tags: [{ key: 'b', label: 'b' }] }
  ]
  const groups = mod.buildGroups(grouped, mod.emptySelection(), 'any', null, {})
  eq(groups.map((g) => g.id).join(','), 'install,tags', '安装状态有 2 个取值 → 成组；启用状态只有 1 个 → 不成组')
  eq(groups[0].title, '安装状态', '分组标题来自定义')
  eq(groups[1].title, '目录标签', '标签组标题')

  const singleValue = [
    { key: 'p1', tagKeys: keySet('a'), facets: { install: 'installed', enabled: 'on' }, tags: [{ key: 'a', label: 'a' }] },
    { key: 'p2', tagKeys: keySet('b'), facets: { install: 'installed', enabled: 'off' }, tags: [{ key: 'b', label: 'b' }] }
  ]
  const onlyEnabled = mod.buildGroups(singleValue, mod.emptySelection(), 'any', null, {})
  eq(onlyEnabled.map((g) => g.id).join(','), 'enabled,tags', '全部已安装 → 安装状态组消失；启用状态分两种 → 出现')
  eq(onlyEnabled[0].chips.length, 2, '启用状态两个值都在')

  const noFacets = mod.buildGroups(grouped, mod.emptySelection(), 'any', null, { showFacets: false })
  eq(noFacets.map((g) => g.id).join(','), 'tags', 'showFacets 关掉后不再有状态组')

  const withCapability = mod.buildGroups(
    [
      {
        key: 'p1',
        tagKeys: keySet('a', 'net'),
        facets: { install: null, enabled: null },
        tags: [
          { key: 'a', label: 'a', capability: false },
          { key: 'net', label: 'net', capability: true }
        ]
      }
    ],
    mod.emptySelection(),
    'any',
    null,
    {}
  )
  eq(withCapability.map((g) => g.id).join(','), 'tags,capability', '能力标签单独成组，排在目录标签之后')

  const emptyGroups = mod.buildGroups([], mod.emptySelection(), 'any', null, {})
  eq(emptyGroups.length, 0, '没有实体 → 没有分组')
}

{
  /* 自定义组 */
  const groups = mod.normalizeGroups([
    { id: 'g1', name: '歌词相关', tags: ['lyrics', 'floating-window', 'lyrics'] },
    { id: 'g1', name: '重复 id', tags: ['x'] },
    { id: 'g2', name: '', tags: ['y'] },
    { id: 'g3', name: '空的', tags: [] },
    { id: 'g4', name: '  ', tags: ['z'] },
    null,
    'garbage'
  ])
  eq(groups.length, 1, '非法/重复/空组被丢掉')
  eq(groups[0].tags.length, 2, '组内标签去重')
  eq(groups[0].name, '歌词相关', '组名保留')

  const group = { id: 'g1', name: '歌词相关', tags: ['lyrics', 'floating-window'] }
  eq(mod.groupSelectionState(group, []), 'none', '没选 → none')
  eq(mod.groupSelectionState(group, ['lyrics']), 'some', '选了一部分 → some')
  eq(mod.groupSelectionState(group, ['lyrics', 'floating-window']), 'all', '全选 → all')
  eq(mod.groupSelectionState(group, ['lyrics', 'floating-window', 'other']), 'all', '组外标签不影响组状态')

  eq(mod.toggleGroupTags(group, []).sort().join(','), 'floating-window,lyrics', '未全选 → 一次全选')
  eq(mod.toggleGroupTags(group, ['lyrics']).sort().join(','), 'floating-window,lyrics', '部分选中 → 补全')
  eq(mod.toggleGroupTags(group, ['lyrics', 'floating-window']).join(','), '', '全选状态下点击 → 全部取消')
  eq(
    mod.toggleGroupTags(group, ['lyrics', 'floating-window', 'other']).join(','),
    'other',
    '全选状态下点击 → 只取消组内标签，组外不受影响'
  )

  const members = [{ key: 'p1', tagKeys: keySet('lyrics', 'other'), facets: null, tags: [] }]
  const groupChips = mod.buildGroupChips([group], members, { tags: ['lyrics'], install: [], enabled: [] })
  eq(groupChips.length, 1, '每个组一个 chip')
  eq(groupChips[0].kind, 'group', 'chip 类型是 group')
  eq(groupChips[0].count, 2, '组 chip 的 count = 成员数')
  eq(groupChips[0].present, 1, 'present = 本视图里真实存在的成员数')
  eq(groupChips[0].selectedCount, 1, 'selectedCount = 已选成员数')
  eq(groupChips[0].partial, true, '部分选中 → partial')
  eq(groupChips[0].selected, false, '部分选中不算全选')
}

{
  /* 分组等价判定：用来避免每秒重渲染 */
  const chip = (key, extra = {}) => ({ key, label: key, count: 1, alive: 1, selected: false, dead: false, ...extra })
  const groupOf = (chips) => [{ id: 'tags', kind: 'tag', title: '目录标签', chips }]
  ok(mod.sameGroups(groupOf([chip('a')]), groupOf([chip('a')])), 'sameGroups：内容一致等价')
  ok(!mod.sameGroups(groupOf([chip('a')]), groupOf([chip('b')])), 'sameGroups：chip 不同不等价')
  ok(!mod.sameGroups(groupOf([chip('a')]), []), 'sameGroups：分组数量不同不等价')
  ok(
    !mod.sameGroups(groupOf([chip('a', { partial: true })]), groupOf([chip('a')])),
    'sameGroups：partial 变化要算不等价'
  )
}

/* ========================================================================== *
 * 2. 激活与注册
 * ========================================================================== */

section('激活与注册')

const fixture = buildPluginPage()
const { ctx, record } = makeCtx()
let activateError = null
try {
  await mod.activate(ctx)
} catch (error) {
  activateError = error
}
ok(!activateError, 'activate 不抛错', activateError && String(activateError.stack).slice(0, 400))

eq(record.pages.length, 1, '注册了 1 个插件页面')
eq(record.pages[0].id, 'tag-filter', '页面 id 正确')
ok(!!record.pages[0].component, '页面带组件')
eq(record.settingsDefs.length, 1, '注册了设置面板')
eq(record.sidebarItems.length, 1, '注册了侧边栏入口')
eq(record.sidebarItems[0].pageId, 'tag-filter', '侧边栏入口指向本页面')
eq(record.sidebarItems[0].section, 'plugins', '侧边栏入口落在「插件」分组')
ok(record.commands.has('clear-tag-filter'), '注册了 clear-tag-filter 命令')
ok(record.commands.has('toggle-tag-filter-bar'), '注册了 toggle-tag-filter-bar 命令')

const hosts = doc.querySelectorAll('.etf-host')
eq(hosts.length, 1, '在插件面板注入了 1 条筛选条')
eq(hosts[0].parentNode, fixture.content, '筛选条挂在插件管理页的内容容器里')
eq(hosts[0].nextSibling, fixture.grid, '筛选条紧贴在卡片网格上方')
eq(record.mounts.length, 1, '筛选条组件已挂载到自建元素上')
eq(record.mounts[0].host, hosts[0], '挂载目标就是注入的宿主元素')
eq(observers.length, 1, '起了 1 个 MutationObserver')
eq(timers.intervals.size, 1, '起了 1 个兜底轮询定时器')

/* ========================================================================== *
 * 3. 标签提取与 chip 渲染
 * ========================================================================== */

section('标签提取与 chip 渲染')

const bar = renderComponent(record.mounts[0].component)
let tree = bar()

eq(chipsOf(tree).length, TAG_COUNT + 1, '聚合出 12 个目录标签 + 1 个「未标注」')
eq(chipByTag(tree, 'kugou').props['data-count'], String(N_KUGOU), 'kugou 的计数正确')
eq(chipByTag(tree, 'lyrics').props['data-count'], String(N_LYRICS), 'lyrics 的计数正确')
ok(!!chipByTag(tree, '__untagged__'), '没有标签的插件产生了「未标注」chip')
eq(chipByTag(tree, '__untagged__').props['data-capability'], '0', '「未标注」不是能力标签')
ok(!chipTags(tree).includes('网络'), '默认不纳入能力标签（「网络」不应出现）')
ok(
  chipsOf(tree).every((n) => n.props['data-selected'] === '0'),
  '初始状态所有 chip 都未选中'
)
includes(textOfNode(tree), `共 ${CARD_COUNT} 个插件`, '状态行显示插件总数')
includes(textOfNode(tree), `${TAG_COUNT} 个标签`, '状态行显示标签数')
includes(textOfNode(tree), '1 个未标注', '状态行显示未标注数量')
ok(!byProp(tree, 'data-role', 'empty'), '初始没有空状态')

const cardsOf = () => Array.from(fixture.grid.querySelectorAll('.plugin-card'))
const visibleCards = () => cardsOf().filter((card) => card.style.display !== 'none')

/* ========================================================================== *
 * 4. 单选过滤
 * ========================================================================== */

section('单选过滤')

clickChip(tree, 'kugou')
tree = bar()

eq(visibleCards().length, N_KUGOU, '单选 kugou 后只剩 1 张卡片可见')
eq(cardsOf().length, CARD_COUNT, '卡片只是被隐藏，没有从 DOM 移除')
eq(chipByTag(tree, 'kugou').props['data-selected'], '1', 'kugou chip 变成选中态')
eq(chipByTag(tree, 'kugou').props['aria-pressed'], 'true', '选中 chip 的 aria-pressed 为 true')
eq(chipByTag(tree, 'lyrics').props['data-selected'], '0', '其它 chip 仍未选中')
includes(textOfNode(tree), `显示 ${N_KUGOU} / ${CARD_COUNT}`, '状态行显示匹配进度')
includes(textOfNode(tree), `隐藏 ${CARD_COUNT - N_KUGOU} 个`, '状态行显示隐藏数量')
eq(chipByTag(tree, 'kugou').props['data-count'], String(N_KUGOU), 'kugou 计数不随选择变化')
eq(chipByTag(tree, 'lyrics').props['data-count'], String(N_LYRICS), 'lyrics 计数不随选择变化')

clickChip(tree, 'kugou')
tree = bar()
eq(visibleCards().length, CARD_COUNT, '再次点击同一 chip = 取消选择，列表恢复完整')

/* ========================================================================== *
 * 5. 多选（任一 / 全部）与空状态
 * ========================================================================== */

section('多选与空状态')

clickChip(tree, 'lyrics')
tree = bar()
eq(visibleCards().length, N_LYRICS, '单选 lyrics 命中 2 个')

clickChip(tree, 'local')
tree = bar()
eq(visibleCards().length, N_LYRICS + N_LOCAL, '任一模式：lyrics 或 local 的并集 = 3 个')

byProp(tree, 'data-mode', 'all').props.onClick()
tree = bar()
eq(visibleCards().length, 0, '「全部」模式：lyrics AND local 无交集 → 0 个')
ok(byProp(tree, 'data-mode', 'all').props.class.includes('is-on'), '「全部」按钮进入选中态')
ok(!!byProp(tree, 'data-role', 'empty'), '无匹配时渲染出空状态')
includes(textOfNode(byProp(tree, 'data-role', 'empty')), '没有符合条件的插件', '空状态标题友好')
includes(textOfNode(byProp(tree, 'data-role', 'empty')), 'lyrics', '空状态列出已选条件，便于自查')
ok(cardsOf().every((card) => card.style.display === 'none'), '空状态下列表确实是空的')

byProp(tree, 'data-action', 'clear').props.onClick()
tree = bar()
eq(visibleCards().length, CARD_COUNT, '空状态里点「清除筛选」恢复完整列表')
ok(!byProp(tree, 'data-role', 'empty'), '恢复后空状态消失')

clickChip(tree, 'kugou')
tree = bar()
eq(visibleCards().length, N_KUGOU, '全部模式下单选 kugou = 1 个')
ok(chipByTag(tree, 'lyrics').props.class.includes('is-dead'), 'kugou 已选时 lyrics 被标记为 is-dead')
eq(chipByTag(tree, 'lyrics').props['data-selected'], '0', 'is-dead 的 chip 依旧可点（不是 disabled）')
includes(chipByTag(tree, 'lyrics').props.title, '没有插件符合', 'is-dead 的提示文案解释了原因')

byProp(tree, 'data-action', 'clear').props.onClick()
tree = bar()

byProp(tree, 'data-mode', 'any').props.onClick()
tree = bar()
eq(visibleCards().length, CARD_COUNT, '切回「任一」模式后无选择即全部可见')

/* ========================================================================== *
 * 6.「未标注」伪标签
 * ========================================================================== */

section('未标注伪标签')

clickChip(tree, '__untagged__')
tree = bar()
eq(visibleCards().length, 1, '「未标注」只命中没有标签的那张卡片')
eq(visibleCards()[0].querySelector('.plugin-card-name').textContent, 'GitHub 加速器', '命中的确实是没有标签的插件')
byProp(tree, 'data-action', 'clear').props.onClick()
tree = bar()
eq(visibleCards().length, CARD_COUNT, '清除后恢复')

/* ========================================================================== *
 * 7. 清除筛选
 * ========================================================================== */

section('清除筛选')

clickChip(tree, 'lyrics')
tree = bar()
eq(byProp(tree, 'data-action', 'clear').props.disabled, false, '有选择时「清除筛选」可点')
byProp(tree, 'data-action', 'clear').props.onClick()
tree = bar()
eq(visibleCards().length, CARD_COUNT, '「清除筛选」恢复完整列表')
eq(byProp(tree, 'data-action', 'clear').props.disabled, true, '无选择时「清除筛选」禁用')
ok(
  chipsOf(tree).every((n) => n.props['data-selected'] === '0'),
  '清除后所有 chip 回到未选中'
)
ok(
  cardsOf().every((card) => !card.style.display),
  '被隐藏过的卡片行内 display 已还原为空（不留残留）'
)
includes(textOfNode(tree), `共 ${CARD_COUNT} 个插件`, '状态行回到总数文案')

/* ========================================================================== *
 * 8. 骨架屏网格必须跳过
 * ========================================================================== */

section('骨架屏网格')

{
  const busyGrid = el('div', 'plugin-card-grid')
  busyGrid.setAttribute('aria-busy', 'true')
  for (let i = 0; i < 3; i++) {
    busyGrid.appendChild(makeCard({ id: `skeleton-${i}`, name: `骨架 ${i}`, tags: ['SKELETON-TAG'] }))
  }
  fixture.content.insertBefore(busyGrid, fixture.grid)

  hostRerender()
  tree = bar()

  ok(!chipTags(tree).includes('skeleton-tag'), '骨架屏里的占位标签不会被聚合进来')
  eq(chipsOf(tree).length, TAG_COUNT + 1, 'chip 数量不因骨架屏变化')
  eq(doc.querySelectorAll('.etf-host').length, 1, '骨架屏网格不会额外注入一条筛选条')
  ok(
    Array.from(busyGrid.querySelectorAll('.plugin-card')).every((card) => card.style.display !== 'none'),
    '骨架卡片不受筛选影响'
  )

  busyGrid.remove()
  hostRerender()
  tree = bar()
}

/* ========================================================================== *
 * 9. 标签大小写归一（端到端）
 * ========================================================================== */

section('标签大小写归一')

{
  const extra = makeCard({ id: 'case-test', name: '大小写测试', tags: ['LYRICS', '  Spotify  '] })
  fixture.grid.appendChild(extra)
  hostRerender()
  tree = bar()

  ok(!chipTags(tree).includes('LYRICS'), '大写标签不会另开一个 chip')
  eq(chipByTag(tree, 'lyrics').props['data-count'], String(N_LYRICS + 1), 'lyrics 的计数把大写变体算进来')
  eq(chipByTag(tree, 'lyrics').props['data-tag'], 'lyrics', 'chip 的 key 统一为小写')
  eq(chipByTag(tree, 'lyrics').props.title.startsWith('标签'), true, 'chip 的展示文案仍用原始写法')

  clickChip(tree, 'lyrics')
  tree = bar()
  eq(visibleCards().length, N_LYRICS + 1, '按 lyrics 过滤时大小写变体一起命中')
  byProp(tree, 'data-action', 'clear').props.onClick()
  tree = bar()

  extra.remove()
  hostRerender()
  tree = bar()
  eq(visibleCards().length, CARD_COUNT, '移除测试卡片后恢复')
}

/* ========================================================================== *
 * 10. 宿主原地重渲染不会让筛选失效
 * ========================================================================== */

section('宿主重渲染')

clickChip(tree, 'lyrics')
tree = bar()
eq(visibleCards().length, N_LYRICS, '先筛出 2 个')

{
  // 宿主卡片状态变化时 Vue 会整串重写 className（这也正是不能用 class 做隐藏的原因）
  const target = cardsOf().find((card) => card.querySelector('.plugin-card-name').textContent === '鼠标手势')
  target.className = 'plugin-card is-disabled'
  eq(target.style.display, 'none', '隐藏靠行内 display，className 被重写不影响')

  // 万一有东西把行内样式清了，兜底轮询要能把它重新压回去
  target.style.display = ''
  hostRerender()
  eq(target.style.display, 'none', '兜底轮询会把被清掉的隐藏样式重新应用')
  eq(visibleCards().length, N_LYRICS, '可见卡片数量保持不变')
}

byProp(tree, 'data-action', 'clear').props.onClick()
tree = bar()

/* ========================================================================== *
 * 11. 视图切换 / 网格节点被替换
 * ========================================================================== */

section('视图切换与节点替换')

{
  const savedGrid = fixture.grid
  const emptyState = el('div', 'plugin-empty-state', '暂无已安装插件')
  fixture.content.insertBefore(emptyState, savedGrid)
  savedGrid.remove()

  hostRerender()
  eq(doc.querySelectorAll('.etf-host').length, 0, '没有卡片网格时移除筛选条（不在空页面上占位）')

  fixture.content.insertBefore(savedGrid, emptyState)
  emptyState.remove()
  hostRerender()
  const restored = doc.querySelectorAll('.etf-host')
  eq(restored.length, 1, '网格回来后重新注入筛选条')
  eq(restored[0].nextSibling, savedGrid, '重新注入后位置依旧在网格上方')
}

{
  const oldGrid = fixture.grid
  const newGrid = el('div', 'plugin-card-grid')
  for (const item of FIXTURE) newGrid.appendChild(makeCard(item))
  fixture.content.insertBefore(newGrid, oldGrid)
  oldGrid.remove()

  hostRerender()
  tree = bar()
  const host = doc.querySelectorAll('.etf-host')[0]
  eq(doc.querySelectorAll('.etf-host').length, 1, '网格换节点后仍然只有一条筛选条')
  eq(host.nextSibling, newGrid, '筛选条被挪到新网格上方')
  eq(chipsOf(tree).length, TAG_COUNT + 1, '新网格的标签重新聚合正确')

  fixture.grid = newGrid
}

/* ========================================================================== *
 * 12. 设置面板
 * ========================================================================== */

section('设置面板')

const settingsPanel = renderComponent(record.settingsDefs[0].component)
let settingsTree = settingsPanel()
const switchNodes = () => findAll(settingsTree, (n) => n.props && n.props.role === 'switch')
const clickSwitch = (index) => switchNodes()[index].props.onClick({ preventDefault() {} })

eq(switchNodes().length, 7, '设置面板有 7 个开关')
ok(
  switchNodes()
    .slice(0, 5)
    .every((n) => n.props['aria-checked'] === 'true'),
  '默认前 5 个开关都是开启的（筛选条 / 侧边栏入口 / 记住筛选 / 显示计数 / 状态维度）'
)
eq(switchNodes()[5].props['aria-checked'], 'false', '「同时纳入能力标签」默认关闭（避免两套标签体系混淆）')
eq(switchNodes()[6].props['aria-checked'], 'false', '「调试日志」默认关闭')

/* 关闭「显示计数」 */
clickSwitch(3)
flushTimeouts()
settingsTree = settingsPanel()
ok(
  !chipsOf(bar()).some((n) => n.props.class.includes('etf-chip-count')),
  '关掉「显示计数」后 chip 不再渲染数量'
)
eq(switchNodes()[3].props['aria-checked'], 'false', '开关状态同步更新')

/* 打开「能力标签」 */
clickSwitch(5)
flushTimeouts()
tree = bar()
ok(!!chipByTag(tree, '网络'), '打开「能力标签」后能力标签进入 chip 列表')
eq(chipByTag(tree, '网络').props['data-capability'], '1', '能力标签带 capability 标记')
includes(chipByTag(tree, '网络').props.title, '能力标签', '能力标签的提示文案与目录标签区分')
eq(chipByTag(tree, 'lyrics').props['data-capability'], '0', '目录标签的 capability 为 0')

/* 关掉筛选条：必须先制造一次筛选，否则「还原」这条断言是空的 */
{
  tree = bar()
  clickChip(tree, 'lyrics')
  tree = bar()
  eq(visibleCards().length, N_LYRICS, '关掉筛选条前先筛出 2 个（让「还原」这条断言有的可验）')

  clickSwitch(0)
  flushTimeouts()
  eq(doc.querySelectorAll('.etf-host').length, 0, '关掉「面板筛选条」后注入被移除')
  eq(visibleCards().length, CARD_COUNT, '关掉筛选条时已隐藏的卡片全部还原')
  ok(cardsOf().every((card) => !card.style.display), '关掉筛选条后行内样式不留残留')
  eq(renderComponent(record.mounts[0].component)() === null, true, '筛选条组件渲染为 null')

  settingsTree = settingsPanel()
  clickSwitch(0)
  clickSwitch(3)
  clickSwitch(5)
  flushTimeouts()
  eq(doc.querySelectorAll('.etf-host').length, 1, '重新打开后筛选条回来了')
  tree = bar()
  ok(!!chipByTag(tree, 'kugou'), '重新打开后标签依然正确')
  eq(chipByTag(tree, 'lyrics').props['data-selected'], '1', '关掉再打开期间筛选条仍记得刚才的选择')
  byProp(tree, 'data-action', 'clear').props.onClick()
  tree = bar()
  eq(visibleCards().length, CARD_COUNT, '清除筛选，回到干净状态供后续断言使用')
}

/* 侧边栏入口开关：必须立即生效（不能要求重启主程序） */
{
  settingsTree = settingsPanel()
  clickSwitch(1)
  flushTimeouts()
  eq(record.sidebarItems.length, 0, '关掉「侧边栏入口」后入口被移除（立即生效）')
  settingsTree = settingsPanel()
  clickSwitch(1)
  flushTimeouts()
  eq(record.sidebarItems.length, 1, '再打开后入口回来了')
  eq(record.sidebarItems[0].pageId, 'tag-filter', '入口依旧指向本页面')
}

/* 默认匹配方式：没有选择时应当立刻改变筛选条的语义 */
{
  byProp(settingsPanel(), 'data-default-mode', 'all').props.onClick()
  flushTimeouts()
  ok(
    byProp(bar(), 'data-mode', 'all').props.class.includes('is-on'),
    '把默认匹配方式改成「全部」后筛选条立刻跟着变（当前没有选择）'
  )
  byProp(settingsPanel(), 'data-default-mode', 'any').props.onClick()
  flushTimeouts()
  ok(byProp(bar(), 'data-mode', 'any').props.class.includes('is-on'), '改回「任一」同样立即生效')
}

/* ========================================================================== *
 * 13. 命令
 * ========================================================================== */

section('命令')

clickChip(tree, 'lyrics')
tree = bar()
eq(visibleCards().length, N_LYRICS, '命令执行前先选中一个标签')
await ctx.commands.execute('clear-tag-filter')
tree = bar()
eq(visibleCards().length, CARD_COUNT, 'clear-tag-filter 清除筛选')
includes(toastText(record), '已清除筛选条件', '清除后给出提示')

await ctx.commands.execute('clear-tag-filter')
includes(toastText(record), '当前没有筛选条件', '无筛选时给出中性提示')
await ctx.commands.execute('toggle-tag-filter-bar')
flushTimeouts()
eq(doc.querySelectorAll('.etf-host').length, 0, 'toggle 命令关闭了筛选条')
await ctx.commands.execute('toggle-tag-filter-bar')
flushTimeouts()
eq(doc.querySelectorAll('.etf-host').length, 1, '再执行 toggle 命令又打开了')

/* ========================================================================== *
 * 14. 独立页面：标签总览与诊断
 * ========================================================================== */

section('独立页面')

const page = renderComponent(record.pages[0].component)
let pageTree = page()
includes(textOfNode(pageTree), '插件标签筛选', '页面标题')
eq(
  findAll(pageTree, (n) => n.props && n.props['data-tag'] !== undefined).length,
  chipsOf(bar()).length,
  '页面的标签总览与筛选条共享同一份数据'
)
includes(textOfNode(byProp(pageTree, 'data-role', 'catalog-meta')), '实时', '面板已打开时标注为实时数据')

/* 页面上的 chip 与面板筛选条联动 */
{
  const pageChip = findAll(pageTree, (n) => n.props && n.props['data-tag'] === 'lyrics')[0]
  pageChip.props.onClick()
  pageTree = page()
  eq(
    findAll(pageTree, (n) => n.props && n.props['data-tag'] === 'lyrics')[0].props['data-selected'],
    '1',
    '页面上的 chip 选中后自身更新'
  )
  eq(visibleCards().length, N_LYRICS, '页面上的选择同样作用于插件面板')
  byProp(pageTree, 'data-action', 'clear').props.onClick()
  pageTree = page()
  eq(visibleCards().length, CARD_COUNT, '页面上的「清除筛选」也生效')
}

/* 「定位筛选条」高亮 */
{
  byProp(pageTree, 'data-action', 'locate').props.onClick()
  pageTree = page()
  ok(bar().props.class.includes('is-focused'), '点击「定位筛选条」后筛选条被高亮')
  flushTimeouts()
  ok(!bar().props.class.includes('is-focused'), '高亮在一段时间后自动消失')
}

/* 「复制诊断」 */
{
  let copied = null
  const originalNavigator = globalThis.navigator
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async (text) => void (copied = text) } },
      configurable: true,
      writable: true
    })
  } catch (error) {
    /* Node 自带的 navigator 不可写时，插件会走降级分支，下面两条断言都不会通过 */
  }
  byProp(page(), 'data-action', 'copy-diagnostics').props.onClick()
  await tick()
  if (copied) {
    const parsed = JSON.parse(copied)
    eq(parsed.plugin, 'tag-filter', '诊断 JSON 带插件标识')
    eq(parsed.dom.cards, CARD_COUNT, '诊断里记录了面板卡片数')
    eq(parsed.dom.hosts, 1, '诊断里记录了已注入的筛选条数量')
    eq(parsed.cards.length, CARD_COUNT, '诊断里逐张列出了卡片与其标签')
    ok(parsed.selection && Array.isArray(parsed.selection.tags), '诊断里带当前选择（三维度结构）')
    ok(Array.isArray(parsed.groups), '诊断里带自定义组列表')
  } else {
    ok(true, '当前环境不支持剪贴板，跳过诊断内容断言')
  }
  Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true, writable: true })
}

/* 面板离开后：页面回落到快照（独立页面必须仍然有用） */
{
  const saved = record.store.get('tag-filter-store')
  ok(!!saved, '筛选状态已写进插件存储')
  ok(Array.isArray(saved.snapshot.items) && saved.snapshot.items.length > 0, '快照里记下了插件与标签')
  eq(saved.snapshot.items.length, CARD_COUNT, '快照条目数 = 卡片数')
  ok(saved.snapshot.at > 0, '快照带采集时间')
  ok(!!saved.settings, '设置也持久化了')
  const untaggedItem = saved.snapshot.items.find((item) => item.id === 'gh-accelerator')
  eq(untaggedItem.tags.length, 0, '未标注插件在快照里标签为空数组')

  const grid = fixture.grid
  grid.remove()
  hostRerender()
  pageTree = page()
  eq(
    findAll(pageTree, (n) => n.props && n.props['data-tag'] !== undefined).length,
    TAG_COUNT + 1,
    '面板离开后页面仍能给出标签总览（走快照）'
  )
  includes(textOfNode(byProp(pageTree, 'data-role', 'catalog-meta')), '上次采集', '回落时明确标注是上次采集')
  fixture.content.appendChild(grid)
  hostRerender()
  pageTree = page()
  includes(textOfNode(byProp(pageTree, 'data-role', 'catalog-meta')), '实时', '回到面板后恢复实时标注')
}

/* ========================================================================== *
 * 15. 停用还原
 * ========================================================================== */

section('停用还原')

clickChip(bar(), 'lyrics')
eq(visibleCards().length, N_LYRICS, '停用前先制造一次筛选')

{
  const store = record.store
  eq(doc.querySelectorAll('.etf-host').length, 1, '停用前筛选条在页面上')

  disposeAll(record)
  eq(doc.querySelectorAll('.etf-host').length, 0, '停用后筛选条被移除')
  ok(cardsOf().every((card) => !card.style.display), '停用后被隐藏的卡片全部还原（不能留下被筛过的列表）')
  eq(timers.intervals.size, 0, '停用后兜底轮询被清掉')
  ok(
    observers.every((o) => o.targets.length === 0),
    '停用后 DOM 监听被断开'
  )
  eq(record.sidebarItems.length, 0, '停用后侧边栏入口被移除')
  record.store = store
}

/* ========================================================================== *
 * 16. 重启后恢复选择
 * ========================================================================== */

section('重启恢复')

{
  resetDom()
  const fresh = buildPluginPage()
  const { ctx: ctx2, record: record2 } = makeCtx(record.store)

  const saved = clone(record.store.get('tag-filter-store'))
  saved.selection = ['lyrics']
  saved.mode = 'any'
  record.store.set('tag-filter-store', saved)

  let error = null
  try {
    await mod.activate(ctx2)
  } catch (thrown) {
    error = thrown
  }
  ok(!error, '重启后 activate 不抛错', error && String(error.stack).slice(0, 300))

  const tree2 = renderComponent(record2.mounts[0].component)()
  eq(chipByTag(tree2, 'lyrics').props['data-selected'], '1', '重启后恢复上次选中的标签')
  const visible2 = Array.from(fresh.grid.querySelectorAll('.plugin-card')).filter(
    (card) => card.style.display !== 'none'
  )
  eq(visible2.length, N_LYRICS, '重启后立即按上次的选择过滤了列表')

  disposeAll(record2)
}

{
  resetDom()
  buildPluginPage()
  const saved = clone(record.store.get('tag-filter-store'))
  saved.settings.persistSelection = false
  saved.selection = ['kugou']
  saved.mode = 'all'
  record.store.set('tag-filter-store', saved)

  const { ctx: ctx3, record: record3 } = makeCtx(record.store)
  await mod.activate(ctx3)
  const tree3 = renderComponent(record3.mounts[0].component)()
  ok(
    chipsOf(tree3).every((n) => n.props['data-selected'] === '0'),
    '关掉「记住筛选状态」后不再恢复上次的选择'
  )
  ok(byProp(tree3, 'data-mode', 'any').props.class.includes('is-on'), '匹配模式回落到默认的「任一」')
  disposeAll(record3)
}

/* ========================================================================== *
 * 17. 宿主一个标签都没给出来时的降级
 * ========================================================================== */

section('无标签降级')

{
  resetDom()
  const content = el('div', 'plugin-content px-6 pb-6')
  const grid = el('div', 'plugin-card-grid')
  for (let i = 0; i < 3; i++) grid.appendChild(makeCard({ id: `local-${i}`, name: `本地插件 ${i}`, tags: [] }))
  content.appendChild(grid)
  doc.body.appendChild(content)

  const { ctx: ctx4, record: record4 } = makeCtx()
  await mod.activate(ctx4)
  const render4 = renderComponent(record4.mounts[0].component)
  let tree4 = render4()

  eq(chipsOf(tree4).length, 1, '一个标签都没有时只剩「未标注」一个 chip')
  ok(!!chipByTag(tree4, '__untagged__'), '「未标注」仍然可用')
  eq(chipByTag(tree4, '__untagged__').props['data-count'], '3', '「未标注」计数正确')

  const hint = byProp(tree4, 'data-role', 'hint')
  ok(!!hint, '给出降级提示（而不是静悄悄地只有一个「未标注」）')
  includes(textOfNode(hint), '宿主没有提供任何插件标签', '提示文案说明了原因')

  clickChip(tree4, '__untagged__')
  tree4 = render4()
  eq(
    Array.from(grid.querySelectorAll('.plugin-card')).filter((card) => card.style.display !== 'none').length,
    3,
    '只有「未标注」时筛选依然可用'
  )
  ok(!byProp(tree4, 'data-role', 'empty'), '全部命中时不会出现空状态')
  ok(!!byProp(tree4, 'data-role', 'hint'), '一个标签都没有时降级提示一直保留（这时的解释始终有效）')

  disposeAll(record4)
}

/* ========================================================================== *
 * 18. 状态维度：安装状态（在线插件视图）
 * ========================================================================== */

section('状态维度·安装状态')

const groupsOf = (tree) => findAll(tree, (n) => n.props && n.props['data-role'] === 'group')
const groupIds = (tree) => groupsOf(tree).map((n) => n.props['data-group'])
const facetChipsOf = (tree) => findAll(tree, (n) => n.props && n.props['data-facet'] !== undefined)
const facetChip = (tree, facetId, value) =>
  facetChipsOf(tree).find((n) => n.props['data-facet'] === facetId && n.props['data-value'] === value)
const groupHeads = (tree) => findAll(tree, (n) => n.props && n.props['data-action'] === 'toggle-group')
const groupHeadOf = (tree, id) => groupHeads(tree).find((n) => n.props['data-group'] === id)
const customGroupChips = (tree) =>
  findAll(tree, (n) => n.props && typeof n.props['data-key'] === 'string' && n.props['data-key'].startsWith('group:'))
const customGroupChip = (tree, id) => customGroupChips(tree).find((n) => n.props['data-group'] === id)
const expandButton = (tree) => byProp(tree, 'data-action', 'toggle-expand')
const groupsBlock = (tree) => byProp(tree, 'data-role', 'groups')
const summaryRow = (tree) => byProp(tree, 'data-role', 'summary')

const MARKETPLACE_FIXTURE = [
  { id: 'kugou-recommend', name: '推荐电台', tags: ['kugou', 'radio'], status: '已安装' },
  { id: 'taskbar-lyric', name: '任务栏歌词', tags: ['lyrics'], status: '可更新' },
  { id: 'player-frontend', name: '播放器前端', tags: ['player', 'lyrics'], status: '未安装' },
  { id: 'mouse-gesture', name: '鼠标手势', tags: ['gesture'], status: '未安装' }
]

{
  resetDom()
  const page = buildPageWith(MARKETPLACE_FIXTURE.map((item) => makeMarketplaceCard(item)))
  const { ctx: mkCtx, record: mkRecord } = makeCtx()
  await mod.activate(mkCtx)
  const mkBar = renderComponent(mkRecord.mounts[0].component)
  let mkTree = mkBar()
  const mkCards = () => Array.from(page.grid.querySelectorAll('.plugin-card'))
  const mkVisible = () => mkCards().filter((card) => card.style.display !== 'none')

  eq(groupIds(mkTree).join(','), 'install,tags', '在线视图：安装状态成组；启用状态不暴露所以不出现')
  eq(groupHeadOf(mkTree, 'install').props.class.includes('is-collapsed'), false, '分组默认展开')
  eq(facetChipsOf(mkTree).length, 3, '安装状态列出 已安装 / 未安装 / 可更新 三个值')
  eq(facetChip(mkTree, 'install', 'installed').props['data-count'], '1', '已安装计数 1')
  eq(facetChip(mkTree, 'install', 'missing').props['data-count'], '2', '未安装计数 2')
  eq(facetChip(mkTree, 'install', 'update').props['data-count'], '1', '可更新计数 1')
  eq(facetChip(mkTree, 'install', 'missing').props['data-selected'], '0', '初始都未选中')
  ok(
    !chipsOf(mkTree).some((n) => String(n.props['data-tag']).indexOf('install:') === 0),
    '状态 chip 不带 data-tag，不会混进标签统计'
  )
  eq(groupHeadOf(mkTree, 'install').props['aria-expanded'], 'true', '分组标题声明为展开')

  facetChip(mkTree, 'install', 'missing').props.onClick()
  mkTree = mkBar()
  eq(mkVisible().length, 2, '选「未安装」→ 只剩两张未安装的卡片')
  eq(facetChip(mkTree, 'install', 'missing').props['data-selected'], '1', '「未安装」进入选中态')
  includes(textOfNode(byProp(mkTree, 'data-role', 'status')), '已选 1 个条件', '状态行的条件数含状态维度')
  includes(textOfNode(groupHeadOf(mkTree, 'install')), '已选 1 / 3', '分组标题显示已选进度')

  facetChip(mkTree, 'install', 'installed').props.onClick()
  mkTree = mkBar()
  eq(mkVisible().length, 3, '同一维度内多选是 OR（未安装 + 已安装 = 3）')

  facetChip(mkTree, 'install', 'missing').props.onClick()
  mkTree = mkBar()
  eq(mkVisible().length, 1, '取消「未安装」后只剩已安装的那张')
  eq(
    facetChip(mkTree, 'install', 'missing').props.class.includes('is-dead'),
    false,
    '「未安装」已取消且仍有匹配，不算 dead'
  )

  /* 状态维度与标签维度之间是 AND */
  byProp(mkTree, 'data-action', 'clear').props.onClick()
  mkTree = mkBar()
  clickChip(mkTree, 'lyrics')
  mkTree = mkBar()
  eq(mkVisible().length, 2, '只按 lyrics 筛 → 2 张（可更新的 + 未安装的各一张）')
  facetChip(mkTree, 'install', 'missing').props.onClick()
  mkTree = mkBar()
  eq(mkVisible().length, 1, 'lyrics + 未安装 = 1（维度之间是 AND）')
  eq(visibleName(mkVisible()[0]), '播放器前端', '交集命中的正是那张「未安装且带 lyrics」的卡片')
  eq(
    facetChip(mkTree, 'install', 'update').props.class.includes('is-on'),
    false,
    '带 lyrics 的那张「可更新」被 AND 排除掉了'
  )

  /* 标签与状态一起清除 */
  byProp(mkTree, 'data-action', 'clear').props.onClick()
  mkTree = mkBar()
  eq(mkVisible().length, MARKETPLACE_FIXTURE.length, '清除筛选后全部可见')
  eq(facetChipsOf(mkTree).every((n) => n.props['data-selected'] === '0'), true, '状态 chip 也一起被清掉')

  disposeAll(mkRecord)
}

function visibleName(card) {
  const name = card.querySelector('.plugin-card-name')
  return name ? name.textContent : ''
}

/* ========================================================================== *
 * 19. 状态维度：启用状态（已安装视图里有停用卡）
 * ========================================================================== */

section('状态维度·启用状态')

{
  resetDom()
  const cards = [
    makeCard({ id: 'a', name: '启用中的', tags: ['lyrics'] }),
    markDisabled(makeCard({ id: 'b', name: '停用的', tags: ['lyrics'] })),
    markDisabled(makeCard({ id: 'c', name: '也停用的', tags: ['radio'] }))
  ]
  const page = buildPageWith(cards)
  const { ctx: onCtx, record: onRecord } = makeCtx()
  await mod.activate(onCtx)
  const onBar = renderComponent(onRecord.mounts[0].component)
  let onTree = onBar()
  const onVisible = () => Array.from(page.grid.querySelectorAll('.plugin-card')).filter((c) => c.style.display !== 'none')

  eq(groupIds(onTree).join(','), 'enabled,tags', '已安装视图：启用状态成组（安装状态只有一种取值 → 不出现）')
  eq(facetChipsOf(onTree).map((n) => n.props['data-value']).join(','), 'on,off', '启用状态两个值都在')
  eq(facetChip(onTree, 'enabled', 'on').props['data-count'], '1', '已启用计数 1')
  eq(facetChip(onTree, 'enabled', 'off').props['data-count'], '2', '未启用计数 2')
  includes(
    facetChip(onTree, 'enabled', 'off').props.title,
    'is-disabled',
    '「未启用」的提示里说明了判定依据'
  )

  facetChip(onTree, 'enabled', 'off').props.onClick()
  onTree = onBar()
  eq(onVisible().length, 2, '选「未启用」→ 只剩两张停用卡')
  eq(visibleName(onVisible()[0]), '停用的', '命中的确实是带 is-disabled 的卡')

  clickChip(onTree, 'lyrics')
  onTree = onBar()
  eq(onVisible().length, 1, '未启用 + lyrics = 1（AND）')
  eq(visibleName(onVisible()[0]), '停用的', '交集正确')

  byProp(onTree, 'data-action', 'clear').props.onClick()
  onTree = onBar()
  eq(onVisible().length, 3, '清除后恢复')

  disposeAll(onRecord)
}

/* ========================================================================== *
 * 20. 分组折叠 + 整体收起 / 展开
 * ========================================================================== */

section('分组折叠与整体收起')

{
  resetDom()
  const cards = [
    makeCard({ id: 'a', name: 'A', tags: ['lyrics', 'player'] }),
    markDisabled(makeCard({ id: 'b', name: 'B', tags: ['lyrics'] }))
  ]
  const page = buildPageWith(cards)
  const { ctx: fc, record: fr } = makeCtx()
  await mod.activate(fc)
  const fBar = renderComponent(fr.mounts[0].component)
  let fTree = fBar()
  const fVisible = () => Array.from(page.grid.querySelectorAll('.plugin-card')).filter((c) => c.style.display !== 'none')

  eq(groupIds(fTree).join(','), 'enabled,tags', '两组：启用状态 + 目录标签')
  eq(!!groupsBlock(fTree), true, '默认展开：分组区在')
  eq(expandButton(fTree).props['data-expanded'], '1', '展开按钮声明为已展开')
  eq(summaryRow(fTree), undefined, '展开时不显示「已选条件」行（标签已经可见，不重复占地方）')
  includes(textOfNode(expandButton(fTree)), '收起', '展开状态下按钮文案是「收起」')

  /* 单个分组折叠 */
  groupHeadOf(fTree, 'tags').props.onClick()
  fTree = fBar()
  eq(groupHeadOf(fTree, 'tags').props.class.includes('is-collapsed'), true, '标签组折叠后带 is-collapsed')
  eq(chipsOf(fTree).length, 0, '折叠的组不再渲染 chip')
  eq(facetChipsOf(fTree).length, 2, '其它组不受影响')
  eq(!!groupsBlock(fTree), true, '单个组折叠不会收起整个分组区')

  groupHeadOf(fTree, 'tags').props.onClick()
  fTree = fBar()
  eq(chipsOf(fTree).length, 2, '再点一次展开，chip 回来')
  eq(groupHeads(fTree).length, 2, '两个组标题都在')

  /* 整体收起 */
  clickChip(fTree, 'lyrics')
  fTree = fBar()
  eq(fVisible().length, 2, '先筛一下，让「已选条件」行有内容')
  expandButton(fTree).props.onClick()
  fTree = fBar()
  eq(expandButton(fTree).props['data-expanded'], '0', '整体收起后按钮状态翻转')
  eq(groupsBlock(fTree), undefined, '整体收起后分组区消失')
  includes(textOfNode(expandButton(fTree)), '展开筛选', '收起状态下按钮提示展开')
  const summary = summaryRow(fTree)
  ok(!!summary, '收起时显示「已选条件」行（否则用户看不到自己在筛什么）')
  includes(textOfNode(summary), 'lyrics', '「已选条件」行列出已选标签')
  eq(
    findAll(summary, (n) => n.props && n.props['data-summary'] === '1').length,
    1,
    '已选条件行里每个条件一个可点 chip'
  )
  eq(fVisible().length, 2, '收起只是界面收起，过滤依旧生效')

  /* 点「已选条件」行里的 chip = 取消该条件 */
  findAll(summaryRow(fTree), (n) => n.props && n.props['data-summary'] === '1')[0].props.onClick()
  fTree = fBar()
  eq(fVisible().length, 2, '取消唯一条件后全部可见')
  includes(textOfNode(summaryRow(fTree)), '未选择筛选条件', '没有条件时给出提示文案')

  expandButton(fTree).props.onClick()
  fTree = fBar()
  ok(!!groupsBlock(fTree), '再点一次又展开')

  /* 命令也能切换展开状态 */
  await fc.commands.execute('toggle-tag-filter-expand')
  fTree = fBar()
  eq(expandButton(fTree).props['data-expanded'], '0', 'toggle-tag-filter-expand 命令能收起')
  await fc.commands.execute('toggle-tag-filter-expand')
  fTree = fBar()
  eq(expandButton(fTree).props['data-expanded'], '1', '再执行一次又展开')

  /* 折叠状态会被持久化 */
  groupHeadOf(fTree, 'tags').props.onClick()
  expandButton(fTree).props.onClick()
  flushTimeouts()
  const savedUi = fr.store.get('tag-filter-store').ui
  eq(savedUi.expanded, false, '整体收起状态已持久化')
  eq(savedUi.groupCollapsed.tags, true, '分组折叠状态已持久化')

  disposeAll(fr)
  resetDom()

  /* 重启后恢复折叠状态 */
  const { ctx: rc, record: rr } = makeCtx(fr.store)
  buildPageWith(MARKETPLACE_FIXTURE.map((item) => makeMarketplaceCard(item)))
  await mod.activate(rc)
  const rTree = renderComponent(rr.mounts[0].component)()
  eq(expandButton(rTree).props['data-expanded'], '0', '重启后保持收起状态')
  eq(!!groupsBlock(rTree), false, '收起状态下分组区确实没渲染')
  disposeAll(rr)
}

/* ========================================================================== *
 * 21. 自定义标签组
 * ========================================================================== */

section('自定义标签组')

{
  resetDom()
  const page = buildPageWith([
    makeCard({ id: 'a', name: 'A', tags: ['lyrics', 'floating-window'] }),
    makeCard({ id: 'b', name: 'B', tags: ['radio'] })
  ])
  const { ctx: gc, record: gr } = makeCtx()
  await mod.activate(gc)
  const gBar = renderComponent(gr.mounts[0].component)
  const gPage = renderComponent(gr.pages[0].component)
  let gTree = gBar()
  let pageTree = gPage()
  const gVisible = () => Array.from(page.grid.querySelectorAll('.plugin-card')).filter((c) => c.style.display !== 'none')

  eq(customGroupChips(gTree).length, 0, '没有自定义组时不出「快捷组」这一组')
  eq(groupIds(gTree).join(','), 'tags', '只有标签组')
  ok(!!byProp(pageTree, 'data-role', 'groups-empty'), '页面上提示还没有自定义组')

  /* 没选标签就建组 → 提示而不是建出空组 */
  byProp(pageTree, 'data-action', 'group-create').props.onClick()
  includes(toastText(gr), '请先在筛选条里选中至少一个标签', '没选标签时建组给出提示')
  eq(customGroupChips(gBar()).length, 0, '不会建出空组')

  /* 选两个标签 → 用它们建组 */
  clickChip(gTree, 'lyrics')
  gTree = gBar()
  clickChip(gTree, 'floating-window')
  gTree = gBar()
  eq(gVisible().length, 1, '两个标签生效（同一个插件同时带这两个标签）')

  pageTree = gPage()
  byProp(pageTree, 'data-role', 'new-group-name').props.onInput({ target: { value: '歌词相关' } })
  pageTree = gPage()
  byProp(pageTree, 'data-action', 'group-create').props.onClick()
  flushTimeouts()

  gTree = gBar()
  pageTree = gPage()
  eq(groupIds(gTree).join(','), 'shortcuts,tags', '建组后「快捷组」排在最前面')
  eq(customGroupChips(gTree).length, 1, '快捷组里有一个 chip')
  const created = customGroupChips(gTree)[0]
  eq(created.props['data-key'].startsWith('group:'), true, '组 chip 的 key 带 group: 前缀')
  eq(created.props['data-selected'], '1', '刚建组时成员正是当前选择 → 全选')
  includes(textOfNode(created), '歌词相关', 'chip 上是组名')
  eq(findAll(created, (n) => String(n.props.class || '').includes('etf-chip-count')).length, 1, '组 chip 显示已选/成员数')
  includes(textOfNode(created), '2/2', '组 chip 显示 2/2')
  includes(created.props.title, '含 2 个标签', '悬停提示说明成员数')

  /* 清除筛选后：点组 = 一次选中全部成员 */
  byProp(gTree, 'data-action', 'clear').props.onClick()
  gTree = gBar()
  eq(gVisible().length, 2, '清除后两张都可见')
  eq(customGroupChips(gTree)[0].props['data-selected'], '0', '清除后组 chip 回到未选')
  customGroupChips(gTree)[0].props.onClick()
  gTree = gBar()
  eq(gVisible().length, 1, '点一下组 = 一次选中组内全部标签')
  eq(customGroupChips(gTree)[0].props['data-selected'], '1', '组 chip 变成全选态')

  /* 组内手动少选一个 → 部分选中态（组外标签不影响组状态） */
  clickChip(gTree, 'radio')
  gTree = gBar()
  eq(customGroupChips(gTree)[0].props['data-partial'], '0', '选了组外标签不影响组状态')
  includes(textOfNode(customGroupChips(gTree)[0]), '2/2', '组 chip 仍是 2/2')
  clickChip(gTree, 'floating-window')
  gTree = gBar()
  eq(customGroupChips(gTree)[0].props['data-partial'], '1', '少选一个成员 → partial')
  eq(customGroupChips(gTree)[0].props['data-selected'], '0', 'partial 不算全选')
  ok(customGroupChips(gTree)[0].props.class.includes('is-partial'), 'partial 有对应的样式类')
  includes(textOfNode(customGroupChips(gTree)[0]), '1/2', '组 chip 显示 1/2')

  /* 再点组 = 补全全选 */
  customGroupChips(gTree)[0].props.onClick()
  gTree = gBar()
  eq(customGroupChips(gTree)[0].props['data-selected'], '1', 'partial 状态下点击 → 补全为全选')

  /* 全选状态下点击 = 全部取消 */
  customGroupChips(gTree)[0].props.onClick()
  gTree = gBar()
  eq(customGroupChips(gTree)[0].props['data-partial'], '0', '全选状态下点击 → 取消组内全部')
  eq(customGroupChips(gTree)[0].props['data-selected'], '0', '取消后组 chip 回到未选')
  eq(gVisible().length, 1, '组外那张带 radio 的卡片还在（取消组只影响组内标签）')

  /* 页面上的组管理：成员单独移除 */
  pageTree = gPage()
  const row = byProp(pageTree, 'data-role', 'custom-group')
  ok(!!row, '页面上有组管理行')
  const memberChips = findAll(row, (n) => n.props && n.props['data-action'] === 'group-member')
  eq(memberChips.length, 2, '组内成员各一个 chip')
  ok(
    findAll(memberChips[0], (n) => n.props && n.props.class === 'etf-chip-remove').length === 1,
    '成员 chip 上有「×」移除按钮'
  )
  findAll(memberChips[0], (n) => n.props && n.props.class === 'etf-chip-remove')[0].props.onClick({
    stopPropagation() {}
  })
  flushTimeouts()
  eq(
    findAll(
      byProp(gPage(), 'data-role', 'custom-group'),
      (n) => n.props && n.props['data-action'] === 'group-member'
    ).length,
    1,
    '成员被移出组'
  )

  /* 用当前筛选覆盖成员 */
  gTree = gBar()
  byProp(gTree, 'data-action', 'clear').props.onClick()
  gTree = gBar()
  clickChip(gTree, 'radio')
  gTree = gBar()
  let pageNow = gPage()
  byProp(pageNow, 'data-action', 'group-replace').props.onClick()
  flushTimeouts()
  const replaced = findAll(
    byProp(gPage(), 'data-role', 'custom-group'),
    (n) => n.props && n.props['data-action'] === 'group-member'
  )
  eq(replaced.length, 1, '「用当前筛选覆盖」把成员换成了当前选中的标签')
  eq(replaced[0].props['data-member'], 'radio', '覆盖后的成员就是当前选中的那个标签')

  /* 改名 */
  const nameInput = byProp(gPage(), 'data-role', 'group-name')
  nameInput.props.onInput({ target: { value: '电台相关' } })
  byProp(gPage(), 'data-role', 'group-name').props.onChange({ target: { value: '电台相关' } })
  flushTimeouts()
  gTree = gBar()
  includes(textOfNode(customGroupChips(gTree)[0]), '电台相关', '改名生效并同步到筛选条')

  /* 删组 */
  byProp(gPage(), 'data-action', 'group-remove').props.onClick()
  flushTimeouts()
  gTree = gBar()
  eq(customGroupChips(gTree).length, 0, '删组后快捷组消失')
  eq(groupIds(gTree).join(','), 'tags', '只剩标签组')
  eq(gVisible().length, 2, '删组不影响当前筛选')

  /* 把最后那个成员也移掉 → 空组自动删除 */
  byProp(gBar(), 'data-action', 'clear').props.onClick()
  gTree = gBar()
  clickChip(gTree, 'floating-window')
  gTree = gBar()
  byProp(gPage(), 'data-role', 'new-group-name').props.onInput({ target: { value: '临时' } })
  byProp(gPage(), 'data-action', 'group-create').props.onClick()
  flushTimeouts()
  eq(customGroupChips(gBar()).length, 1, '又建了一个组')
  const single = findAll(
    byProp(gPage(), 'data-role', 'custom-group'),
    (n) => n.props && n.props['data-action'] === 'group-member'
  )[0]
  findAll(single, (n) => n.props.class === 'etf-chip-remove')[0].props.onClick({ stopPropagation() {} })
  flushTimeouts()
  eq(customGroupChips(gBar()).length, 0, '成员被删空后整组自动删除')
  includes(toastText(gr), '已空了', '并给出提示')

  disposeAll(gr)
}

/* ========================================================================== *
 * 22. 新状态的持久化（状态维度选择 + 自定义组）
 * ========================================================================== */

section('新状态持久化')

{
  resetDom()
  const page = buildPageWith([
    makeMarketplaceCard({ id: 'kugou-recommend', name: '推荐电台', tags: ['kugou'], status: '已安装' }),
    makeMarketplaceCard({ id: 'player-frontend', name: '播放器前端', tags: ['player'], status: '未安装' })
  ])
  const { ctx: pc, record: pr } = makeCtx()
  await mod.activate(pc)
  const pBar = renderComponent(pr.mounts[0].component)
  let pTree = pBar()

  facetChip(pTree, 'install', 'missing').props.onClick()
  pTree = pBar()
  clickChip(pTree, 'player')
  pTree = pBar()
  flushTimeouts()
  const store = pr.store
  const saved = store.get('tag-filter-store')
  eq(saved.selection.install.join(','), 'missing', '状态维度选择已持久化')
  eq(saved.selection.tags.join(','), 'player', '标签选择已持久化')
  eq(saved.groups.length, 0, '没有自定义组时存的是空数组')

  disposeAll(pr)
  resetDom()

  const page2 = buildPageWith([
    makeMarketplaceCard({ id: 'kugou-recommend', name: '推荐电台', tags: ['kugou'], status: '已安装' }),
    makeMarketplaceCard({ id: 'player-frontend', name: '播放器前端', tags: ['player'], status: '未安装' })
  ])
  const { ctx: qc, record: qr } = makeCtx(store)
  await mod.activate(qc)
  const qTree = renderComponent(qr.mounts[0].component)()
  eq(facetChip(qTree, 'install', 'missing').props['data-selected'], '1', '重启后恢复状态维度选择')
  eq(chipByTag(qTree, 'player').props['data-selected'], '1', '重启后恢复标签选择')
  eq(
    Array.from(page2.grid.querySelectorAll('.plugin-card')).filter((c) => c.style.display !== 'none').length,
    1,
    '重启后立即按「未安装 + player」过滤'
  )
  disposeAll(qr)
}

/* ========================================================================== *
 * 汇总
 * ========================================================================== */

const lines = ['']
for (let i = 0; i < sectionResults.length; i++) {
  const start = sectionResults[i].at
  const end = i + 1 < sectionResults.length ? sectionResults[i + 1].at : pass
  const failed = failures.filter((f) => f.startsWith('[' + sectionResults[i].name + ']')).length
  lines.push(`${failed === 0 ? '  ok ' : ' FAIL'}  ${sectionResults[i].name.padEnd(20)} ${end - start} 项`)
}

if (failures.length) {
  lines.push('', '失败明细：')
  for (const failure of failures) lines.push('  - ' + failure)
}

const total = pass + failures.length
lines.push('', `${pass}/${total} 通过${failures.length ? `，${failures.length} 项失败` : ''}`)

const report = lines.join('\n')
// 自己把报告落盘：PowerShell 的重定向会按 OEM 代码页解码 stdout，中文会变成乱码
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(path.join(CACHE_DIR, 'tag-filter-smoke-report.txt'), report, 'utf8')
} catch (error) {
  void error
}
console.log(report)
process.exitCode = failures.length ? 1 : 0
