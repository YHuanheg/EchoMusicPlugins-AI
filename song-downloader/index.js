/**
 * 歌曲下载 (song-downloader) —— EchoMusic 插件
 * ===========================================================================
 * 把「当前播放」或「播放队列」里的歌下载到本地。四条技术线必须先讲清楚，
 * 因为它们的边界直接决定了插件能做到什么、做不到什么：
 *
 * ① 取播放地址：走宿主内置的酷狗本地路由（主进程 KuGouMusicApi），插件不实现签名。
 *      ctx.electron.api.request({ method, url: '/song/url', params: {...} })
 *      → { status, body, cookie, headers }
 *    宿主实现要点（app.asar 逐字节核验）：
 *      - `method` 被完全忽略，模块自己决定上游方法；上游业务错误映射成
 *        **HTTP 502 + 顶层 error_code**，不抛异常（4xx/5xx 也照常 resolve）；
 *      - params 里除 cookie 外会平铺进模块参数，数字会被 String() 化；
 *      - 路由 = 模块文件名去掉 .js 并把 `_` 换成 `/`：song_url.js → /song/url。
 *
 * ② 音质与 hash：完全对齐宿主 PlayerResolver 的算法
 *      - 可用音质来自 track.relateGoods（= /privilege/lite 的条目，宿主会写回轨道上），
 *        匹配表：320/hq/level4、flac/sq/level5、high/hires/level6、viper_tape/level101；
 *      - **每种音质对应不同的 hash**，取地址必须用该音质自己的 hash，否则拿到的是别的文件；
 *      - 目标音质不可用时逐级降级（flac → 320 → 128）；
 *      - 128 必须用轨道主 hash —— qualityMatch(entry,'128') 恒为 true，
 *        直接 find 会命中数组第一条（可能是 flac 那条），拿到错误的音频。
 *
 * ③ 落盘：宿主**没有**给插件「写到任意目录」的能力，三条路都被堵死
 *      - ctx.fs.writeFile：路径被硬限制在插件目录内（ip() 里 resolve + relative 校验），
 *        且单次写入上限 8 MB（writePluginFile 的 uf 常量）；
 *      - ctx.process.launch：只允许启动「插件目录内的 .exe/.com」，且每次弹窗授权；
 *      - 主进程没有注册 will-download / setDownloadPath，也没有给插件暴露保存对话框。
 *    所以主通道是 Chromium 自身的下载行为：Blob + <a download>，落到**系统默认下载目录**；
 *    若宿主内核支持 File System Access API，再额外给一个「另存为…」按钮（可选任意位置）。
 *
 * ④ 进度：ctx.net.request 没有字节回调，所以默认用 Range 分片（1 MiB/片）自建进度与速度；
 *    服务端忽略 Range（回 200 并给整包）时自动退回一次性下载。
 *    注意 `maxResponseBytes` 必须显式传 0（= 不限制），否则默认 32 MiB 会把大 FLAC 截断。
 *
 * 取消：不向宿主传 AbortSignal（要跨 IPC 序列化，风险大于收益），改为在分片之间检查标志，
 *      因此「停止」的生效粒度是「当前分片下载完」。
 */

const PLUGIN_ID = 'song-downloader'

const KEY_SETTINGS = 'settings'
const KEY_HISTORY = 'history'

/** 音质阶梯：低 → 高（与宿主 Us 常量一致） */
const QUALITY_LADDER = ['128', '320', 'flac', 'high', 'viper_tape']

const QUALITY_LABEL = {
  '128': '128K',
  '320': '320K',
  flac: 'FLAC',
  high: 'Hi-Res',
  viper_tape: '母带'
}

/** 粗略码率（kbps），仅用于「是不是只有试听片段」的估算 */
const QUALITY_BITRATE = { '128': 128, '320': 320, flac: 900, high: 1200, viper_tape: 1300 }

const EXT_MIME = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  ape: 'audio/x-ape',
  wav: 'audio/wav',
  wv: 'audio/x-wavpack',
  dff: 'audio/x-dff',
  dsf: 'audio/x-dsf'
}

const AUDIO_EXT = Object.keys(EXT_MIME)
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']

/** 上游错误码 → 人类可读文案（只列与本插件强相关的） */
const ERROR_TEXT = {
  20010: '上游拒绝了该请求（参数或权限不符）',
  20018: '登录状态无效，请在宿主里重新登录',
  20028: '账号触发风控，需要安全验证',
  21001: '接口参数有误',
  30002: '该次数已用光',
  51002: '登录状态无效，请在宿主里重新登录'
}

const SONG_URL_TIMEOUT_MS = 15000
const PROBE_TIMEOUT_MS = 20000
const FILE_TIMEOUT_MS = 600000

const MIN_CHUNK_BYTES = 256 * 1024
const MAX_CHUNK_BYTES = 8 * 1024 * 1024

const MAX_HISTORY = 200
const MAX_TASKS = 400
const MAX_FILE_BYTES = 1024 * 1024 * 1024 // 单文件上限 1 GiB，防止误点把内存吃光

const DEFAULT_SETTINGS = {
  quality: 'auto', // auto | 128 | 320 | flac | high | viper_tape
  saveMode: 'direct', // direct（系统下载目录）| ask（单曲弹另存为对话框）
  confirmBeforeDownload: true, // 下载前弹确认框（可改音质/保存位置/文件名）
  fileNameTemplate: '{artist} - {name}',
  chunked: true, // Range 分片下载（能显示真实进度与速度）
  chunkSizeMb: 1,
  maxRetries: 1, // 每个分片/整包的重试次数
  concurrency: 1, // 同时下载几首（1~2，默认 1，对上游克制）
  toastOnDone: true,
  sidebarEntry: true,
  toolbarEntry: false,
  playerBarButton: true, // 播放栏右侧的下载按钮
  debug: false
}

/* ========================================================================== *
 * 通用工具
 * ========================================================================== */

function isObj(v) {
  return !!v && typeof v === 'object'
}

function str(v) {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n, min, max) {
  const v = num(n, min)
  return Math.min(max, Math.max(min, v))
}

/** 点号路径取值，任意一层缺失都安全返回 undefined */
function pathGet(obj, path) {
  const parts = String(path).split('.')
  let cur = obj
  for (const p of parts) {
    if (!isObj(cur)) return undefined
    cur = cur[p]
  }
  return cur
}

/** 按候选路径依次取第一个「有值」的字段 */
function firstOf(obj, paths) {
  if (!isObj(obj)) return undefined
  for (const p of paths) {
    const v = pathGet(obj, p)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * 限深 BFS 按候选键名找第一个非空标量。
 * 对外只暴露两个参数，递归深度是内部状态 —— 本仓库踩过的坑：
 * `deepFind(body, keys, "")` 把 fallback 传成了 depth，导致深层字段静默查不到。
 */
function findFieldDeep(obj, keys) {
  return findFieldDeepAt(obj, keys, 3, 120)
}

function findFieldDeepAt(obj, keys, depth, budget) {
  if (!isObj(obj) || depth < 0) return undefined
  const queue = [{ node: obj, d: 0 }]
  let visited = 0
  while (queue.length && visited < budget) {
    const cur = queue.shift()
    visited++
    const node = cur.node
    if (Array.isArray(node)) {
      if (cur.d >= depth) continue
      for (const item of node) queue.push({ node: item, d: cur.d + 1 })
      continue
    }
    if (!isObj(node)) continue
    for (const key of keys) {
      const v = node[key]
      if (typeof v === 'string' || typeof v === 'number') {
        const s = str(v)
        if (s) return s
      }
    }
    if (cur.d >= depth) continue
    for (const v of Object.values(node)) {
      if (isObj(v)) queue.push({ node: v, d: cur.d + 1 })
    }
  }
  return undefined
}

function formatBytes(bytes) {
  const n = num(bytes, 0)
  if (!n || n < 0) return '-'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function formatSpeed(bytesPerSec) {
  const n = num(bytesPerSec, 0)
  if (n <= 0) return '-'
  return formatBytes(n) + '/s'
}

function formatSeconds(ms) {
  const s = Math.max(0, Math.round(num(ms, 0) / 1000))
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return m + ' 分 ' + String(rest).padStart(2, '0') + ' 秒'
  return Math.floor(m / 60) + ' 时 ' + String(m % 60).padStart(2, '0') + ' 分'
}

function formatClock(ts) {
  const ms = num(ts, 0)
  if (!ms) return '-'
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()).slice(2) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, num(ms, 0))))
}

/** 判断一组字节是不是图片（上游偶尔会把封面混进 url 列表） */
function looksLikeImageBytes(u8) {
  if (!u8 || u8.length < 4) return false
  if (u8[0] === 0xff && u8[1] === 0xd8) return true
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return true
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return true
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) return true
  return false
}

function toU8(data) {
  if (!data) return new Uint8Array(0)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') {
    const out = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff
    return out
  }
  return new Uint8Array(0)
}

function headerGet(headers, name) {
  if (!isObj(headers)) return ''
  const want = String(name).toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return Array.isArray(v) ? str(v[0]) : str(v)
  }
  return ''
}

/** `bytes 0-0/12345678` → 12345678；`bytes 0-0/*` → 0 */
function parseTotalFromContentRange(value) {
  const m = /\/(\d+)\s*$/.exec(str(value))
  return m ? num(m[1], 0) : 0
}

/* ========================================================================== *
 * 音质：与宿主 PlayerResolver 完全一致的判定
 * ========================================================================== */

/** entry 是不是「quality 这一档」的文件 */
function qualityMatch(entry, quality) {
  if (quality === '128') return true
  const name = str(entry && entry.quality).toLowerCase()
  const level = num(entry && entry.level, -1)
  if (quality === '320') return name === '320' || name === 'hq' || level === 4
  if (quality === 'flac') return name === 'flac' || name === 'sq' || level === 5
  if (quality === 'high') return name === 'high' || name === 'hires' || name === 'hi-res' || name === 'res' || level === 6
  if (quality === 'viper_tape') return name === 'viper_tape' || level === 101
  return false
}

/** 升序的可用音质（128 恒可用） */
function availableQualities(relateGoods) {
  const goods = Array.isArray(relateGoods) ? relateGoods : []
  return QUALITY_LADDER.filter((q) => (q === '128' ? true : goods.some((g) => qualityMatch(g, q))))
}

/** 取某个音质对应的 hash；128 必须用轨道主 hash（见文件头 ②） */
function pickHashForQuality(track, quality) {
  const main = str(track && track.hash).toLowerCase()
  if (!main || quality === '128') return main
  const goods = Array.isArray(track && track.relateGoods) ? track.relateGoods : []
  const hit = goods.find((g) => qualityMatch(g, quality) && str(g.hash))
  return hit ? str(hit.hash).toLowerCase() : main
}

/** 从目标音质起逐级降级到 128 */
function candidateQualities(track, preferred) {
  const avail = availableQualities(track && track.relateGoods)
  const top = avail[avail.length - 1] || '128'
  const want = !preferred || preferred === 'auto' ? top : str(preferred)
  let start = QUALITY_LADDER.indexOf(want)
  if (start < 0) start = QUALITY_LADDER.indexOf(top)
  if (start < 0) start = 0
  const list = []
  for (let i = start; i >= 0; i--) list.push(QUALITY_LADDER[i])
  return list.length ? list : ['128']
}

/** 音质 → 扩展名（拿不到上游 extName 时的兜底） */
function guessExtByQuality(quality) {
  if (quality === 'flac' || quality === 'high' || quality === 'viper_tape') return 'flac'
  return 'mp3'
}

function mimeForExt(ext) {
  return EXT_MIME[str(ext).toLowerCase()] || 'application/octet-stream'
}

/* ========================================================================== *
 * 轨道归一化
 * ========================================================================== */

const UNSUPPORTED_SOURCES = ['local', 'cloud']

function normalizeTrack(raw) {
  if (!isObj(raw)) return null
  const name = str(firstOf(raw, ['name', 'title', 'songname', 'audio_name'])) || '未知歌曲'
  const artist = str(firstOf(raw, ['artist', 'singername', 'author_name'])) || '未知歌手'
  const goods = Array.isArray(raw.relateGoods)
    ? raw.relateGoods
        .filter((g) => isObj(g) && str(g.hash))
        .map((g) => ({ hash: str(g.hash).toLowerCase(), quality: str(g.quality), level: g.level }))
    : []
  return {
    id: str(firstOf(raw, ['id', 'mixSongId', 'audio_id'])) || str(raw.hash) || name + '|' + artist,
    name,
    artist,
    album: str(firstOf(raw, ['album', 'albumName', 'album_name'])),
    hash: str(firstOf(raw, ['hash', 'file_hash', 'hash_128'])).toLowerCase(),
    albumId: str(firstOf(raw, ['albumId', 'album_id'])),
    albumAudioId: str(firstOf(raw, ['albumAudioId', 'album_audio_id', 'mixSongId'])),
    duration: num(firstOf(raw, ['duration', 'timelength']), 0),
    coverUrl: str(firstOf(raw, ['coverUrl', 'cover', 'img'])),
    source: str(raw.source).toLowerCase(),
    relateGoods: goods
  }
}

/** 归一化后的轨道 → 任务里的最小快照（入队后重试仍然可用） */
function trackSnapshot(track) {
  return {
    hash: track.hash,
    albumId: track.albumId,
    albumAudioId: track.albumAudioId,
    duration: track.duration,
    relateGoods: track.relateGoods
  }
}

function trackOfTask(task) {
  const src = isObj(task.src) ? task.src : {}
  return {
    id: task.trackId,
    name: task.name,
    artist: task.artist,
    album: task.album,
    hash: str(src.hash).toLowerCase(),
    albumId: str(src.albumId),
    albumAudioId: str(src.albumAudioId),
    duration: num(src.duration, 0),
    relateGoods: Array.isArray(src.relateGoods) ? src.relateGoods : []
  }
}

/* ========================================================================== *
 * 上游载荷解析
 * ========================================================================== */

/**
 * 从 /song/url 的响应体里抠出所有候选播放地址。
 * 移植宿主的 xh()：兼容字符串 / 数组 / {url|play_url|backup_url|urls} /
 * 以及 `data`、`info` 里再包一层等形态；并剔除疑似图片的地址。
 */
function extractUrls(payload) {
  const out = []
  const push = (v) => {
    if (typeof v !== 'string') return
    const s = v.trim()
    if (!s || !/^https?:\/\//i.test(s)) return
    if (out.includes(s)) return
    out.push(s)
  }
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 6) return
    if (typeof node === 'string') {
      push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (!isObj(node)) return
    for (const key of ['url', 'urls', 'play_url', 'playUrl', 'play_urls', 'backup_url', 'backupUrl', 'backup_urls', 'backupUrls']) {
      if (key in node) walk(node[key], depth + 1)
    }
    if (out.length) return
    for (const key of ['data', 'info', 'songs', 'list', 'audio_info', 'audioInfo']) {
      if (key in node) walk(node[key], depth + 1)
    }
    if (out.length) return
    for (const v of Object.values(node)) walk(v, depth + 1)
  }
  walk(payload, 0)

  const isImage = (u) => {
    const ext = extFromUrl(u)
    return !!ext && IMAGE_EXT.includes(ext)
  }
  const audio = out.filter((u) => !isImage(u))
  // 带音频后缀的排前面，避免把无后缀的杂项地址当首选
  audio.sort((a, b) => (AUDIO_EXT.includes(extFromUrl(a)) ? 0 : 1) - (AUDIO_EXT.includes(extFromUrl(b)) ? 0 : 1))
  return audio
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname
    const m = /\.([a-z0-9]{2,5})$/i.exec(pathname)
    return m ? m[1].toLowerCase() : ''
  } catch {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(url))
    return m ? m[1].toLowerCase() : ''
  }
}

/** 从响应体里猜扩展名：先精确键名，再限深兜底，最后看 URL */
function pickExt(body, url) {
  const raw =
    str(firstOf(body, ['extName', 'ext_name', 'fileExt', 'file_ext', 'audio_ext'])) ||
    str(findFieldDeep(body, ['extName', 'ext_name'])) ||
    ''
  const clean = raw.replace(/^\./, '').toLowerCase()
  if (clean && AUDIO_EXT.includes(clean)) return clean
  const fromUrl = extFromUrl(url)
  if (fromUrl && AUDIO_EXT.includes(fromUrl)) return fromUrl
  return ''
}

/** 失败文案：error_code 为 0 表示「没有业务错误码」，绝不能拿 0 去查错误码表 */
function describeFailure(body, status, errorCode) {
  if (status === 503) return '宿主本地接口服务未就绪（需要 EchoMusic ≥ 2.3.2-beta.2，或重启主程序）'
  if (status === 404) return '本地路由不存在（/song/url）'
  const text = (errorCode ? ERROR_TEXT[errorCode] || '' : '') || str(firstOf(body, ['error', 'msg', 'message'])) || ''
  if (text) {
    // 上游风控文案（「本次请求需要验证」）单独点名，否则用户不知道要去点验证弹窗
    if (/需要验证|安全验证|风控/.test(text)) return text + '（账号风控：需要在安全验证弹窗里完成验证）'
    return text
  }
  return status && status !== 200 ? 'HTTP ' + status : '接口返回失败'
}

/* ========================================================================== *
 * 酷狗安全验证（风控）
 * --------------------------------------------------------------------------
 * 主进程的 request 层会把 ssa-code 同时写进 `answer.headers['ssa-code']` 与
 * `answer.body.ssaCode`（失败时 body 里还会带 edt/sid 行为指纹），
 * 但**插件这一侧没有任何自动兜底** —— 必须自己唤起宿主的验证弹窗再重试一次。
 * 判定与重试姿势对齐 auto-team-vip / kugou-recommend（本仓库已验证可用）：
 *   eventId 存在 且 请求确实失败（error_code=20028 或 status=0）→ 唤起验证 → 成功就原样重试一次。
 * 注意验证能力必须在 manifest 里声明 `capabilities.kugouVerification`，否则宿主直接抛错。
 * ========================================================================== */

function verificationEventId(res) {
  if (!isObj(res)) return ''
  const body = res.body
  const headers = res.headers || {}
  const raw =
    (isObj(body) && (body.ssaCode || (isObj(body.data) && (body.data.event_id || body.data.eventId)))) ||
    headers['ssa-code'] ||
    headers['SSA-CODE'] ||
    ''
  const eventId = str(raw)
  if (!eventId) return ''
  const errorCode = num(isObj(body) ? body.error_code : 0, 0)
  const bizStatus = num(isObj(body) ? body.status : 1, 1)
  if (errorCode !== 20028 && bizStatus !== 0) return ''
  return eventId
}

/** 唤起宿主的安全验证弹窗；返回 { ok, error, canceled } */
async function tryKugouVerify(ctx, eventId, log) {
  const api = ctx && ctx.kugouVerification
  if (!api || typeof api.request !== 'function') {
    return { ok: false, error: '宿主未提供安全验证通道（需要 manifest 声明 capabilities.kugouVerification）' }
  }
  try {
    const r = await api.request(eventId)
    if (r && r.ok) return { ok: true }
    return { ok: false, error: (r && r.error) || '安全验证未通过', canceled: !!(r && r.canceled) }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    log('安全验证异常', msg)
    return { ok: false, error: msg, canceled: /已取消/.test(msg) }
  }
}

/* ========================================================================== *
 * 网络
 * ========================================================================== */

function hasHostApi(ctx) {
  return !!(ctx && ctx.electron && ctx.electron.api && typeof ctx.electron.api.request === 'function')
}

/** 本地路由调用（/song/url 等），4xx/5xx 不抛异常 */
async function callLocalRoute(ctx, url, params, method) {
  const api = ctx.electron && ctx.electron.api
  const res = await api.request({ method: method || 'GET', url, params: params || {} })
  return {
    status: num(res && res.status, 0),
    body: res && res.body,
    headers: (res && res.headers) || {}
  }
}

/**
 * 取字节。优先 ctx.net.request（主进程 Axios，无 CORS），
 * 旧宿主没有它时退回 ctx.net.fetch（浏览器语义，可能被 CORS 拦）。
 * 必须显式 maxResponseBytes: 0 —— 默认 32 MiB 会截断大 FLAC。
 */
async function netGetBytes(ctx, url, opts) {
  const o = opts || {}
  if (ctx.net && typeof ctx.net.request === 'function') {
    const res = await ctx.net.request({
      url,
      method: 'GET',
      headers: o.headers || {},
      responseType: 'arrayBuffer',
      maxResponseBytes: 0,
      timeoutMs: num(o.timeoutMs, FILE_TIMEOUT_MS)
    })
    return {
      status: num(res && res.status, 0),
      headers: (res && res.headers) || {},
      parts: [toU8(res && res.data)]
    }
  }
  if (ctx.net && typeof ctx.net.fetch === 'function') {
    const res = await ctx.net.fetch(url, { headers: o.headers || {} })
    const buf = await res.arrayBuffer()
    const headers = {}
    try {
      if (res.headers && typeof res.headers.forEach === 'function') {
        res.headers.forEach((v, k) => {
          headers[String(k).toLowerCase()] = String(v)
        })
      }
    } catch {
      /* 忽略 */
    }
    return { status: num(res.status, 0), headers, parts: [new Uint8Array(buf)] }
  }
  throw new Error('宿主缺少网络能力（ctx.net.request / ctx.net.fetch）')
}

/** 带重试取字节；4xx 不重试（重试也没用），只对网络异常/5xx 重试 */
async function netGetBytesWithRetry(ctx, url, opts, maxRetries, log) {
  let lastError = ''
  let attempts = 0
  const tries = Math.max(0, num(maxRetries, 0))
  for (let i = 0; i <= tries; i++) {
    attempts = i + 1
    try {
      const res = await netGetBytes(ctx, url, opts)
      if (res.status >= 200 && res.status < 400) return { ok: true, res, attempts }
      lastError = 'HTTP ' + res.status
      if (res.status >= 400 && res.status < 500) return { ok: false, error: lastError, attempts, status: res.status }
    } catch (e) {
      lastError = e && e.message ? e.message : String(e)
    }
    if (i < tries) {
      log('请求失败，第 ' + (i + 1) + ' 次重试', lastError)
      await sleep(700)
    }
  }
  return { ok: false, error: lastError || '网络请求失败', attempts }
}

/* ========================================================================== *
 * 解析播放地址
 * ========================================================================== */

/** 取一次 /song/url：命中风控时唤起宿主安全验证弹窗，通过后原样重试一次
 *  verifyState 记住本轮验证的结果：同一轮（一次用户动作）只弹**一次**验证弹窗，
 *  否则 flac/320/128 三档会连弹三次，用户会以为插件坏了。 */
async function requestSongUrl(ctx, params, log, verifyState) {
  let res = await callLocalRoute(ctx, '/song/url', params, 'GET')
  let verifyError = ''
  const eventId = verificationEventId(res)
  if (eventId) {
    if (verifyState && verifyState.done) {
      verifyError = verifyState.ok
        ? '本轮已完成过安全验证，但上游仍要求验证（可稍后再试）'
        : verifyState.error || '安全验证未通过（点「重试」可再次验证）'
    } else {
      const v = await tryKugouVerify(ctx, eventId, log)
      if (verifyState) {
        verifyState.done = true
        verifyState.ok = !!v.ok
        verifyState.error = v.canceled ? '已取消安全验证，已停止本次下载' : v.error || '安全验证未通过'
      }
      if (v.ok) {
        log('安全验证通过，重试取地址')
        res = await callLocalRoute(ctx, '/song/url', params, 'GET')
        if (verificationEventId(res)) verifyError = '安全验证通过后上游仍要求验证（可稍后再试）'
      } else {
        verifyError = verifyState ? verifyState.error : v.error || '安全验证未通过'
      }
    }
  }
  return { res, verifyError }
}

async function resolveAudio(ctx, track, preferredQuality, log) {
  if (!track || !track.hash) {
    return { ok: false, error: '这首歌没有 hash（本地/云盘歌曲无法解析播放地址）', attempts: [] }
  }
  if (!hasHostApi(ctx)) {
    return { ok: false, error: '宿主缺少本地接口通道（需要 EchoMusic ≥ 2.3.2-beta.2）', attempts: [] }
  }
  const qualities = candidateQualities(track, preferredQuality)
  const attempts = []
  const verifyState = { done: false }
  let needsVerify = false
  for (const quality of qualities) {
    const hash = pickHashForQuality(track, quality)
    if (!hash) {
      attempts.push({ quality, hash: '', error: '缺少 hash' })
      continue
    }
    let res
    let verifyError = ''
    try {
      const got = await requestSongUrl(ctx, { hash, quality, album_id: track.albumId || 0, album_audio_id: track.albumAudioId || 0 }, log, verifyState)
      res = got.res
      verifyError = got.verifyError
    } catch (e) {
      attempts.push({ quality, hash, error: e && e.message ? e.message : String(e) })
      continue
    }
    const urls = extractUrls(res.body)
    const errorCode = num(firstOf(res.body, ['error_code', 'errorCode']), 0)
    if (urls.length) {
      log('解析成功', quality, urls.length + ' 条候选地址')
      return {
        ok: true,
        urls,
        quality,
        hash,
        ext: pickExt(res.body, urls[0]),
        errorCode,
        status: res.status,
        attempts
      }
    }
    if (verifyError) needsVerify = true
    attempts.push({
      quality,
      hash,
      status: res.status,
      errorCode,
      needsVerify: !!verifyError,
      error: verifyError || describeFailure(res.body, res.status, errorCode)
    })
  }
  const last = attempts[attempts.length - 1]
  return {
    ok: false,
    needsVerify,
    error: (last && last.error) || '没有可用的播放地址',
    attempts
  }
}

/* ========================================================================== *
 * 下载字节
 * ========================================================================== */

function clipUrl(url) {
  const s = str(url)
  return s.length > 70 ? s.slice(0, 70) + '…' : s
}

/**
 * 下载字节。返回 { ok, parts: Uint8Array[], total, viaChunked, error, canceled }
 * onProgress({ loaded, total }) 每次分片回调一次。
 */
async function downloadBytes(ctx, urls, opts) {
  const o = opts || {}
  const log = o.log || (() => {})
  const errors = []
  for (const url of urls) {
    if (o.isCanceled && o.isCanceled()) return { ok: false, canceled: true, error: '已取消' }
    const res = await downloadFromUrl(ctx, url, o)
    if (res.ok || res.canceled) return res
    errors.push(clipUrl(url) + ' → ' + res.error)
    log('该地址失败，尝试下一个候选', clipUrl(url), res.error)
  }
  return { ok: false, error: errors.join('；') || '所有候选地址都失败了' }
}

async function downloadFromUrl(ctx, url, o) {
  const log = o.log || (() => {})
  const chunkSize = clamp(num(o.chunkSize, MIN_CHUNK_BYTES), MIN_CHUNK_BYTES, MAX_CHUNK_BYTES)
  const maxRetries = num(o.maxRetries, 0)

  if (!o.chunked) return singleShot(ctx, url, o, maxRetries, log)

  // ① 先探一字节：同时拿到「服务端是否支持 Range」与「文件总长」
  let probe
  try {
    probe = await netGetBytesWithRetry(ctx, url, { headers: { Range: 'bytes=0-0' }, timeoutMs: PROBE_TIMEOUT_MS }, 0, log)
  } catch (e) {
    probe = { ok: false, error: e && e.message ? e.message : String(e) }
  }
  if (!probe.ok) {
    log('Range 探测失败，退回一次性下载', probe.error)
    return singleShot(ctx, url, o, maxRetries, log)
  }

  const status = probe.res.status
  const total = parseTotalFromContentRange(headerGet(probe.res.headers, 'content-range'))
  const firstPart = probe.res.parts[0] || new Uint8Array(0)

  if (status === 200 && !total) {
    // 服务端忽略 Range，直接给了整包 —— 正好省一次请求
    if (o.isCanceled && o.isCanceled()) return { ok: false, canceled: true, error: '已取消' }
    if (looksLikeImageBytes(firstPart)) return { ok: false, error: '返回的不是音频（疑似图片）' }
    if (firstPart.byteLength > MAX_FILE_BYTES) return { ok: false, error: '文件过大（超过 ' + formatBytes(MAX_FILE_BYTES) + '）' }
    if (o.onProgress) o.onProgress({ loaded: firstPart.byteLength, total: firstPart.byteLength })
    return { ok: true, parts: [firstPart], total: firstPart.byteLength, viaChunked: false }
  }

  if (status === 206 && total > 0 && total > chunkSize) {
    return chunkedLoop(ctx, url, total, chunkSize, o, maxRetries, log)
  }

  // 206 但整包比一个分片还小 → 一次性拿全更省事
  return singleShot(ctx, url, o, maxRetries, log)
}

async function chunkedLoop(ctx, url, total, chunkSize, o, maxRetries, log) {
  if (total > MAX_FILE_BYTES) {
    return { ok: false, error: '文件过大（' + formatBytes(total) + '，超过上限 ' + formatBytes(MAX_FILE_BYTES) + '）' }
  }
  const parts = []
  let loaded = 0
  while (loaded < total) {
    if (o.isCanceled && o.isCanceled()) return { ok: false, canceled: true, error: '已取消' }
    const start = loaded
    const end = Math.min(total, start + chunkSize) - 1
    const got = await netGetBytesWithRetry(
      ctx,
      url,
      { headers: { Range: 'bytes=' + start + '-' + end }, timeoutMs: FILE_TIMEOUT_MS },
      maxRetries,
      log
    )
    if (!got.ok) return { ok: false, error: '分片 ' + start + '-' + end + ' 失败：' + got.error }
    const bytes = got.res.parts[0] || new Uint8Array(0)
    if (got.res.status === 200) {
      // 中途开始忽略 Range：当整包处理
      if (bytes.byteLength < total) {
        return { ok: false, error: '服务端中途忽略了 Range（返回 ' + bytes.byteLength + ' 字节 / 需要 ' + total + '）' }
      }
      if (o.onProgress) o.onProgress({ loaded: bytes.byteLength, total: bytes.byteLength })
      return { ok: true, parts: [bytes], total: bytes.byteLength, viaChunked: false }
    }
    if (!bytes.byteLength) return { ok: false, error: '分片 ' + start + '-' + end + ' 返回空内容' }
    parts.push(bytes)
    loaded += bytes.byteLength
    if (o.onProgress) o.onProgress({ loaded, total })
  }
  if (loaded !== total) return { ok: false, error: '下载字节数不匹配（' + loaded + ' / ' + total + '）' }
  return { ok: true, parts, total, viaChunked: true }
}

async function singleShot(ctx, url, o, maxRetries, log) {
  const got = await netGetBytesWithRetry(ctx, url, { timeoutMs: FILE_TIMEOUT_MS }, maxRetries, log)
  if (!got.ok) return { ok: false, error: got.error }
  if (o.isCanceled && o.isCanceled()) return { ok: false, canceled: true, error: '已取消' }
  const bytes = got.res.parts[0] || new Uint8Array(0)
  if (!bytes.byteLength) return { ok: false, error: '响应内容为空' }
  if (looksLikeImageBytes(bytes)) return { ok: false, error: '返回的不是音频（疑似图片）' }
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, error: '文件过大（超过 ' + formatBytes(MAX_FILE_BYTES) + '）' }
  if (o.onProgress) o.onProgress({ loaded: bytes.byteLength, total: bytes.byteLength })
  return { ok: true, parts: [bytes], total: bytes.byteLength, viaChunked: false }
}

/* ========================================================================== *
 * 文件名与落盘
 * ========================================================================== */

function sanitizeFileName(name) {
  const cleaned = String(name === null || name === undefined ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, 120) || '未知歌曲'
}

function buildFileName(track, quality, ext, template) {
  const tpl = str(template) || DEFAULT_SETTINGS.fileNameTemplate
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp =
    String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes())
  const base = tpl
    .replace(/\{artist\}/g, (track && track.artist) || '未知歌手')
    .replace(/\{name\}/g, (track && track.name) || '未知歌曲')
    .replace(/\{album\}/g, (track && track.album) || '未知专辑')
    .replace(/\{quality\}/g, QUALITY_LABEL[quality] || quality || '')
    .replace(/\{ext\}/g, ext || '')
    .replace(/\{time\}/g, stamp)
  return sanitizeFileName(base) + (ext ? '.' + ext : '')
}

function partsToBlob(parts, mime) {
  return new Blob(parts, { type: mime || 'application/octet-stream' })
}

/** 主通道：Blob + <a download>，由 Chromium 落到系统默认下载目录 */
function saveViaAnchor(parts, fileName, mime, log) {
  const blob = partsToBlob(parts, mime)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // 撤 blob 不能太早（下载可能还没排队完），留 30s
  setTimeout(() => {
    try {
      a.remove()
    } catch {
      /* 忽略 */
    }
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* 忽略 */
    }
  }, 30000)
  log('已交给 Chromium 下载通道', fileName, formatBytes(blob.size))
  return { ok: true, method: 'downloads', file: fileName }
}

function canUseSavePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

/** 可选通道：File System Access API，用户自选位置（必须在点击手势内调用） */
async function pickSaveHandle(fileName, ext) {
  const mime = mimeForExt(ext)
  const types = [{ description: '音频文件', accept: { [mime]: ['.' + (ext || 'mp3')] } }]
  return window.showSaveFilePicker({ suggestedName: fileName, types })
}

async function writeToHandle(handle, parts, mime) {
  const writable = await handle.createWritable()
  await writable.write(partsToBlob(parts, mime))
  await writable.close()
  return { ok: true, method: 'picker', file: handle.name || '' }
}

/* ========================================================================== *
 * 复制文本（剪贴板，带兜底）
 * ========================================================================== */

async function copyText(text, log) {
  const value = str(text)
  if (!value) return false
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch (e) {
      log('clipboard API 失败，改用兜底方案', e)
    }
  }
  try {
    const el = document.createElement('textarea')
    el.value = value
    el.style.position = 'fixed'
    el.style.top = '-1000px'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    const ok = document.execCommand && document.execCommand('copy')
    el.remove()
    return !!ok
  } catch {
    return false
  }
}

/* ========================================================================== *
 * 插件本体
 * ========================================================================== */

let ctxRef = null
let runtime = null

export async function activate(ctx) {
  ctxRef = ctx

  const V = ctx.vue
  const { h, reactive, watch } = V

  const log = (...args) => {
    if (runtime && runtime.state && runtime.state.settings.debug) console.log('[歌曲下载]', ...args)
  }

  /* ---------------- 持久化 ---------------- */

  async function readStorage(key, fallback) {
    try {
      const v = await ctx.storage.get(key)
      return v === undefined || v === null ? fallback : v
    } catch (e) {
      log('读取存储失败', key, e)
      return fallback
    }
  }

  async function writeStorage(key, value) {
    try {
      await ctx.storage.set(key, value)
      return true
    } catch (e) {
      log('写入存储失败', key, e)
      return false
    }
  }

  function normalizeSettings(raw) {
    const src = isObj(raw) ? raw : {}
    const out = { ...DEFAULT_SETTINGS }
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (src[k] !== undefined) out[k] = src[k]
    }
    const q = str(out.quality)
    out.quality = q === 'auto' || QUALITY_LADDER.includes(q) ? q : 'auto'
    out.saveMode = out.saveMode === 'ask' ? 'ask' : 'direct'
    out.fileNameTemplate = str(out.fileNameTemplate) || DEFAULT_SETTINGS.fileNameTemplate
    out.chunkSizeMb = clamp(out.chunkSizeMb, 1, 8)
    out.maxRetries = clamp(out.maxRetries, 0, 3)
    out.concurrency = clamp(out.concurrency, 1, 2)
    out.chunked = !!out.chunked
    out.confirmBeforeDownload = !!out.confirmBeforeDownload
    out.toastOnDone = !!out.toastOnDone
    out.sidebarEntry = !!out.sidebarEntry
    out.toolbarEntry = !!out.toolbarEntry
    out.playerBarButton = !!out.playerBarButton
    out.debug = !!out.debug
    return out
  }

  const [savedSettings, savedHistory] = await Promise.all([readStorage(KEY_SETTINGS, null), readStorage(KEY_HISTORY, null)])

  const state = reactive({
    settings: normalizeSettings(savedSettings),
    tasks: [],
    history: Array.isArray(savedHistory) ? savedHistory.slice(0, MAX_HISTORY) : [],
    selected: {},
    notice: '',
    beat: 0,
    resolved: null // { trackId, quality, count, url, at }
  })

  /**
   * 下载确认框的状态。
   * 注意：`handle`（FileSystemFileHandle）**不能**放进 reactive —— 它会被代理包装，
   * 之后 handle.createWritable() 的 this 变成 Proxy，内部槽校验直接抛 Illegal invocation。
   * 所以句柄只作为 startDownloads 的 options 传进去，结束时由 saveTargets 统一回收。
   */
  const dlg = reactive({
    open: false,
    tracks: [],
    quality: 'auto',
    destination: 'downloads', // downloads | picker
    pickedName: '',
    template: '',
    chunked: true,
    toastOnDone: true,
    remember: true,
    error: '',
    busy: false // 正在解析 / 等系统保存对话框
  })
  /** 打开确认框的「代际」：解析或保存对话框还没结束时用户关掉弹窗，用它把后续流程作废 */
  let dlgGen = 0

  /** 取消标志与另存为句柄都放在容器外：句柄是宿主对象，放进 reactive 会被代理包装，
   *  之后 handle.createWritable() 的 this 就变成 Proxy，内部槽校验会抛 "Illegal invocation"。 */
  const controllers = new Map() // taskId → { canceled }
  const saveTargets = new Map() // taskId → FileSystemFileHandle
  const noticeTimers = []
  let runningCount = 0
  let taskSeq = 0
  let heartbeat = null

  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return
    state.settings[key] = value
    if (key === 'sidebarEntry') applySidebarEntry(!!value)
    if (key === 'toolbarEntry') applyToolbarEntry(!!value)
    if (key === 'playerBarButton') applyPlayerBarButton(!!value)
    void writeStorage(KEY_SETTINGS, { ...state.settings })
  }

  /* ---------------- 任务引擎 ---------------- */

  function hasActiveTasks() {
    return state.tasks.some((t) => t.status === 'resolving' || t.status === 'downloading' || t.status === 'saving')
  }

  function startHeartbeat() {
    if (heartbeat) return
    heartbeat = setInterval(() => {
      if (hasActiveTasks()) state.beat += 1
    }, 500)
  }

  function pushHistory(entry) {
    state.history.unshift(entry)
    if (state.history.length > MAX_HISTORY) state.history.splice(MAX_HISTORY)
    void writeStorage(
      KEY_HISTORY,
      state.history.map((x) => ({ ...x }))
    )
  }

  function createTask(track, qualityOverride) {
    taskSeq += 1
    const task = {
      id: 't' + Date.now().toString(36) + '-' + taskSeq,
      trackId: track.id,
      name: track.name,
      artist: track.artist,
      album: track.album,
      quality: qualityOverride && qualityOverride !== 'auto' ? qualityOverride : state.settings.quality,
      actualQuality: '',
      status: 'pending',
      phaseText: '排队中',
      loaded: 0,
      total: 0,
      speed: 0,
      startedAt: 0,
      endedAt: 0,
      attempts: 0,
      viaChunked: false,
      bytes: 0,
      fileName: '',
      saveMethod: '',
      directUrl: '',
      error: '',
      warning: '',
      needsVerify: false,
      preResolved: null, // 确认框里已解析好的地址（避免重复请求 / 地址过期时会在执行时兜底重解析）
      src: trackSnapshot(track)
    }
    state.tasks.push(task)
    if (state.tasks.length > MAX_TASKS) state.tasks.splice(0, state.tasks.length - MAX_TASKS)
    // 关键：必须从 reactive 容器里读回来才是 Proxy，否则 patch() 不触发依赖更新
    const idx = state.tasks.findIndex((x) => x.id === task.id)
    return idx >= 0 ? state.tasks[idx] : null
  }

  function patch(task, fields) {
    if (!task) return
    Object.assign(task, fields)
  }

  function pump() {
    const limit = clamp(state.settings.concurrency, 1, 2)
    while (runningCount < limit) {
      const next = state.tasks.find((t) => t.status === 'pending')
      if (!next) break
      void executeTask(next)
    }
  }

  /** 失败/取消时清掉「选择位置」留下的空文件
   *  （picker 一确认，Chromium 就会先把 0 字节文件建出来；后面任何环节失败都会留下残骸） */
  async function cleanupSaveTarget(taskId, log) {
    const handle = saveTargets.get(taskId)
    if (!handle) return ''
    saveTargets.delete(taskId)
    try {
      if (typeof handle.remove === 'function') {
        await handle.remove()
        log('已删除失败留下的空文件')
        return '（已清理失败留下的空文件）'
      }
    } catch (e) {
      log('删除空文件失败', e)
    }
    return '（所选位置可能留下一个 0 KB 空文件：' + (handle.name || '请手动检查') + '）'
  }

  async function executeTask(task) {
    runningCount += 1
    const ctrl = { canceled: false }
    controllers.set(task.id, ctrl)
    const isCanceled = () => ctrl.canceled
    const handle = saveTargets.get(task.id) || null
    try {
      const track = trackOfTask(task)
      if (!track.hash) throw new Error('这首歌没有 hash（本地/云盘歌曲不支持下载）')

      patch(task, { status: 'resolving', phaseText: '解析播放地址…', startedAt: Date.now() })
      // 确认框里如果已经解析过（用户先选位置再开始），直接复用：省一次请求、少一次风控机会
      let resolved =
        isObj(task.preResolved) && Array.isArray(task.preResolved.urls) && task.preResolved.urls.length ? task.preResolved : null
      const reused = !!resolved
      if (!resolved) resolved = await resolveAudio(ctx, track, task.quality, log)
      if (isCanceled()) {
        const note = await cleanupSaveTarget(task.id, log)
        patch(task, { status: 'canceled', endedAt: Date.now(), phaseText: '已取消' + note })
        return
      }
      if (!resolved.ok) {
        const err = new Error(resolved.error || '解析播放地址失败')
        err.attempts = resolved.attempts ? resolved.attempts.length : 0
        err.needsVerify = !!resolved.needsVerify
        throw err
      }

      const ext = resolved.ext || guessExtByQuality(resolved.quality)
      const mime = mimeForExt(ext)
      const autoName = buildFileName(track, resolved.quality, ext, state.settings.fileNameTemplate)
      const fileName = handle && handle.name ? handle.name : autoName

      patch(task, {
        status: 'downloading',
        phaseText: '下载中…',
        actualQuality: resolved.quality,
        attempts: (resolved.attempts || []).length,
        fileName
      })

      let lastTickAt = Date.now()
      let lastLoaded = 0
      const dlOptions = {
        chunked: !!state.settings.chunked,
        chunkSize: clamp(state.settings.chunkSizeMb, 1, 8) * 1024 * 1024,
        maxRetries: state.settings.maxRetries,
        isCanceled,
        log,
        onProgress: (p) => {
          const now = Date.now()
          const dt = now - lastTickAt
          const db = p.loaded - lastLoaded
          lastTickAt = now
          lastLoaded = p.loaded
          const speed = dt > 0 ? (db / dt) * 1000 : 0
          patch(task, { loaded: p.loaded, total: p.total, speed })
        }
      }

      let result = await downloadBytes(ctx, resolved.urls, dlOptions)

      // 预解析的地址可能已过期（用户在系统保存对话框上停留了很久）：重新解析一次再试
      if (!result.ok && !result.canceled && reused && !isCanceled()) {
        log('预解析地址下载失败，重新解析一次', result.error)
        const again = await resolveAudio(ctx, track, task.quality, log)
        if (again.ok) {
          resolved = again
          patch(task, { actualQuality: again.quality, attempts: (again.attempts || []).length })
          result = await downloadBytes(ctx, resolved.urls, dlOptions)
        }
      }

      if (result.canceled || isCanceled()) {
        const note = await cleanupSaveTarget(task.id, log)
        patch(task, { status: 'canceled', endedAt: Date.now(), phaseText: '已取消' + note, speed: 0 })
        return
      }
      if (!result.ok) throw new Error(result.error || '下载失败')

      const bytes = result.total || 0
      const warning = suspectShortClip(track, resolved.quality, bytes)
      patch(task, {
        status: 'saving',
        phaseText: handle ? '写入文件…' : '交给下载器…',
        loaded: bytes,
        total: bytes,
        bytes,
        viaChunked: !!result.viaChunked,
        warning,
        speed: 0
      })

      let saveResult
      if (handle) {
        saveResult = await writeToHandle(handle, result.parts, mime)
      } else {
        saveResult = saveViaAnchor(result.parts, fileName, mime, log)
      }

      patch(task, {
        status: 'done',
        phaseText: saveResult.method === 'picker' ? '已保存' : '已交给下载器',
        endedAt: Date.now(),
        speed: 0,
        bytes,
        saveMethod: saveResult.method,
        directUrl: resolved.urls[0] || '',
        error: ''
      })
      pushHistory({
        id: task.id,
        name: task.name,
        artist: task.artist,
        quality: resolved.quality,
        requestedQuality: task.quality,
        file: saveResult.file || fileName,
        ext,
        bytes,
        at: Date.now(),
        url: resolved.urls[0] || '',
        viaChunked: !!result.viaChunked,
        warning,
        needsVerify: false,
        ok: true
      })
      if (state.settings.toastOnDone) {
        try {
          ctx.toast.success(
            '已下载：' + task.name + '（' + (QUALITY_LABEL[resolved.quality] || resolved.quality) + '，' + formatBytes(bytes) + '）'
          )
        } catch {
          /* 忽略 */
        }
      }
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      const note = await cleanupSaveTarget(task.id, log)
      const needsVerify = !!(e && e.needsVerify)
      patch(task, {
        status: 'failed',
        phaseText: '失败',
        error: message + (note ? ' ' + note : ''),
        endedAt: Date.now(),
        speed: 0,
        attempts: (e && e.attempts) || task.attempts,
        needsVerify
      })
      pushHistory({
        id: task.id,
        name: task.name,
        artist: task.artist,
        quality: task.actualQuality || task.quality,
        requestedQuality: task.quality,
        file: task.fileName || '',
        ext: '',
        bytes: 0,
        at: Date.now(),
        url: '',
        viaChunked: false,
        warning: '',
        needsVerify,
        ok: false,
        error: message
      })
      try {
        ctx.toast.danger('下载失败：' + task.name + ' —— ' + message)
      } catch {
        /* 忽略 */
      }
      log('任务失败', task.id, message)
    } finally {
      controllers.delete(task.id)
      saveTargets.delete(task.id)
      runningCount = Math.max(0, runningCount - 1)
      pump()
    }
  }

  /** 「只有试听片段」的启发式判断：实际字节数远小于 码率×时长 */
  function suspectShortClip(track, quality, bytes) {
    const duration = num(track.duration, 0)
    if (!duration || duration < 60 || !bytes) return ''
    const seconds = duration > 10000 ? duration / 1000 : duration
    const kbps = QUALITY_BITRATE[quality] || 128
    const expected = seconds * kbps * 125
    if (bytes < expected * 0.6) {
      return '实际文件（' + formatBytes(bytes) + '）明显小于该音质的预期体积，可能只是试听片段'
    }
    return ''
  }

  /* ---------------- 对外动作 ---------------- */

  function trackKey(track) {
    return track.hash || track.id || track.name
  }

  function toNormalized(raw) {
    const t = normalizeTrack(raw)
    if (!t) return null
    if (!t.hash) return { ...t, unsupported: '这首歌没有 hash（本地/云盘歌曲无法下载）' }
    if (UNSUPPORTED_SOURCES.includes(t.source)) return { ...t, unsupported: '本地文件 / 云盘歌曲暂不支持下载' }
    return t
  }

  function notice(text) {
    state.notice = str(text)
    if (!state.notice) return
    try {
      ctx.toast.info(state.notice)
    } catch {
      /* 忽略 */
    }
    const value = state.notice
    const timer = setTimeout(() => {
      if (state.notice === value) state.notice = ''
    }, 6000)
    noticeTimers.push(timer)
  }

  /** 入队并开跑；opts.saveHandle = File System Access 句柄（单曲另存为） */
  function startDownloads(tracks, qualityOverride, opts) {
    const options = opts || {}
    const created = []
    for (const raw of tracks) {
      const track = toNormalized(raw)
      if (!track) continue
      if (track.unsupported) {
        notice(track.unsupported)
        continue
      }
      const task = createTask(track, qualityOverride)
      if (task) {
        if (options.saveHandle) saveTargets.set(task.id, options.saveHandle)
        // 预解析结果只对「单曲 + 已经解析过」的场景有意义（确认框里先解析、再弹保存对话框）
        if (options.preResolved && created.length === 0 && tracks.length === 1) {
          task.preResolved = options.preResolved
        }
        created.push(task)
      }
    }
    if (created.length) {
      startHeartbeat()
      pump()
    }
    return created
  }

  function cancelTask(task) {
    if (!task) return
    const ctrl = controllers.get(task.id)
    if (ctrl) ctrl.canceled = true
    if (task.status === 'pending') patch(task, { status: 'canceled', phaseText: '已取消', endedAt: Date.now() })
  }

  function cancelAll() {
    for (const task of state.tasks.slice()) {
      const s = task.status
      if (s === 'pending' || s === 'resolving' || s === 'downloading' || s === 'saving') cancelTask(task)
    }
  }

  function retryTask(task) {
    if (!task) return
    const s = task.status
    if (s === 'downloading' || s === 'resolving' || s === 'saving') return
    patch(task, {
      status: 'pending',
      phaseText: '排队中',
      loaded: 0,
      total: 0,
      speed: 0,
      bytes: 0,
      error: '',
      warning: '',
      endedAt: 0
    })
    startHeartbeat()
    pump()
  }

  function removeTask(task) {
    if (!task) return
    const idx = state.tasks.findIndex((x) => x.id === task.id)
    if (idx >= 0) state.tasks.splice(idx, 1)
  }

  function clearFinished() {
    for (let i = state.tasks.length - 1; i >= 0; i--) {
      const s = state.tasks[i].status
      if (s === 'done' || s === 'failed' || s === 'canceled') state.tasks.splice(i, 1)
    }
  }

  function clearHistory() {
    state.history.splice(0)
    void writeStorage(KEY_HISTORY, [])
  }

  function currentTrack() {
    try {
      const ref = ctx.player && ctx.player.currentTrack
      const t = ref && 'value' in ref ? ref.value : ref
      return t || null
    } catch {
      return null
    }
  }

  function readQueue() {
    try {
      const q = ctx.stores && ctx.stores.playlist && ctx.stores.playlist.activeQueue
      const songs = q && Array.isArray(q.songs) ? q.songs : []
      return songs.slice(0, 300)
    } catch {
      return []
    }
  }

  /** 把当前播放直接入队（不走任何对话框） */
  function enqueueCurrent() {
    const cur = currentTrack()
    if (!cur) {
      notice('当前没有正在播放的歌曲')
      return null
    }
    const created = startDownloads([cur], state.settings.quality)
    return created[0] || null
  }

  async function downloadCurrent() {
    const cur = currentTrack()
    if (!cur) {
      notice('当前没有正在播放的歌曲')
      return null
    }
    // 确认框（默认开）：音质 / 保存位置 / 文件名都在里面改
    if (state.settings.confirmBeforeDownload) return openDownloadDialog([cur])
    // 关掉确认框后，「保存方式 = 弹窗询问」这条快捷路径依然有效
    if (state.settings.saveMode === 'ask' && canUseSavePicker()) return downloadCurrentAs()
    return enqueueCurrent()
  }

  /**
   * 「另存为…」：**先解析地址，再弹系统保存对话框**。
   * 顺序反了的话，解析失败（风控/无版权很常见）会在磁盘上留下一个 0 KB 空文件。
   * 代价是解析耗时算在「用户手势」的 5 秒有效期内；正常几百毫秒，超时会优雅降级到系统下载目录。
   */
  async function downloadCurrentAs() {
    const cur = currentTrack()
    if (!cur) {
      notice('当前没有正在播放的歌曲')
      return null
    }
    const track = toNormalized(cur)
    if (!track || track.unsupported) {
      notice((track && track.unsupported) || '这首歌无法下载')
      return null
    }
    if (!canUseSavePicker()) {
      notice('当前内核不支持「另存为」，已改为保存到系统下载目录')
      return enqueueCurrent()
    }
    const quality = state.settings.quality
    notice('正在解析播放地址…')
    const resolved = await resolveAudio(ctx, track, quality, log)
    if (!resolved.ok) {
      notice('解析失败：' + resolved.error + '（没有创建任何文件）')
      return null
    }
    const ext = resolved.ext || guessExtByQuality(resolved.quality)
    const fileName = buildFileName(track, resolved.quality, ext, state.settings.fileNameTemplate)
    let handle
    try {
      handle = await pickSaveHandle(fileName, ext)
    } catch (e) {
      if (isAbortError(e)) {
        notice('已取消保存（没有创建文件）')
        return null
      }
      log('另存为对话框失败', e)
      notice('另存为不可用，已改为保存到系统下载目录')
      return enqueueCurrent()
    }
    const created = startDownloads([cur], quality, { saveHandle: handle, preResolved: resolved })
    return created[0] || null
  }

  async function copyDirectLink(rawOrTrack, qualityOverride) {
    const track = toNormalized(rawOrTrack)
    if (!track || track.unsupported) {
      notice((track && track.unsupported) || '这首歌无法解析')
      return
    }
    notice('正在解析直链…')
    const resolved = await resolveAudio(ctx, track, qualityOverride || state.settings.quality, log)
    if (!resolved.ok) {
      notice('解析失败：' + resolved.error)
      return
    }
    const ok = await copyText(resolved.urls[0], log)
    state.resolved = {
      trackId: track.id,
      quality: resolved.quality,
      count: resolved.urls.length,
      url: resolved.urls[0],
      at: Date.now()
    }
    notice(ok ? '直链已复制（' + (QUALITY_LABEL[resolved.quality] || resolved.quality) + '）' : '复制失败，请手动选择文本')
  }

  function copyDiagnostics() {
    return JSON.stringify(
      {
        plugin: PLUGIN_ID,
        version: (ctx.manifest && ctx.manifest.version) || '',
        platform: (ctx.electron && ctx.electron.platform) || '',
        time: new Date().toISOString(),
        settings: { ...state.settings },
        savePicker: canUseSavePicker(),
        tasks: state.tasks.slice(-12).map((t) => ({
          id: t.id,
          name: t.name,
          artist: t.artist,
          quality: t.quality,
          actualQuality: t.actualQuality,
          status: t.status,
          fileName: t.fileName,
          bytes: t.bytes,
          viaChunked: t.viaChunked,
          attempts: t.attempts,
          warning: t.warning,
          needsVerify: t.needsVerify,
          error: t.error
        })),
        history: state.history.slice(0, 8),
        resolved: state.resolved
      },
      null,
      2
    )
  }

  async function copyDiagnosticsToClipboard() {
    const text = copyDiagnostics()
    const ok = await copyText(text, log)
    notice(ok ? '诊断信息已复制' : '复制失败')
  }

  /* ---------------- 渲染 ---------------- */

  function qualityChips(track) {
    return availableQualities(track.relateGoods).map((q) =>
      h('span', { class: 'sd-chip sd-chip-q' + q, key: 'q-' + q, title: '可用音质：' + (QUALITY_LABEL[q] || q) }, QUALITY_LABEL[q] || q)
    )
  }

  function statusText(task) {
    if (task.status === 'pending') return '排队中'
    if (task.status === 'resolving') return '解析地址…'
    if (task.status === 'downloading') return task.total ? '下载中 ' + Math.floor((task.loaded / task.total) * 100) + '%' : '下载中…'
    if (task.status === 'saving') return '写入文件…'
    if (task.status === 'done') return task.saveMethod === 'picker' ? '已保存' : '已交给下载器'
    if (task.status === 'canceled') return '已取消'
    return '失败'
  }

  function taskProgress(task) {
    if (!task.total) return task.status === 'done' ? 100 : 0
    return Math.min(100, Math.max(0, Math.round((task.loaded / task.total) * 100)))
  }

  function taskTimeText(task) {
    void state.beat // 显式建立依赖：否则在渲染里读 Date.now() 会冻住
    if (task.status === 'done' || task.status === 'failed' || task.status === 'canceled') {
      return task.startedAt && task.endedAt ? '耗时 ' + formatSeconds(task.endedAt - task.startedAt) : ''
    }
    if (!task.startedAt) return ''
    const elapsed = Date.now() - task.startedAt
    if (task.status === 'downloading' && task.speed > 0 && task.total > task.loaded) {
      return '已用 ' + formatSeconds(elapsed) + ' · 剩余约 ' + formatSeconds(((task.total - task.loaded) / task.speed) * 1000)
    }
    return '已用 ' + formatSeconds(elapsed)
  }

  function overallProgress() {
    void state.beat
    const active = state.tasks.filter((t) => t.status === 'downloading' || t.status === 'resolving' || t.status === 'saving')
    const loaded = active.reduce((a, t) => a + num(t.loaded, 0), 0)
    const total = active.reduce((a, t) => a + num(t.total, 0), 0)
    return { count: active.length, loaded, total, pct: total ? Math.round((loaded / total) * 100) : 0 }
  }

  function renderCurrentCard() {
    const raw = currentTrack()
    const track = raw ? toNormalized(raw) : null
    if (!track) {
      return h('section', { class: 'sd-card', 'data-role': 'current-card' }, [
        h('div', { class: 'sd-card-head' }, h('h3', null, '当前播放')),
        h('p', { class: 'sd-empty' }, '宿主里还没有正在播放的歌曲。播放一首后，这里会出现「下载」按钮。')
      ])
    }
    const disabled = !!track.unsupported
    const buttons = [
      h(
        'button',
        { class: 'sd-btn sd-btn-primary', 'data-action': 'download-current', disabled, onClick: () => void downloadCurrent() },
        '下载'
      ),
      h(
        'button',
        {
          class: 'sd-btn',
          'data-action': 'download-current-as',
          disabled,
          title: canUseSavePicker() ? '选择保存位置' : '当前内核不支持，将保存到系统下载目录',
          onClick: () => void downloadCurrentAs()
        },
        '另存为…'
      ),
      h(
        'button',
        { class: 'sd-btn', 'data-action': 'copy-current-link', disabled, onClick: () => void copyDirectLink(raw) },
        '复制直链'
      )
    ]
    return h('section', { class: 'sd-card', 'data-role': 'current-card' }, [
      h('div', { class: 'sd-card-head' }, [h('h3', null, '当前播放'), h('div', { class: 'sd-head-actions' }, buttons)]),
      h('div', { class: 'sd-current' }, [
        track.coverUrl
          ? h('img', { class: 'sd-cover', src: track.coverUrl, alt: '' })
          : h('div', { class: 'sd-cover sd-cover-empty' }, '♪'),
        h('div', { class: 'sd-meta' }, [
          h('div', { class: 'sd-name', title: track.name }, track.name),
          h('div', { class: 'sd-artist' }, track.artist + (track.album ? ' · ' + track.album : '')),
          h('div', { class: 'sd-chips' }, [h('span', { class: 'sd-muted' }, '可用音质：'), ...qualityChips(track)]),
          disabled ? h('div', { class: 'sd-error' }, '⚠ ' + track.unsupported) : null
        ])
      ]),
      state.resolved && track.id === state.resolved.trackId
        ? h(
            'p',
            { class: 'sd-muted sd-mono', 'data-role': 'resolved-link' },
            '已解析：' +
              (QUALITY_LABEL[state.resolved.quality] || state.resolved.quality) +
              ' · ' +
              state.resolved.count +
              ' 条候选地址 · ' +
              String(state.resolved.url).slice(0, 72) +
              '…'
          )
        : null
    ])
  }

  function renderQueue() {
    const items = readQueue()
      .map((raw) => ({ raw, track: toNormalized(raw) }))
      .filter((x) => x.track)
    if (!items.length) {
      return h('section', { class: 'sd-card', 'data-role': 'queue-card' }, [
        h('div', { class: 'sd-card-head' }, h('h3', null, '播放队列')),
        h('p', { class: 'sd-empty' }, '播放队列是空的。把歌加到队列后，这里可以勾选批量下载。')
      ])
    }
    const usable = items.filter((x) => !x.track.unsupported)
    const selectedIds = usable.filter((x) => state.selected[trackKey(x.track)]).map((x) => trackKey(x.track))

    const rows = items.map((x) => {
      const t = x.track
      const key = trackKey(t)
      const checked = !!state.selected[key]
      return h('div', { class: 'sd-row', key: 'r-' + key, 'data-row': key }, [
        h(
          'button',
          {
            class: 'sd-check' + (checked ? ' is-on' : ''),
            role: 'checkbox',
            'aria-checked': checked ? 'true' : 'false',
            'data-action': 'toggle-row',
            'data-key': key,
            disabled: !!t.unsupported,
            onClick: () => {
              state.selected[key] = !checked
            }
          },
          checked ? '✓' : ''
        ),
        h('div', { class: 'sd-row-main' }, [
          h('div', { class: 'sd-row-name', title: t.name }, t.name),
          h('div', { class: 'sd-row-sub' }, t.artist + (t.unsupported ? ' · ⚠ ' + t.unsupported : ''))
        ]),
        h('div', { class: 'sd-row-chips' }, qualityChips(t)),
        h(
          'button',
          {
            class: 'sd-btn sd-btn-sm',
            'data-action': 'download-row',
            'data-key': key,
            disabled: !!t.unsupported,
            onClick: () => {
              openDownloadDialog([x.raw])
            }
          },
          '下载'
        )
      ])
    })

    return h('section', { class: 'sd-card', 'data-role': 'queue-card' }, [
      h('div', { class: 'sd-card-head' }, [
        h('h3', null, '播放队列（' + items.length + '）'),
        h('div', { class: 'sd-head-actions' }, [
          h(
            'button',
            {
              class: 'sd-btn sd-btn-sm',
              'data-action': 'select-all',
              onClick: () => {
                for (const x of usable) state.selected[trackKey(x.track)] = true
              }
            },
            '全选'
          ),
          h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'select-none', onClick: () => { state.selected = {} } }, '清空选择'),
          h(
            'button',
            {
              class: 'sd-btn sd-btn-sm sd-btn-primary',
              'data-action': 'download-selected',
              disabled: !selectedIds.length,
              onClick: () => {
                const picked = usable.filter((x) => state.selected[trackKey(x.track)]).map((x) => x.raw)
                openDownloadDialog(picked)
                state.selected = {}
              }
            },
            '下载选中（' + selectedIds.length + '）'
          )
        ])
      ]),
      h('div', { class: 'sd-list' }, rows)
    ])
  }

  function renderTasks() {
    const tasks = state.tasks.slice().reverse()
    const overall = overallProgress()
    return h('section', { class: 'sd-card', 'data-role': 'tasks-card' }, [
      h('div', { class: 'sd-card-head' }, [
        h('h3', null, '下载任务（' + state.tasks.length + '）'),
        h('div', { class: 'sd-head-actions' }, [
          h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'cancel-all', disabled: !overall.count, onClick: () => cancelAll() }, '全部停止'),
          h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'clear-finished', onClick: () => clearFinished() }, '清空已完成')
        ])
      ]),
      overall.count
        ? h('div', { class: 'sd-overall', 'data-role': 'overall' }, [
            h('div', { class: 'sd-bar' }, h('div', { class: 'sd-bar-fill', style: { width: overall.pct + '%' } })),
            h(
              'span',
              { class: 'sd-muted' },
              '进行中 ' +
                overall.count +
                ' 个 · ' +
                formatBytes(overall.loaded) +
                ' / ' +
                (overall.total ? formatBytes(overall.total) : '未知') +
                ' · ' +
                overall.pct +
                '%'
            )
          ])
        : null,
      tasks.length ? h('div', { class: 'sd-list' }, tasks.slice(0, 60).map((t) => renderTaskRow(t))) : h('p', { class: 'sd-empty' }, '还没有下载任务。点上面的「下载」或勾选队列里的歌开始。')
    ])
  }

  function renderTaskRow(task) {
    const pct = taskProgress(task)
    const active = task.status === 'downloading' || task.status === 'resolving' || task.status === 'saving' || task.status === 'pending'
    const label = QUALITY_LABEL[task.actualQuality || task.quality] || task.actualQuality || task.quality || '自动'
    const degraded = !!(task.actualQuality && task.quality !== 'auto' && task.actualQuality !== task.quality)
    return h('div', { class: 'sd-task', key: 't-' + task.id, 'data-task': task.id, 'data-status': task.status }, [
      h('div', { class: 'sd-task-head' }, [
        h('div', { class: 'sd-row-main' }, [
          h('div', { class: 'sd-row-name', title: task.name }, task.name),
          h('div', { class: 'sd-row-sub' }, task.artist + ' · ' + label + (degraded ? '（请求 ' + (QUALITY_LABEL[task.quality] || task.quality) + '，已降级）' : ''))
        ]),
        h('div', { class: 'sd-task-actions' }, [
          h('span', { class: 'sd-status sd-status-' + task.status, 'data-role': 'status' }, statusText(task)),
          task.status === 'failed' ? h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'retry', onClick: () => retryTask(task) }, '重试') : null,
          active
            ? h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'cancel', onClick: () => cancelTask(task) }, '停止')
            : h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'remove', onClick: () => removeTask(task) }, '移除')
        ])
      ]),
      h('div', { class: 'sd-bar' }, h('div', { class: 'sd-bar-fill', style: { width: pct + '%' } })),
      h('div', { class: 'sd-task-foot' }, [
        h(
          'span',
          { class: 'sd-muted' },
          (task.total ? formatBytes(task.loaded) + ' / ' + formatBytes(task.total) : task.loaded ? formatBytes(task.loaded) : '大小未知') +
            (task.status === 'downloading' && task.speed > 0 ? ' · ' + formatSpeed(task.speed) : '') +
            (task.status === 'done' ? ' · ' + formatBytes(task.bytes) + (task.viaChunked ? ' · 分片' : '') : '')
        ),
        h('span', { class: 'sd-muted' }, taskTimeText(task))
      ]),
      task.fileName ? h('div', { class: 'sd-muted sd-mono' }, '文件名：' + task.fileName) : null,
      task.warning ? h('div', { class: 'sd-warn' }, '⚠ ' + task.warning) : null,
      task.needsVerify
        ? h('div', { class: 'sd-warn', 'data-role': 'needs-verify' }, '⚠ 需要完成酷狗安全验证：点「重试」会再次唤起验证弹窗')
        : null,
      task.error ? h('div', { class: 'sd-error' }, '✕ ' + task.error) : null
    ])
  }

  function renderHistory() {
    const items = state.history.slice(0, 60)
    return h('section', { class: 'sd-card', 'data-role': 'history-card' }, [
      h('div', { class: 'sd-card-head' }, [
        h('h3', null, '下载历史（' + state.history.length + '）'),
        h('div', { class: 'sd-head-actions' }, [
          h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'clear-history', onClick: () => clearHistory() }, '清空历史'),
          h('button', { class: 'sd-btn sd-btn-sm', 'data-action': 'copy-diagnostics', onClick: () => void copyDiagnosticsToClipboard() }, '复制诊断')
        ])
      ]),
      items.length
        ? h(
            'div',
            { class: 'sd-list' },
            items.map((item, i) =>
              h('div', { class: 'sd-row', key: 'h-' + item.id + '-' + i, 'data-history': item.id }, [
                h('div', { class: 'sd-row-main' }, [
                  h('div', { class: 'sd-row-name', title: item.name }, item.name),
                  h(
                    'div',
                    { class: 'sd-row-sub' },
                    item.artist +
                      ' · ' +
                      (QUALITY_LABEL[item.quality] || item.quality) +
                      ' · ' +
                      formatClock(item.at) +
                      (item.ok ? '' : ' · ' + (item.error || '失败'))
                  )
                ]),
                h('div', { class: 'sd-row-chips' }, [
                  h('span', { class: 'sd-chip' }, item.ok ? formatBytes(item.bytes) : '—'),
                  item.viaChunked ? h('span', { class: 'sd-chip' }, '分片') : null,
                  item.warning ? h('span', { class: 'sd-chip sd-chip-warn', title: item.warning }, '体积偏小') : null
                ]),
                h('div', { class: 'sd-task-actions' }, [
                  h(
                    'button',
                    {
                      class: 'sd-btn sd-btn-sm',
                      'data-action': 'history-link',
                      disabled: !item.url,
                      onClick: () =>
                        void (async () => {
                          const ok = await copyText(item.url, log)
                          notice(ok ? '已复制该次下载用到的直链' : '复制失败')
                        })()
                    },
                    '复制直链'
                  )
                ])
              ])
            )
          )
        : h('p', { class: 'sd-empty' }, '还没有下载记录。')
    ])
  }

  const DownloadPage = V.defineComponent({
    name: 'SongDownloaderPage',
    setup() {
      return () => {
        const overall = overallProgress()
        return h('div', { class: 'sd-page' }, [
          h('header', { class: 'sd-head' }, [
            h('div', null, [
              h('h1', { class: 'sd-title' }, '歌曲下载'),
              h('p', { class: 'sd-sub' }, '把当前播放或播放队列里的歌存到本地：自动挑可用音质（FLAC / 320K / HQ），分片下载带实时进度与速度。')
            ]),
            h('div', { class: 'sd-head-actions' }, [
              h('button', { class: 'sd-btn sd-btn-primary', 'data-action': 'download-current-top', onClick: () => void downloadCurrent() }, '下载当前歌曲'),
              h(
                'select',
                {
                  class: 'sd-select',
                  'data-action': 'quality-select',
                  value: state.settings.quality,
                  onChange: (e) => setSetting('quality', e.target.value)
                },
                [
                  ['auto', '音质：自动（最优可用）'],
                  ['flac', '音质：FLAC'],
                  ['320', '音质：320K'],
                  ['128', '音质：128K'],
                  ['high', '音质：Hi-Res'],
                  ['viper_tape', '音质：母带']
                ].map(([v, label]) => h('option', { value: v, selected: state.settings.quality === v }, label))
              )
            ])
          ]),
          overall.count
            ? h('div', { class: 'sd-card sd-progress-card', 'data-role': 'top-progress' }, [
                h('div', { class: 'sd-bar' }, h('div', { class: 'sd-bar-fill', style: { width: overall.pct + '%' } })),
                h(
                  'span',
                  { class: 'sd-muted' },
                  '正在下载 ' + overall.count + ' 个任务 · ' + formatBytes(overall.loaded) + (overall.total ? ' / ' + formatBytes(overall.total) : '') + ' · ' + overall.pct + '%'
                )
              ])
            : null,
          state.notice ? h('div', { class: 'sd-notice', 'data-role': 'notice' }, state.notice) : null,
          renderCurrentCard(),
          renderQueue(),
          renderTasks(),
          renderHistory(),
          h('footer', { class: 'sd-foot' }, [
            h(
              'p',
              { class: 'sd-muted' },
              '保存位置：主通道使用 Chromium 自身的下载行为，文件落到系统默认下载目录（Windows 通常是 C:\\Users\\<你>\\Downloads）。' +
                (canUseSavePicker() ? '需要指定位置时用「另存为…」（仅单曲）。' : '当前内核不支持「另存为」，需要指定位置请用「复制直链」交给下载工具。')
            ),
            h(
              'p',
              { class: 'sd-muted' },
              '为什么不能直接选目录：宿主没有把「写任意路径」的能力开放给插件（本地文件 API 被限制在插件目录内且单次 ≤ 8 MB，进程启动只允许插件目录内的 exe）。这是宿主的安全边界，本插件不改动它。'
            ),
            h(
              'p',
              { class: 'sd-muted' },
              '音质说明：可用音质来自歌曲的版权信息，缺版权 / 非 VIP 时可能只有 128K；请求高音质失败会自动降级，并在任务行里标明实际音质。'
            )
          ])
        ])
      }
    }
  })

  /* ---------------- 设置面板 ---------------- */

  const SettingsPanel = V.defineComponent({
    name: 'SongDownloaderSettings',
    setup() {
      const row = (key, label, hint, control) =>
        h('div', { class: 'sd-set-row', 'data-setting': key }, [
          h('div', { class: 'sd-set-label' }, [h('span', null, label), hint ? h('small', { class: 'sd-muted' }, hint) : null]),
          control
        ])

      const toggle = (key, label, hint) =>
        row(
          key,
          label,
          hint,
          h(
            'button',
            {
              class: 'sd-switch' + (state.settings[key] ? ' is-on' : ''),
              role: 'switch',
              'aria-checked': state.settings[key] ? 'true' : 'false',
              'data-on': state.settings[key] ? 'true' : 'false',
              onClick: () => setSetting(key, !state.settings[key])
            },
            state.settings[key] ? '已开启' : '已关闭'
          )
        )

      const select = (key, label, hint, options) =>
        row(
          key,
          label,
          hint,
          h(
            'select',
            { class: 'sd-select', value: state.settings[key], onChange: (e) => setSetting(key, e.target.value) },
            options.map(([v, text]) => h('option', { value: v, selected: String(state.settings[key]) === String(v) }, text))
          )
        )

      const numberInput = (key, label, hint, min, max) =>
        row(
          key,
          label,
          hint,
          h('input', {
            class: 'sd-input',
            type: 'number',
            min: String(min),
            max: String(max),
            value: String(state.settings[key]),
            onChange: (e) => setSetting(key, clamp(Number(e.target.value), min, max))
          })
        )

      return () =>
        h('div', { class: 'sd-settings' }, [
          h('section', { class: 'sd-card' }, [
            h('div', { class: 'sd-card-head' }, h('h3', null, '下载')),
            toggle('confirmBeforeDownload', '下载前弹确认框', '每次下载前弹窗确认音质 / 保存位置 / 文件名；关掉则直接用下面的默认设置开始下载'),
            select('quality', '默认音质', '「自动」= 该歌可用的最高音质；不可用时自动逐级降级', [
              ['auto', '自动（最优可用）'],
              ['flac', 'FLAC'],
              ['320', '320K'],
              ['128', '128K'],
              ['high', 'Hi-Res'],
              ['viper_tape', '母带']
            ]),
            select('saveMode', '保存方式', '「直接下载」落到系统下载目录；「弹窗询问」仅对单曲生效（需要内核支持）', [
              ['direct', '直接下载到系统下载目录'],
              ['ask', '弹窗询问保存位置（单曲）']
            ]),
            row(
              'fileNameTemplate',
              '文件名模板',
              '可用占位符：{artist} {name} {album} {quality} {ext} {time}',
              h('input', {
                class: 'sd-input',
                type: 'text',
                value: state.settings.fileNameTemplate,
                onChange: (e) => setSetting('fileNameTemplate', e.target.value)
              })
            )
          ]),
          h('section', { class: 'sd-card' }, [
            h('div', { class: 'sd-card-head' }, h('h3', null, '性能与容错')),
            toggle('chunked', '分片下载（推荐）', '按 Range 分片取字节，能显示真实进度与速度；关闭则一次性下载（只有总进度）'),
            numberInput('chunkSizeMb', '分片大小（MB）', '1–8 MB，越大请求次数越少、进度越粗', 1, 8),
            numberInput('maxRetries', '失败重试次数', '每个分片 / 整包的重试次数，0 = 不重试', 0, 3),
            numberInput('concurrency', '同时下载数', '1–2，默认 1（对上游 CDN 更友好）', 1, 2)
          ]),
          h('section', { class: 'sd-card' }, [
            h('div', { class: 'sd-card-head' }, h('h3', null, '界面与通知')),
            toggle('sidebarEntry', '侧边栏显示入口', '关闭后可从插件管理页重新启用；立即生效'),
            toggle('toolbarEntry', '顶部工具栏显示入口', '在标题栏放一个「下载当前歌曲」按钮；立即生效'),
            toggle('playerBarButton', '播放栏显示下载按钮', '在播放栏右侧（收藏 / 播放队列那排）插一个下载按钮；立即生效，不需要重启'),
            toggle('toastOnDone', '完成时弹提示', '关闭后只在任务列表里显示结果'),
            toggle('debug', '调试日志', '在控制台输出解析与下载细节，便于排障')
          ]),
          h(
            'p',
            { class: 'sd-muted sd-footnote' },
            '本插件只读写自己命名空间下的存储。网络请求有两个去向：宿主内置的酷狗本地接口（/song/url）与歌曲 CDN 直链。不加载任何第三方代码，不上传任何数据。'
          )
        ])
    }
  })

  /* ---------------- 下载确认框 ---------------- */

  const QUALITY_OPTIONS = [
    ['auto', '自动（最优可用）'],
    ['flac', 'FLAC'],
    ['320', '320K'],
    ['128', '128K'],
    ['high', 'Hi-Res'],
    ['viper_tape', '母带']
  ]

  function isAbortError(e) {
    const msg = (e && e.message) || String(e === undefined || e === null ? '' : e)
    return !!(e && (e.name === 'AbortError' || /cancel|已取消|用户取消/i.test(msg)))
  }

  /** 弹窗里「实际会用的音质」：auto = 该歌可用的最高音质 */
  function dlgEffectiveQuality() {
    if (dlg.quality !== 'auto') return dlg.quality
    const first = dlg.tracks[0]
    if (!first) return '128'
    return availableQualities(first.track.relateGoods).slice(-1)[0] || '128'
  }

  function dlgPreviewName() {
    const first = dlg.tracks[0]
    if (!first) return ''
    if (dlg.destination === 'picker' && dlg.pickedName) return dlg.pickedName
    const q = dlgEffectiveQuality()
    const ext = guessExtByQuality(q)
    return buildFileName(first.track, q, ext, dlg.template || state.settings.fileNameTemplate)
  }

  /**
   * 所有「下载」入口都先走这里：
   * - 关掉 confirmBeforeDownload → 直接入队（老行为）
   * - 开着 → 弹确认框，让用户改音质 / 选保存位置 / 改文件名模板
   */
  function openDownloadDialog(rawTracks) {
    const list = []
    for (const raw of rawTracks) {
      const track = toNormalized(raw)
      if (!track) continue
      if (track.unsupported) {
        notice(track.unsupported)
        continue
      }
      list.push({ raw, track })
    }
    if (!list.length) return null
    if (!state.settings.confirmBeforeDownload) {
      startDownloads(
        list.map((x) => x.raw),
        state.settings.quality
      )
      return null
    }
    dlg.tracks = list
    dlg.quality = state.settings.quality
    dlg.destination = 'downloads'
    dlg.pickedName = ''
    dlg.template = state.settings.fileNameTemplate
    dlg.chunked = !!state.settings.chunked
    dlg.toastOnDone = !!state.settings.toastOnDone
    dlg.remember = true
    dlg.error = ''
    dlg.busy = false
    dlgGen += 1
    dlg.open = true
    return dlg
  }

  function closeDownloadDialog() {
    dlgGen += 1
    dlg.open = false
    dlg.tracks = []
    dlg.error = ''
    dlg.busy = false
    dlg.pickedName = ''
  }

  /**
   * 只把「保存位置」切到 picker，**不**立刻弹系统对话框。
   * 原因：Chromium 的 showSaveFilePicker 一确认就会先把 0 字节文件建出来，
   * 如果此刻地址还没解析（风控/版权失败很常见），失败后就会在磁盘上留下一堆空文件。
   * 所以顺序必须是：点「开始下载」→ 先解析 → 再弹保存对话框 → 再写字节。
   */
  function chooseSaveTarget() {
    const first = dlg.tracks[0]
    if (!first) return
    if (dlg.tracks.length > 1) {
      dlg.error = '批量下载只能存到系统下载目录（避免逐首弹窗）'
      return
    }
    if (!canUseSavePicker()) {
      dlg.error = '当前内核不支持「选择位置」；可改用系统下载目录，或用「复制直链」交给下载工具'
      return
    }
    dlg.destination = 'picker'
    dlg.pickedName = ''
    dlg.error = ''
  }

  async function confirmDownloadDialog() {
    if (!dlg.open || dlg.busy) return
    const list = dlg.tracks.slice()
    if (!list.length) {
      closeDownloadDialog()
      return
    }
    const quality = dlg.quality
    const wantPicker = dlg.destination === 'picker'
    if (wantPicker && list.length > 1) {
      dlg.error = '批量下载只能存到系统下载目录'
      return
    }

    let preResolved = null
    let handle = null
    if (wantPicker) {
      // gen 用来防「解析/对话框还没结束，用户已经 Esc 关掉弹窗」后仍然开下
      const gen = (dlgGen += 1)
      dlg.busy = true
      dlg.error = ''
      try {
        const resolved = await resolveAudio(ctx, list[0].track, quality, log)
        if (gen !== dlgGen) return
        if (!resolved.ok) {
          dlg.error = '解析失败：' + resolved.error + '（没有创建任何文件）'
          return
        }
        preResolved = resolved
        const ext = resolved.ext || guessExtByQuality(resolved.quality)
        const name = buildFileName(list[0].track, resolved.quality, ext, dlg.template || state.settings.fileNameTemplate)
        const h = await pickSaveHandle(name, ext)
        if (gen !== dlgGen) {
          // 弹窗已被关掉：把刚建出来的空文件清掉，别留残骸
          try {
            if (h && typeof h.remove === 'function') await h.remove()
          } catch {
            /* 忽略 */
          }
          return
        }
        handle = h
        dlg.pickedName = (h && h.name) || name
      } catch (e) {
        if (gen !== dlgGen) return
        if (isAbortError(e)) {
          dlg.error = '已取消选择位置（没有创建文件）'
          return
        }
        log('另存为对话框失败', e)
        dlg.error = '无法打开系统保存对话框：' + ((e && e.message) || String(e))
        return
      } finally {
        if (gen === dlgGen) dlg.busy = false
      }
    }

    if (dlg.remember) {
      setSetting('quality', quality)
      setSetting('fileNameTemplate', dlg.template || DEFAULT_SETTINGS.fileNameTemplate)
      setSetting('chunked', !!dlg.chunked)
      setSetting('toastOnDone', !!dlg.toastOnDone)
    }
    const raws = list.map((x) => x.raw)
    const opts = handle ? { saveHandle: handle, preResolved } : undefined
    closeDownloadDialog()
    startDownloads(raws, quality, opts)
  }

  function onOptionClick(group, value) {
    if (group === 'quality') {
      dlg.quality = value
      return
    }
    if (group === 'dest') {
      if (value === 'downloads') {
        dlg.destination = 'downloads'
        dlg.pickedName = ''
        dlg.error = ''
        return
      }
      chooseSaveTarget()
    }
  }

  function optionChip(group, value, label, active, disabled, extra) {
    return h(
      'button',
      {
        type: 'button',
        class: 'sd-opt' + (active ? ' is-on' : ''),
        role: 'radio',
        'aria-checked': active ? 'true' : 'false',
        'data-group': group,
        'data-value': value,
        disabled: !!disabled,
        title: (extra && extra.title) || undefined,
        onClick: () => onOptionClick(group, value)
      },
      label
    )
  }

  function renderDialogBody() {
    const first = dlg.tracks[0]
    const multi = dlg.tracks.length > 1
    const curQuality = dlgEffectiveQuality()

    const songsBlock = multi
      ? h('div', { class: 'sd-dlg-songs', 'data-role': 'dlg-songs' }, [
          ...dlg.tracks.slice(0, 6).map((x, i) =>
            h('div', { class: 'sd-dlg-song', key: 's-' + i }, [
              h('span', { class: 'sd-dlg-song-name', title: x.track.name }, x.track.name),
              h('span', { class: 'sd-muted' }, x.track.artist)
            ])
          ),
          dlg.tracks.length > 6 ? h('div', { class: 'sd-muted' }, '…还有 ' + (dlg.tracks.length - 6) + ' 首') : null
        ])
      : h('div', { class: 'sd-dlg-current' }, [
          first.track.coverUrl
            ? h('img', { class: 'sd-cover', src: first.track.coverUrl, alt: '' })
            : h('div', { class: 'sd-cover sd-cover-empty' }, '♪'),
          h('div', { class: 'sd-meta' }, [
            h('div', { class: 'sd-name', title: first.track.name }, first.track.name),
            h('div', { class: 'sd-artist' }, first.track.artist + (first.track.album ? ' · ' + first.track.album : '')),
            h('div', { class: 'sd-chips' }, [h('span', { class: 'sd-muted' }, '可用音质：'), ...qualityChips(first.track)])
          ])
        ])

    const qualityBlock = h('div', { class: 'sd-dlg-block' }, [
      h('div', { class: 'sd-dlg-label' }, '音质'),
      h(
        'div',
        { class: 'sd-opt-group', 'data-role': 'dlg-quality-group' },
        QUALITY_OPTIONS.map(([value, label]) =>
          optionChip('quality', value, label, dlg.quality === value, false, {
            title: value === 'auto' ? '每首歌各自取可用的最高音质' : label
          })
        )
      ),
      h('div', { class: 'sd-muted' }, multi ? '批量下载时每首歌各自按这个音质取，取不到会自动降级' : '实际会使用：' + (QUALITY_LABEL[curQuality] || curQuality))
    ])

    const destBlock = h('div', { class: 'sd-dlg-block' }, [
      h('div', { class: 'sd-dlg-label' }, '保存位置'),
      h('div', { class: 'sd-opt-group', 'data-role': 'dlg-dest-group' }, [
        optionChip('dest', 'downloads', '系统下载目录', dlg.destination === 'downloads', false, {
          title: 'Windows 通常是 %USERPROFILE%\\Downloads'
        }),
        optionChip('dest', 'picker', canUseSavePicker() ? '选择位置…' : '选择位置（不支持）', dlg.destination === 'picker', multi || !canUseSavePicker(), {
          title: multi ? '批量下载只能存到系统下载目录' : '打开系统保存对话框，自己选目录与文件名'
        })
      ]),
      h(
        'div',
        { class: 'sd-muted' },
        dlg.destination === 'picker' && dlg.pickedName
          ? '将保存到：' + dlg.pickedName
          : dlg.destination === 'picker'
            ? '点「开始下载」后**先解析播放地址**，再弹出系统保存对话框 —— 解析失败不会创建任何文件（避免留下 0 KB 空文件）'
            : multi
              ? '批量下载逐首落到系统下载目录（Windows 通常是 %USERPROFILE%\\Downloads）'
              : '落到系统下载目录（Windows 通常是 %USERPROFILE%\\Downloads）；想指定位置点「选择位置…」'
      )
    ])

    const nameBlock = h('div', { class: 'sd-dlg-block' }, [
      h('div', { class: 'sd-dlg-label' }, '文件名'),
      h('input', {
        class: 'sd-input sd-dlg-input',
        type: 'text',
        value: dlg.template,
        'data-action': 'dlg-template',
        placeholder: '{artist} - {name}',
        onChange: (e) => {
          dlg.template = e.target.value
        }
      }),
      h('div', { class: 'sd-muted sd-mono', 'data-role': 'dlg-preview' }, '将保存为：' + (dlgPreviewName() || '-')),
      h('div', { class: 'sd-muted' }, '可用占位符：{artist} {name} {album} {quality} {ext} {time}')
    ])

    const extraBlock = h('div', { class: 'sd-dlg-block sd-dlg-extra' }, [
      h(
        'button',
        {
          type: 'button',
          class: 'sd-chip-toggle' + (dlg.chunked ? ' is-on' : ''),
          role: 'switch',
          'aria-checked': dlg.chunked ? 'true' : 'false',
          'data-action': 'dlg-chunked'
        },
        (dlg.chunked ? '✓ ' : '') + '分片下载（显示进度与速度）'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'sd-chip-toggle' + (dlg.toastOnDone ? ' is-on' : ''),
          role: 'switch',
          'aria-checked': dlg.toastOnDone ? 'true' : 'false',
          'data-action': 'dlg-toast'
        },
        (dlg.toastOnDone ? '✓ ' : '') + '完成后弹提示'
      )
    ])

    return [songsBlock, qualityBlock, destBlock, nameBlock, extraBlock, dlg.error ? h('div', { class: 'sd-error', 'data-role': 'dlg-error' }, '✕ ' + dlg.error) : null]
  }

  /** 全局键盘：Esc 关闭确认框，Ctrl/Cmd+Enter 直接开始下载。
   *  监听放在 activate 里注册（而不是组件 onMounted）—— teleport 出去的是独立 app 实例，
   *  用全局监听既简单又能保证卸载时一定摘掉。 */
  function onDialogKey(e) {
    if (!dlg.open || !e) return
    if (e.key === 'Escape') {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      if (typeof e.stopPropagation === 'function') e.stopPropagation()
      closeDownloadDialog()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      confirmDownloadDialog()
    }
  }

  const DownloadDialog = V.defineComponent({
    name: 'SongDownloaderDialog',
    setup() {
      return () => {
        if (!dlg.open) return null
        const count = dlg.tracks.length
        return h(
          'div',
          {
            class: 'sd-mask',
            'data-role': 'download-dialog',
            onClick: (e) => {
              if (e.target === e.currentTarget) closeDownloadDialog()
            }
          },
          [
            h('div', { class: 'sd-dialog', onClick: (e) => e.stopPropagation() }, [
              h('div', { class: 'sd-dialog-head' }, [
                h('div', null, [
                  h('h3', null, count > 1 ? '下载 ' + count + ' 首歌' : '下载歌曲'),
                  h('p', { class: 'sd-muted' }, count > 1 ? '逐首下载，可随时在任务列表里停止' : '确认音质与保存位置后开始')
                ]),
                h(
                  'button',
                  { type: 'button', class: 'sd-dialog-close', 'data-action': 'dlg-close', title: '关闭（Esc）', onClick: () => closeDownloadDialog() },
                  '✕'
                )
              ]),
              h('div', { class: 'sd-dialog-body' }, renderDialogBody()),
              h('div', { class: 'sd-dialog-foot' }, [
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'sd-chip-toggle' + (dlg.remember ? ' is-on' : ''),
                    role: 'switch',
                    'aria-checked': dlg.remember ? 'true' : 'false',
                    'data-action': 'dlg-remember',
                    title: '把这次的音质 / 文件名模板 / 下载选项记到插件设置里',
                    onClick: () => {
                      dlg.remember = !dlg.remember
                    }
                  },
                  (dlg.remember ? '✓ ' : '') + '记住这些选项'
                ),
                h('div', { class: 'sd-dialog-actions' }, [
                  h('button', { type: 'button', class: 'sd-btn', 'data-action': 'dlg-cancel', disabled: !!dlg.busy, onClick: () => closeDownloadDialog() }, '取消'),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'sd-btn sd-btn-primary',
                      'data-action': 'dlg-confirm',
                      disabled: !!dlg.busy,
                      onClick: () => void confirmDownloadDialog()
                    },
                    dlg.busy ? '准备中…' : count > 1 ? '开始下载（' + count + '）' : '开始下载'
                  )
                ])
              ])
            ])
          ]
        )
      }
    }
  })

  /* ---------------- 播放栏按钮 ---------------- */

  let barMountDispose = null
  let barObserveDispose = null
  let barMutation = null
  let barTimer = null
  let barEnsureTimer = null
  let barEnabled = false

  const PlayerBarButton = V.defineComponent({
    name: 'SongDownloaderBarButton',
    setup() {
      return () => {
        const raw = currentTrack()
        const track = raw ? toNormalized(raw) : null
        const running = !!(
          track &&
          state.tasks.some(
            (t) =>
              t.trackId === track.id &&
              (t.status === 'pending' || t.status === 'resolving' || t.status === 'downloading' || t.status === 'saving')
          )
        )
        const disabled = !track || !!track.unsupported || running
        const tip = !track
          ? '当前没有正在播放的歌曲'
          : track.unsupported
            ? track.unsupported
            : running
              ? '正在下载这首…'
              : '下载当前歌曲'
        return h(
          'button',
          {
            type: 'button',
            class: 'sd-bar-btn',
            'data-action': 'download-current-bar',
            title: tip,
            'aria-label': '下载当前歌曲',
            disabled,
            onClick: (e) => {
              e.stopPropagation()
              void downloadCurrent()
            }
          },
          [
            h(
              'svg',
              {
                class: 'sd-bar-icon',
                viewBox: '0 0 24 24',
                width: '18',
                height: '18',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': '1.8',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
                'aria-hidden': 'true'
              },
              [
                h('path', { d: 'M12 4v10' }),
                h('path', { d: 'M8.4 10.6 12 14.2l3.6-3.6' }),
                h('path', { d: 'M5 16.6v1.6A2.8 2.8 0 0 0 7.8 21h8.4A2.8 2.8 0 0 0 19 18.2v-1.6' })
              ]
            )
          ]
        )
      }
    }
  })

  /**
   * 播放栏没有「插件按钮」这种一等公民 API，所以走宿主给的 DOM 挂载通道：
   *   ctx.ui.mount('.player-actions', 组件)  —— 不需要自己 createElement/appendChild
   * 重渲染兜底：宿主原地重渲会把我们塞进去的节点抹掉，dom.observe 不会为「同一个元素」再回调，
   * 所以额外用 MutationObserver（防抖）+ 1.5s 轮询把按钮补回来。
   */
  function ensureBarButton() {
    if (!barEnabled || typeof document === 'undefined' || typeof document.querySelector !== 'function') return
    const host = document.querySelector('.player-actions') || document.querySelector('.player-bar')
    if (!host || typeof host.querySelector !== 'function') return
    if (host.querySelector('.sd-bar-btn')) return
    if (typeof barMountDispose === 'function') {
      try {
        barMountDispose()
      } catch {
        /* 忽略 */
      }
    }
    barMountDispose = null
    try {
      const dispose = ctx.ui && typeof ctx.ui.mount === 'function' ? ctx.ui.mount(host, PlayerBarButton) : null
      barMountDispose = typeof dispose === 'function' ? dispose : null
      log('已挂载播放栏下载按钮')
    } catch (e) {
      log('挂载播放栏按钮失败', e)
    }
  }

  function scheduleEnsureBarButton() {
    if (barEnsureTimer || !barEnabled) return
    barEnsureTimer = setTimeout(() => {
      barEnsureTimer = null
      ensureBarButton()
    }, 180)
  }

  function applyPlayerBarButton(enabled) {
    barEnabled = !!enabled
    if (barEnabled) {
      if (!barObserveDispose && ctx.dom && typeof ctx.dom.observe === 'function') {
        try {
          const dispose = ctx.dom.observe('.player-actions', () => ensureBarButton())
          barObserveDispose = typeof dispose === 'function' ? dispose : null
        } catch (e) {
          log('监听播放栏失败', e)
        }
      }
      if (!barMutation && typeof MutationObserver === 'function') {
        try {
          barMutation = new MutationObserver(() => scheduleEnsureBarButton())
          barMutation.observe(document.body, { childList: true, subtree: true })
        } catch (e) {
          barMutation = null
          log('播放栏 MutationObserver 失败', e)
        }
      }
      if (!barTimer) {
        barTimer = setInterval(() => {
          if (barEnabled) ensureBarButton()
        }, 1500)
      }
      ensureBarButton()
      return true
    }
    if (typeof barMountDispose === 'function') {
      try {
        barMountDispose()
      } catch {
        /* 忽略 */
      }
    }
    barMountDispose = null
    if (typeof barObserveDispose === 'function') {
      try {
        barObserveDispose()
      } catch {
        /* 忽略 */
      }
    }
    barObserveDispose = null
    if (barMutation) {
      try {
        barMutation.disconnect()
      } catch {
        /* 忽略 */
      }
      barMutation = null
    }
    if (barTimer) {
      clearInterval(barTimer)
      barTimer = null
    }
    if (barEnsureTimer) {
      clearTimeout(barEnsureTimer)
      barEnsureTimer = null
    }
    return true
  }

  /* ---------------- 注册 ---------------- */

  let sidebarDispose = null
  let toolbarDispose = null
  let settingsDispose = null
  let dialogDispose = null

  function applySidebarEntry(enabled) {
    if (enabled) {
      if (sidebarDispose) return true
      try {
        const dispose =
          ctx.ui && ctx.ui.sidebar && typeof ctx.ui.sidebar.addItem === 'function'
            ? ctx.ui.sidebar.addItem({
                id: PLUGIN_ID + '-entry',
                title: '下载',
                icon: 'tabler:download',
                pageId: 'download',
                section: 'plugins',
                sectionTitle: '插件',
                order: 32
              })
            : null
        sidebarDispose = typeof dispose === 'function' ? dispose : () => {}
        log('侧边栏入口已注册')
        return true
      } catch (e) {
        log('注册侧边栏入口失败', e)
        sidebarDispose = null
        return false
      }
    }
    if (typeof sidebarDispose === 'function') {
      try {
        sidebarDispose()
      } catch (e) {
        log('移除侧边栏入口失败', e)
      }
    }
    sidebarDispose = null
    return true
  }

  function applyToolbarEntry(enabled) {
    if (enabled) {
      if (toolbarDispose) return true
      try {
        const dispose =
          ctx.ui && ctx.ui.titlebar && typeof ctx.ui.titlebar.register === 'function'
            ? ctx.ui.titlebar.register({
                id: PLUGIN_ID,
                title: '下载',
                icon: 'tabler:download',
                tooltip: '下载当前播放的歌曲',
                defaultPlacement: 'toolbar',
                order: 120,
                onClick: () => void downloadCurrent()
              })
            : null
        toolbarDispose = typeof dispose === 'function' ? dispose : () => {}
        return true
      } catch (e) {
        log('注册顶部入口失败', e)
        toolbarDispose = null
        return false
      }
    }
    if (typeof toolbarDispose === 'function') {
      try {
        toolbarDispose()
      } catch (e) {
        log('移除顶部入口失败', e)
      }
    }
    toolbarDispose = null
    return true
  }

  ctx.ui.addPage({ id: 'download', title: '下载', icon: 'tabler:download', component: DownloadPage })

  applySidebarEntry(state.settings.sidebarEntry)
  applyToolbarEntry(state.settings.toolbarEntry)

  settingsDispose = ctx.ui.settings.define({
    title: '歌曲下载 设置',
    description: '默认音质、下载确认框、保存方式、播放栏按钮与下载性能选项。',
    component: SettingsPanel
  })

  // 下载确认框挂在 document.body 上：插件页/设置弹窗都有 overflow:hidden 的祖先，
  // 就地渲染会被裁掉；宿主的 ui.teleport 会以 .echo-plugin-teleport 追加到 body。
  try {
    if (ctx.ui && typeof ctx.ui.teleport === 'function') {
      dialogDispose = ctx.ui.teleport(DownloadDialog, { id: PLUGIN_ID + '-dialog', className: 'sd-teleport' })
    }
  } catch (e) {
    log('挂载下载确认框失败', e)
  }

  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', onDialogKey, true)
    }
  } catch (e) {
    log('注册 Esc 快捷键失败', e)
  }

  applyPlayerBarButton(state.settings.playerBarButton)

  if (ctx.commands && typeof ctx.commands.register === 'function') {
    ctx.commands.register('download-current', () => void downloadCurrent(), { title: '下载当前播放的歌曲' })
    ctx.commands.register('download-current-as', () => void downloadCurrentAs(), { title: '下载当前歌曲并选择保存位置' })
    ctx.commands.register('cancel-all-downloads', () => cancelAll(), { title: '停止全部下载任务' })
  }

  /* ---------------- 队列变化时清理失效选择（避免选择状态无界增长） ---------------- */

  const watchers = []
  try {
    const stop = watch(
      () => readQueue().length,
      () => {
        const keys = new Set(readQueue().map((s) => trackKey(normalizeTrack(s) || {})))
        for (const k of Object.keys(state.selected)) {
          if (!keys.has(k)) delete state.selected[k]
        }
      }
    )
    if (typeof stop === 'function') watchers.push(stop)
  } catch (e) {
    log('监听队列失败', e)
  }

  runtime = { state }

  ctx.dispose(() => {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    for (const timer of noticeTimers) clearTimeout(timer)
    noticeTimers.length = 0
    for (const t of state.tasks) {
      const ctrl = controllers.get(t.id)
      if (ctrl) ctrl.canceled = true
    }
    controllers.clear()
    saveTargets.clear()
    for (const stop of watchers) {
      try {
        if (typeof stop === 'function') stop()
      } catch {
        /* 忽略 */
      }
    }
    watchers.length = 0
    if (typeof sidebarDispose === 'function') {
      try {
        sidebarDispose()
      } catch {
        /* 忽略 */
      }
    }
    sidebarDispose = null
    if (typeof toolbarDispose === 'function') {
      try {
        toolbarDispose()
      } catch {
        /* 忽略 */
      }
    }
    toolbarDispose = null
    if (typeof settingsDispose === 'function') {
      try {
        settingsDispose()
      } catch {
        /* 忽略 */
      }
    }
    settingsDispose = null
    if (typeof dialogDispose === 'function') {
      try {
        dialogDispose()
      } catch {
        /* 忽略 */
      }
    }
    dialogDispose = null
    try {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('keydown', onDialogKey, true)
      }
    } catch {
      /* 忽略 */
    }
    applyPlayerBarButton(false)
    closeDownloadDialog()
    log('已停用并回收资源')
  })

  log('已启用，v' + ((ctx.manifest && ctx.manifest.version) || '?'))

  return {
    state,
    dlg,
    downloadCurrent,
    downloadCurrentAs,
    startDownloads,
    openDownloadDialog,
    closeDownloadDialog,
    confirmDownloadDialog,
    chooseSaveTarget,
    dlgPreviewName,
    cancelAll,
    cancelTask,
    retryTask,
    removeTask,
    clearFinished,
    clearHistory,
    copyDirectLink,
    copyDiagnostics,
    resolveAudio,
    currentTrack,
    readQueue,
    toNormalized,
    ensureBarButton
  }
}

export async function deactivate() {
  if (runtime && runtime.state) {
    for (const t of runtime.state.tasks) {
      const s = t.status
      if (s === 'pending' || s === 'downloading' || s === 'resolving' || s === 'saving') t.status = 'canceled'
    }
  }
  ctxRef = null
  runtime = null
}

/* ========================================================================== *
 * 纯函数导出（供无头测试直接断言真实文件内容；宿主只读 activate/deactivate）
 * ========================================================================== */

export const __internals = {
  QUALITY_LADDER,
  QUALITY_LABEL,
  DEFAULT_SETTINGS,
  normalizeTrack,
  trackSnapshot,
  trackOfTask,
  availableQualities,
  qualityMatch,
  pickHashForQuality,
  candidateQualities,
  extractUrls,
  extFromUrl,
  pickExt,
  describeFailure,
  verificationEventId,
  sanitizeFileName,
  buildFileName,
  parseTotalFromContentRange,
  headerGet,
  looksLikeImageBytes,
  formatBytes,
  formatSpeed,
  formatSeconds,
  clamp,
  findFieldDeep,
  firstOf,
  guessExtByQuality,
  mimeForExt
}
