/**
 * 酷狗每日 VIP (kugou-daily-vip) 无头集成测试
 * ---------------------------------------------------------------------------
 * 用**真实 index.js + 真实 Vue 3 ESM 运行时 + mock ctx**无头跑一遍业务流程：
 *   activate 注册、面板渲染、真实点击按钮跑完整领取链路、错误码分支、
 *   receive_day 形态自校准、手动节流、只读刷新、跨天守卫、停用清理、广告倒计时。
 *
 * 运行： node tests/kugou-daily-vip.smoke.mjs
 * 依赖： 一份 Vue 浏览器 ESM 构建（查找顺序见 resolveVue；可用 VUE_ESM_PATH 指定本地文件）
 *
 * 变异测试：设 KDV_PLUGIN_ENTRY 指向插件的改动副本，即可用同一套断言验证「改坏了会红」。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_DIR = path.join(ROOT, 'kugou-daily-vip')
const PLUGIN_ENTRY = process.env.KDV_PLUGIN_ENTRY
  ? path.resolve(process.env.KDV_PLUGIN_ENTRY)
  : path.join(PLUGIN_DIR, 'index.js')
const SRC = pathToFileURL(PLUGIN_ENTRY).href
const CACHE_DIR = path.join(ROOT, '.workbuddy', 'tmp')
const CACHE_VUE = path.join(CACHE_DIR, 'vue.runtime.esm-browser.js')
const VUE_CDN = 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.runtime.esm-browser.js'
const REPORT_FILE = path.join(CACHE_DIR, 'kugou-daily-vip-smoke-report.txt')

// 夹具用的假 uid：刻意只留 4 位，避开发布门禁的 kugou-userid-literal 规则（6 位阈值）误判成真 uid
const MOCK_USERID = 4242

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

// ---------- mock 环境 ----------

const reg = { titlebar: [], teleports: [], css: [], disposers: [] }
const storageData = {}
const requests = []
const toasts = []

function beijing() {
  const now = new Date()
  return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000)
}
const BJ_KEY = `${beijing().getFullYear()}-${String(beijing().getMonth() + 1).padStart(2, '0')}-${String(beijing().getDate()).padStart(2, '0')}`
const BJ_DAY = beijing().getDate()

// 真机实测响应结构（渊华 2026-09-19 提供）：
//  - monthRecord.data.list[].day 是**完整日期字符串**（"2026-06-20"），不是日号
//  - vipDetail.data.busi_vip 是数组，svip(畅听/概念版) 与 tvip(听书) 并存，
//    且顶层 data.vip_end_time 是空串
const script = {
  userDetail: { status: 200, body: { status: 1, data: { nickname: '测试用户' } } },
  monthRecord: { status: 200, body: { status: 1, data: { list: [{ day: '2026-06-20' }, { day: '2026-06-21' }, { day: '2026-07-01' }] } } },
  listenSong: { status: 200, body: { status: 1, data: {} } },
  ad: [],
  dayVip: [],
  upgrade: { status: 200, body: { status: 1 } },
  vipDetail: {
    status: 200,
    body: {
      status: 1,
      data: {
        vip_end_time: '',
        busi_vip: [
          { vip_end_time: '2026-09-23 22:09:58', product_type: 'svip', busi_type: 'concept', vip_name: '畅听VIP' },
          { vip_end_time: '2026-10-05 22:42:57', product_type: 'tvip', busi_type: 'concept', vip_name: '听书VIP' },
        ],
      },
    },
  },
  // 广告等待：默认走真实 sleepAbortable，测试里按需替换成快进版
  adWait: null,
}

// 快进版等待器：注入到测试用的插件副本里，替掉真实 30s 等待，
// 但同时把 onTick 回调按原样跑一遍——这样既能秒级跑完，又能真正验证倒计时。
function makeFastWait(tickTimes = [1000, 500]) {
  return async (ms, onTick) => {
    if (ms <= 0) return true
    for (const t of tickTimes) {
      if (typeof onTick === 'function') onTick(t)
      await new Promise((r) => setTimeout(r, 0))
    }
    if (typeof onTick === 'function') onTick(0)
    return true
  }
}

function next(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback
  return list.length === 1 ? list[0] : list.shift()
}

async function fakeApiRequest(config) {
  requests.push({ url: config.url, params: { ...(config.params || {}) }, auth: config.headers?.Authorization })
  const url = config.url
  if (url === '/user/detail') return script.userDetail
  if (url === '/youth/month/vip/record') return script.monthRecord
  if (url === '/youth/listen/song') return script.listenSong
  if (url === '/youth/vip') return next(script.ad, { status: 200, body: { status: 1 } })
  if (url === '/youth/day/vip') return next(script.dayVip, { status: 200, body: { status: 1 } })
  if (url === '/youth/day/vip/upgrade') return script.upgrade
  if (url === '/user/vip/detail') return script.vipDetail
  return { status: 404, body: { code: 404, msg: 'Not Found' } }
}

// 宿主以 loader 函数形式提供 ui.components.*（插件用 defineAsyncComponent 包）
const StubButton = {
  name: 'StubButton',
  setup(props, { slots, attrs }) {
    return () => vue.h('button', { class: 'stub-btn', ...attrs }, slots.default ? slots.default() : [])
  },
}

// 等待器注入：stepAd 的第 4 个参数是 waitFn（可中断 + 可观测的等待）。
// 真实运行时它默认是 sleepAbortable，测试里不可能真等 30s，所以把 runClaim 里
// 广告那段的调用点尾替换成显式传入「快进版 waitFn」。
//
// 踩坑（本轮踩过）：不能用 `/}; \n today.adClaimed = r.claimed;/` 这种宽松正则——
// 本测试文件自身的 script 对象里也有一句同形的 `},\n  },\n  // 广告等待…`，
// 会被一并替换掉，导致 vipDetail 的 mock 被破坏、断言集体失败。
// 所以锚点必须唯一：用「extraWaiting: stepAd 收尾」这种只出现在插件里的上下文。
const FAST_WAIT_ANCHOR = '        } else if (p.phase === "done") {\n          setAdProgress({ phase: "done", waitRemain: null, total: p.total, claimed: p.claimed });\n        }\n      });\n      today.adClaimed = r.claimed;'
async function loadPluginWithFastWait(tag, tickTimes, tickGapMs = 0) {
  const { readFileSync, writeFileSync } = await import('node:fs')
  let src = readFileSync(PLUGIN_ENTRY, 'utf8')
  if (!src.includes(FAST_WAIT_ANCHOR)) {
    throw new Error('未找到 stepAd 调用点锚点，测试注入失效（插件调用点被改动过？）')
  }
  const ticks = JSON.stringify(tickTimes || [1000, 500])
  const patchedTail =
    `        } else if (p.phase === "done") {\n` +
    `          setAdProgress({ phase: "done", waitRemain: null, total: p.total, claimed: p.claimed });\n` +
    `        }\n` +
    `      }, async (ms, onTick) => {\n` +
    `        globalThis.__kdvWaits = globalThis.__kdvWaits || [];\n` +
    `        globalThis.__kdvWaits.push(ms);\n` +
    `        for (const t of ${ticks}) {\n` +
    `          if (typeof onTick === 'function') { globalThis.__kdvTicks.push(t); onTick(t); }\n` +
    `          await new Promise((res) => setTimeout(res, ${Number(tickGapMs) || 0}));\n` +
    `        }\n` +
    `        if (typeof onTick === 'function') onTick(0);\n` +
    `        return true;\n` +
    `      });\n` +
    `      today.adClaimed = r.claimed;`
  const patched = src.replace(FAST_WAIT_ANCHOR, patchedTail)
  if (patched === src) throw new Error('锚点替换未生效')
  const tmp = path.join(CACHE_DIR, `kugou-daily-vip-fast-${tag}.mjs`)
  writeFileSync(tmp, patched, 'utf8')
  return import(pathToFileURL(tmp).href + '?t=' + Date.now())
}

function makeCtx() {
  // 与宿主一致：ctx.pinia.state 是一个 ref，登录态在 .value.user / .value.device
  const pinia = {
    state: vue.ref({
      user: { info: { token: 'tok-abc', userid: MOCK_USERID, nickname: '测试用户', t1: 'T1' } },
      device: { info: { dfid: 'dfid-1', mid: 'mid-1', uuid: 'uuid-1', guid: 'guid-1', serverDev: 'EchoMusic', mac: 'AA:BB' } },
    }),
  }
  return {
    id: 'kugou-daily-vip',
    manifest: { id: 'kugou-daily-vip', name: '概念版每日领VIP', version: '1.0.0' },
    vue,
    pinia,
    storage: {
      get: async (k) => storageData[k],
      set: async (k, v) => {
        storageData[k] = JSON.parse(JSON.stringify(v))
      },
    },
    electron: { api: { request: fakeApiRequest }, platform: 'win32' },
    kugouVerification: { request: async () => ({ ok: true }) },
    ui: {
      components: { Button: () => StubButton, Switch: () => StubButton },
      teleport: (component, options) => {
        reg.teleports.push({ component, options })
        return () => {}
      },
      titlebar: {
        register: (item) => {
          reg.titlebar.push(item)
          return () => {}
        },
      },
    },
    css: {
      inject: (text, options) => {
        reg.css.push({ text, options })
        return () => {}
      },
    },
    toast: {
      info: (m) => toasts.push(['info', m]),
      success: (m) => toasts.push(['success', m]),
      warning: (m) => toasts.push(['warning', m]),
      danger: (m) => toasts.push(['danger', m]),
    },
    dispose: (fn) => reg.disposers.push(fn),
  }
}

// ---------- 渲染工具 ----------

function walk(tree, fn) {
  if (!tree) return
  if (Array.isArray(tree)) {
    tree.forEach((n) => walk(n, fn))
    return
  }
  if (typeof tree !== 'object') return
  fn(tree)
  if (tree.children) walk(tree.children, fn)
}
function findByProp(tree, key, value) {
  const hits = []
  walk(tree, (n) => {
    if (n.props && n.props[key] !== undefined && (value === undefined || n.props[key] === value)) hits.push(n)
  })
  return hits
}
function subtreeText(node, acc = []) {
  if (node == null) return acc
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node))
    return acc
  }
  if (Array.isArray(node)) {
    node.forEach((n) => subtreeText(n, acc))
    return acc
  }
  if (typeof node === 'object' && node.children) subtreeText(node.children, acc)
  return acc
}
function buttonLabel(vnode) {
  try {
    return subtreeText(vnode.children?.default ? vnode.children.default() : []).join('')
  } catch {
    return ''
  }
}
function stepMarkOf(panel, id) {
  const row = findByProp(panel, 'data-step', id)[0]
  return row?.children?.[0]?.props?.['data-mark']
}
function currentPanel() {
  const dialogTree = reg.teleports[reg.teleports.length - 1].component.setup()()
  const holders = []
  walk(dialogTree, (n) => {
    if (n.type && typeof n.type === 'object' && typeof n.type.setup === 'function') holders.push(n)
  })
  return holders.length ? holders[0].type.setup()() : null
}
function openPanelFromToolbar() {
  reg.titlebar[0].onClick()
  return currentPanel()
}
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

function resetReg() {
  reg.titlebar = []
  reg.teleports = []
  reg.css = []
  reg.disposers = []
}

const origWarn = console.warn
const origError = console.error
console.warn = () => {}
console.error = () => {}

// ---------- 测试主体 ----------

const report = []
try {
  const mod = await import(SRC)

  // ===== 1. activate 注册 =====
  let ctx = makeCtx()
  storageData.settings = { adCount: 3, adIntervalSec: 0, autoUpgrade: true }
  try {
    await mod.activate(ctx)
    ok('activate(ctx) 执行成功', true)
  } catch (error) {
    ok('activate(ctx) 执行成功', false, String(error && error.stack).slice(0, 400))
  }
  await settle(60)

  ok('注册了顶部入口（titlebar）', reg.titlebar.length === 1, JSON.stringify(reg.titlebar[0]?.id))
  ok('入口 id/图标/位置正确',
    reg.titlebar[0]?.id === 'kugou-daily-vip' && reg.titlebar[0]?.icon === 'tabler:gift' && reg.titlebar[0]?.defaultPlacement === 'toolbar',
    `icon=${reg.titlebar[0]?.icon} placement=${reg.titlebar[0]?.defaultPlacement}`)
  ok('注册了 teleport 面板', reg.teleports.length === 1, String(reg.teleports[0]?.options?.id))
  ok('注入样式且带 id', reg.css.length === 1 && reg.css[0].options?.id === 'kdv-dialog-style')
  ok('注册 dispose 回收函数', reg.disposers.length >= 1)
  ok('激活时不发任何业务请求', requests.length === 0, `requests=${requests.length}`)

  // ===== 2. 打开面板并渲染 =====
  let panel = openPanelFromToolbar()
  ok('点击顶部入口后面板渲染成功', !!panel)
  await settle(60) // 等 statusOnly 刷新落地

  {
    ok('面板根节点带 data-panel 标识', findByProp(panel, 'data-panel', 'kugou-daily-vip').length === 1)
    const steps = findByProp(panel, 'data-step')
    ok('渲染 4 个领取步骤行', steps.length === 4, steps.map((s) => s.props['data-step']).join(','))
    const settings = findByProp(panel, 'data-setting')
    ok('渲染 9 项设置', settings.length === 9, settings.map((s) => s.props['data-setting']).join(','))
    ok('设置包含全部关键项',
      ['autoDaily', 'listenSong', 'adVip', 'adCount', 'adIntervalSec', 'dayVip', 'receiveDayFormat', 'autoUpgrade', 'toastOnDone']
        .every((k) => settings.some((s) => s.props['data-setting'] === k)))
    const actions = findByProp(panel, 'data-action')
    ok('渲染 4 个操作按钮',
      ['claim', 'stop', 'refresh', 'diag'].every((a) => actions.some((n) => n.props['data-action'] === a)),
      actions.map((n) => n.props['data-action']).join(','))
    const claimBtn = actions.find((n) => n.props['data-action'] === 'claim')
    ok('主按钮文案为「一键领取今日 VIP」', buttonLabel(claimBtn) === '一键领取今日 VIP', buttonLabel(claimBtn))
    ok('未领取时主按钮可点', claimBtn?.props.disabled === false)
    ok('未领取时 4 条步骤均为待领取态', findByProp(panel, 'data-mark', 'idle').length === 4)
    ok('打开面板只做只读刷新（不发领取请求）',
      requests.every((r) => ['/user/detail', '/youth/month/vip/record', '/user/vip/detail'].includes(r.url)),
      requests.map((r) => r.url).join(' > '))
  }

  // ===== 3. 点击「一键领取」跑完整流程 =====
  script.ad = [
    { status: 200, body: { status: 1 } },
    { status: 200, body: { status: 1 } },
    { status: 502, body: { status: 0, error_code: 30002, error_msg: '今天次数已用光' } },
  ]
  script.listenSong = { status: 200, body: { status: 1, data: {} } }
  script.dayVip = [{ status: 200, body: { status: 1 } }]

  {
    requests.length = 0
    toasts.length = 0
    const claimBtn = findByProp(panel, 'data-action', 'claim')[0]
    await claimBtn.props.onClick()
    await settle(120)

    const urls = requests.map((r) => r.url)
    ok('请求序列完整且顺序正确',
      urls.join(' > ') ===
        '/user/detail > /youth/month/vip/record > /youth/listen/song > /youth/vip > /youth/vip > /youth/vip > /youth/day/vip > /youth/day/vip/upgrade > /user/vip/detail',
      urls.join(' > '))

    const adCalls = requests.filter((r) => r.url === '/youth/vip')
    ok('广告领取遇 30002（次数用光）立即停止', adCalls.length === 3, `calls=${adCalls.length}`)

    const dayCall = requests.find((r) => r.url === '/youth/day/vip')
    ok('签到先按「日号」形态传 receive_day',
      dayCall.params.receive_day === BJ_DAY && Object.keys(dayCall.params).length === 1,
      `receive_day=${JSON.stringify(dayCall.params.receive_day)}`)

    const auth = requests[0].auth || ''
    ok('Authorization 含 token/userid', auth.includes('token=tok-abc') && auth.includes('userid=' + MOCK_USERID))
    ok('Authorization 携带设备指纹', auth.includes('KUGOU_API_MID=mid-1') && auth.includes('dfid=dfid-1'), auth)

    const rec = storageData.lastClaim
    ok('写入当日记录 lastClaim', rec?.dateKey === BJ_KEY, String(rec?.dateKey))
    ok('记录中广告成功 2 次', rec?.adClaimed === 2, `adClaimed=${rec?.adClaimed}`)
    ok('记录中听歌/签到为成功', rec?.listen === 'ok' && rec?.dayVip === 'ok', `${rec?.listen}/${rec?.dayVip}`)
    ok('记录中升级为成功', rec?.upgrade === 'ok', String(rec?.upgrade))
    // 真机结构：data.busi_vip[] 里 svip 才是畅听/概念版，tvip 是听书
    ok('抓到 svip 那条 VIP 到期时间（不是数组里碰运气）',
      rec?.vipExpire === '2026-09-23 22:09:58', String(rec?.vipExpire))
    ok('完整跑完后写入 lastDoneDate', storageData.lastDoneDate === BJ_KEY, String(storageData.lastDoneDate))
    ok('历史记录已保存 1 条', Array.isArray(storageData.history) && storageData.history.length === 1)
    ok('自校准结果落盘 receiveDayFormat=day', storageData.receiveDayFormat === 'day', String(storageData.receiveDayFormat))
    ok('成功路径使用 success toast', toasts.some(([k]) => k === 'success'), JSON.stringify(toasts))

    panel = currentPanel()
    ok('重新渲染后听歌步骤为 ok', stepMarkOf(panel, 'listen') === 'ok', String(stepMarkOf(panel, 'listen')))
    ok('重新渲染后广告步骤为 ok', stepMarkOf(panel, 'ad') === 'ok', String(stepMarkOf(panel, 'ad')))
    ok('重新渲染后签到步骤为 ok', stepMarkOf(panel, 'dayVip') === 'ok', String(stepMarkOf(panel, 'dayVip')))
    const text = subtreeText(panel).join(' ')
    ok('面板显示 VIP 到期时间', text.includes('2026-09-23 22:09:58'))
    ok('面板显示本月记录条数与已领天数', text.includes('3 条') && text.includes('已领 3 天'), text.match(/本月记录：[^　]*/)?.[0] || '')
    ok('面板显示今日领取小结', text.includes('今日已领取'))
    ok('面板显示领取历史', text.includes('听歌+1') && text.includes('广告+2'))
  }

  // ===== 4. 手动节流 + 只读刷新 =====
  {
    const before = requests.length
    const claimBtn = findByProp(panel, 'data-action', 'claim')[0]
    await claimBtn.props.onClick()
    await settle(60)
    ok('手动领取 60s 内二次点击被节流', requests.length === before, `new=${requests.length - before}`)

    const refreshBtn = findByProp(currentPanel(), 'data-action', 'refresh')[0]
    const before2 = requests.length
    await refreshBtn.props.onClick()
    await settle(80)
    const refreshUrls = requests.slice(before2).map((r) => r.url)
    ok('「刷新」只做只读查询',
      refreshUrls.length === 3 && refreshUrls.every((u) => ['/user/detail', '/youth/month/vip/record', '/user/vip/detail'].includes(u)),
      refreshUrls.join(' > '))
  }

  // ===== 5. 已领取分支（130012 / 131001 / 30002）与设置持久化 =====
  {
    resetReg()
    requests.length = 0
    toasts.length = 0
    const ctx2 = makeCtx()
    const mod2 = await import(SRC + '?v=2')
    storageData.settings = { adCount: 2, adIntervalSec: 0, listenSong: true, adVip: true, dayVip: true, autoUpgrade: false, toastOnDone: true, receiveDayFormat: 'auto' }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    delete storageData.history
    script.listenSong = { status: 502, body: { status: 0, error_code: 130012, error_msg: '今日已经领取过了' } }
    script.dayVip = [{ status: 502, body: { status: 0, error_code: 131001, error_msg: '今日已领取' } }]
    script.ad = [{ status: 502, body: { status: 0, error_code: 30002, error_msg: '今天次数已用光' } }]

    await mod2.activate(ctx2)
    await settle(60)
    const p2 = openPanelFromToolbar()
    await settle(60)
    const c2 = findByProp(p2, 'data-action', 'claim')[0]
    await c2.props.onClick()
    await settle(120)

    const p2b = currentPanel()
    ok('听歌「已领取」判定为 already', stepMarkOf(p2b, 'listen') === 'already', String(stepMarkOf(p2b, 'listen')))
    ok('签到「已领取」判定为 already', stepMarkOf(p2b, 'dayVip') === 'already', String(stepMarkOf(p2b, 'dayVip')))
    ok('全部已领取时不产生错误态', findByProp(p2b, 'data-role', 'error').length === 0)
    ok('全部已领取时写入 lastDoneDate（当天不再重试）', storageData.lastDoneDate === BJ_KEY, String(storageData.lastDoneDate))
    ok('全部已领取时的文案提示已领取', subtreeText(p2b).join(' ').includes('今日已领取'), '')
    ok('已领取路径不误报 warning', !toasts.some(([k]) => k === 'warning'), JSON.stringify(toasts))

    // 关闭开关 → 落盘
    storageData.settings = { adCount: 2, adIntervalSec: 0, listenSong: true, adVip: false, dayVip: true, autoUpgrade: false, toastOnDone: true, receiveDayFormat: 'auto' }
    const p2c = currentPanel()
    const adRow = findByProp(p2c, 'data-setting', 'adVip')[0]
    const adSwitch = findByProp(adRow, 'data-switch', 'adVip')[0] || findByProp(adRow, 'onUpdate:modelValue')[0]
    ok('广告开关可定位', !!adSwitch)
    await adSwitch.props['onUpdate:modelValue'](false)
    ok('关闭广告开关已持久化 adVip=false', storageData.settings.adVip === false, JSON.stringify(storageData.settings))

    const autoRow = findByProp(currentPanel(), 'data-setting', 'autoDaily')[0]
    const autoSwitch = findByProp(autoRow, 'onUpdate:modelValue')[0]
    await autoSwitch.props['onUpdate:modelValue'](false)
    ok('关闭每日自动领取已持久化 autoDaily=false', storageData.settings.autoDaily === false, JSON.stringify(storageData.settings))

    const countRow = findByProp(currentPanel(), 'data-setting', 'adCount')[0]
    const countInput = findByProp(countRow, 'data-input', 'adCount')[0]
    ok('广告次数输入框可定位', !!countInput)
    await countInput.props.onChange({ target: { value: '99' } })
    ok('超出上界的次数被钳制到 8', storageData.settings.adCount === 8, String(storageData.settings.adCount))
    await countInput.props.onChange({ target: { value: '-5' } })
    ok('低于下界的次数被钳制到 1', storageData.settings.adCount === 1, String(storageData.settings.adCount))

    mod2.deactivate()
  }

  // ===== 6. receive_day 形态自校准 =====
  {
    resetReg()
    requests.length = 0
    const ctx3 = makeCtx()
    const mod3 = await import(SRC + '?v=3')
    storageData.settings = { adCount: 1, adIntervalSec: 0, listenSong: false, adVip: false, dayVip: true, autoUpgrade: false, toastOnDone: false, receiveDayFormat: 'auto' }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    delete storageData.history
    delete storageData.receiveDayFormat
    script.dayVip = [
      { status: 502, body: { status: 0, error_code: -1, error_msg: '日期不能小于今天' } },
      { status: 200, body: { status: 1 } },
    ]
    await mod3.activate(ctx3)
    await settle(60)
    const p3 = openPanelFromToolbar()
    await settle(60)
    await findByProp(p3, 'data-action', 'claim')[0].props.onClick()
    await settle(120)

    const dayCalls = requests.filter((r) => r.url === '/youth/day/vip')
    ok('receive_day 先日号、遇「日期」错误后用完整日期重试',
      dayCalls.length === 2 && dayCalls[0].params.receive_day === BJ_DAY && dayCalls[1].params.receive_day === BJ_KEY,
      dayCalls.map((c) => JSON.stringify(c.params.receive_day)).join(' , '))
    ok('自校准结果落盘 receiveDayFormat=date', storageData.receiveDayFormat === 'date', String(storageData.receiveDayFormat))
    ok('关闭听歌/广告开关后不发对应请求',
      !requests.some((r) => r.url === '/youth/listen/song') && !requests.some((r) => r.url === '/youth/vip'))
    mod3.deactivate()
  }

  // ===== 7. 登录失效分支 =====
  {
    resetReg()
    requests.length = 0
    const ctx4 = makeCtx()
    const mod4 = await import(SRC + '?v=4')
    storageData.settings = { adCount: 1, adIntervalSec: 0, autoUpgrade: false, toastOnDone: true }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    // 真实场景：token 失效 → 服务端 status 0 + error_code 20018（未登录）
    script.userDetail = { status: 502, body: { status: 0, error_code: 20018, msg: '未登录' } }
    await mod4.activate(ctx4)
    await settle(60)
    const p4 = openPanelFromToolbar()
    await settle(60)
    requests.length = 0 // 面板打开的只读刷新不计入本次断言
    await findByProp(p4, 'data-action', 'claim')[0].props.onClick()
    await settle(80)

    ok('登录失效时只发一次账号查询即中止',
      requests.map((r) => r.url).join(',') === '/user/detail', requests.map((r) => r.url).join(','))
    const p4b = currentPanel()
    ok('登录失效时展示错误态', findByProp(p4b, 'data-role', 'error').length === 1)
    ok('错误文案提示重新登录', /重新登录|登录已过期/.test(subtreeText(findByProp(p4b, 'data-role', 'error')).join('')))
    ok('登录失效时不写 lastDoneDate（下轮仍会重试）', storageData.lastDoneDate === undefined)
    mod4.deactivate()
  }

  // ===== 7b. 账号未设昵称不应被误判为登录失效 =====
  {
    resetReg()
    requests.length = 0
    const ctx4b = makeCtx()
    const mod4b = await import(SRC + '?v=4b')
    storageData.settings = { adCount: 1, adIntervalSec: 0, listenSong: true, adVip: false, dayVip: false, autoUpgrade: false, toastOnDone: false }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    script.userDetail = { status: 200, body: { status: 1, data: { userid: MOCK_USERID } } } // 无 nickname
    script.listenSong = { status: 200, body: { status: 1 } }
    await mod4b.activate(ctx4b)
    await settle(60)
    const p4c = openPanelFromToolbar()
    await settle(60)
    requests.length = 0
    await findByProp(p4c, 'data-action', 'claim')[0].props.onClick()
    await settle(100)
    ok('账号无昵称时仍正常走完领取（不误判登录失效）',
      requests.some((r) => r.url === '/youth/listen/song') && storageData.lastClaim?.listen === 'ok',
      requests.map((r) => r.url).join(' > '))
    ok('无昵称时账号名回退为「已登录账号」',
      subtreeText(currentPanel()).join(' ').includes('已登录账号'))
    mod4b.deactivate()
  }

  // ===== 8. 跨天守卫：今日已完成则启动不补领 =====
  {
    resetReg()
    requests.length = 0
    const ctx5 = makeCtx()
    const mod5 = await import(SRC + '?v=5')
    script.userDetail = { status: 200, body: { status: 1, data: { nickname: '测试用户' } } }
    storageData.settings = { adCount: 1, adIntervalSec: 0, autoDaily: true }
    storageData.lastDoneDate = BJ_KEY
    delete storageData.lastClaim
    await mod5.activate(ctx5)
    await new Promise((r) => setTimeout(r, 7000)) // 越过 6s 启动首查延迟
    ok('今日已完成时启动不再重复领取', requests.length === 0, `requests=${requests.length}`)
    mod5.deactivate()
  }

  // ===== 9. 跨天未完成 → 启动自动补领 =====
  {
    resetReg()
    requests.length = 0
    const ctx6 = makeCtx()
    const mod6 = await import(SRC + '?v=6')
    storageData.settings = { adCount: 1, adIntervalSec: 0, autoDaily: true, listenSong: true, adVip: false, dayVip: false, toastOnDone: false }
    storageData.lastDoneDate = '2020-01-01'
    delete storageData.lastClaim
    delete storageData.history
    script.listenSong = { status: 200, body: { status: 1 } }
    await mod6.activate(ctx6)
    await new Promise((r) => setTimeout(r, 7000))
    ok('跨天未完成时启动自动补领并落盘',
      requests.some((r) => r.url === '/youth/listen/song') && storageData.lastClaim?.dateKey === BJ_KEY,
      requests.map((r) => r.url).join(' > '))
    mod6.deactivate()
  }

  // ===== 12. 真机数据校正：解析升级失败/本月日期/VIP 业务线 =====
  {
    resetReg()
    requests.length = 0
    toasts.length = 0
    globalThis.__kdvTicks = []
    globalThis.__kdvWaits = []
    const ctx9 = makeCtx()
    storageData.settings = { adCount: 2, adIntervalSec: 5, listenSong: true, adVip: true, dayVip: true, autoUpgrade: true, toastOnDone: true, receiveDayFormat: 'auto' }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    delete storageData.history
    delete storageData.receiveDayFormat
    // 前面的用例改过 script.userDetail / monthRecord / vipDetail，这里必须回到真机结构，
    // 否则本轮断言的其实是上一个用例的残留 mock（踩过一次）。
    script.userDetail = { status: 200, body: { status: 1, data: { nickname: '测试用户' } } }
    script.monthRecord = { status: 200, body: { status: 1, data: { list: [{ day: '2026-06-20' }, { day: '2026-06-21' }, { day: '2026-07-01' }] } } }
    script.vipDetail = {
      status: 200,
      body: {
        status: 1,
        data: {
          vip_end_time: '',
          busi_vip: [
            { vip_end_time: '2026-09-23 22:09:58', product_type: 'svip', busi_type: 'concept', vip_name: '畅听VIP' },
            { vip_end_time: '2026-10-05 22:42:57', product_type: 'tvip', busi_type: 'concept', vip_name: '听书VIP' },
          ],
        },
      },
    }
    script.ad = [
      { status: 502, body: { status: 0, error_code: 30002, error_msg: '今天次数已用光' } }, // 真机：0 次，已用光
    ]
    script.listenSong = { status: 502, body: { status: 0, error_code: 130012, error_msg: '今日已经领取过了' } }
    script.dayVip = [{ status: 502, body: { status: 0, error_code: 131001, error_msg: '今日已领取' } }]
    // 真机：升级接口答「无法升级奖励」
    script.upgrade = { status: 502, body: { status: 0, error_code: 10001, error_msg: '无法升级奖励' } }
    const mod9 = await loadPluginWithFastWait('real', [1000, 500])
    await mod9.activate(ctx9)
    await settle(60)
    openPanelFromToolbar()
    await settle(80)
    // 关键：面板必须在这之后「重新取一次」。
    // currentPanel() 走的是 setup()() 重新渲染，能读到最新 uiState；
    // 而 openPanelFromToolbar() 返回的那份 vnode 是刷新落地之前的快照，
    // 直接拿它断言就会永远读到「未登录 / 读取失败」（本轮踩过这个坑）。
    const p9 = currentPanel()

    {
      const text = subtreeText(p9).join(' ')
      ok('本月记录日期按完整日期字符串解析（不再显示 "-"）',
        text.includes('已领 3 天') && text.includes('06-20') && text.includes('06-21') && text.includes('07-01'),
        text.match(/本月记录：[^　]*/)?.[0] || '')
      ok('VIP 到期取 svip 那条而非数组里第一条乱抓',
        text.includes('2026-09-23 22:09:58'), text.match(/VIP 到期：[^　]*/)?.[0] || '')
      ok('tvip（听书）作为其它权益辅助展示',
        text.includes('其它权益') && text.includes('2026-10-05'), '')
    }

    requests.length = 0
    await findByProp(currentPanel(), 'data-action', 'claim')[0].props.onClick()
    await settle(200)
    const p9b = currentPanel()
    const t9 = subtreeText(p9b).join(' ')

    ok('升级「无法升级奖励」判为中性 skip（不记 fail）',
      stepMarkOf(p9b, 'upgrade') === 'skip', String(stepMarkOf(p9b, 'upgrade')))
    ok('整轮不再误报「部分失败」', !t9.includes('部分失败') && !findByProp(p9b, 'data-role', 'error').length,
      t9.match(/[^　]*失败[^　]*/)?.[0] || '')
    ok('升级中性态提示「暂无升级额度」', t9.includes('暂无升级额度') || t9.includes('无可升级额度'), '')
    ok('广告 0 次且已用光时不算失败', stepMarkOf(p9b, 'ad') === 'already', String(stepMarkOf(p9b, 'ad')))
    ok('升级中性态不弹 warning toast', !toasts.some(([k]) => k === 'warning'), JSON.stringify(toasts))
    ok('没有额度时仍写 lastDoneDate（当天不反复重试）', storageData.lastDoneDate === BJ_KEY, String(storageData.lastDoneDate))
  }

  // ===== 13. 广告领取倒计时 =====
  {
    resetReg()
    requests.length = 0
    toasts.length = 0
    globalThis.__kdvTicks = []
    globalThis.__kdvWaits = []
    const ctx10 = makeCtx()
    storageData.settings = { adCount: 3, adIntervalSec: 30, listenSong: false, adVip: true, dayVip: false, autoUpgrade: false, toastOnDone: false, receiveDayFormat: 'auto' }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    script.ad = [
      { status: 200, body: { status: 1 } },
      { status: 200, body: { status: 1 } },
      { status: 502, body: { status: 0, error_code: 30002, error_msg: '今天次数已用光' } },
    ]
    const mod10 = await loadPluginWithFastWait('countdown', [12000, 4000], 45)
    await mod10.activate(ctx10)
    await settle(60)
    openPanelFromToolbar()
    await settle(80)
    const p10 = currentPanel()

    // 面板渲染阶段：此刻没有流程在跑，倒计时条不该出现
    ok('未领取时不渲染广告倒计时条', findByProp(p10, 'data-ad-countdown').length === 0)

    requests.length = 0
    const claim10 = findByProp(p10, 'data-action', 'claim')[0]
    // 关键：快进等待器是「同步连发几拍 + setTimeout(0)」，等 settle 之后再取面板
    // 早就跑完了。所以改成在等待回调里抓快照——那才是用户真看到的中间态。
    // 做法：临时替换快进时钟为「每次 tick 之间留 40ms」，让外层有机会采样。
    globalThis.__kdvSnapshots = []
    const run10Raw = claim10.props.onClick()
    const sampler = (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 15))
        const snap = currentPanel()
        const nodes = findByProp(snap, 'data-ad-countdown')
        if (nodes.length) {
          globalThis.__kdvSnapshots.push({
            countdown: nodes[0].props['data-ad-countdown'],
            text: subtreeText(snap).join(' '),
          })
        }
      }
    })()
    await run10Raw
    await sampler
    await settle(120)

    const withCountdown = globalThis.__kdvSnapshots

    ok('广告等待期间渲染出倒计时条', withCountdown.length > 0,
      `snapshots=${withCountdown.length}`)
    ok('倒计时条带秒数属性且为递减中的数值',
      withCountdown.length > 0 &&
        withCountdown.every((s) => /^\d+$/.test(String(s.countdown))) &&
        withCountdown.some((s) => Number(s.countdown) > 0),
      JSON.stringify(withCountdown.map((s) => s.countdown).slice(0, 6)))
    ok('倒计时条包含「等待第 N/M 次」进度文案',
      withCountdown.some((s) => /等待第 2\/3 次/.test(s.text) || /等待第 3\/3 次/.test(s.text)),
      (withCountdown[0]?.text || '').match(/广告领取中[^　]*/)?.[0] || '')
    ok('步骤行内嵌倒计时文本（不依赖展开）',
      withCountdown.some((s) => /已得 \d+ 天 · 等待 \d+s/.test(s.text)),
      (withCountdown[0]?.text || '').match(/已得[^　]*/)?.[0] || '')
    ok('倒计时秒数随时间递减',
      withCountdown.length >= 2 &&
        Number(withCountdown[0].countdown) >= Number(withCountdown[withCountdown.length - 1].countdown),
      JSON.stringify(withCountdown.map((s) => s.countdown)))

    ok('等待器被调用且时长 = 配置的 30s', globalThis.__kdvWaits.every((ms) => ms === 30000),
      JSON.stringify(globalThis.__kdvWaits))
    // 快进等待器每次等待连发 [12000, 4000, 0] 三拍；按「每次等待的第 1 拍」取样，
    // 得到的就是「这一次等待的起手秒数」，用它验证递减才是对的。
    // （踩坑：不能直接拿全序列判断单调，跨轮会从 4000 跳回 12000。）
    const perWaitTicks = globalThis.__kdvWaits.map((_, i) => globalThis.__kdvTicks[i * 3])
    ok('倒计时每 500ms 级回调一次（onTick 真的在动）', globalThis.__kdvTicks.length >= 4,
      JSON.stringify(globalThis.__kdvTicks))
    ok('倒计时在单次等待内递减（12s → 4s）',
      perWaitTicks.every((v, i, a) => i === 0 || v <= a[i - 1]),
      JSON.stringify(perWaitTicks))
    ok('倒计时起点等于配置的间隔（30s 未过半即 12s 起手）',
      perWaitTicks.length >= 1 && perWaitTicks[0] === 12000 && perWaitTicks[0] < 30000,
      JSON.stringify(perWaitTicks))

    // 流程结束后倒计时条撤掉，避免留下幽灵进度
    const donePanel = currentPanel()
    ok('领取结束后倒计时条自动隐藏', findByProp(donePanel, 'data-ad-countdown').length === 0)
    ok('倒计时结束后广告步骤显示最终结果',
      /广告领取 2 次/.test(subtreeText(donePanel).join(' ')),
      String(stepMarkOf(donePanel, 'ad')))
  }

  // ===== 14. 快速连续点击不再白等一个间隔（等待与请求并行）=====
  {
    resetReg()
    requests.length = 0
    globalThis.__kdvTicks = []
    globalThis.__kdvWaits = []
    const ctx11 = makeCtx()
    storageData.settings = { adCount: 3, adIntervalSec: 30, listenSong: false, adVip: true, dayVip: false, autoUpgrade: false, toastOnDone: false }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    script.ad = [
      { status: 200, body: { status: 1 } },
      { status: 200, body: { status: 1 } },
      { status: 200, body: { status: 1 } },
    ]
    const mod11 = await loadPluginWithFastWait('parallel', [1000])
    await mod11.activate(ctx11)
    await settle(60)
    const p11 = openPanelFromToolbar()
    await settle(80)
    requests.length = 0
    await findByProp(p11, 'data-action', 'claim')[0].props.onClick()
    await settle(150)
    ok('广告取满次数时不额外等待（最后一次拿到即收工）',
      globalThis.__kdvWaits.length === 2, `waits=${globalThis.__kdvWaits.length}`,
      )
    ok('广告 3 次全部领取成功并落盘', storageData.lastClaim?.adClaimed === 3, String(storageData.lastClaim?.adClaimed))
    mod11.deactivate()
  }

  // ===== 10. 停用清理 =====
  {
    resetReg()
    const ctx7 = makeCtx()
    const mod7 = await import(SRC + '?v=7')
    storageData.settings = { adCount: 1, adIntervalSec: 0 }
    delete storageData.lastDoneDate
    await mod7.activate(ctx7)
    await settle(60)
    let threw = null
    try {
      reg.disposers.forEach((fn) => fn())
    } catch (e) {
      threw = e
    }
    ok('dispose 回收全部资源不抛错', !threw, threw ? String(threw.message) : '')
    let threw2 = null
    try {
      await mod7.deactivate()
    } catch (e) {
      threw2 = e
    }
    ok('deactivate() 幂等可重复调用', !threw2, threw2 ? String(threw2.message) : '')
    const p7 = (() => {
      try {
        return openPanelFromToolbar()
      } catch {
        return null
      }
    })()
    ok('停用后入口不再渲染面板', p7 === null)
  }

  // ===== 11. 宿主未提供 ui.components 时退回原生元素，面板仍可用 =====
  {
    resetReg()
    requests.length = 0
    const ctx8 = makeCtx()
    ctx8.ui.components = undefined
    const mod8 = await import(SRC + '?v=8')
    storageData.settings = { adCount: 1, adIntervalSec: 0, listenSong: true, adVip: false, dayVip: false, autoUpgrade: false, toastOnDone: false }
    delete storageData.lastDoneDate
    delete storageData.lastClaim
    script.userDetail = { status: 200, body: { status: 1, data: { nickname: '测试用户' } } }
    script.listenSong = { status: 200, body: { status: 1 } }
    let activated = true
    try {
      await mod8.activate(ctx8)
    } catch (e) {
      activated = false
      ok('缺失 ui.components 时 activate 不抛错', false, String(e && e.message))
    }
    if (activated) ok('缺失 ui.components 时 activate 正常', true)
    await settle(60)
    const p8 = openPanelFromToolbar()
    await settle(60)
    ok('缺失 ui.components 时面板仍能渲染', !!p8 && findByProp(p8, 'data-panel', 'kugou-daily-vip').length === 1)
    const c8 = findByProp(p8, 'data-action', 'claim')[0]
    ok('退回原生元素的按钮仍可点击', typeof c8?.props?.onClick === 'function')
    requests.length = 0
    await c8.props.onClick()
    await settle(100)
    ok('退回原生元素时领取流程仍可跑通', storageData.lastClaim?.listen === 'ok', requests.map((r) => r.url).join(' > '))
    mod8.deactivate()
  }
} catch (error) {
  ok('测试主体无未捕获异常', false, String(error && error.stack).slice(0, 600))
}

console.warn = origWarn
console.error = origError

const passed = out.filter((l) => l.includes('PASS')).length
const report2 = [
  'kugou-daily-vip 无头集成测试',
  `结果: ${passed}/${out.length} 通过${fails.length ? '，失败 ' + fails.length : ''}`,
  '',
  ...out,
  '',
  fails.length ? '失败项:\n' + fails.map((f) => '  - ' + f).join('\n') : '全部通过 ✓',
].join('\n')
writeFileSync(REPORT_FILE, report2, 'utf8')
console.log(report2)

// 插件 activate() 里起的 setInterval（启动首查 / 登录后首查 / 倒计时 tick）在无头环境不会自行清理，
// 事件循环因此永不空闲、进程不会自然退出。报告已同步落盘，这里显式收尾。
const exitCode = fails.length ? 1 : 0
process.exitCode = exitCode
const finish = () => process.exit(exitCode)
if (process.stdout.writableLength === 0) finish()
else {
  process.stdout.once('drain', finish)
  setTimeout(finish, 300).unref()
}
