/**
 * GitHub 加速器 (gh-accelerator) 无头集成测试
 * ---------------------------------------------------------------------------
 * 用**真实 index.js + 真实 Vue 3 ESM 运行时 + 假 DOM + 本机假 GitHub 源**跑一遍业务流程：
 *   注册与面板渲染、本地桥（302 桥）启用 / 自检 / 停用 / 重启恢复、
 *   宿主插件市场页状态条注入、线路测速与结果持久化、命令注册、manifest 契约。
 *
 * 本机假源监听非默认端口（见 TEST_PORT），不会和正在运行的 EchoMusic 真实本地桥（47823）抢端口。
 *
 * 运行： node tests/gh-accelerator.smoke.mjs
 * 依赖： 一份 Vue 浏览器 ESM 构建（查找顺序见 resolveVue；可用 VUE_ESM_PATH 指定本地文件）
 *
 * 变异测试：设 GA_PLUGIN_ENTRY 指向插件的改动副本，即可用同一套断言验证「改坏了会红」。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_DIR = path.join(ROOT, 'gh-accelerator')
const PLUGIN_ENTRY = process.env.GA_PLUGIN_ENTRY
  ? path.resolve(process.env.GA_PLUGIN_ENTRY)
  : path.join(PLUGIN_DIR, 'index.js')
const SRC = pathToFileURL(PLUGIN_ENTRY).href
const CACHE_DIR = path.join(ROOT, '.workbuddy', 'tmp')
const CACHE_VUE = path.join(CACHE_DIR, 'vue.runtime.esm-browser.js')
const VUE_CDN = 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.esm-browser.js'
const REPORT_FILE = path.join(CACHE_DIR, 'gh-accelerator-smoke-report.txt')

/* ========================================================================== *
 * Vue 运行时解析
 * ========================================================================== */

async function resolveVue() {
  const candidates = []
  if (process.env.VUE_ESM_PATH) candidates.push(path.resolve(process.env.VUE_ESM_PATH))
  candidates.push(CACHE_VUE)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  mkdirSync(CACHE_DIR, { recursive: true })
  const res = await fetch(VUE_CDN)
  if (!res.ok) throw new Error('无法下载 Vue ESM 构建：HTTP ' + res.status + '（可设 VUE_ESM_PATH 指定本地文件）')
  writeFileSync(CACHE_VUE, await res.text(), 'utf8')
  return CACHE_VUE
}


const out = []
const fails = []
const ok = (label, cond, extra = '') => {
  out.push(`${cond ? '  PASS' : '  FAIL'}  ${label}${extra ? '  → ' + extra : ''}`)
  if (!cond) fails.push(label)
}

const vue = await import(pathToFileURL(await resolveVue()).href)

// ---------- 假 DOM（模拟「插件管理 → 在线插件」页） ----------
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    isConnected: true,
    parentNode: null,
    children: [],
    _attrs: {},
    style: {},
    addEventListener(type, handler) {
      if (type === 'click') this.__clickHandler = handler
      this.__handlers = this.__handlers || {}
      this.__handlers[type] = handler
    },
    getAttribute(name) { return this._attrs[name] ?? null },
    setAttribute(name, value) { this._attrs[name] = String(value) },
    querySelectorAll: () => [],
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : -1
      if (i >= 0) this.children.splice(i, 0, node)
      else this.children.push(node)
      node.parentNode = this
      node.isConnected = true
      return node
    },
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
      node.isConnected = true
      return node
    },
    removeChild(node) {
      const i = this.children.indexOf(node)
      if (i >= 0) { this.children.splice(i, 1); node.parentNode = null; node.isConnected = false }
      return node
    }
  }
}
const dom = { content: makeEl('div'), toolbar: makeEl('div'), grid: makeEl('div') }
dom.content.insertBefore(dom.toolbar, null)
dom.content.insertBefore(dom.grid, null)

// ---------- 宿主的「刷新」按钮（用于验证接管层） ----------
// 真实的宿主工具条里，刷新按钮是最右那个 button；拉取中会带上 animate-spin 的图标。
const hostRefreshBtn = makeEl('button')
hostRefreshBtn.className = 'host-refresh-btn'
hostRefreshBtn.innerHTML = '<svg class="icon"></svg>'
hostRefreshBtn.querySelectorAll = () => []
dom.toolbar.querySelectorAll = (sel) => (sel === 'button' ? [hostRefreshBtn] : [])
dom.toolbar.insertBefore = dom.content.insertBefore
// 关键：按钮必须真的挂在工具条里，插件的注入逻辑会检查 button.parentNode
hostRefreshBtn.parentNode = dom.toolbar
dom.toolbar.children.push(hostRefreshBtn)

globalThis.document = {
  querySelector(sel) {
    if (sel === '.marketplace-toolbar') return dom.toolbar
    if (sel === '.gha-mkt-strip-host') return dom.content.children.find((c) => c.className === 'gha-mkt-strip-host') || null
    return null
  },
  createElement: (tag) => makeEl(tag)
}
globalThis.getComputedStyle = () => ({ position: 'relative' })

// ---------- mock ctx ----------
const reg = {
  pages: [], settings: [], commands: {}, handler: null, listenOpts: null, listenCalls: 0,
  mounts: [], observeSel: null, observeHandler: null, observeDisposed: false,
  sidebarAdds: [], sidebarDisposed: 0,
  commandOptions: {},
  marketplaceListCalls: []
}
const store = { githubProxyUrl: '', sidebarSectionCollapsed: { discover: false, library: false, plugins: true } }
const storageData = {}
// 用非默认端口，避免和正在运行的 EchoMusic 真实本地桥（47823）抢端口
const TEST_PORT = 47899
storageData['gh-accelerator-settings'] = { settings: { bridgePort: TEST_PORT }, customSources: [] }

// ---------- 市场页 DOM 模拟：骨架网格 vs 真实卡片网格 ----------
// 宿主的契约：`.plugin-card-grid[aria-busy="true"]` ⇒ 仍在加载（渲染 6 张骨架卡）；
// 去掉 aria-busy 后网格里放的是真实卡片（同样带 .plugin-card / .marketplace-card）。
const mkt = { busy: false, skeletons: 0, cards: 0, countText: '' }
function makeCard(tag) { return { tagName: 'DIV', className: 'plugin-card marketplace-card' } }
function makeGrid() {
  const el = {
    tagName: 'DIV',
    className: 'plugin-card-grid',
    _attrs: {},
    getAttribute(name) { return this._attrs[name] ?? null },
    setAttribute(name, value) { this._attrs[name] = String(value) },
    querySelectorAll(sel) {
      if (sel === '.plugin-card') return Array.from({ length: mkt.busy ? mkt.skeletons : mkt.cards }, () => makeCard())
      return []
    }
  }
  if (mkt.busy) el.setAttribute('aria-busy', 'true')
  return el
}
function makeHeading() {
  return {
    tagName: 'DIV',
    className: 'plugin-content-heading',
    querySelector(sel) {
      if (sel === 'span') return { textContent: mkt.countText }
      return null
    }
  }
}
const origQuerySelector = globalThis.document.querySelector
globalThis.document.querySelector = function (sel) {
  if (sel === '.plugin-card-grid') return mkt.mounted === false ? null : makeGrid()
  if (sel === '.plugin-content-heading') return mkt.countText ? makeHeading() : null
  return origQuerySelector.call(this, sel)
}
globalThis.document.querySelectorAll = function (sel) {
  if (sel === '.plugin-card-grid') return mkt.mounted === false ? [] : [makeGrid()]
  if (sel === '.plugin-content-heading') return mkt.countText ? [makeHeading()] : []
  return []
}
mkt.mounted = true

// ---------- 可控网络：用于验证探针的「加速失败 → 回落直连」 ----------
// 'real'          = 走真实网络（桥的端到端测试需要）
// 'probeFallback' = 让「镜像」（127.0.0.1 前缀）失败，直连 raw 返回一份假索引
let netMode = 'real'
const FAKE_INDEX_PLUGINS = 7
const FAKE_INDEX = JSON.stringify({
  name: 'EchoMusic 官方插件源',
  plugins: Array.from({ length: FAKE_INDEX_PLUGINS }, (_, i) => ({ id: 'fake-' + i, name: '假插件' + i }))
})
const DIRECT_INDEX_URL = 'https://raw.githubusercontent.com/hoowhoami/EchoMusicPlugins/HEAD/echo-plugins.json'

async function hostRequest(options) {
  const { url, method = 'GET', headers, timeoutMs = 30000, maxRedirects = 5, maxResponseBytes = 32 * 1024 * 1024, responseType = 'json' } = options

  if (netMode === 'probeFallback') {
    if (String(url).startsWith('http://127.0.0.1:')) {
      throw new Error('模拟：加速镜像不可用')
    }
    if (String(url) === DIRECT_INDEX_URL) {
      const buf = Buffer.from(FAKE_INDEX, 'utf8')
      return {
        url, status: 200, statusText: 'OK', headers: {},
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      }
    }
  }

  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, { method, headers, redirect: maxRedirects > 0 ? 'follow' : 'manual', signal: controller.signal })
    const buf = await res.arrayBuffer()
    if (maxResponseBytes > 0 && buf.byteLength > maxResponseBytes) throw new Error('maxResponseBytes exceeded')
    const headerObj = {}
    res.headers.forEach((v, k) => { headerObj[k] = v })
    let data = buf
    if (responseType === 'text') data = new TextDecoder().decode(buf)
    else if (responseType === 'json') { try { data = JSON.parse(new TextDecoder().decode(buf)) } catch { data = new TextDecoder().decode(buf) } }
    return { url: res.url, status: res.status, statusText: res.statusText, headers: headerObj, data }
  } finally { if (timer) clearTimeout(timer) }
}

function makeCtx() {
  return {
    id: 'gh-accelerator',
    manifest: { name: 'GitHub 加速器', version: '1.0.0' },
    vue,
    stores: { settings: store },
    settings: store,
    storage: { get: async (k) => storageData[k], set: async (k, v) => { storageData[k] = v } },
    ui: {
      addPage: (o) => { reg.pages.push(o); return () => {} },
      settings: { define: (o) => { reg.settings.push(o); return () => {} } },
      sidebar: {
        addItem: (item) => {
          reg.sidebarAdds.push(item)
          return () => { reg.sidebarDisposed += 1 }
        }
      },
      mount: (target, component, options) => {
        reg.mounts.push({ target, component, options })
        return () => { reg.mountDisposed = true }
      }
    },
    dom: {
      observe: (sel, handler) => {
        reg.observeSel = sel
        reg.observeHandler = handler
        return () => { reg.observeDisposed = true }
      }
    },
    net: { request: hostRequest, fetch: fetch },
    webServer: {
      listen: async (handler, options) => {
        reg.handler = handler
        reg.listenOpts = options
        reg.listenCalls += 1
        const port = options?.port ?? 0
        return { ok: true, host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/` }
      },
      close: async () => { reg.handler = null; return true }
    },
    toast: { info() {}, success() {}, warning() {}, danger() {} },
    commands: { register: (id, fn, options) => { reg.commands[id] = fn; reg.commandOptions[id] = options ?? null }, execute: () => {} },
    css: { inject: () => () => {} },
    dispose: (fn) => { reg.disposers = reg.disposers || []; reg.disposers.push(fn) },
    appearance: { getSnapshot: () => ({ isDark: false, accentColor: '#31cfa1' }), onSnapshot: () => () => {} },
    electron: {
      platform: 'win32',
      plugins: {
        marketplace: {
          list: async (options) => {
            reg.marketplaceListCalls.push(options)
            return {
              ok: true,
              fetchedAt: Date.now(),
              sources: [{ id: 'official', lastError: '' }],
              plugins: [
                { id: 'gh-accelerator', name: 'GitHub 加速器' },
                { id: 'kugou-daily-vip', name: '酷狗会员' },
                { id: 'kugou-recommend', name: '酷狗推荐' }
              ]
            }
          }
        }
      }
    },
    dialog: {},
    router: { push() {} }
  }
}

const origWarn = console.warn, origError = console.error
console.warn = () => {}; console.error = () => {}

const mod = await import(SRC)

// 另取一份带内部导出的副本，用于校验预置清单完整性
const TMPMOD = path.join(CACHE_DIR, 'gh-accelerator-internals.mjs')
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  writeFileSync(
    TMPMOD,
    readFileSync(PLUGIN_ENTRY, 'utf8') +
      '\nexport { PRESET_PROXY, PRESET_XGET, githubFamilyPath, extractOriginalUrl, PLATFORM_PREFIX, OFFICIAL_MARKETPLACE_REPO, MKT_PHASES, DEFAULT_SETTINGS }\n',
    'utf8'
  )
}
const internals = await import(pathToFileURL(TMPMOD).href)

/**
 * 当前桥接线路的域名。
 * 不硬编码具体域名：本地开发副本里第一顺位是Xget 实例，发布副本会在
 * publishRewrites 里整块删掉该预置项，届时第一顺位自动变成官方实例。
 * 从 PRESET_XGET 推导，两边都能跑。
 */
const XGET_HOST = (() => {
  const first = internals.PRESET_XGET[0]
  return first ? new URL(first.domain).host : ''
})()

// ---------- 预置线路清单完整性 ----------
{
  const proxies = internals.PRESET_PROXY
  const xgets = internals.PRESET_XGET
  ok('gh-proxy 预置线路数量充足', proxies.length >= 20, `count=${proxies.length}`)
  ok('Xget 预置线路存在', xgets.length >= 1, `count=${xgets.length}`)
  ok('全部 gh-proxy 线路 kind 正确', proxies.every((s) => s.kind === 'ghproxy'))
  ok('全部 Xget 线路 kind 正确', xgets.every((s) => s.kind === 'xget'))
  const ids = [...proxies, ...xgets].map((s) => s.id)
  ok('线路 id 无重复', new Set(ids).size === ids.length, `${ids.length} ids`)
  ok('线路域名均为 https 且无尾斜杠',
    [...proxies, ...xgets].every((s) => /^https:\/\/[^/]+$/.test(s.domain)),
    [...proxies, ...xgets].filter((s) => !/^https:\/\/[^/]+$/.test(s.domain)).map((s) => s.domain).join(', ') || 'ok')
  ok('gh-proxy 线路都带地区标签', proxies.every((s) => typeof s.region === 'string' && s.region), '')
  ok('URL 换算：raw 主机被改写成 github.com 网页路径',
    internals.githubFamilyPath(new URL('https://raw.githubusercontent.com/o/r/main/f.md')) === '/gh/o/r/raw/main/f.md', '')
  ok('extractOriginalUrl 解析 gh-proxy 形态',
    internals.extractOriginalUrl('/https://github.com/o/r/archive/main.zip') === 'https://github.com/o/r/archive/main.zip', '')
}
try {
  await mod.activate(makeCtx())
  ok('activate(ctx) 执行成功', true)
} catch (error) {
  ok('activate(ctx) 执行成功', false, String(error && error.stack).slice(0, 300))
}
console.warn = origWarn; console.error = origError

// ---------- 基础注册 ----------
ok('注册插件页面', reg.pages.length === 1 && reg.pages[0].id === 'accelerator')
ok('注册设置面板', reg.settings.length === 1, reg.settings[0]?.title)
ok('注册命令', Object.keys(reg.commands).length >= 2, Object.keys(reg.commands).join(', '))
ok('本地桥惰性启动', reg.listenCalls === 0)

// ---------- 渲染工具 ----------
function walk(tree, fn) {
  if (!tree) return
  if (Array.isArray(tree)) { tree.forEach((n) => walk(n, fn)); return }
  if (typeof tree !== 'object') return
  fn(tree)
  if (tree.children) walk(tree.children, fn)
}
function findByClass(tree, cls) {
  const hits = []
  walk(tree, (n) => { if (n.props?.class && String(n.props.class).split(/\s+/).includes(cls)) hits.push(n) })
  return hits
}
function subtreeText(node, acc = []) {
  if (node == null) return acc
  if (typeof node === 'string') { acc.push(node); return acc }
  if (Array.isArray(node)) { node.forEach((n) => subtreeText(n, acc)); return acc }
  if (typeof node === 'object' && node.children) subtreeText(node.children, acc)
  return acc
}
function findSwitchInRowByText(tree, text) {
  const rows = findByClass(tree, 'gha-switch-row')
  const row = rows.find((r) => subtreeText(r).join(' ').includes(text))
  if (!row) return null
  return findByClass(row, 'gha-switch')[0] || null
}
function renderOf(comp, label) {
  try {
    const tree = comp.setup()()
    ok(`${label}渲染成功`, true, `class="${tree?.props?.class || ''}"`)
    return tree
  } catch (error) {
    ok(`${label}渲染成功`, false, String(error && error.message))
    return null
  }
}

const pageTree = renderOf(reg.pages[0].component, '加速器页面')
const settingsTree = renderOf(reg.settings[0].component, '设置面板')

// ---------- 需求 2：自动测速开关状态是否明显 ----------
{
  const checks = findByClass(pageTree, 'gha-check')
  ok('页面有 gha-check 开关容器', checks.length === 1)
  const flag = checks[0]?.props?.['data-on']
  ok('gha-check 带 data-on 状态属性（默认开启）', flag === 'true', `data-on=${flag}`)
  ok('页面使用真实开关控件（非原生 checkbox）', findByClass(pageTree, 'gha-switch').length >= 1, `switch=${findByClass(pageTree, 'gha-switch').length}`)
  const chips = findByClass(pageTree, 'gha-state-chip').filter((c) => subtreeText(c).join('').includes('已开启'))
  ok('页面显示「已开启」状态标签', chips.length >= 1, `chips=${chips.length}`)

  const pageSwitch = findByClass(checks[0], 'gha-switch')[0]
  ok('找到页面内的开关', !!pageSwitch)
  if (pageSwitch) {
    await pageSwitch.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 30))
    const tree2 = renderOf(reg.pages[0].component, '加速器页面（关闭自动测速后）')
    const checks2 = findByClass(tree2, 'gha-check')
    ok('点击后 data-on 变为 false', checks2[0]?.props?.['data-on'] === 'false', `data-on=${checks2[0]?.props?.['data-on']}`)
    ok('点击后显示「已关闭」标签', findByClass(tree2, 'gha-state-chip').some((c) => subtreeText(c).join('').includes('已关闭')))
    ok('配置已持久化 autoTestOnOpen=false', storageData['gh-accelerator-settings']?.settings?.autoTestOnOpen === false)
    // 复原
    await pageSwitch.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 30))
  }

  const settingsSwitches = findByClass(settingsTree, 'gha-switch')
  ok('设置面板开关总数已增至 10（进度 2 + 接管 1）', settingsSwitches.length === 10, `switch=${settingsSwitches.length}`)
  ok('设置面板开关都带状态标签',
    findByClass(settingsTree, 'gha-state-chip').length === settingsSwitches.length,
    `chip=${findByClass(settingsTree, 'gha-state-chip').length}`)
}

// ---------- 需求 1：在线插件界面（插件市场）显示加速状态 ----------
{
  ok('注册了插件市场页的 DOM 观察', reg.observeSel === '.marketplace-toolbar', String(reg.observeSel))
  ok('激活时已尝试注入状态条（此时未加速）', reg.mounts.length === 1, `mounts=${reg.mounts.length}`)
  const mount = reg.mounts[0]
  ok('状态条容器 class 正确', mount?.target?.className === 'gha-mkt-strip-host', String(mount?.target?.className))
  ok('状态条容器已插入到工具条之后', dom.content.children.some((c) => c.className === 'gha-mkt-strip-host'))

  const stripTree = renderOf(mount.component, '市场状态条')
  ok('未加速时状态条为 gha-mkt-off', findByClass(stripTree, 'gha-mkt-off').length === 1)
  ok('未加速时文案提示直连', subtreeText(stripTree).join(' ').includes('未启用加速'))
  ok('状态条内含快捷操作按钮', findByClass(stripTree, 'gha-btn').length >= 2, `btn=${findByClass(stripTree, 'gha-btn').length}`)

  // 防重复注入
  reg.observeHandler()
  ok('重复触发观察不会重复注入', reg.mounts.length === 1, `mounts=${reg.mounts.length}`)
}

// ---------- 侧边栏入口（动态增删 + 分组折叠诊断） ----------
{
  ok('侧边栏入口通过 addItem 动态注册', reg.sidebarAdds.length === 1, `adds=${reg.sidebarAdds.length}`)
  const item = reg.sidebarAdds[0] || {}
  ok('入口参数正确（pageId/section/order）',
    item.pageId === 'accelerator' && item.section === 'plugins' && item.order === 20 && item.title === '加速器',
    JSON.stringify({ pageId: item.pageId, section: item.section, order: item.order, title: item.title }))
  ok('addPage 不再内嵌 sidebar（改由 addItem 管理）', reg.pages[0].sidebar === undefined, String(reg.pages[0].sidebar))

  const tree = renderOf(reg.pages[0].component, '加速器页面（分组折叠时）')
  const text = subtreeText(tree).join(' ')
  ok('页面检测到「插件」分组被折叠', text.includes('「插件」分组被折叠'), '')
  ok('页面给出展开按钮', !!findByClass(tree, 'gha-btn').find((b) => subtreeText(b).join('').includes('展开「插件」分组')))

  const unfoldBtn = findByClass(tree, 'gha-btn').find((b) => subtreeText(b).join('').includes('展开「插件」分组'))
  await unfoldBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  ok('点击后宿主的 sidebarSectionCollapsed.plugins 被置为 false', store.sidebarSectionCollapsed.plugins === false, JSON.stringify(store.sidebarSectionCollapsed))

  // 开关联动：关掉 → 调 disposer；再开 → 重新注册
  const st = renderOf(reg.settings[0].component, '设置面板（侧边栏开关）')
  const sw = findSwitchInRowByText(st, '侧边栏入口')
  ok('设置面板可找到侧边栏入口开关', !!sw)
  await sw.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 30))
  ok('关闭后移除侧边栏入口（调用 disposer）', reg.sidebarDisposed === 1, `disposed=${reg.sidebarDisposed}`)
  const st2 = renderOf(reg.settings[0].component, '设置面板（侧边栏开关 2）')
  await findSwitchInRowByText(st2, '侧边栏入口').props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 30))
  ok('重新开启后入口再次注册', reg.sidebarAdds.length === 2, `adds=${reg.sidebarAdds.length}`)
  ok('开关切换后持久化', storageData['gh-accelerator-settings']?.settings?.showSidebarEntry === true)
}

// ---------- 启用桥后再看状态条 ----------
{
  const enableBtn = findByClass(pageTree, 'gha-btn').find((b) => subtreeText(b).join('').includes('启用 Xget 加速'))
  ok('找到「启用 Xget 加速」按钮', !!enableBtn)
  if (enableBtn) await enableBtn.props.onClick()
  ok('桥已启动（固定端口）', reg.listenCalls === 1 && reg.listenOpts?.port === TEST_PORT, `port=${reg.listenOpts?.port}`)
  ok('宿主设置写入本地桥', store.githubProxyUrl === `http://127.0.0.1:${TEST_PORT}`, store.githubProxyUrl)

  const stripTree2 = renderOf(reg.mounts[0].component, '市场状态条（已启用）')
  ok('启用后状态条为 gha-mkt-on', findByClass(stripTree2, 'gha-mkt-on').length === 1)
  const text = subtreeText(stripTree2).join(' ')
  ok('状态条显示「加速已启用」', text.includes('加速已启用'))
  ok('状态条显示当前线路与本地桥地址', text.includes('本地桥') && text.includes(XGET_HOST), text.slice(0, 120))
  ok('已启用时不再显示「启用 Xget 加速」按钮', !text.includes('启用 Xget 加速'))
}

// ---------- 桥 handler 端到端 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  try {
    const result = await reg.handler({
      requestId: 't', method: req.method, url: req.url, path: u.pathname,
      query: Object.fromEntries(u.searchParams), headers: req.headers, body: null, remoteAddress: '127.0.0.1'
    })
    res.writeHead(result?.status ?? 200, result?.headers ?? {})
    res.end(typeof result?.body === 'string' ? result.body : JSON.stringify(result?.body ?? ''))
  } catch (error) { res.writeHead(500); res.end(String(error.message)) }
})
await new Promise((r) => server.listen(TEST_PORT, '127.0.0.1', r))
out.push('')

async function bridgeFetch(name, original, expect) {
  const t0 = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/${original}`, { headers: { accept: 'application/zip,application/octet-stream,*/*' } })
    const buf = await res.arrayBuffer()
    const ms = Date.now() - t0
    const viaXget = XGET_HOST ? String(res.url).startsWith('https://' + XGET_HOST) : false
    const pass = expect === 'reject' ? res.status >= 400 && !viaXget : buf.byteLength > 0 && viaXget && res.status === 200
    ok(name, pass, `HTTP ${res.status} · ${buf.byteLength} B · ${ms}ms · ${(buf.byteLength / 1024 / (ms / 1000)).toFixed(1)} KB/s · final=${String(res.url).slice(0, 50)}`)
  } catch (error) { ok(name, false, String(error.message).slice(0, 90)) }
}
await bridgeFetch('桥→Xget：插件仓库 zip', 'https://github.com/hoowhoami/EchoMusicPlugins/archive/refs/heads/main.zip', 'ok')
await bridgeFetch('桥→Xget：raw 文件', 'https://raw.githubusercontent.com/hoowhoami/EchoMusic/main/docs/plugin-system.md', 'ok')
await bridgeFetch('桥→Xget：codeload 换算', 'https://codeload.github.com/hoowhoami/EchoMusic/zip/refs/heads/main', 'ok')
await bridgeFetch('桥：不支持主机被拒', 'https://example.com/file.zip', 'reject')

// ---------- 市场刷新进度：阶段表 / 常量 / 索引地址常量 ----------
{
  const repo = internals.OFFICIAL_MARKETPLACE_REPO
  ok('官方市场仓库常量正确', repo === 'hoowhoami/EchoMusicPlugins', String(repo))

  const phases = internals.MKT_PHASES
  ok('阶段表存在且含 6 个阶段', Array.isArray(phases) && phases.length === 6, `count=${phases?.length}`)
  const ids = (phases || []).map((p) => p.id)
  ok('阶段 id 顺序正确',
    ids.join(',') === 'idle,probe,index,manifests,settle,done', ids.join(','))
  ok('每个阶段都有中文标签', (phases || []).every((p) => typeof p.label === 'string' && p.label.length > 0))

  const ds = internals.DEFAULT_SETTINGS
  ok('默认显示刷新进度', ds.showMarketplaceProgress === true)
  ok('默认开启总数探针', ds.probeMarketplaceCount === true)
  ok('默认探针超时合理（1s–15s）', ds.marketplaceProbeTimeoutMs >= 1000 && ds.marketplaceProbeTimeoutMs <= 15000, `${ds.marketplaceProbeTimeoutMs}ms`)
}

// ---------- 市场刷新进度：设置面板 UI ----------
{
  const title = findByClass(settingsTree, 'gha-section-title').find((n) => subtreeText(n).join('').includes('拉取进度'))
  ok('设置面板新增「在线插件页 · 拉取进度」小节', !!title)

  const swProgress = findSwitchInRowByText(settingsTree, '显示刷新进度条')
  ok('可找到「显示刷新进度条」开关', !!swProgress)
  ok('该开关默认开启', swProgress?.props?.['data-on'] === 'true', `data-on=${swProgress?.props?.['data-on']}`)

  const swProbe = findSwitchInRowByText(settingsTree, '刷新时探测插件总数')
  ok('可找到「探测插件总数」开关', !!swProbe)
  ok('该开关默认开启', swProbe?.props?.['data-on'] === 'true', `data-on=${swProbe?.props?.['data-on']}`)

  // 定位「拉取进度」小节内部的那一个数值输入（设置面板里还有其它数值输入）
  const sectionIdx = (() => {
    const titles = findByClass(settingsTree, 'gha-section-title')
    return titles.findIndex((n) => subtreeText(n).join('').includes('拉取进度'))
  })()
  ok('「拉取进度」小节在设置面板中存在', sectionIdx >= 0, `idx=${sectionIdx}`)
  const allTitles = findByClass(settingsTree, 'gha-section-title')
  const nextTitle = sectionIdx >= 0 ? allTitles[sectionIdx + 1] : null
  const sectionNodes = findByClass(settingsTree, 'gha-field').filter((field) => {
    // 小节顺序判定：在该小节的标题之后、下一个标题之前
    const flat = []
    walk(settingsTree, (n) => flat.push(n))
    const a = flat.indexOf(allTitles[sectionIdx])
    const b = nextTitle ? flat.indexOf(nextTitle) : flat.length
    const i = flat.indexOf(field)
    return a >= 0 && i > a && i < b
  })
  const probeInput = sectionNodes.map((f) => findByClass(f, 'gha-input')[0]).find(Boolean)
  ok('拉取进度小节内可定位数值输入', !!probeInput,
    `type=${probeInput?.props?.type} min=${probeInput?.props?.min} max=${probeInput?.props?.max}`)
  ok('探针超时输入被限制在 1000–15000',
    Number(probeInput?.props?.min) === 1000 && Number(probeInput?.props?.max) === 15000,
    `min=${probeInput?.props?.min} max=${probeInput?.props?.max}`)
  ok('探针超时输入为 number 类型', probeInput?.props?.type === 'number', String(probeInput?.props?.type))
}

// ---------- 接管刷新按钮（选项 ③）：默认关闭 → 打开后注入命中层 ----------
{
  const ds = internals.DEFAULT_SETTINGS
  ok('接管刷新按钮默认关闭（不改变宿主原生行为）', ds.takeoverMarketplaceRefresh === false, String(ds.takeoverMarketplaceRefresh))

  const swTakeover = findSwitchInRowByText(settingsTree, '接管「刷新」按钮')
  ok('设置面板可找到「接管刷新按钮」开关', !!swTakeover)
  ok('该开关默认关闭', swTakeover?.props?.['data-on'] === 'false', `data-on=${swTakeover?.props?.['data-on']}`)

  // 默认关闭时不应有命中层
  ok('默认未注入接管层', hostRefreshBtn.children.length === 0, `children=${hostRefreshBtn.children.length}`)

  const st = renderOf(reg.settings[0].component, '设置面板（接管开关）')
  const sw = findSwitchInRowByText(st, '接管「刷新」按钮')
  await sw.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 60))
  ok('打开后注入透明命中层', hostRefreshBtn.children.length === 1, `children=${hostRefreshBtn.children.length}`)
  ok('命中层 class 为 gha-takeover-hit', hostRefreshBtn.children[0]?.className === 'gha-takeover-hit', String(hostRefreshBtn.children[0]?.className))
  ok('命中层被定位为绝对定位覆盖', String(hostRefreshBtn.children[0]?.style?.cssText || '').includes('position:absolute'))
  ok('接管开关已持久化', storageData['gh-accelerator-settings']?.settings?.takeoverMarketplaceRefresh === true)

  // 再次点击命中层 → 应走插件自己的管线并显示真实数量
  const hit = hostRefreshBtn.children[0]
  const before = reg.marketplaceListCalls.length
  if (hit && typeof hit.__clickHandler === 'function') {
    await hit.__clickHandler({ preventDefault() {}, stopPropagation() {} })
    ok('接管点击驱动了一次宿主 IPC 拉取', reg.marketplaceListCalls.length === before + 1, `calls=${reg.marketplaceListCalls.length}`)
    const lastCall = reg.marketplaceListCalls[reg.marketplaceListCalls.length - 1]
    ok('IPC 调用带了 refresh=true', lastCall?.refresh === true, JSON.stringify(lastCall))
  } else {
    ok('接管点击驱动了一次宿主 IPC 拉取', false, '命中层未挂上 click 处理器')
  }

  // 关掉 → 应彻底移除，宿主 DOM 零残留
  const st2 = renderOf(reg.settings[0].component, '设置面板（接管开关 2）')
  await findSwitchInRowByText(st2, '接管「刷新」按钮').props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 60))
  ok('关闭后命中层被移除（宿主 DOM 零残留）', hostRefreshBtn.children.length === 0, `children=${hostRefreshBtn.children.length}`)

  const settingsSwitches = findByClass(renderOf(reg.settings[0].component, '设置面板（开关总数）'), 'gha-switch')
  ok('设置面板开关总数已增至 10', settingsSwitches.length === 10, `switch=${settingsSwitches.length}`)
}


{
  // 通过内部分支复现：临时把宿主网格切成骨架态，观察 strip 进度条是否出现
  mkt.busy = true; mkt.skeletons = 6; mkt.cards = 0
  const strip = reg.mounts[0].component
  const treeBusy = renderOf(strip, '市场状态条（加载中）')
  ok('骨架态下进度条不误判为「已完成」', findByClass(treeBusy, 'gha-mkt-progress').length <= 1, `bars=${findByClass(treeBusy, 'gha-mkt-progress').length}`)

  mkt.busy = false; mkt.skeletons = 0; mkt.cards = 3; mkt.countText = '共 3 个 · 官方源'
  const treeDone = renderOf(strip, '市场状态条（加载完成）')
  ok('真实卡片态下不抛异常', !!treeDone)
  mkt.countText = ''
}

// ---------- 迭代修复：版本号 / 心跳 / 阶段文案 / 点击即刻开表 ----------
{
  // 1) 版本号必须已递进（用户明确反馈「版本号未变更」）
  const mf = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'))
  ok('manifest 版本号已从 1.0.0 递进', mf.version !== '1.0.0', `version=${mf.version}`)
  ok('版本号符合 semver', /^\d+\.\d+\.\d+$/.test(mf.version), mf.version)

  // 2) 心跳常量存在且 beat 字段已初始化（否则「已用/约剩/完成后倒计时」会冻住）
  const ds = internals.DEFAULT_SETTINGS
  ok('接管开关默认关闭未变', ds.takeoverMarketplaceRefresh === false)

  const src = readFileSync(PLUGIN_ENTRY, 'utf8')
  ok('已引入心跳常量 MKT_BEAT_MS', /MKT_BEAT_MS\s*=\s*\d+/.test(src))
  ok('已引入完成后停留常量 MKT_RESULT_LINGER_MS', /MKT_RESULT_LINGER_MS\s*=\s*\d+/.test(src))
  ok('mkt 状态含 beat 字段', /beat:\s*0/.test(src))
  ok('computed 显式依赖 beat', /void\s+m\.beat/.test(src))
  ok('存在 startMktHeartbeat / stopMktHeartbeat',
    /function startMktHeartbeat/.test(src) && /function stopMktHeartbeat/.test(src))
  ok('abort 时停掉心跳', /stopMktHeartbeat\(\)/.test(src))
  ok('完成时启动心跳以支撑停留窗口', /startMktHeartbeat\(\)/.test(src))

  // 3) 点击宿主刷新按钮应「立刻」开表（不依赖 250ms 轮询是否撞上）
  ok('存在刷新按钮点击监听（非接管模式下）', /function tapRefreshHandler/.test(src) && /function syncRefreshTap/.test(src))
  ok('点击监听用捕获阶段且不拦截宿主行为',
    /addEventListener\('click',\s*tapRefreshHandler,\s*true\)/.test(src) && !/tapRefreshHandler[\s\S]{0,200}preventDefault/.test(src))
  ok('清理时摘掉点击监听', /stopRefreshTap/.test(src))

  // 4) 数量文案随阶段变化，不再自相矛盾
  ok('数量文案按阶段区分（探测/索引/写缓存）',
    /正在探测插件源/.test(src) && /正在解析插件索引/.test(src) && /正在写入缓存/.test(src))
}

// ---------- 探针回落直连（对齐宿主的双段取数语义） ----------
{
  const src = readFileSync(PLUGIN_ENTRY, 'utf8')
  ok('探针默认超时提为具名常量', /DEFAULT_MARKETPLACE_PROBE_TIMEOUT_MS\s*=\s*\d+/.test(src))
  ok('默认超时不再过紧（≥8000ms）', internals.DEFAULT_SETTINGS.marketplaceProbeTimeoutMs >= 8000,
    `${internals.DEFAULT_SETTINGS.marketplaceProbeTimeoutMs}ms`)
  ok('探针实现带回落标记 viaFallback', /viaFallback/.test(src))
  ok('mkt 状态含 probeFallback', /probeFallback:\s*false/.test(src))
  ok('索引地址形态与宿主 F_ 一致（raw + /HEAD/）',
    /raw\.githubusercontent\.com\/\$\{OFFICIAL_MARKETPLACE_REPO\}\/HEAD\/echo-plugins\.json/.test(src))

  // 端到端：让「加速镜像」失败、直连可用，看进度条能否仍拿到真实总数
  netMode = 'probeFallback'
  mkt.cards = 3; mkt.skeletons = 6; mkt.busy = false
  await new Promise((r) => setTimeout(r, 1800))   // 让上一轮（若有）先收敛结束
  mkt.busy = true
  await new Promise((r) => setTimeout(r, 900))    // 轮询侦测闲→忙 → 开表 → 探针回落

  const strip = reg.mounts[0].component
  const tree = renderOf(strip, '市场状态条（探针回落直连）')
  const text = subtreeText(tree).join(' ')
  ok('镜像失败时仍拿到了插件总数', text.includes(String(FAKE_INDEX_PLUGINS)), text.slice(0, 210))
  ok('进度条按「已到手 / 总数」显示', text.includes(`/ ${FAKE_INDEX_PLUGINS} 个`), text.slice(0, 210))
  ok('明示总数是经直连取得的', text.includes('总数经直连取得'), text.slice(0, 210))

  mkt.busy = false
  netMode = 'real'
  await new Promise((r) => setTimeout(r, 400))
}

// ---------- 状态条开关：关掉后应移除 DOM ----------
{
  const sTree = renderOf(reg.settings[0].component, '设置面板（复核）')
  const sw = findSwitchInRowByText(sTree, '在线插件界面显示加速状态条')
  ok('设置面板可找到状态条开关', !!sw)
  if (sw) {
    await sw.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 30))
    ok('关闭后 DOM 中的状态条容器被移除', !dom.content.children.some((c) => c.className === 'gha-mkt-strip-host'))
    ok('关闭后 dispose 了挂载', reg.mountDisposed === true)
    // 重新渲染后再取开关（vnode 会捕获当时的状态，必须用最新的）
    const sTree2 = renderOf(reg.settings[0].component, '设置面板（复核 2）')
    const sw2 = findSwitchInRowByText(sTree2, '在线插件界面显示加速状态条')
    await sw2.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 30))
    ok('重新开启后状态条再次注入', reg.mounts.length >= 2 && dom.content.children.some((c) => c.className === 'gha-mkt-strip-host'), `mounts=${reg.mounts.length}`)
  }
}

// ---------- 重启恢复 + 停用 ----------
out.push('')
reg.handler = null; reg.listenOpts = null; reg.listenCalls = 0
reg.pages.length = 0; reg.settings.length = 0
try {
  await mod.activate(makeCtx())
  ok('重启后自动恢复本地桥', reg.listenCalls === 1 && reg.listenOpts?.port === TEST_PORT, `port=${reg.listenOpts?.port}`)
} catch (error) { ok('重启后自动恢复本地桥', false, String(error && error.message)) }

{
  const tree = renderOf(reg.pages[0].component, '加速器页面（重启后）')
  const stopBtn = findByClass(tree, 'gha-btn').find((b) => subtreeText(b).join('').includes('停用 Xget 加速'))
  if (stopBtn && !stopBtn.props.disabled) {
    await stopBtn.props.onClick()
    ok('停用后清空宿主设置', store.githubProxyUrl === '', JSON.stringify(store.githubProxyUrl))
  } else { ok('停用后清空宿主设置', false, '按钮不可用') }
}

// ---------- 迭代：延迟指标 / 结果持久化 / 命令标题 / 检查更新 / runtime ----------
{
  const GH_DIR = path.dirname(PLUGIN_ENTRY)
  const src = readFileSync(`${GH_DIR}/index.js`, 'utf8')
  const mf = JSON.parse(readFileSync(`${GH_DIR}/manifest.json`, 'utf8'))

  // runtime：宿主按窗口选择性加载，显式 false 是自文档化写法
  ok('manifest 显式声明 runtime（两个副窗口 false）',
    mf.runtime?.miniPlayer === false && mf.runtime?.desktopLyric === false, JSON.stringify(mf.runtime))
  ok('版本号已递进到 1.3.0', mf.version === '1.3.0', mf.version)

  // 命令标题：宿主会把它用在「插件命令: <title>」的错误归因文案里
  ok('run-speed-test 带 title',
    reg.commandOptions['run-speed-test']?.title === 'GitHub 加速器：全线路测速',
    JSON.stringify(reg.commandOptions['run-speed-test']))
  ok('apply-fastest 带 title',
    /GitHub 加速器/.test(reg.commandOptions['apply-fastest']?.title || ''),
    JSON.stringify(reg.commandOptions['apply-fastest']))
  ok('新增 check-updates 命令且带 title',
    typeof reg.commands['check-updates'] === 'function' &&
      /检查更新/.test(reg.commandOptions['check-updates']?.title || ''),
    JSON.stringify(reg.commandOptions['check-updates']))

  // 检查更新：宿主有该 action 时应被调用；没有时应优雅降级
  ok('检查更新做了存在性探测（不硬依赖非公开 API）',
    /typeof store\?\.checkForUpdates !== 'function'/.test(src))
  let cfuCalls = 0
  let cfuSilent = 'unset'
  store.checkForUpdates = async (silent) => { cfuCalls += 1; cfuSilent = silent }
  await reg.commands['check-updates']()
  ok('check-updates 调用了宿主 settings.checkForUpdates', cfuCalls === 1, `calls=${cfuCalls}`)
  ok('传 silent=false（让宿主展示检查过程）', cfuSilent === false, String(cfuSilent))
  delete store.checkForUpdates
  const degraded = await reg.commands['check-updates']()
  ok('宿主未提供该 API 时不抛错、给出明确失败', degraded?.ok === false, JSON.stringify(degraded))

  // ---- 结果持久化：种子一份「有效」结果 → 重启 → 列表应立刻有延迟可看 ----
  const NOW = Date.now()
  storageData['gh-accelerator-results'] = {
    resultsAt: NOW,
    results: {
      'wget-la': { ok: true, latencyMs: 531, elapsedMs: 531, bytes: 3989, status: 200 },
      'git-yylx': { ok: true, latencyMs: 1038, elapsedMs: 1038, bytes: 3989, status: 200 }
    },
    throughputAt: NOW,
    throughput: {
      'git-yylx': { ok: true, kbps: 5200, bytes: 12 * 1024 * 1024, elapsedMs: 2360, status: 200 }
    }
  }
  reg.pages.length = 0; reg.settings.length = 0
  await mod.activate(makeCtx())

  const treeRestored = renderOf(reg.pages[0].component, '加速器页面（恢复测速结果后）')
  const rows = findByClass(treeRestored, 'gha-row')
  const rowIndexOf = (name) => rows.findIndex((x) => subtreeText(x).join('').includes(name))
  const textOfRow = (name) => {
    const i = rowIndexOf(name)
    return i >= 0 ? subtreeText(rows[i]).join(' ') : ''
  }
  const wget = textOfRow('wget.la')
  const yylx = textOfRow('git.yylx.win')

  ok('重启后恢复出延迟（不再是一片「未测速」）', wget.includes('531 ms'), wget.slice(0, 130))
  ok('不再把 4KB 小文件的 bytes/耗时显示成 KB/s', !/\d+\s*KB\/s/.test(wget), wget.slice(0, 130))
  ok('恢复出吞吐列（已测吞吐的线路）', /\d+(\.\d+)?\s*(KB\/s|MB\/s)/.test(yylx), yylx.slice(0, 130))
  // 列表自身按「线路池」的固定顺序（分组的）展示，排序效果体现在「应用最快」选中谁 —— 所以断言按钮文案
  const applyBtn = findByClass(treeRestored, 'gha-btn').find((b) => subtreeText(b).join('').includes('应用最快'))
  const applyLabel = applyBtn ? subtreeText(applyBtn).join('') : ''
  ok('已测吞吐的线路被优先选为「最快」（排序生效）', applyLabel.includes('git.yylx.win'), applyLabel || '未找到按钮')

  // ---- 过期结果必须被丢弃（线路可用性变化很快，旧数字只会误导）----
  storageData['gh-accelerator-results'] = {
    resultsAt: NOW - 7 * 60 * 60 * 1000,
    results: { 'wget-la': { ok: true, latencyMs: 531, elapsedMs: 531, bytes: 3989, status: 200 } },
    throughputAt: 0,
    throughput: {}
  }
  reg.pages.length = 0; reg.settings.length = 0
  await mod.activate(makeCtx())
  const treeExpired = renderOf(reg.pages[0].component, '加速器页面（结果过期后）')
  const expiredRows = findByClass(treeExpired, 'gha-row')
  const ei = expiredRows.findIndex((x) => subtreeText(x).join('').includes('wget.la'))
  const expiredText = ei >= 0 ? subtreeText(expiredRows[ei]).join(' ') : ''
  ok('过期结果不恢复（逼一次真实测量）', expiredText.includes('未测速'), expiredText.slice(0, 130))
}

server.closeAllConnections?.()
server.close()
out.push('')
const passCount = out.filter((l) => l.startsWith('  PASS')).length
out.push(fails.length === 0 ? `全部通过（${passCount} 项）` : `失败 ${fails.length} 项：${fails.join(' / ')}`)
writeFileSync(REPORT_FILE, out.join('\n'), 'utf8')
console.log(out.join('\n'))

// 插件 activate() 里起的 setInterval（市场跟踪 / 心跳 / 刷新守护）在无头环境不会自行清理，
// 事件循环因此永不空闲、进程不会自然退出。报告已同步落盘，这里显式收尾。
const exitCode = fails.length ? 1 : 0
process.exitCode = exitCode
const finish = () => process.exit(exitCode)
if (process.stdout.writableLength === 0) finish()
else {
  process.stdout.once('drain', finish)
  setTimeout(finish, 300).unref()
}
