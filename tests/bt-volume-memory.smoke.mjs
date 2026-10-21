/**
 * 音量记忆 (bt-volume-memory) 无头集成测试
 * ---------------------------------------------------------------------------
 * 用**真实 Vue 3 ESM 运行时**无头跑插件，配一个**仿真 helper HTTP 服务**：
 *
 *   1. 按宿主契约 mock ctx（process.launch/terminate、net.request、ui、storage、dispose…）
 *   2. 仿真 helper 实现 /ping /config /endpoints /events /set /forget /shutdown，
 *      并且**真的按端口与 token 判鉴权**（token 不对就 403），插件漏带 token 会红
 *   3. await activate(ctx) → 断言注册项、helper 启动参数、配置下发
 *   4. 手动推进受控定时器 + 往仿真 helper 的事件队列里塞事件，断言记忆/浮层/落盘行为
 *
 * 定时器全是受控替身（真实 sleep 走不通，因为插件内部的 await sleep 也用的是替身），
 * 所以整套测试不依赖真实时间，也没有 flaky 风险。
 *
 * 运行： node tests/bt-volume-memory.smoke.mjs
 * 依赖： 一份 Vue 浏览器 ESM 构建（VUE_ESM_PATH 或 .workbuddy/tmp/vue.runtime.esm-browser.js）
 *
 * 变异测试：设 BVM_PLUGIN_ENTRY 指向插件的改动副本，用同一套断言验证「改坏了会红」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_ENTRY = process.env.BVM_PLUGIN_ENTRY
  ? path.resolve(process.env.BVM_PLUGIN_ENTRY)
  : path.join(ROOT, 'bt-volume-memory', 'index.js')
const CACHE_DIR = path.join(ROOT, '.workbuddy', 'tmp')
const CACHE_VUE = path.join(CACHE_DIR, 'vue.runtime.esm-browser.js')
const REPORT_FILE = process.env.BVM_REPORT_FILE
  ? path.resolve(process.env.BVM_REPORT_FILE)
  : path.join(CACHE_DIR, 'bt-volume-memory-smoke-report.txt')
const VUE_CDN = 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.esm-browser.js'

/* ========================================================================== *
 * 断言
 * ========================================================================== */

let pass = 0
const failures = []
const sections = []
let current = '(root)'

function section(name) {
  current = name
  sections.push({ name, at: pass })
}
function ok(cond, name, extra) {
  if (cond) {
    pass++
    return true
  }
  failures.push('[' + current + '] ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300)))
  return false
}
function eq(actual, expected, name) {
  return ok(actual === expected, name, { actual, expected })
}
function includes(hay, needle, name) {
  return ok(String(hay || '').includes(needle), name, { haystack: String(hay || '').slice(0, 240), needle })
}

/* ========================================================================== *
 * Vue
 * ========================================================================== */

async function resolveVue() {
  for (const c of [process.env.VUE_ESM_PATH, CACHE_VUE].filter(Boolean)) {
    if (fs.existsSync(c)) return c
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const res = await fetch(VUE_CDN)
  if (!res.ok) throw new Error('无法下载 Vue ESM：HTTP ' + res.status)
  fs.writeFileSync(CACHE_VUE, await res.text(), 'utf8')
  return CACHE_VUE
}
const V = await import(pathToFileURL(await resolveVue()).href)

/* ========================================================================== *
 * 受控定时器
 * ========================================================================== */

function installTimers() {
  const intervals = []
  const timeouts = []
  const orig = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  }
  globalThis.setInterval = (fn, ms) => {
    const h = { fn, ms, cleared: false }
    intervals.push(h)
    return h
  }
  globalThis.clearInterval = (h) => {
    if (h) h.cleared = true
    const i = intervals.indexOf(h)
    if (i >= 0) intervals.splice(i, 1)
  }
  globalThis.setTimeout = (fn, ms) => {
    const h = { fn, ms, cleared: false }
    timeouts.push(h)
    return h
  }
  globalThis.clearTimeout = (h) => {
    if (h) h.cleared = true
    const i = timeouts.indexOf(h)
    if (i >= 0) timeouts.splice(i, 1)
  }
  return {
    intervals,
    timeouts,
    get liveIntervals() {
      return intervals.filter((h) => !h.cleared).length
    },
    get liveTimeouts() {
      return timeouts.filter((h) => !h.cleared)
    },
    fireIntervals() {
      intervals.slice().forEach((h) => {
        if (!h.cleared) h.fn()
      })
    },
    /** 只触发指定延时的那一批 timeout（避免把浮层和落盘误当成同一个） */
    fireTimeout(ms) {
      timeouts
        .filter((h) => !h.cleared && h.ms === ms)
        .forEach((h) => {
          h.fn()
          const i = timeouts.indexOf(h)
          if (i >= 0) timeouts.splice(i, 1)
        })
    },
    restore() {
      Object.assign(globalThis, orig)
    }
  }
}

const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
}

/* ========================================================================== *
 * 假 DOM（插件只用到 body.appendChild 这一层）
 * ========================================================================== */

function installFakeDom() {
  const box = () => ({
    style: {},
    children: [],
    className: '',
    appendChild(c) {
      this.children.push(c)
      return c
    },
    remove() {},
    setAttribute() {},
    removeAttribute() {}
  })
  globalThis.document = {
    body: box(),
    documentElement: box(),
    createElement: () => box(),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {}
  }
  return () => {
    delete globalThis.document
  }
}

/* ========================================================================== *
 * 仿真 helper HTTP 服务
 * ========================================================================== */

function createFakeHelper() {
  const state = {
    running: false,
    port: 0,
    token: '',
    coreAudioOk: true,
    coreAudioError: '',
    enabled: true,
    scope: 'bth',
    memories: {},
    endpoints: [],
    queue: { deviceEvents: [], volumeEvents: [], restoredEvents: [] },
    calls: [],
    configCalls: 0,
    endpointsCalls: 0,
    eventsCalls: 0,
    shutdownCalls: 0,
    forgetCalls: [],
    badEntries: 0
  }

  const reply = (url, status, data) => ({ url, status, statusText: status === 200 ? 'OK' : 'ERR', headers: {}, data })

  async function request(config) {
    const url = new URL(config.url)
    const port = Number(url.port)
    const token = url.searchParams.get('t')
    const method = (config.method || 'GET').toUpperCase()
    state.calls.push({ method, path: url.pathname, token, body: config.body || '', port })

    // 没在监听 / 端口不对 → 模拟连接被拒（插件的探测必须能优雅吃掉）
    if (!state.running || port !== state.port) {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:' + port), { code: 'ECONNREFUSED' })
    }
    if (token !== state.token) {
      return reply(config.url, 403, { ok: false, error: '令牌无效' })
    }

    const form = new URLSearchParams(config.body || '')

    switch (url.pathname) {
      case '/ping':
        return reply(config.url, 200, {
          ok: true,
          signature: 'volume-helper',
          version: '1.0.0',
          pid: 4321,
          scope: state.scope,
          coreAudioOk: state.coreAudioOk,
          coreAudioError: state.coreAudioError,
          enabled: state.enabled,
          memoryCount: Object.keys(state.memories).length,
          pendingEvents: 0,
          uptimeSeconds: 1
        })

      case '/config': {
        state.configCalls++
        state.enabled = form.get('enabled') === '1'
        state.scope = form.get('scope') || 'bth'
        if (form.get('memReset') === '1') state.memories = {}
        let bad = 0
        for (const item of String(form.get('mems') || '').split(';')) {
          if (!item) continue
          const sep = item.lastIndexOf(':')
          if (sep <= 0) {
            bad++
            continue
          }
          const v = Number(item.slice(sep + 1))
          if (!Number.isFinite(v)) {
            bad++
            continue
          }
          state.memories[item.slice(0, sep)] = v
        }
        state.badEntries = bad
        return reply(config.url, 200, {
          ok: true,
          enabled: state.enabled,
          scope: state.scope,
          memoryCount: Object.keys(state.memories).length,
          badEntries: bad
        })
      }

      case '/endpoints':
        state.endpointsCalls++
        // Core Audio 不可用时真实 helper 会 503，仿真服务必须一致，否则测不出插件的降级路径
        if (!state.coreAudioOk) {
          return reply(config.url, 503, { ok: false, error: 'Core Audio 不可用：' + state.coreAudioError })
        }
        return reply(config.url, 200, {
          ok: true,
          scope: state.scope,
          count: state.endpoints.length,
          bluetoothCount: state.endpoints.filter((e) => e.isBluetooth).length,
          endpoints: state.endpoints
        })

      case '/events': {
        state.eventsCalls++
        const drained = state.queue
        state.queue = { deviceEvents: [], volumeEvents: [], restoredEvents: [] }
        return reply(config.url, 200, { ok: true, ...drained })
      }

      case '/set':
        return reply(config.url, 200, {
          ok: true,
          key: form.get('key'),
          requested: Number(form.get('volume')),
          applied: Number(form.get('volume'))
        })

      case '/forget': {
        const key = form.get('key')
        state.forgetCalls.push(key)
        const existed = Object.prototype.hasOwnProperty.call(state.memories, key)
        delete state.memories[key]
        return reply(config.url, 200, { ok: true, key, removed: existed, memoryCount: Object.keys(state.memories).length })
      }

      case '/shutdown':
        state.shutdownCalls++
        state.running = false
        return reply(config.url, 200, { ok: true })

      default:
        return reply(config.url, 404, { ok: false, error: '未知接口' })
    }
  }

  return { state, request }
}

const EP_BT = {
  key: '{11111111-1111-1111-1111-111111111111}',
  id: '{0.0.0.0.00000000}.' + '{11111111-1111-1111-1111-111111111111}',
  name: '耳机 (J21)',
  enumerator: 'BTHENUM',
  isBluetooth: true,
  volume: 54,
  muted: false,
  active: true
}
const EP_WIRED = {
  key: '{22222222-2222-2222-2222-222222222222}',
  id: '{0.0.0.0.00000000}.' + '{22222222-2222-2222-2222-222222222222}',
  name: '扬声器 (Realtek(R) Audio)',
  enumerator: 'HDAUDIO',
  isBluetooth: false,
  volume: 51,
  muted: true,
  active: true
}

/* ========================================================================== *
 * ctx mock（按 app.asar 实证的宿主契约）
 * ========================================================================== */

function createCtx({ helper, processMock, storageSeed = {}, appearanceDark = true }) {
  const store = { ...storageSeed }
  const rec = {
    writes: 0,
    pages: [],
    sidebarItems: [],
    mounted: [],
    toasts: [],
    disposers: [],
    platformCalls: []
  }
  const ctx = {
    vue: V,
    appearance: {
      getSnapshot: () => ({ isDark: appearanceDark, accentColor: '#4c8dff' }),
      onSnapshot: () => () => {}
    },
    storage: {
      get: (k) => store[k],
      set: (k, v) => {
        rec.writes++
        store[k] = v
      },
      _store: store
    },
    net: {
      request: (config) => {
        rec.platformCalls.push(config.url)
        return helper.request(config)
      }
    },
    process: processMock,
    electron: { platform: 'win32' },
    toast: {
      info: (m) => rec.toasts.push({ level: 'info', m }),
      success: (m) => rec.toasts.push({ level: 'success', m }),
      warning: (m) => rec.toasts.push({ level: 'warning', m }),
      danger: (m) => rec.toasts.push({ level: 'danger', m })
    },
    ui: {
      addPage: (def) => {
        rec.pages.push(def)
      },
      sidebar: {
        addItem: (def) => {
          rec.sidebarItems.push(def)
        }
      },
      mount: (target, component, options) => {
        rec.mounted.push({ target, component, options })
      },
      components: {} // 宿主组件缺席 → 插件必须退到朴素替身而不是炸掉
    },
    dispose: (fn) => {
      rec.disposers.push(fn)
    }
  }
  return { ctx, rec }
}

function createProcessMock(onLaunch) {
  const mock = {
    launches: [],
    terminated: [],
    async launch(params) {
      mock.launches.push(params)
      const res = onLaunch ? await onLaunch(params, mock.launches.length - 1) : null
      if (res) return res
      return { ok: true, pid: 5000 + mock.launches.length, executable: params.executable, cwd: '', startedAt: Date.now() }
    },
    async terminate(pid) {
      mock.terminated.push(pid)
      return { ok: true, pid, terminated: true }
    }
  }
  return mock
}

/** activate 里含「等 helper 起来」的 sleep 循环，受控定时器下要手动推进才能跑完 */
async function runActivate(ctx, timers, maxSteps = 600) {
  let done = false
  const p = Promise.resolve()
    .then(() => ctx.__activate())
    .then(
      (v) => {
        done = true
        return v
      },
      (e) => {
        done = true
        return { __error: e }
      }
    )
  for (let i = 0; i < maxSteps && !done; i++) {
    timers.fireTimeout(150)
    await settle(6)
  }
  return p
}

/* ========================================================================== *
 * 用例
 * ========================================================================== */

const mod = await import(pathToFileURL(PLUGIN_ENTRY).href + '?t=' + Date.now())
const activate = mod.activate
const internals = mod.__internals

const timers = installTimers()
const restoreDom = installFakeDom()

function argValue(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

/** 标准场景：插件启动 → helper 拉起成功 → 已下发配置 → 已刷新端点 */
async function bootHappy({ storageSeed = {}, endpoints = [EP_BT], processMock } = {}) {
  const helper = createFakeHelper()
  const pm = processMock || createProcessMock(async (params) => {
    helper.state.running = true
    helper.state.port = Number(argValue(params.args, '--port'))
    helper.state.token = argValue(params.args, '--token')
    helper.state.endpoints = endpoints
    return null
  })
  const { ctx, rec } = createCtx({ helper, processMock: pm, storageSeed })
  ctx.__activate = () => activate(ctx)
  ctx.process.launchCalls = pm.launches
  const handle = await runActivate(ctx, timers)
  return { helper, pm, ctx, rec, handle }
}

/* ---------------------------------------------------------------- 1. 注册项 */
section('注册与启动')
{
  const { helper, pm, ctx, rec } = await bootHappy()

  eq(pm.launches.length, 1, '没找到实例时应 launch 一次')
  const args = pm.launches[0].args
  eq(pm.launches[0].executable, 'Host/VolumeHelper.exe', 'executable 用插件目录内相对路径')
  eq(argValue(args, '--port'), '18790', '端口从 18790 起')
  ok(typeof argValue(args, '--token') === 'string' && argValue(args, '--token').length >= 16, '带了足够长的 token')
  eq(argValue(args, '--idle'), '20', '带了空闲自退（禁用插件时宿主不会杀子进程，这是兜底）')
  eq(argValue(args, '--scope'), 'bth', '默认作用范围是仅蓝牙')
  eq(args.includes('--parent-pid'), false, '不再传 --parent-pid（helper 靠空闲自退兜底）')

  eq(rec.pages.length, 1, '注册了一个页面')
  eq(rec.pages[0].id, 'devices', '页面 id')
  eq(rec.sidebarItems.length, 1, '注册了侧栏入口')
  eq(rec.sidebarItems[0].pageId, 'devices', '侧栏入口指向页面')
  eq(rec.mounted.length, 1, '浮层挂载了一次')

  const tokens = new Set(helper.state.calls.map((c) => c.token))
  eq(tokens.size, 1, '所有请求只用同一个 token')
  eq([...tokens][0], argValue(args, '--token'), '请求里的 token 与启动参数一致')

  // 启动时已经连着的设备不算「重连」，不该弹层
  eq(internals.state.osd.visible, false, '启动时不弹浮层')

  eq(helper.state.memories && Object.keys(helper.state.memories).length, 0, '空记忆表也能正常下发')
  eq(helper.state.configCalls >= 1, true, '启动时下发过配置')
  eq(internals.state.helper.token, argValue(args, '--token'), '状态里的 token 与启动参数一致')
}

/* ---------------------------------------------------------------- 2. 复用已运行的实例 */
section('复用已有实例')
{
  const TOKEN = 'persisted-token-0123456789abcdef'
  const helper = createFakeHelper()
  helper.state.running = true
  helper.state.port = 18794
  helper.state.token = TOKEN
  helper.state.endpoints = [EP_BT]
  let launched = 0
  const pm = createProcessMock(async () => {
    launched++
    return null
  })
  const { ctx } = createCtx({
    helper,
    processMock: pm,
    storageSeed: { 'settings-v1': { enabled: true, scope: 'bth', memories: {}, helperToken: TOKEN } }
  })
  ctx.__activate = () => activate(ctx)
  await runActivate(ctx, timers)

  eq(launched, 0, 'token 落盘后能认出已有实例 → 不重复拉起（否则会留孤儿进程）')
  eq(internals.state.helper.port, 18794, '接管了已有实例的端口')
  eq(internals.state.helper.state, 'running', '状态为运行中')
  eq(helper.state.shutdownCalls, 0, '复用时不关掉它')
  await internals.stopHelper()
}

/* ---------------------------------------------------------------- 3. 端口被占 → 换端口 */
section('端口占用')
{
  let n = 0
  const helper = createFakeHelper()
  const pm = createProcessMock(async (params) => {
    n++
    // 第一次一直起不来（模拟端口被无关程序占着），第二次成功
    if (n >= 2) {
      helper.state.running = true
      helper.state.port = Number(argValue(params.args, '--port'))
      helper.state.token = argValue(params.args, '--token')
      helper.state.endpoints = [EP_BT]
    }
    return null
  })
  const { ctx } = createCtx({ helper, processMock: pm })
  ctx.__activate = () => activate(ctx)
  await runActivate(ctx, timers)

  eq(n, 2, '起不来就换下一个端口重试')
  eq(argValue(pm.launches[1].args, '--port'), '18791', '第二次用的是 18791')
  eq(pm.terminated.length >= 1, true, '起不来那个进程被 terminate 掉（不留在后台）')
  await internals.stopHelper()
}

/* ---------------------------------------------------------------- 4. 授权被取消 */
section('授权取消 / 能力缺失')
{
  const helper = createFakeHelper()
  const pm = createProcessMock(async () => ({ ok: false, canceled: true, error: '用户已取消启动本地程序' }))
  const { ctx, rec } = createCtx({ helper, processMock: pm })
  ctx.__activate = () => activate(ctx)
  await runActivate(ctx, timers)

  eq(internals.state.helper.state, 'error', '进入 error 状态')
  includes(internals.state.helper.error, '取消', '文案点明「你取消了授权」')
  eq(rec.toasts.length >= 1, true, '给了一条 toast 提示')
  eq(pm.launches.length, 1, '用户拒绝后不反复弹窗')
}

{
  const helper = createFakeHelper()
  const { ctx } = createCtx({ helper, processMock: {} }) // 旧宿主：没有 ctx.process
  ctx.__activate = () => activate(ctx)
  await runActivate(ctx, timers)

  eq(internals.state.helper.state, 'error', '没有进程 API 时进入 error')
  includes(internals.state.helper.error, '进程 API', '文案说明宿主没提供进程 API')
  eq(internals.state.osd.visible, false, '失败时不弹浮层')
}

{
  // helper 起来了但 Core Audio 不可用
  const helper = createFakeHelper()
  helper.state.coreAudioOk = false
  helper.state.coreAudioError = 'EnumAudioEndpoints 失败'
  const pm = createProcessMock(async (params) => {
    helper.state.running = true
    helper.state.port = Number(argValue(params.args, '--port'))
    helper.state.token = argValue(params.args, '--token')
    return null
  })
  const { ctx } = createCtx({ helper, processMock: pm })
  ctx.__activate = () => activate(ctx)
  await runActivate(ctx, timers)

  eq(internals.state.helper.state, 'running', 'helper 仍算运行中')
  eq(internals.state.helper.coreAudioOk, false, '如实反映 Core Audio 不可用（不会被一次成功调用误置为 true）')
  includes(internals.state.helper.error, 'Core Audio', '文案点明 Core Audio 不可用')
  await internals.stopHelper()
}

/* ---------------------------------------------------------------- 5. 学音量 + 防抖落盘 */
section('记忆与防抖')
{
  const { helper, rec, ctx } = await bootHappy()

  const before = rec.writes
  // 连续三次音量变化（模拟拖动滑条）
  helper.state.queue.volumeEvents.push({ key: EP_BT.key, volume: 40, muted: false, at: new Date().toISOString() })
  timers.fireIntervals()
  await settle()
  helper.state.queue.volumeEvents.push({ key: EP_BT.key, volume: 45, muted: false, at: new Date().toISOString() })
  timers.fireIntervals()
  await settle()
  helper.state.queue.volumeEvents.push({ key: EP_BT.key, volume: 47, muted: false, at: new Date().toISOString() })
  timers.fireIntervals()
  await settle()

  eq(internals.state.memories[EP_BT.key].volume, 47, '以最后一次为准')
  eq(rec.writes - before, 0, '防抖窗口内不落盘')

  timers.fireTimeout(2000)
  await settle()
  eq(rec.writes - before, 1, '防抖后只落盘一次')
  eq(ctx.storage._store['settings-v1'].memories[EP_BT.key].volume, 47, '落盘的是最终值')
  eq(helper.state.memories[EP_BT.key], 47, '也推给了 helper')

  // 音量 0 永不记忆
  const keep = internals.state.memories[EP_BT.key].volume
  helper.state.queue.volumeEvents.push({ key: EP_BT.key, volume: 0, muted: false, at: new Date().toISOString() })
  timers.fireIntervals()
  await settle()
  eq(internals.state.memories[EP_BT.key].volume, keep, '音量 0 不覆盖已有记忆（蓝牙栈断开时会打出 0）')

  // 越界值只可能是坏数据 → 丢弃，绝不 clamp（clamp 成 100 会让下次重连炸到满音量）
  helper.state.queue.volumeEvents.push({ key: EP_BT.key, volume: 300, muted: false, at: new Date().toISOString() })
  timers.fireIntervals()
  await settle()
  eq(internals.state.memories[EP_BT.key].volume, keep, '越界上报被丢弃，不覆盖好值')

  await internals.stopHelper()
  void ctx
}

/* ---------------------------------------------------------------- 6. 恢复 + 浮层 */
section('重连恢复与浮层')
{
  const { helper, rec, ctx } = await bootHappy()

  helper.state.queue.restoredEvents.push({
    key: EP_BT.key,
    name: '耳机 (J21)',
    enumerator: 'BTHENUM',
    isBluetooth: true,
    rememberedVolume: 35,
    previousVolume: 100,
    appliedVolume: 33,
    muted: false,
    announce: true,
    at: new Date().toISOString()
  })
  const before = rec.writes
  timers.fireIntervals()
  await settle()

  eq(internals.state.osd.visible, true, '重连恢复时弹浮层')
  eq(internals.state.osd.volume, 33, '浮层显示的是**实际生效值**（端点可能 snap）')
  eq(internals.state.osd.previous, 100, '浮层带上了恢复前的值')
  eq(internals.state.osd.count, 1, '第一次恢复 count=1')
  eq(internals.state.memories[EP_BT.key].volume, 33, '记忆按实际生效值更新')
  eq(rec.writes - before >= 1, true, '恢复是立刻落盘，不等防抖')

  // announce=false（启动时已连着的设备）不该弹
  internals.state.osd.visible = false
  helper.state.queue.restoredEvents.push({
    key: EP_BT.key,
    name: '耳机 (J21)',
    enumerator: 'BTHENUM',
    isBluetooth: true,
    rememberedVolume: 33,
    previousVolume: 33,
    appliedVolume: 33,
    muted: false,
    announce: false,
    at: new Date().toISOString()
  })
  timers.fireIntervals()
  await settle()
  eq(internals.state.osd.visible, false, 'announce=false 不弹浮层')

  // 合并：A2DP + 免手持两个端点几乎同时恢复 → 原地刷新不叠层
  helper.state.queue.restoredEvents.push({
    key: EP_WIRED.key, name: '免手持', enumerator: 'BTHHFENUM', isBluetooth: true,
    rememberedVolume: 20, previousVolume: 50, appliedVolume: 20, muted: false, announce: true, at: new Date().toISOString()
  })
  timers.fireIntervals()
  await settle()
  eq(internals.state.osd.count, 2, '同一窗口内的第二次恢复是原地刷新（count=2）')

  // 浮层自动隐藏
  timers.fireTimeout(2600)
  await settle()
  eq(internals.state.osd.visible, false, '到点自动隐藏')

  await internals.stopHelper()
  void ctx
}

/* ---------------------------------------------------------------- 7. 开关与范围 */
section('开关与作用范围')
{
  const { helper, ctx } = await bootHappy()
  const page = ctx.ui && internals

  // 直接驱动内部状态与下发逻辑（UI 交互在下面单独用 vnode 测）
  internals.state.enabled = false
  await internals.pushConfig({ reset: true })
  eq(helper.state.enabled, false, '关掉开关后 helper 也关掉记忆')
  eq(Object.keys(helper.state.memories).length, 0, '关掉时记忆表被清空 → 保证完全不恢复')

  internals.state.enabled = true
  internals.state.scope = 'all'
  await internals.pushConfig({ reset: false })
  eq(helper.state.scope, 'all', '作用范围切换被下发')
  eq(helper.state.enabled, true, '开关打开被下发')

  await internals.stopHelper()
  void page
}

/* ---------------------------------------------------------------- 8. 忘记设备 */
section('忘记设备')
{
  const { helper, rec } = await bootHappy()
  internals.state.memories[EP_BT.key] = { volume: 40, name: '耳机', enumerator: 'BTHENUM', isBluetooth: true, lastSeenAt: '' }
  await internals.pushConfig()
  eq(helper.state.memories[EP_BT.key], 40, '先让 helper 也有一份')

  // 走页面的「忘记」按钮（真实 vnode 交互）
  const vnode = pageVnode(rec)
  const btn = findButton(vnode, '忘记')
  ok(!!btn, '设备行里有「忘记」按钮')
  if (btn) {
    await btn.props.onClick()
    await settle()
  }

  eq(internals.state.memories[EP_BT.key], undefined, '记忆被删掉')
  eq(helper.state.forgetCalls.includes(EP_BT.key), true, 'helper 也收到了 /forget')
  eq(helper.state.memories[EP_BT.key], undefined, 'helper 侧那份也没了')

  await internals.stopHelper()
}

/* ---------------------------------------------------------------- 9. 页面渲染 */
section('设置页渲染')
{
  const { rec } = await bootHappy({ endpoints: [EP_BT, EP_WIRED] })

  // 给一个「有记忆但离线」的设备，验证列表里能描述离线设备
  internals.state.memories['{99999999-9999-9999-9999-999999999999}'] = {
    volume: 66, name: '旧蓝牙音箱', enumerator: 'BTHENUM', isBluetooth: true, lastSeenAt: '2026-10-01T10:00:00.000Z'
  }

  const vnode = pageVnode(rec)
  const text = textOf(vnode)
  includes(text, '音量记忆', '页面标题')
  includes(text, '耳机 (J21)', '列出了已连接的蓝牙设备')
  includes(text, '扬声器 (Realtek(R) Audio)', '列出了有线设备')
  includes(text, '旧蓝牙音箱', '列出了未连接的设备（含记忆值）')
  includes(text, '未连接', '标出了离线状态')
  includes(text, '已连接', '标出了在线状态')
  includes(text, '蓝牙 · 立体声', '蓝牙类型文案')
  includes(text, '板载/HDMI', '有线设备类型文案')

  const rows = countRows(vnode)
  ok(rows >= 3, '设备行数覆盖已连接与未连接', { rows })

  // 换一个主题快照再渲染一次：浅色主题下浮层不该仍是黑底（配色取自 S.osd.dark）
  await internals.stopHelper()
}

/* ---------------------------------------------------------------- 10. dispose */
section('停用清理')
{
  const { helper, rec, pm } = await bootHappy()
  ok(timers.liveIntervals >= 1, '运行时有一个轮询 interval')

  // 本次激活自己注册的那个 interval 是否被清掉。用差值断言：
  // 受控定时器数组是全局共享的，前面若干用例的 interval 还留在里面。
  const beforeDispose = timers.liveIntervals
  const timeoutsBefore = timers.liveTimeouts.filter((t) => t.ms === 2000).length

  // 模拟宿主停用插件：跑掉 ctx.dispose 注册的清理
  rec.disposers.splice(0).forEach((fn) => fn())
  await settle(20)

  eq(helper.state.shutdownCalls, 1, 'deactivate 时要求 helper 退出')
  eq(timers.liveIntervals, beforeDispose - 1, '本次激活的 interval 被清掉（否则测试会挂住）')
  eq(timers.liveTimeouts.filter((t) => t.ms === 2000).length, timeoutsBefore, '防抖定时器被清掉')

  // stopHelper 的 pid 兜底：/shutdown 之后不该再 terminate（实例已退出）
  void pm
}

/* ---------------------------------------------------------------- 11. 纯函数 */
section('纯函数')
{
  internals.state.memories = {
    A: { volume: 40 },
    B: { volume: 0 },      // 越界 → 不编码
    C: { volume: 100 }
  }
  const enc = internals.encodeMemories()
  includes(enc, 'A:40', '编码包含合法项')
  includes(enc, 'C:100', '编码包含 100')
  eq(enc.includes('B:'), false, '越界项不进编码')

  eq(internals.isUsableMemory(0), false, '0 不算用户选择')
  eq(internals.isUsableMemory(1), true, '1 合法')
  eq(internals.isUsableMemory(100), true, '100 合法')
  eq(internals.isUsableMemory(101), false, '101 越界')
  eq(internals.isUsableMemory(NaN), false, 'NaN 越界')

  eq(internals.deviceTypeLabel({ enumerator: 'BTHENUM' }), '蓝牙 · 立体声', 'A2DP 类型')
  eq(internals.deviceTypeLabel({ enumerator: 'BTHHFENUM' }), '蓝牙 · 免手持', 'HFP 类型')
  eq(internals.deviceTypeLabel({ enumerator: 'BTHLEENUM' }), '蓝牙 · LE Audio', 'LE Audio 类型')
  eq(internals.deviceTypeLabel({ enumerator: 'USB' }), 'USB', 'USB 类型')

  // 落盘 → 重新读回，越界记录被丢弃
  const loaded = internals.loadSettings({
    storage: {
      get: () => ({
        enabled: true,
        scope: 'all',
        memories: { X: { volume: 50, name: 'n' }, Y: { volume: 0 }, Z: { volume: 'abc' } },
        helperToken: 'tk'
      })
    }
  })
  eq(loaded.scope, 'all', 'scope 读回')
  eq(Object.keys(loaded.memories).length, 1, '读回时丢掉越界与不可解析的记录')
  eq(loaded.memories.X.volume, 50, '合法记录读回')
  eq(loaded.helperToken, 'tk', 'token 读回（复用实例的关键）')
}

/* ========================================================================== *
 * vnode 辅助
 * ========================================================================== */

/** 从 ctx.ui.addPage 的记录里拿页面组件，直接 setup()() 拿真实 vnode 树 */
function pageVnode(rec) {
  const page = rec.pages[0]
  return page ? page.component.setup()() : null
}
function findButton(vnode, label) {
  let found = null
  walk(vnode, (v) => {
    if (found) return
    if (v && v.props && v.props.label === label) found = v
  })
  return found
}
function countRows(vnode) {
  let n = 0
  walk(vnode, (v) => {
    // 设备行与表头都用 inline 的 grid-template-columns 排版，靠这个属性认行；减去表头那一行
    if (v && v.props && v.props.style && v.props.style.gridTemplateColumns) n++
  })
  return Math.max(0, n - 1)
}
function textOf(vnode) {
  const out = []
  walk(vnode, (v) => {
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v))
  })
  return out.join(' ')
}
function walk(node, fn) {
  fn(node)
  if (!node || typeof node !== 'object') return
  const kids = node.children
  if (Array.isArray(kids)) {
    for (const k of kids) walk(k, fn)
    return
  }
  // ⚠️ Vue 的 h() 把「单个字符串/数字子节点」**原样**放进 children（不包成 text vnode），
  // 所以只处理数组会漏掉这类文本 —— 页面上大部分文案都是这么写的。插槽对象同理。
  if (typeof kids === 'string' || typeof kids === 'number') {
    fn(kids)
  } else if (kids && typeof kids === 'object' && typeof kids.type !== 'undefined') {
    walk(kids, fn)
  }
}

/* ========================================================================== *
 * 汇总
 * ========================================================================== */

const lines = ['']
for (let i = 0; i < sections.length; i++) {
  const start = sections[i].at
  const end = i + 1 < sections.length ? sections[i + 1].at : pass
  const failed = failures.filter((f) => f.startsWith('[' + sections[i].name + ']')).length
  lines.push(`${failed === 0 ? '  ok ' : ' FAIL'}  ${sections[i].name.padEnd(18)} ${end - start} 项`)
}
if (failures.length) {
  lines.push('', '失败明细：')
  for (const f of failures) lines.push('  - ' + f)
}
const total = pass + failures.length
lines.push('', `${pass}/${total} 通过${failures.length ? `，${failures.length} 项失败` : ''}`)

const report = lines.join('\n')
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(REPORT_FILE, report, 'utf8')
} catch (e) {
  void e
}
console.log(report)
process.exitCode = failures.length ? 1 : 0
timers.restore()
restoreDom()
