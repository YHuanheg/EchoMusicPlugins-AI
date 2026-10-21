/**
 * 音量记忆（bt-volume-memory）—— EchoMusic 插件
 * ============================================================================================
 * 按「音频输出设备」记住音量，设备重连时自动恢复，并弹出一个音量浮层。
 *
 * 参考实现：EarTrumpet（https://github.com/File-New-Project/EarTrumpet，MIT）的
 * 「记住蓝牙设备音量」特性。本插件复刻它的行为契约，但作用层不同 —— 见下方「与 EarTrumpet 的差异」。
 *
 * ---------------------------------------------------------------------------------------------
 * 【为什么必须带一个原生 helper】
 * EchoMusic 插件跑在渲染进程里，纯 JS 摸不到 Windows 音频端点（Core Audio 的 IAudioEndpointVolume）。
 * 宿主给插件的开进程能力只有一条窄缝：`ctx.process.launch` 只允许启动**插件目录内**的 .exe/.com，
 * 且 spawn 时是 `stdio:'ignore'` —— 拿不到 stdout。所以 helper 做成常驻进程 + 127.0.0.1 本地 HTTP，
 * 本插件通过 `ctx.net.request` 与它通信。
 *
 * 【宿主契约事实】以下全部从已安装宿主的 `resources/app.asar` 里实证挖出（不是读文档推断）：
 *   · `plugins:process:launch` → spawn(exe, args, { shell:false, stdio:'ignore', windowsHide:true })
 *     返回 `{ok, pid, executable, cwd, startedAt}`；失败 `{ok:false, error, canceled?}`
 *     - exe 必须是插件目录内的 .exe/.com（realpath 校验）
 *     - args 是字符串数组，≤64 项、单项 ≤8192 字符、不含 \0
 *     - 宿主会自动注入 `ECHOMUSIC_PLUGIN_ID` / `ECHOMUSIC_PLUGIN_DIR`
 *   · 授权按「插件ID:exe相对路径 + 插件版本 + exe sha256」记账。**升版本号或换 exe 都会重新弹窗**，
 *     弹窗按钮是 [允许并记住 / 取消]，默认停在「取消」。
 *   · `ctx.process.terminate(pid)` → `{ok, pid, terminated}`
 *   · **禁用插件不会自动杀掉子进程**（宿主的批量终止只挂在 before-quit 与插件安装/更新上）。
 *     所以本插件必须在 dispose / deactivate 时主动 POST /shutdown，helper 自己也带空闲自退兜底。
 *   · `ctx.net.request` 强制要求 `capabilities.unrestrictedNetwork`（否则报「插件未声明不受限网络能力」）；
 *     URL 只校验 protocol ∈ {http:,https:} 且不含凭据，**没有 host 白名单** → 访问 127.0.0.1 合法。
 *     默认 timeoutMs=30000、响应上限 32 MiB、每插件并发上限 64。
 *   · 能力清单是「白名单式布尔校验」：`capabilities.process` / `unrestrictedNetwork` 写错类型会被判 manifest 无效。
 *
 * ---------------------------------------------------------------------------------------------
 * 【从 EarTrumpet 逐条照搬的行为契约】（出处见 Host/CoreAudio.cs 的注释）
 *   1. 只对**蓝牙端点**生效（端点枚举器名以 BTH 开头：BTHENUM/BTHHFENUM/BTHLEENUM）；
 *      设置里可放宽到「所有输出设备」。
 *   2. 按**端点 GUID** 记账（砍掉 `{0.0.0.00000000}.` 前缀），适配器容器重建时记忆仍然有效。
 *   3. **音量 0 永不记忆** —— 很多蓝牙栈在断开过程中会把端点打到 0，记住它等于还给用户一副静音耳机。
 *   4. 拖动滑条产生的连续变化**合并成一次写**（防抖 2 s）。
 *   5. **只有「重连」才弹浮层**；首次连接（没有记忆值）与程序启动时就已经连着的设备都不弹。
 *   6. 恢复后**回读实际值**：端点可能 snap 到自己支持的档位，此时以观察到的为准。
 *   7. 设置页列出**所有记录过的设备（含当前未连接的）**，可逐条「忘记此设备」。
 *   8. 总开关关掉后**既不记忆也不恢复**（开着关会把设备当前碰巧的值覆盖掉好值）。
 *
 * 【与 EarTrumpet 的两处有意差异】
 *   · 浮层是插件内的 HTML，跟随 EchoMusic 主题；EarTrumpet 是自己画独立窗口并跟随**系统**主题 ——
 *     因为 Windows 原生音量浮层归 ShellExperienceHost 私有，第三方唤不出来，而这里宿主是 EchoMusic。
 *   · 记忆表存在 `ctx.storage`（插件私有 KV）而不是注册表/打包设置。
 * ============================================================================================
 */

const PLUGIN_ID = 'bt-volume-memory'

/** helper 相对插件目录的路径。授权弹窗按这个相对路径 + exe 哈希记账。 */
export const HELPER_RELATIVE = 'Host/VolumeHelper.exe'

const PORT_FIRST = 18790
const PORT_LAST = 18809
const POLL_MS = 1000
/** 每 N 个 tick 拉一次端点快照（1 s × 5 = 5 s） */
const ENDPOINT_REFRESH_TICKS = 5
/** 拖动滑条时的写盘/推送防抖，对应 EarTrumpet 的 SaveDelay */
const SAVE_DELAY_MS = 2000
const OSD_HIDE_MS = 2600
/** 这个窗口内到达的恢复事件原地刷新浮层而不是叠层（A2DP + 免手持会几乎同时恢复） */
const OSD_COALESCE_MS = 1500
const MIN_REMEMBERED = 1
const MAX_REMEMBERED = 100
const STORAGE_KEY = 'settings-v1'
const DEFAULT_SCOPE = 'bth'

/** helper 的 /ping 签名，用来确认端口上跑的是「本插件的 helper」而不是别的程序 */
const HELPER_SIGNATURE = 'volume-helper'

/** 模块级状态：activate 时重建，deactivate 时清空 */
let S = null
let ctxRef = null
let pollTimer = null
let saveTimer = null
let osdTimer = null
let lastOsdAt = 0
let consentCanceled = false
let disposed = false

/* ==========================================================================================
 * 工具
 * ======================================================================================== */

const clampVolume = (v) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return -1
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}

/** 越界的记忆值一律视为「不是用户的选择」（0 经常是蓝牙栈断开时打出来的） */
const isUsableMemory = (v) => Number.isFinite(v) && v >= MIN_REMEMBERED && v <= MAX_REMEMBERED

const nowIso = () => new Date().toISOString()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ==========================================================================================
 * 与 helper 的 HTTP 通信
 * ======================================================================================== */

function helperBase() {
  return 'http://127.0.0.1:' + S.helper.port
}

async function helperCall(path, { method = 'GET', form, timeoutMs = 8000 } = {}) {
  const ctx = ctxRef
  const sep = path.includes('?') ? '&' : '?'
  const url = helperBase() + path + sep + 't=' + encodeURIComponent(S.helper.token)
  const init = { url, method, responseType: 'json', timeoutMs }
  if (form) {
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    init.body = new URLSearchParams(form).toString()
  }
  const res = await ctx.net.request(init)
  // 宿主把 4xx/5xx 也正常返回（不会 reject），所以状态要自己判。
  if (!res || res.status < 200 || res.status >= 300) {
    const msg = (res && res.data && res.data.error) || ('HTTP ' + (res && res.status))
    throw new Error(msg)
  }
  return res.data || {}
}

/** 端口探测：只有带着我们 token 且签名对上的实例才算「本插件的 helper」 */
async function probePort(port, token) {
  const ctx = ctxRef
  try {
    const res = await ctx.net.request({
      url: 'http://127.0.0.1:' + port + '/ping?t=' + encodeURIComponent(token),
      method: 'GET',
      responseType: 'json',
      timeoutMs: 900
    })
    const d = res && res.data
    if (res && res.status === 200 && d && d.ok === true && d.signature === HELPER_SIGNATURE) return d
    return null
  } catch {
    return null
  }
}

/**
 * 确保 helper 在跑。
 * 顺序：① 先扫端口找已经活着的实例（插件重载/宿主重渲染时不重复拉起，也不会重复弹授权窗）
 *       ② 没有就 ctx.process.launch 拉一个
 *       ③ 等它起来（授权弹窗是同步阻塞的，所以这里给的等待窗口要够）
 */
async function ensureHelper() {
  const ctx = ctxRef
  if (!S.helper.token) S.helper.token = makeToken()

  // ① 复用已有实例
  for (let port = PORT_FIRST; port <= PORT_LAST; port++) {
    const ping = await probePort(port, S.helper.token)
    if (ping) {
      adoptHelper(ping, port)
      return true
    }
  }

  // ② 拉起
  if (typeof ctx.process?.launch !== 'function') {
    setHelperError('宿主没有提供进程 API（ctx.process.launch 不存在），无法启动 helper')
    return false
  }

  let port = PORT_FIRST
  // 端口被无关程序占用时换一个再来。每次换端口都要重新走一遍 launch（包含一次授权确认）。
  for (; port <= PORT_LAST; port++) {
    const launched = await ctx.process.launch({
      executable: HELPER_RELATIVE,
      args: [
        '--port', String(port),
        '--token', S.helper.token,
        // 空闲自退：宿主禁用插件时**不会**杀掉子进程（只有 before-quit 与安装/更新会），
        // 所以这是「插件没了但进程还在」的最后一道兜底。插件活着时每秒都会 ping 一次。
        '--idle', '20',
        '--scope', S.scope
      ]
    })

    if (!launched || launched.ok !== true) {
      if (launched && launched.canceled) {
        consentCanceled = true
        setHelperError('你取消了「允许插件启动本地程序」。音量记忆需要这个 helper 才能读写系统音频端点。')
      } else {
        setHelperError((launched && launched.error) || 'helper 启动失败')
      }
      return false
    }

    S.helper.pid = launched.pid
    S.helper.port = port

    // ③ 等它监听成功（最多 ~6 s：首次运行还要等用户点授权确认）
    for (let i = 0; i < 40; i++) {
      const ping = await probePort(port, S.helper.token)
      if (ping) {
        adoptHelper(ping, port)
        return true
      }
      await sleep(150)
    }

    // 起来了但没监听 → 大概率端口被别的程序占了，换一个端口重来
    try {
      await ctx.process.terminate(launched.pid)
    } catch {
      /* 尽力而为 */
    }
    S.helper.pid = 0
  }

  setHelperError('找不到可用端口（' + PORT_FIRST + '–' + PORT_LAST + ' 都被占用）')
  return false
}

function adoptHelper(ping, port) {
  S.helper.port = port
  S.helper.pid = ping.pid || 0
  S.helper.version = ping.version || ''
  S.helper.coreAudioOk = ping.coreAudioOk === true
  S.helper.coreAudioError = ping.coreAudioError || ''
  S.helper.state = 'running'
  S.helper.error = S.helper.coreAudioOk ? '' : ('helper 起来了但读不到音频端点：' + (ping.coreAudioError || '未知原因'))
}

function makeToken() {
  // 只做本机回环的身份标识，不做密码学用途；用 crypto 有就用，没有就退到随机串。
  try {
    if (globalThis.crypto?.getRandomValues) {
      const a = new Uint8Array(16)
      globalThis.crypto.getRandomValues(a)
      return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    /* 落到下面 */
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function setHelperError(message) {
  if (!S) return
  S.helper.state = 'error'
  S.helper.error = message
}

async function stopHelper() {
  if (!S || S.helper.state !== 'running' || !S.helper.port) return
  try {
    await helperCall('/shutdown', { method: 'POST', timeoutMs: 1500 })
  } catch {
    /* helper 可能已经自己退了，无所谓 */
  }
  // 兜底：万一 /shutdown 没走到（比如端口已失效），再显式 kill 一次 pid
  const pid = S.helper.pid
  if (pid && typeof ctxRef?.process?.terminate === 'function') {
    try {
      await ctxRef.process.terminate(pid)
    } catch {
      /* 已经被宿主的 before-quit 收走了 */
    }
  }
  S.helper.state = 'stopped'
  S.helper.pid = 0
  S.helper.port = 0
}

/* ==========================================================================================
 * 配置下发 / 记忆表
 * ======================================================================================== */

/** 记忆表的线上编码：`{guid}:40;{guid2}:55`（记账键里不含 ':' 与 ';'） */
function encodeMemories() {
  return Object.entries(S.memories)
    .filter(([, m]) => isUsableMemory(m.volume))
    .map(([key, m]) => key + ':' + m.volume)
    .join(';')
}

async function pushConfig({ reset = false } = {}) {
  if (S.helper.state !== 'running') return
  try {
    await helperCall('/config', {
      method: 'POST',
      form: {
        enabled: S.enabled ? '1' : '0',
        scope: S.scope,
        memReset: reset ? '1' : '0',
        mems: encodeMemories()
      }
    })
  } catch (e) {
    S.helper.error = '下发配置失败：' + e.message
  }
}

/** 拖动滑条会一路改值，合并成一次写盘 + 一次下发（EarTrumpet 的 SaveDelay 语义） */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    saveTimer = null
    persist()
    await pushConfig()
  }, SAVE_DELAY_MS)
}

function persist() {
  if (!ctxRef) return
  try {
    ctxRef.storage.set(STORAGE_KEY, {
      enabled: S.enabled,
      scope: S.scope,
      memories: S.memories,
      // token 必须落盘：helper 用它对回环请求做鉴权与**身份识别**。
      // 每次 activate 重新生成的话，插件重载后就认不出自己刚拉起的 helper，
      // 会在下一个端口再起一个，第一个变成孤儿进程。
      // 它只是本机回环的身份标志，不是任何外部服务的凭证。
      helperToken: S.helper.token
    })
  } catch (e) {
    S.helper.error = '保存设置失败：' + (e && e.message ? e.message : String(e))
  }
}

function loadSettings(ctx) {
  const raw = ctx.storage.get(STORAGE_KEY)
  const st = raw && typeof raw === 'object' ? raw : {}
  const memories = {}
  if (st.memories && typeof st.memories === 'object') {
    // 读的时候就把不可用记录滤掉：越界值是被写坏的记录，不是用户的选择。
    for (const [key, m] of Object.entries(st.memories)) {
      if (m && isUsableMemory(Number(m.volume))) {
        memories[key] = {
          volume: Math.round(Number(m.volume)),
          name: String(m.name || ''),
          enumerator: String(m.enumerator || ''),
          isBluetooth: m.isBluetooth === true,
          lastSeenAt: String(m.lastSeenAt || '')
        }
      }
    }
  }
  return {
    enabled: st.enabled !== false,          // 默认开
    scope: st.scope === 'all' ? 'all' : DEFAULT_SCOPE,
    memories,
    helperToken: typeof st.helperToken === 'string' ? st.helperToken : ''
  }
}

/**
 * 学到一个音量。这就是「记忆」的产生点：
 * 用户（或任何别的程序）改了某个受监视端点的音量 → helper 报事件 → 我们记下来。
 */
function rememberVolume(key, volume, meta) {
  const raw = Number(volume)
  // 0 与越界值一律不算「用户的选择」，**直接丢弃而不是 clamp**：
  //   · 蓝牙栈在断开过程中常把端点打到 0，记住它等于还用户一副静音耳机；
  //   · 越界上报只可能是坏数据，clamp 成 100 会让下次重连直接炸到满音量，比不记更糟。
  if (!isUsableMemory(raw)) return false
  const v = Math.round(raw)

  const prev = S.memories[key]
  const next = {
    volume: v,
    name: (meta && meta.name) || (prev && prev.name) || '',
    enumerator: (meta && meta.enumerator) || (prev && prev.enumerator) || '',
    isBluetooth: meta && meta.isBluetooth !== undefined
      ? meta.isBluetooth === true
      : prev
        ? prev.isBluetooth
        : true,
    lastSeenAt: nowIso()
  }
  S.memories[key] = next
  return !prev || prev.volume !== v
}

/** 端点快照按记账键建索引，供事件处理时补名称/类型 */
function endpointIndex() {
  const map = {}
  for (const e of S.endpoints || []) map[e.key] = e
  return map
}

/* ==========================================================================================
 * 事件轮询
 * ======================================================================================== */

async function pollOnce() {
  if (disposed || !S || S.helper.state !== 'running') return
  S.tick++

  let data
  try {
    data = await helperCall('/events', { timeoutMs: 4000 })
  } catch (e) {
    S.helper.error = '与 helper 通信失败：' + e.message
    // 端口还在但探测不到了 → 认为 helper 挂了，让 UI 能提示并允许手动重启
    const ping = await probePort(S.helper.port, S.helper.token)
    if (!ping) {
      S.helper.state = 'error'
      S.helper.error = 'helper 已停止响应（' + e.message + '）'
    }
    return
  }

  S.helper.error = ''
  const index = endpointIndex()

  // ① 重连恢复：helper 已经把音量写回去了，我们负责「把浮层弹出来」+ 按实际生效值更新记忆。
  for (const ev of data.restoredEvents || []) {
    if (ev.announce === true) showOsd({
      key: ev.key,
      name: ev.name,
      isBluetooth: ev.isBluetooth === true,
      volume: ev.appliedVolume,
      muted: ev.muted === true,
      previous: ev.previousVolume
    })
    // 端点可能 snap 到别的档位，以 helper 观察到的为准
    rememberVolume(ev.key, ev.appliedVolume, {
      name: ev.name,
      enumerator: ev.enumerator,
      isBluetooth: ev.isBluetooth
    })
  }

  // ② 用户改音量 → 记忆
  let learned = false
  for (const ev of data.volumeEvents || []) {
    const meta = index[ev.key]
    if (rememberVolume(ev.key, ev.volume, meta)) learned = true
    else if (S.memories[ev.key] && meta) S.memories[ev.key].lastSeenAt = nowIso()
  }

  // ③ 端点增删：顺便把设备名/类型这些元信息补齐（离线设备靠这份元信息在设置页里显示）
  for (const ev of data.deviceEvents || []) {
    if (ev.kind === 'added' && ev.endpoint) {
      const m = S.memories[ev.key]
      if (m) {
        m.name = ev.endpoint.name || m.name
        m.enumerator = ev.endpoint.enumerator || m.enumerator
        m.isBluetooth = ev.endpoint.isBluetooth === true
        m.lastSeenAt = nowIso()
      }
    }
    if (ev.kind === 'removed') {
      const m = S.memories[ev.key]
      if (m) m.lastSeenAt = nowIso()
      S.endpoints = (S.endpoints || []).filter((e) => e.key !== ev.key)
    }
  }

  const needPush = (data.restoredEvents || []).length > 0
  if (needPush) {
    // 恢复产生的「实际生效值」很重要（下次要按它恢复），所以立刻落盘，不走防抖
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    persist()
    await pushConfig()
  } else if (learned) {
    scheduleSave()
  }

  // ④ 周期性刷新端点快照（设置页要用）
  if (S.tick % ENDPOINT_REFRESH_TICKS === 0) await refreshEndpoints()
}

async function refreshEndpoints() {
  if (!S || S.helper.state !== 'running') return
  try {
    const data = await helperCall('/endpoints', { timeoutMs: 4000 })
    S.endpoints = Array.isArray(data.endpoints) ? data.endpoints : []
    S.helper.coreAudioOk = true
    // 顺手把元信息补进记忆表（设备名可能在系统里被改过）
    for (const e of S.endpoints) {
      const m = S.memories[e.key]
      if (m) {
        m.name = e.name || m.name
        m.enumerator = e.enumerator || m.enumerator
        m.isBluetooth = e.isBluetooth === true
      }
    }
  } catch (e) {
    S.helper.error = '读取端点失败：' + e.message
  }
}

/* ==========================================================================================
 * 音量浮层（OSD）
 * ======================================================================================== */

/**
 * 这个窗口内到达的第二次恢复视为「同一次重连的另一半」（蓝牙耳机常同时有 A2DP 与
 * 免手持两个端点）→ 原地刷新，不叠层。
 */
function showOsd(payload) {
  const now = Date.now()
  const coalesce = now - lastOsdAt < OSD_COALESCE_MS
  lastOsdAt = now

  S.osd.name = payload.name || ''
  S.osd.isBluetooth = payload.isBluetooth === true
  S.osd.volume = clampVolume(payload.volume)
  S.osd.muted = payload.muted === true
  S.osd.previous = coalesce ? S.osd.previous : payload.previous
  S.osd.key = payload.key || ''
  S.osd.count = coalesce ? S.osd.count + 1 : 1
  S.osd.visible = true

  if (osdTimer) clearTimeout(osdTimer)
  osdTimer = setTimeout(() => {
    osdTimer = null
    if (S) S.osd.visible = false
  }, OSD_HIDE_MS)
}

/* ==========================================================================================
 * UI
 * ======================================================================================== */

const h = (...a) => ctxRef.vue.h(...a)

/** 取宿主组件；宿主没提供（或在测试里）就退到一个朴素替身，保证 UI 不炸。 */
function hostComponent(name, fallback) {
  const src = ctxRef.ui?.components?.[name]
  if (!src) return fallback
  return ctxRef.vue.defineAsyncComponent(src)
}

function makeSwitch() {
  return hostComponent('Switch', (props) => {
    return h('button', {
      type: 'button',
      disabled: props.disabled,
      onClick: () => props.onChange && props.onChange(!props.modelValue),
      style: switchStyle(!!props.modelValue)
    }, props.modelValue ? '开' : '关')
  })
}

function switchStyle(on) {
  return {
    minWidth: '46px',
    padding: '3px 10px',
    borderRadius: '11px',
    border: '1px solid rgba(127,127,127,.45)',
    background: on ? 'rgba(64,158,255,.28)' : 'rgba(127,127,127,.14)',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
    lineHeight: '16px'
  }
}

function makeSelect() {
  return hostComponent('Select', (props) => {
    return h('select', {
      value: props.modelValue,
      disabled: props.disabled,
      onChange: (e) => props.onChange && props.onChange(e.target.value),
      style: {
        padding: '3px 6px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.45)',
        background: 'rgba(127,127,127,.10)',
        color: 'inherit',
        fontSize: '12px'
      }
    }, (props.options || []).map((o) => h('option', { value: o.value }, o.label)))
  })
}

function makeButton() {
  return hostComponent('Button', (props) => {
    return h('button', {
      type: 'button',
      disabled: props.disabled,
      onClick: () => props.onClick && props.onClick(),
      style: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.45)',
        background: 'rgba(127,127,127,.10)',
        color: 'inherit',
        cursor: props.disabled ? 'default' : 'pointer',
        fontSize: '12px'
      }
    }, props.label)
  })
}

function formatSeen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  return sameDay ? ('今天 ' + hm) : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
}

function deviceTypeLabel(m) {
  const e = String(m.enumerator || '').toUpperCase()
  if (e.startsWith('BTHENUM')) return '蓝牙 · 立体声'
  if (e.startsWith('BTHHFENUM')) return '蓝牙 · 免手持'
  if (e.startsWith('BTHLEENUM')) return '蓝牙 · LE Audio'
  if (e.startsWith('BTH')) return '蓝牙'
  if (e.startsWith('USB')) return 'USB'
  if (e.startsWith('HDAUDIO')) return '板载/HDMI'
  return e || '未知'
}

/** 设置页：设备清单 + 开关 + helper 状态 */
function makeDevicePage() {
  const Switch = makeSwitch()
  const Select = makeSelect()
  const Button = makeButton()

  return ctxRef.vue.defineComponent({
    name: 'BtVolumeMemoryPage',
    setup() {
      const scopeOptions = [
        { value: 'bth', label: '仅蓝牙设备（推荐）' },
        { value: 'all', label: '所有输出设备' }
      ]

      const rows = ctxRef.vue.computed(() => {
        const index = endpointIndex()
        const keys = new Set([...Object.keys(S.memories), ...Object.keys(index)])
        return [...keys]
          .map((key) => {
            const m = S.memories[key]
            const live = index[key]
            return {
              key,
              name: (live && live.name) || (m && m.name) || '（未知设备）',
              remembered: m ? m.volume : null,
              current: live ? live.volume : null,
              muted: live ? live.muted === true : false,
              connected: !!live,
              type: deviceTypeLabel(m || (live ? { enumerator: live.enumerator } : {})),
              isBluetooth: live ? live.isBluetooth === true : (m ? m.isBluetooth : false),
              lastSeenAt: m ? m.lastSeenAt : ''
            }
          })
          .sort((a, b) => (Number(b.connected) - Number(a.connected)) || a.name.localeCompare(b.name))
      })

      const onToggleEnabled = async (v) => {
        S.enabled = !!v
        persist()
        await pushConfig()
        // 关掉开关时也把 helper 里的记忆表清掉，保证「关了就是完全不恢复」
        if (!S.enabled) await pushConfig({ reset: true })
      }

      const onScopeChange = async (v) => {
        S.scope = v === 'all' ? 'all' : DEFAULT_SCOPE
        persist()
        S.endpoints = []
        await pushConfig()
        await refreshEndpoints()
      }

      const onForget = async (key) => {
        delete S.memories[key]
        persist()
        if (S.helper.state === 'running') {
          try {
            await helperCall('/forget', { method: 'POST', form: { key } })
          } catch (e) {
            S.helper.error = '忘记设备失败：' + e.message
          }
        }
        await pushConfig()
      }

      const onForgetAll = async () => {
        S.memories = {}
        persist()
        await pushConfig({ reset: true })
      }

      const onRestartHelper = async () => {
        consentCanceled = false
        if (S.helper.state === 'running') await stopHelper()
        S.helper.error = ''
        const ok = await ensureHelper()
        if (ok) {
          await pushConfig({ reset: true })
          await refreshEndpoints()
        }
      }

      const onRefresh = async () => {
        await refreshEndpoints()
      }

      const onPreviewOsd = () => {
        showOsd({
          key: '__preview__',
          name: '预览：蓝牙耳机',
          isBluetooth: true,
          volume: S.osd.volume || 66,
          muted: false,
          previous: null
        })
      }

      return () => {
        const helper = S.helper
        const statusText = {
          idle: '未启动',
          running: helper.coreAudioOk ? '运行中' : '运行中（Core Audio 不可用）',
          error: '异常',
          stopped: '已停止'
        }[helper.state] || helper.state

        return h('div', { style: { padding: '16px 20px', fontSize: '13px', lineHeight: '1.7' } }, [
          h('div', { style: { marginBottom: '6px', fontSize: '15px', fontWeight: '600' } }, '音量记忆'),

          h('div', {
            style: { opacity: '.72', marginBottom: '14px' }
          }, S.scope === 'bth'
            ? '按每个蓝牙输出设备记住音量。耳机断开重连时自动回到你上次设置的音量 —— 蓝牙耳机重连后音量常常被系统重置成一个很大的值。'
            : '按每个输出设备记住音量（当前已放宽到所有输出设备）。'),

          // 总开关
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 12px', borderRadius: '8px', background: 'rgba(127,127,127,.08)',
              marginBottom: '10px'
            }
          }, [
            h('div', { style: { flex: '1' } }, [
              h('div', null, '记住设备音量'),
              h('div', { style: { opacity: '.62', fontSize: '12px' } }, '关掉后既不记忆也不恢复（不会覆盖已记录的值）')
            ]),
            h(Switch, {
              modelValue: S.enabled,
              onChange: onToggleEnabled,
              disabled: helper.state !== 'running'
            })
          ]),

          // 作用范围
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 12px', borderRadius: '8px', background: 'rgba(127,127,127,.08)',
              marginBottom: '10px'
            }
          }, [
            h('div', { style: { flex: '1' } }, [
              h('div', null, '作用范围'),
              h('div', { style: { opacity: '.62', fontSize: '12px' } }, '默认只处理蓝牙设备，与 EarTrumpet 的行为一致')
            ]),
            h(Select, {
              modelValue: S.scope,
              options: scopeOptions,
              onChange: onScopeChange,
              disabled: helper.state !== 'running'
            })
          ]),

          // helper 状态
          h('div', {
            style: {
              padding: '10px 12px', borderRadius: '8px',
              background: helper.state === 'error' ? 'rgba(255,120,120,.12)' : 'rgba(127,127,127,.08)',
              marginBottom: '14px'
            }
          }, [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
              h('span', { style: { opacity: '.7' } }, '本地服务：'),
              h('span', null, statusText + (helper.version ? ' v' + helper.version : '')),
              helper.port ? h('span', { style: { opacity: '.55' } }, '· 127.0.0.1:' + helper.port) : null,
              helper.pid ? h('span', { style: { opacity: '.55' } }, '· pid ' + helper.pid) : null
            ]),
            helper.error
              ? h('div', { style: { marginTop: '6px' } }, [
                h('span', { style: { color: '#e57373' } }, helper.error),
                h('div', { style: { marginTop: '8px', display: 'flex', gap: '8px' } }, [
                  h(Button, { label: consentCanceled ? '重新授权并启动' : '重试启动', onClick: onRestartHelper })
                ])
              ])
              : null
          ]),

          // 工具条
          h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } }, [
            h(Button, { label: '刷新设备列表', onClick: onRefresh, disabled: helper.state !== 'running' }),
            h(Button, { label: '预览音量浮层', onClick: onPreviewOsd }),
            h(Button, { label: '重启本地服务', onClick: onRestartHelper }),
            Object.keys(S.memories).length
              ? h(Button, { label: '清空全部记录', onClick: onForgetAll })
              : null
          ]),

          // 设备清单
          h('div', { style: { opacity: '.7', margin: '4px 0 6px' } },
            '设备记录（含当前未连接的设备，共 ' + Object.keys(S.memories).length + ' 条）'),

          rows.value.length === 0
            ? h('div', {
              style: {
                padding: '18px', textAlign: 'center', opacity: '.55',
                border: '1px dashed rgba(127,127,127,.4)', borderRadius: '8px'
              }
            }, helper.state === 'running'
              ? '还没有记录。用音量键或系统音量条调整一次耳机音量就会记录下来。'
              : '本地服务未运行，无法读取设备。')
            : h('div', { style: { border: '1px solid rgba(127,127,127,.22)', borderRadius: '8px', overflow: 'hidden' } }, [
              h('div', {
                style: {
                  display: 'grid',
                  gridTemplateColumns: '1fr 84px 84px 88px 108px 76px',
                  gap: '8px', padding: '8px 12px',
                  background: 'rgba(127,127,127,.10)', fontWeight: '600', fontSize: '12px'
                }
              }, ['设备', '记忆', '当前', '类型', '上次见到', '']),
              ...rows.value.map((r) => h('div', {
                key: r.key,
                style: {
                  display: 'grid',
                  gridTemplateColumns: '1fr 84px 84px 88px 108px 76px',
                  gap: '8px', padding: '8px 12px', alignItems: 'center',
                  borderTop: '1px solid rgba(127,127,127,.14)'
                }
              }, [
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: '0' } }, [
                  h('span', {
                    title: r.isBluetooth ? '蓝牙设备' : '有线设备',
                    style: { opacity: r.isBluetooth ? '1' : '.45', fontSize: '12px' }
                  }, r.isBluetooth ? '🔵' : '⚪'),
                  h('span', {
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                  }, r.name),
                  r.connected
                    ? h('span', { style: { opacity: '.5', fontSize: '11px' } }, '已连接')
                    : h('span', { style: { opacity: '.45', fontSize: '11px' } }, '未连接')
                ]),
                h('div', null, r.remembered == null ? '—' : r.remembered + '%'),
                h('div', null, r.current == null ? '—' : (r.current + '%' + (r.muted ? ' 静音' : ''))),
                h('div', { style: { fontSize: '12px', opacity: '.75' } }, r.type),
                h('div', { style: { fontSize: '12px', opacity: '.75' } }, formatSeen(r.lastSeenAt)),
                h(Button, { label: '忘记', onClick: () => onForget(r.key) })
              ]))
            ]),

          h('div', { style: { marginTop: '14px', opacity: '.5', fontSize: '12px' } },
            '音量由插件目录内的 Host/VolumeHelper.exe 读写（首次启动需要你确认一次授权）。helper 只监听 127.0.0.1，不联网、不写注册表、不开机自启。')
        ])
      }
    }
  })
}

/** 音量浮层：插件内 HTML，跟随 EchoMusic 主题 */
function makeOsdComponent() {
  return ctxRef.vue.defineComponent({
    name: 'BtVolumeOsd',
    setup() {
      return () => {
        if (!S.osd.visible) return null
        const pct = S.osd.volume
        // 明暗两套配色：宿主是浅色主题时不能贴一块黑玻璃上去
        const dark = S.osd.dark !== false
        const fg = dark ? '#fff' : '#1b1b1f'
        const track = dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.14)'
        const surface = dark ? 'rgba(28,28,30,.86)' : 'rgba(250,250,252,.94)'
        const shadow = dark ? 'rgba(0,0,0,.35)' : 'rgba(0,0,0,.16)'
        return h('div', {
          style: {
            position: 'fixed',
            left: '50%',
            bottom: '96px',
            transform: 'translateX(-50%)',
            zIndex: '9999',
            minWidth: '232px',
            padding: '14px 18px',
            borderRadius: '14px',
            background: surface,
            color: fg,
            boxShadow: '0 10px 30px ' + shadow,
            backdropFilter: 'blur(12px)',
            fontFamily: 'inherit',
            pointerEvents: 'none',
            transition: 'opacity .18s ease'
          }
        }, [
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '13px' }
          }, [
            h('span', { style: { fontSize: '14px' } }, S.osd.isBluetooth ? '🔵' : '🔊'),
            h('span', {
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '190px' }
            }, S.osd.name || '设备音量'),
            h('span', { style: { marginLeft: 'auto', opacity: '.85', fontVariantNumeric: 'tabular-nums' } }, pct + '%')
          ]),
          h('div', {
            style: {
              height: '6px', borderRadius: '3px', background: track, overflow: 'hidden'
            }
          }, [
            h('div', {
              style: {
                width: pct + '%', height: '100%', borderRadius: '3px',
                background: S.osd.muted ? (dark ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.3)') : fg,
                transition: 'width .16s ease'
              }
            })
          ]),
          h('div', { style: { marginTop: '8px', fontSize: '11px', opacity: '.68' } },
            S.osd.muted
              ? '已静音'
              : (S.osd.previous != null && S.osd.previous !== pct
                ? '已恢复记忆音量：' + S.osd.previous + '% → ' + pct + '%'
                : '已恢复记忆音量'))
        ])
      }
    }
  })
}

/* ==========================================================================================
 * 入口
 * ======================================================================================== */

export async function activate(ctx) {
  ctxRef = ctx
  disposed = false
  consentCanceled = false

  const settings = loadSettings(ctx)
  const tokenWasGenerated = !settings.helperToken
  S = ctx.vue.reactive({
    enabled: settings.enabled,
    scope: settings.scope,
    memories: settings.memories,
    endpoints: [],
    tick: 0,
    helper: {
      state: 'idle',
      pid: 0,
      port: 0,
      // 复用上次的 token：helper 靠它认「这是本插件的请求」，也靠它认「这是本插件的实例」
      token: settings.helperToken || makeToken(),
      version: '',
      coreAudioOk: false,
      coreAudioError: '',
      error: ''
    },
    osd: { visible: false, name: '', isBluetooth: false, volume: 0, muted: false, previous: null, key: '', count: 0, dark: true }
  })
  // 新生成的 token 立刻落盘，否则插件一重载就认不出自己拉起的 helper
  if (tokenWasGenerated) persist()

  // 主题化：浮层跟随宿主的明暗主题（宿主是浅色主题时不要往界面上贴一块黑玻璃）。
  S.osd.dark = true
  try {
    const snap = ctx.appearance?.getSnapshot?.()
    if (snap) S.osd.dark = snap.isDark !== false
    if (typeof ctx.appearance?.onSnapshot === 'function') {
      ctx.dispose(ctx.appearance.onSnapshot((next) => {
        if (S && next) S.osd.dark = next.isDark !== false
      }))
    }
  } catch {
    /* 拿不到主题就按深色渲染 */
  }

  // 页面 + 入口 + 浮层
  ctx.ui.addPage({
    id: 'devices',
    title: '音量记忆',
    icon: 'tabler:device-speaker',
    component: makeDevicePage()
  })
  ctx.ui.sidebar.addItem({
    id: 'devices',
    title: '音量记忆',
    icon: 'tabler:device-speaker',
    section: 'plugins',
    sectionTitle: '插件',
    order: 60,
    pageId: 'devices'
  })

  try {
    const host = (globalThis.document && globalThis.document.body) || null
    if (host) ctx.ui.mount(host, makeOsdComponent())
  } catch {
    /* 浮层挂不上不影响核心功能 */
  }

  // 启动 helper 并下发配置
  const ok = await ensureHelper()
  if (ok) {
    await pushConfig({ reset: true })
    await refreshEndpoints()
  } else {
    ctx.toast.warning('音量记忆：本地服务未启动，功能暂不可用')
  }

  // 事件轮询
  pollTimer = setInterval(() => {
    pollOnce().catch(() => {})
  }, POLL_MS)

  const cleanup = async () => {
    if (disposed) return
    disposed = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (osdTimer) {
      clearTimeout(osdTimer)
      osdTimer = null
    }
    persist()
    await stopHelper()
  }
  ctx.dispose(() => {
    void cleanup()
  })

  return {
    // 供测试与排查使用
    get state() {
      return S
    }
  }
}

export async function deactivate() {
  disposed = true
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (osdTimer) {
    clearTimeout(osdTimer)
    osdTimer = null
  }
  try {
    await stopHelper()
  } catch {
    /* 尽力而为 */
  }
  S = null
  ctxRef = null
}

/** 给测试与变异套件用的内部钩子（宿主不会调用） */
export const __internals = {
  get state() {
    return S
  },
  pollOnce,
  refreshEndpoints,
  pushConfig,
  rememberVolume,
  showOsd,
  ensureHelper,
  stopHelper,
  loadSettings,
  encodeMemories,
  isUsableMemory,
  deviceTypeLabel,
  helperRelative: HELPER_RELATIVE
}
