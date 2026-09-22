/**
 * 推荐电台 —— EchoMusic 音乐推荐插件
 * ---------------------------------------------------------------------------
 * 参考 MakcRe/KuGouMusicApi 的推荐类接口（module/ 目录下的 everyday_* / fm_* /
 * personal_fm / ai_recommend_* / recommend_songs / top_song / user_history /
 * youth_* 等），把它们编排成一个可播放、可续杯、可反馈的推荐电台。
 *
 * 两条取数通道（与宿主自带的酷狗能力对齐，插件自己不实现签名与设备指纹）：
 *
 *   1) 本地路由通道  ctx.electron.api.request({ url: '/everyday/recommend', ... })
 *      → 主进程内的 KuGouMusicApi 模块（resources/server/module/*.js）。
 *        路由规则：模块文件名去掉 .js 后把 `_` 换成 `/`。
 *        鉴权：headers.Authorization 会被宿主按 "k=v; k=v" 解析成 cookie。
 *
 *   2) 网关直连通道  ctx.net.request({ url: 'https://gateway.kugou.com/...' })
 *      → 概念版（youth）网关，与官方插件 channel-wander 同源同款，
 *        无需登录即可拿到推荐流，是「无账号也能用」的兜底源。
 *
 * 设计上刻意做成「多源 + 源健康检查」：不同宿主机型/账号态下各源可用性差异较大，
 * 面板里可以一键逐源打点，直接看到 HTTP / error_code / 返回条数 / 耗时。
 */

const PLUGIN_ID = 'kugou-recommend'

const KEY_SETTINGS = 'settings'
const KEY_MARKS = 'marks'
const KEY_STATS = 'stats'

const REQUEST_TIMEOUT_MS = 15000
const MAX_LIKED = 500
const MAX_BLOCKED = 3000
const MAX_SEEN = 2000
const LIST_RENDER_LIMIT = 300

const GATEWAY_CHANNEL_WANDER = 'https://gateway.kugou.com/youth/v1/recommend/channel_wander'

const DEFAULT_SETTINGS = {
  defaultSource: 'channel', // 启动时选用的推荐源
  batchSize: 30, // 每批拉取/展示数量
  autoRefreshOnSwitch: true, // 切换推荐源时是否立即拉一批（关闭则只切源，保留当前列表）
  autoRadio: true, // 电台模式：队列快播完时自动续下一批
  refillThreshold: 2, // 队列剩余多少首时触发续杯
  dedupe: true, // 同一会话内不重复推荐同一首（按 hash）
  filterBlocked: true, // 过滤「不感兴趣」的歌
  shuffle: false, // 拉回后随机打散
  showQuality: true, // 列表显示音质标签
  showCover: true, // 列表显示封面
  sidebarEntry: true, // 侧边栏「插件」分组里显示入口
  toastOnRadio: false, // 电台续杯时弹提示（默认静默，避免打断）
  tags: '', // 频道漫游 / 曲风推荐的标签
  historyDate: '', // 每日历史：指定日期（YYYY-MM-DD），留空取列表
  debug: false // 调试日志
}

// 酷狗业务错误码 → 人类可读文案（只列与本插件强相关的）
const ERROR_TEXT = {
  0: '成功',
  20010: '上游拒绝了该请求（参数或权限不符）',
  20018: '登录状态无效，请在宿主里重新登录',
  51002: '登录状态无效，请在宿主里重新登录',
  20028: '账号触发风控，需要安全验证',
  21001: '接口参数有误',
  30002: '该次数已用光'
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

function safeJson(text) {
  if (isObj(text)) return text
  try {
    return JSON.parse(String(text))
  } catch {
    return null
  }
}

function clipText(s, n) {
  const t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ')
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 点号路径取值，任意一层不存在都安全返回 undefined */
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
 * 在对象图里按候选键名做一次「限深广度优先」查找，返回第一个非空标量。
 *
 * 为什么需要它：酷狗各接口对同一件事的键名与嵌套层级并不统一。
 * 实测 `/user/history`（听歌排行）返回的条目，歌名/歌手既不在 `base` 上，
 * 也不叫 `songname` / `author_name`，于是在真机上显示成「未知歌曲 - 未知歌手」。
 * 与其逐个接口去猜键名，不如按候选键名做一次限深 BFS：
 * BFS 天然优先命中最浅层，所以调用方只要把「精确键名」放第一次调用、
 * 把「泛化键名」（name / title）放到第二次调用，就能避免"先撞上旁边的无关字段"。
 *
 * 对外只暴露两个参数，递归深度是内部状态 —— 这是本仓库踩过的坑：
 * `deepFind(body, keys, "")` 曾把 fallback 传成 depth，导致深层字段静默查不到。
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
      for (const item of node.slice(0, 8)) if (isObj(item)) queue.push({ node: item, d: cur.d + 1 })
      continue
    }
    if (!isObj(node) || cur.d > depth) continue

    for (const k of keys) {
      const v = node[k]
      if (typeof v === 'string' || typeof v === 'number') {
        const s = String(v).trim()
        if (s) return s
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (isObj(v)) queue.push({ node: v, d: cur.d + 1 })
    }
  }
  return undefined
}

/**
 * 数组去重（按 key 函数）。
 * 注意：只暴露两个参数 —— 内部递归工具一律用「双函数」写法，避免把默认参数
 * 误传给递归深度（这是本仓库踩过的坑，见 kugou-daily-vip 的 deepFind 注释）。
 */
function uniqBy(arr, keyFn) {
  const out = []
  const seen = new Set()
  for (const item of arr || []) {
    const k = keyFn(item)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

function shuffleCopy(arr) {
  const a = (arr || []).slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(num(seconds, 0)))
  if (!s) return ''
  const m = Math.floor(s / 60)
  const r = s % 60
  return m + ':' + String(r).padStart(2, '0')
}

function beijingDateKey(offsetDays) {
  const n = Number.isFinite(offsetDays) ? offsetDays : 0
  const d = new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 8 * 3600000 + n * 86400000)
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  )
}

/* ========================================================================== *
 * 上游响应 → 宿主可播放的 track
 * ========================================================================== */

const HASH_MIN_LEN = 16
const HASH_FIELDS = ['hash', 'hash_128', 'hash_320', 'hash_flac', 'hash_high', 'file_hash']

function isHashLike(v) {
  return typeof v === 'string' && v.length >= HASH_MIN_LEN
}

function hasHashLike(o) {
  if (!isObj(o)) return false
  for (const f of HASH_FIELDS) if (isHashLike(o[f])) return true
  const ai = o.audio_info || o.audioInfo
  if (isObj(ai)) for (const f of HASH_FIELDS) if (isHashLike(ai[f])) return true
  return false
}

/** 一首歌可能是裸对象，也可能被包在 item.song 里（channel_wander 就是后者） */
function looksLikeSong(item) {
  if (!isObj(item)) return false
  if (hasHashLike(item)) return true
  if (isObj(item.song) && hasHashLike(item.song)) return true
  return false
}

function unwrapSong(raw) {
  if (!isObj(raw)) return null
  const s = raw.song
  if (isObj(s) && (isObj(s.base) || isObj(s.audio_info) || hasHashLike(s))) return s
  return raw
}

/**
 * 这条记录带不带「名称类」信息（歌名/歌手/文件名）。
 *
 * 两个用途：
 *  1) 挑数组时给它加权 —— 有的接口会同时返回「hash 列表」和「带完整信息的列表」，
 *     只按 hash 命中数打分会在两者间随机选，可能挑到光秃秃的 hash 列表。
 *  2) 判断某条记录是否还需要按 hash 反查歌曲信息（实测 `/user/history` 就是纯 hash 记录）。
 */
function hasNameLike(o) {
  if (!isObj(o)) return false
  const s = unwrapSong(o)
  const scope = [s, s.base, s.audio_info, o]
  for (const node of scope) {
    if (!isObj(node)) continue
    for (const k of NAME_FIELDS) {
      if (typeof node[k] === 'string' && node[k].trim()) return true
    }
  }
  return false
}

const NAME_FIELDS = [
  'songname', 'song_name', 'songName', 'audio_name', 'audioName', 'filename',
  'author_name', 'authorName', 'singername', 'singer_name', 'singer', 'artist', 'name', 'title'
]

/**
 * 从任意上游响应里把「歌曲数组」找出来。
 * 不同接口的载荷层级差异很大（data / data.songs / data.song_list /
 * data.info / data.list[].songs …），与其给每个源写一套解析，不如
 * 广度优先遍历一遍对象图，挑「最像歌曲列表」的那个数组。
 * 打分优先级：带名称信息的条目数 >> 命中 hash 的条目数 > 数组长度。
 */
function pickTrackArray(body) {
  if (!isObj(body)) return []
  const queue = [{ node: body, depth: 0 }]
  const candidates = []
  let visited = 0

  while (queue.length && visited < 4000) {
    const cur = queue.shift()
    visited++
    const node = cur.node
    if (!isObj(node) || cur.depth > 7) continue

    if (Array.isArray(node)) {
      const objs = node.filter(isObj)
      if (objs.length) {
        const hits = objs.filter(looksLikeSong).length
        if (hits > 0) {
          // 带名称信息的条目优先：hash 列表与完整信息列表同时存在时，别挑到光秃秃那个
          const rich = objs.filter(hasNameLike).length
          candidates.push({ arr: objs, score: rich * 5000 + hits * 1000 + objs.length })
        }
      }
      for (const x of objs.slice(0, 60)) queue.push({ node: x, depth: cur.depth + 1 })
      continue
    }

    for (const k of Object.keys(node)) {
      const v = node[k]
      if (isObj(v)) queue.push({ node: v, depth: cur.depth + 1 })
    }
  }

  if (!candidates.length) return []
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].arr
}

function normalizeCover(raw) {
  let url = str(raw)
  if (!url) return ''
  url = url.replace('{size}', '400')
  if (url.startsWith('http://')) url = 'https://' + url.slice(7)
  return url
}

/**
 * 剥掉「歌手 - 歌名」复合串里的歌手前缀。
 *
 * 实测 `/privilege/lite`（按 hash 反查歌曲信息的接口）返回的 `name` 是
 * `"涂一乐 - 花落叹"` 这种「歌手 - 歌名」拼串，而 `singername` 另有字段。
 * 若不处理，列表会显示成「涂一乐 - 花落叹 - 涂一乐」。
 * 只有当分隔符**左侧与歌手完全一致**、且右侧还有内容时才剥 —— 避免误伤
 * 本身带连字符的正常歌名（如 `A - B`）。
 */
function cleanupTitle(rawTitle, artist) {
  const t = str(rawTitle)
  const a = str(artist)
  if (!t || !a || a === '未知歌手') return t
  for (const sep of [' - ', ' – ', ' — ', '－']) {
    const i = t.indexOf(sep)
    if (i > 0 && t.slice(0, i).trim() === a) {
      const rest = t.slice(i + sep.length).trim()
      if (rest) return rest
    }
  }
  return t
}

/**
 * 把一个上游歌曲对象归一化成宿主播放器认得的 track。
 * 字段基准来自官方插件 channel-wander（已验证可播放），额外补上
 * albumAudioId / albumId / duration 等字段，提升封面与时长显示。
 */
function normalizeTrack(raw, sourceId) {
  const s = unwrapSong(raw)
  if (!s) return null

  const base = isObj(s.base) ? s.base : s
  const ai = isObj(s.audio_info) ? s.audio_info : isObj(s.audioInfo) ? s.audioInfo : {}
  const album = isObj(s.album_info) ? s.album_info : isObj(s.albumInfo) ? s.albumInfo : {}
  const tp = isObj(s.trans_param) ? s.trans_param : isObj(s.transParam) ? s.transParam : {}

  // 主 hash 的取值顺序很关键：`hash` / `hash_128` 才是这首歌的**规范标识**，
  // 而 `hash_320` / `hash_flac` 是「另一份音质的文件」，属于 relateGoods 的范畴。
  // 如果把 320/flac 的 hash 当主 hash，宿主会拿它当歌曲身份去解析地址 ——
  // 能播但身份/封面/去重都会错位。所以只有整条链都找不到规范 hash 时才退而求其次。
  // 酷狗不同接口返回的 hash 大小写还不一致（实测 channel_wander 给大写），统一转小写，
  // 否则同一首歌跨源会被当成两首、去重失效（宿主请求播放地址时自己也会 toLowerCase）。
  const hash = (
    str(firstOf(ai, ['hash', 'hash_128'])) ||
    str(firstOf(base, ['hash', 'file_hash', 'hash_128'])) ||
    str(firstOf(s, ['hash', 'file_hash'])) ||
    str(findFieldDeep(s, ['hash'])) ||
    str(firstOf(ai, ['hash_320', 'hash_flac', 'hash_high'])) ||
    str(firstOf(base, ['hash_320', 'hash_flac'])) ||
    ''
  ).toLowerCase()
  if (!hash) return null

  // 歌名/歌手：先按精确键名走 pathGet（最快、最准），
  // 全部落空时再用限深 BFS 兜底 —— 实测 `/user/history` 就是靠这一步才认出歌名。
  const rawTitle =
    str(firstOf(base, ['songname', 'song_name', 'audio_name', 'filename'])) ||
    str(firstOf(s, ['songname', 'song_name', 'audio_name', 'filename'])) ||
    str(findFieldDeep(s, ['songname', 'song_name', 'songName', 'audio_name', 'audioName', 'filename'])) ||
    str(findFieldDeep(s, ['title', 'name'])) ||
    '未知歌曲'

  // 歌手优先取 authors 数组（多歌手），退回 author_name
  const authorArr = Array.isArray(base.authors) ? base.authors : Array.isArray(s.authors) ? s.authors : []
  const authorNames = authorArr
    .map((a) => str(firstOf(a, ['author_name', 'name', 'singer_name', 'singer'])))
    .filter(Boolean)
  const artist =
    (authorNames.length ? authorNames.join('、') : '') ||
    str(firstOf(base, ['author_name', 'singername', 'singer_name', 'author'])) ||
    str(firstOf(s, ['author_name', 'singername', 'singer_name', 'author'])) ||
    str(findFieldDeep(s, ['author_name', 'singer_name', 'singername', 'author_name_en'])) ||
    str(findFieldDeep(s, ['singer', 'artist'])) ||
    '未知歌手'

  // 有的接口只给「歌手 - 歌名」这种复合串（实测 /privilege/lite 的 name 就是），
  // 前缀与歌手完全一致时把前缀剥掉，避免显示成「歌手 - 歌名 - 歌手」。
  const title = cleanupTitle(rawTitle, artist)

  const albumName =
    str(firstOf(base, ['album_name', 'albumname'])) ||
    str(firstOf(s, ['album_name', 'albumname'])) ||
    str(findFieldDeep(s, ['album_name', 'albumname', 'albumName'])) ||
    ''
  const albumId = str(firstOf(base, ['album_id', 'albumid'])) || str(firstOf(s, ['album_id', 'albumid']))
  const albumAudioId =
    str(firstOf(base, ['album_audio_id', 'audio_id'])) ||
    str(firstOf(s, ['album_audio_id', 'audio_id', 'albumAudioId']))
  const mixSongId = num(firstOf(base, ['mixsongid', 'audio_id']) ?? firstOf(s, ['mixsongid', 'audio_id']), 0)
  const wideAudioId = str(firstOf(base, ['wide_audio_id'])) || str(firstOf(s, ['wide_audio_id']))

  const id = str(firstOf(s, ['id'])) || wideAudioId || albumAudioId || hash

  // 时长：上游 timelength 是毫秒；宿主 player.duration 是秒
  const rawDur = num(
    firstOf(base, ['timelength', 'duration', 'time_length']) ??
      firstOf(s, ['timelength', 'duration', 'time_length']),
    0
  )
  const durationMs = rawDur > 10000 ? rawDur : rawDur > 0 ? rawDur * 1000 : 0

  const relateGoods = []
  if (isHashLike(ai.hash_flac)) relateGoods.push({ hash: str(ai.hash_flac).toLowerCase(), quality: 'flac' })
  if (isHashLike(ai.hash_320)) relateGoods.push({ hash: str(ai.hash_320).toLowerCase(), quality: '320' })
  if (isHashLike(ai.hash_high)) relateGoods.push({ hash: str(ai.hash_high).toLowerCase(), quality: 'high' })

  const qualityLabel = relateGoods.some((g) => g.quality === 'flac')
    ? 'FLAC'
    : relateGoods.some((g) => g.quality === '320')
      ? '320K'
      : relateGoods.some((g) => g.quality === 'high')
        ? 'HQ'
        : ''

  return {
    // —— 宿主播放器需要的字段（对齐 channel-wander 的可用形态）——
    id,
    title,
    name: title,
    artist,
    artists: (authorNames.length ? authorNames : [artist]).map((n) => ({ name: n })),
    singers: (authorNames.length ? authorNames : [artist]).map((n) => ({ name: n })),
    album: albumName,
    albumName,
    albumId,
    albumAudioId,
    mixSongId,
    coverUrl: normalizeCover(
      firstOf(album, ['cover', 'cover_url', 'img', 'pic']) ||
        firstOf(s, ['cover', 'img', 'pic', 'album_image']) ||
        firstOf(tp, ['union_cover', 'cover', 'sizable_cover'])
    ),
    audioUrl: '',
    hash,
    fileId: num(firstOf(ai, ['fileid', 'file_id']) ?? firstOf(base, ['audio_id']), undefined),
    relateGoods,
    ...(durationMs > 0 ? { duration: Math.round(durationMs / 1000) } : {}),

    // —— 插件自用字段 ——
    // dedupeKey 是「文件级」身份（hash）：同一首歌的不同音质/不同版本 hash 不同。
    // songKey 是「歌曲级」身份（albumAudioId 优先）：用来把同一首歌的多份文件塌成一条，
    // 实测听歌排行会返回同一首歌的多个 hash 变体，只按 hash 去重就会显示成好几条「一样的歌」。
    dedupeKey: hash,
    songKey: albumAudioId || hash,
    durationMs,
    qualityLabel,
    sourceId
  }
}

/* ========================================================================== *
 * 请求层
 * ========================================================================== */

function piniaState(ctx) {
  const state = ctx.pinia && ctx.pinia.state
  if (!state) return null
  return state.value !== undefined ? state.value : state
}

/** 读登录态。昵称可能为空，所以不能用昵称判断是否登录 */
function readAuth(ctx) {
  const root = piniaState(ctx)
  if (!root) return null
  const u = root.user && root.user.info
  const d = root.device && root.device.info
  if (!u || !u.token || !u.userid) return null
  return {
    token: u.token,
    userid: u.userid,
    nickname: str(firstOf(u, ['nickname', 'name'])),
    t1: firstOf(u, ['t1']),
    dfid: firstOf(d, ['dfid']),
    mid: firstOf(d, ['mid']),
    uuid: firstOf(d, ['uuid']),
    guid: firstOf(d, ['guid']),
    serverDev: firstOf(d, ['serverDev']),
    mac: firstOf(d, ['mac'])
  }
}

/** 宿主把 Authorization 按 "k=v; k=v" 解析成 cookie；设备指纹由宿主自动补齐 */
function buildAuthHeader(auth) {
  if (!auth) return ''
  const parts = []
  if (auth.token) parts.push('token=' + auth.token)
  if (auth.userid) parts.push('userid=' + auth.userid)
  if (auth.t1) parts.push('t1=' + auth.t1)
  if (auth.dfid) parts.push('dfid=' + auth.dfid)
  if (auth.mid) parts.push('KUGOU_API_MID=' + auth.mid)
  if (auth.uuid) parts.push('uuid=' + auth.uuid)
  if (auth.guid) parts.push('KUGOU_API_GUID=' + auth.guid)
  if (auth.serverDev) parts.push('KUGOU_API_DEV=' + auth.serverDev)
  if (auth.mac) parts.push('KUGOU_API_MAC=' + auth.mac)
  return parts.join(';')
}

function describeError(code) {
  const c = num(code, NaN)
  if (Number.isFinite(c) && ERROR_TEXT[c]) return ERROR_TEXT[c]
  return code === undefined || code === null || code === '' ? '' : '错误码 ' + code
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 判断是不是「网络层」的临时失败（而不是业务错误）。
 *
 * 实测踩到：`/user/history` 偶发返回 `HTTP 502 + net::ERR_CONNECTION_RESET`
 * （error_code 是 0 —— 说明上游连接被重置，不是酷狗业务拒绝）。
 * 这类错误重试一次基本就好，不该直接判定「该源不可用」；
 * 而 20018 / 20010 / 21001 这类业务错误重试多少次都一样，不能重试（会徒增风控风险）。
 */
function isTransientError(message, httpStatus, errorCode) {
  const m = String(message || '')
  if (/^net::|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK|ERR_SOCKET|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|网关请求失败/i.test(m)) {
    return true
  }
  // 关键判别：酷狗的业务错误**一定带非零 error_code**（20010 / 21001 / 20018 …）。
  // 所以「HTTP 502 但 error_code 为 0」说明根本没走到业务层，是上游连接被重置，
  // 重试一次通常就好；而 20010 这种业务拒绝重试多少次都一样，不该重试（徒增风控风险）。
  return num(httpStatus, 0) === 502 && num(errorCode, 0) === 0
}

class SourceError extends Error {
  constructor(message, extra) {
    super(message)
    this.name = 'SourceError'
    this.httpStatus = extra && extra.httpStatus ? extra.httpStatus : 0
    this.errorCode = extra && extra.errorCode !== undefined ? extra.errorCode : 0
    this.needsLogin = !!(extra && extra.needsLogin)
  }
}

/** 判定上游响应是否成功。注意：4xx/5xx 不会 reject，业务错误会映射成 502 */
function assertKugouOk(body, httpStatus) {
  const status = num(httpStatus, 200)
  const bizStatus = isObj(body) ? body.status : undefined
  const errCode = isObj(body) ? (body.error_code !== undefined ? body.error_code : body.errcode) : undefined
  const bizOk = bizStatus === undefined ? true : num(bizStatus, 0) === 1
  const errOk = errCode === undefined ? true : num(errCode, 0) === 0

  if (status !== 200 || !bizOk || !errOk) {
    // 注意：error_code 为 0 表示「没有业务错误码」（例如 502 + net::ERR_CONNECTION_RESET），
    // 此时绝不能拿 describeError(0) 去当失败文案 —— 那会显示成「成功」，非常误导。
    const code = num(errCode, 0)
    const text =
      (code ? describeError(code) : '') ||
      str(isObj(body) ? body.error || body.msg || body.message : '') ||
      (status !== 200 ? 'HTTP ' + status : '接口返回失败')
    const needsLogin = code === 20018 || code === 51002
    throw new SourceError(text, { httpStatus: status, errorCode: code, needsLogin })
  }
}

/** 账号风控 → 唤起宿主安全验证弹窗，通过后由调用方重试一次 */
function verificationEventId(res) {
  const body = res && res.body
  const headers = (res && res.headers) || {}
  const eventId = (isObj(body) && (body.ssaCode || (isObj(body.data) && body.data.event_id))) || headers['ssa-code'] || ''
  const errCode = num(isObj(body) ? body.error_code : 0, 0)
  const bizStatus = isObj(body) ? body.status : 1
  if (eventId && (errCode === 20028 || num(bizStatus, 1) === 0)) return str(eventId)
  return ''
}

async function tryVerify(ctx, eventId) {
  const v = ctx.kugouVerification
  if (!v || typeof v.request !== 'function') return false
  try {
    const r = await v.request(eventId)
    return !!(r && r.ok)
  } catch {
    return false
  }
}

/** 反查歌曲信息用的本地路由（KuGouMusicApi 里 privilege_lite.js 的注释就是「获取歌曲信息」） */
const ENRICH_ROUTE = '/privilege/lite'
const ENRICH_BATCH = 50

/**
 * 按 hash 批量反查歌曲信息。
 *
 * 为什么必须有这一步：实测 `/user/history`（听歌排行）返回的记录**只有**
 * `{ hash, size, bitrate, privilege, level }` —— 连歌名字段都不存在，
 * 所以整列会显示成「未知歌曲 - 未知歌手」。这不是字段名对不上，是响应本身缺元数据，
 * 只能拿 hash 去 `/privilege/lite` 二次反查，再把结果合并回原记录。
 *
 * 解析不假设层级：沿用 pickTrackArray 找数组，再**按 hash 配对**（大小写不敏感），
 * 这样无论上游把条目放在 data[] / data.info[] / 带 audio_info 包装里都能对上。
 */
async function enrichByHash(ctx, hashes) {
  const list = (hashes || []).map((h) => str(h)).filter(Boolean).slice(0, ENRICH_BATCH)
  if (!list.length) return { ok: false, map: new Map(), route: ENRICH_ROUTE, error: '没有可反查的 hash' }

  try {
    const body = await localRoute(ctx, ENRICH_ROUTE, { hash: list.join(',') })
    const arr = pickTrackArray(body)
    const map = new Map()
    for (const item of arr) {
      const s = unwrapSong(item)
      const h = str(firstOf(s, ['hash', 'hash_128'])) || str(firstOf(item, ['hash', 'hash_128']))
      if (h) map.set(h.toLowerCase(), item)
    }
    const first = arr[0]
    return {
      ok: map.size > 0,
      map,
      route: ENRICH_ROUTE,
      keys: first ? Object.keys(unwrapSong(first)).slice(0, 40).join(',') : '',
      snippet: first ? clipText(JSON.stringify(first), 400) : '',
      error: map.size ? '' : '反查结果里没有可用条目'
    }
  } catch (e) {
    return {
      ok: false,
      map: new Map(),
      route: ENRICH_ROUTE,
      httpStatus: num(e && e.httpStatus, 0),
      errorCode: num(e && e.errorCode, 0),
      error: (e && e.message) || String(e)
    }
  }
}

/** 本地路由通道：宿主主进程内的 KuGouMusicApi 模块 */
async function localRoute(ctx, route, params) {
  const api = ctx.electron && ctx.electron.api
  if (!api || typeof api.request !== 'function') {
    throw new SourceError('宿主未提供内置酷狗接口通道', {})
  }
  const auth = buildAuthHeader(readAuth(ctx))
  const headers = auth ? { Authorization: auth } : {}
  const cfg = { method: 'GET', url: route, params: params || {}, headers }

  let res = await api.request(cfg)
  const eventId = verificationEventId(res)
  if (eventId) {
    const ok = await tryVerify(ctx, eventId)
    if (ok) res = await api.request(cfg)
    else throw new SourceError('账号需要安全验证，请在弹窗中完成验证后重试', { errorCode: 20028 })
  }

  assertKugouOk(res && res.body, res && res.status)
  return res.body
}

/** 网关直连通道：概念版 youth 网关（与官方 channel-wander 插件同款） */
async function gatewayPost(ctx, url, payload) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }
  const req = ctx.net && ctx.net.request
  const f = ctx.net && ctx.net.fetch

  if (typeof req === 'function') {
    let res
    try {
      res = await req({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {}),
        responseType: 'json',
        timeoutMs: REQUEST_TIMEOUT_MS
      })
    } catch (e) {
      throw new SourceError('网关请求失败：' + (e && e.message ? e.message : String(e)), {})
    }
    const body = isObj(res && res.data) ? res.data : safeJson(res && res.data)
    assertKugouOk(body, res && res.status)
    return body
  }

  if (typeof f === 'function') {
    let res
    try {
      res = await f(url, { method: 'POST', headers, body: JSON.stringify(payload || {}) })
    } catch (e) {
      throw new SourceError('网关请求失败：' + (e && e.message ? e.message : String(e)), {})
    }
    const text = await res.text()
    const body = safeJson(text)
    assertKugouOk(body, res && res.status)
    return body
  }

  throw new SourceError('宿主未提供网络能力（ctx.net.request / ctx.net.fetch 均不可用）', {})
}

/* ========================================================================== *
 * 推荐源注册表
 * ========================================================================== */

/** 曲风常用标签（tagids）——酷狗侧为数字 id，前端只做快捷填充 */
const STYLE_TAG_PRESETS = [
  { label: '华语', id: '1' },
  { label: '欧美', id: '2' },
  { label: '日韩', id: '3' },
  { label: '古风', id: '4' },
  { label: '摇滚', id: '5' },
  { label: '民谣', id: '6' },
  { label: '电子', id: '7' },
  { label: '说唱', id: '8' }
]

const SOURCES = [
  {
    id: 'channel',
    name: '频道漫游',
    desc: '概念版官方推荐流，可按标签定向；不需要登录，可无限刷新',
    needLogin: false,
    infinite: true,
    usesTags: true,
    async fetch(ctx, o) {
      const body = await gatewayPost(ctx, GATEWAY_CHANNEL_WANDER, { tags: str(o.tags) })
      const raw = pickTrackArray(body)
      return { raw, tracks: raw.map((r) => normalizeTrack(r, 'channel')) }
    }
  },
  {
    id: 'everyday',
    name: '每日推荐',
    desc: '每天更新的一批个性化推荐（本地路由 /everyday/recommend）',
    needLogin: true,
    infinite: false,
    async fetch(ctx) {
      const body = await localRoute(ctx, '/everyday/recommend', { platform: 'ios' })
      const raw = pickTrackArray(body)
      return { raw, tracks: raw.map((r) => normalizeTrack(r, 'everyday')) }
    }
  },
  {
    id: 'fm',
    name: '猜你喜欢',
    desc: '私人 FM 无限流（本地路由 /personal/fm），适合长时间挂着听',
    needLogin: false,
    infinite: true,
    async fetch(ctx, o) {
      const body = await localRoute(ctx, '/personal/fm', {
        mode: 'normal',
        action: 'play',
        song_pool_id: 0
      })
      const raw = pickTrackArray(body)
      return { raw, tracks: raw.map((r) => normalizeTrack(r, 'fm')) }
    }
  },
  {
    id: 'style',
    name: '曲风推荐',
    desc: '按曲风标签出的每日推荐（本地路由 /everyday/style/recommend）',
    needLogin: true,
    infinite: false,
    usesTags: true,
    async fetch(ctx, o) {
      const body = await localRoute(ctx, '/everyday/style/recommend', { tagids: str(o.tags) })
      const raw = pickTrackArray(body)
      return { raw, tracks: raw.map((r) => normalizeTrack(r, 'style')) }
    }
  },
  {
    id: 'ai',
    name: 'AI 推荐',
    desc: '概念版 AI 推荐歌单（本地路由 /ai/recommend/song，失败时回退 songlistairec 版）',
    needLogin: true,
    infinite: true,
    async fetch(ctx, o) {
      const size = clamp(o.size, 1, 50)
      const page = Math.max(1, num(o.page, 1))

      // 主路：概念版 /concepts/v1/ai/recommend_song
      let primaryErr = null
      try {
        const body = await localRoute(ctx, '/ai/recommend/song', { pagesize: size, page })
        const raw = pickTrackArray(body)
        if (raw.length) return { raw, tracks: raw.map((r) => normalizeTrack(r, 'ai')) }
        primaryErr = { msg: '返回空结果', errorCode: 0 }
      } catch (e) {
        primaryErr = { msg: (e && e.message) || String(e), errorCode: num(e && e.errorCode, 0) }
      }

      // 回退：songlistairec 版 /recommend（空种子 → 通用推荐）
      try {
        const body = await localRoute(ctx, '/ai/recommend', {})
        const raw = pickTrackArray(body)
        if (raw.length) return { raw, tracks: raw.map((r) => normalizeTrack(r, 'ai')) }
        throw new SourceError('返回空结果', {})
      } catch (e) {
        const a = primaryErr.msg + (primaryErr.errorCode ? '（error_code ' + primaryErr.errorCode + '）' : '')
        const b = ((e && e.message) || String(e)) + (e && e.errorCode ? '（error_code ' + e.errorCode + '）' : '')
        throw new SourceError('AI 推荐两个版本都失败 —— concepts: ' + a + '；songlistairec: ' + b, {
          httpStatus: num(e && e.httpStatus, 0),
          errorCode: num(e && e.errorCode, 0) || primaryErr.errorCode
        })
      }
    }
  },
  {
    id: 'newsong',
    name: '新歌速递',
    desc: '最新上架歌曲榜（本地路由 /top/song），不依赖个人口味',
    needLogin: false,
    infinite: true,
    async fetch(ctx, o) {
      const body = await localRoute(ctx, '/top/song', {
        rank_id: 21608,
        page: Math.max(1, num(o.page, 1)),
        pagesize: clamp(o.size, 1, 50)
      })
      const raw = pickTrackArray(body)
      return { raw, tracks: raw.map((r) => normalizeTrack(r, 'newsong')) }
    }
  },
  {
    id: 'history',
    name: '每日历史',
    desc: '往期每日推荐（本地路由 /everyday/history）。模块注释写的是「mode list ,song」：'
      + '不填日期走 mode=list，填了日期走 mode=song',
    needLogin: true,
    infinite: false,
    async fetch(ctx, o) {
      const date = str(o.historyDate)
      const common = { platform: 'ios' }

      // 指定了日期 → 直接取那天的歌（mode=song 才是「按日期取歌」的用法）
      if (date) {
        const body = await localRoute(ctx, '/everyday/history', { ...common, mode: 'song', date })
        const raw = pickTrackArray(body)
        if (!raw.length) throw new SourceError('该日期（' + date + '）没有历史推荐记录', {})
        return { raw, tracks: raw.map((r) => normalizeTrack(r, 'history')) }
      }

      // 未指定日期 → 先拿记录列表
      const listBody = await localRoute(ctx, '/everyday/history', { ...common, mode: 'list' })
      let raw = pickTrackArray(listBody)
      if (raw.length) return { raw, tracks: raw.map((r) => normalizeTrack(r, 'history')) }

      // 列表里没有歌（只有日期记录）→ 取最新一条的日期，再走一次 mode=song
      const picked = findFieldDeep(listBody, ['history_date', 'historyDate', 'date', 'history_name', 'historyname'])
      if (!picked) throw new SourceError('历史记录为空，也找不到可用的日期字段', {})
      const songBody = await localRoute(ctx, '/everyday/history', { ...common, mode: 'song', date: picked })
      raw = pickTrackArray(songBody)
      if (!raw.length) throw new SourceError('历史记录「' + picked + '」没有歌曲', {})
      return { raw, tracks: raw.map((r) => normalizeTrack(r, 'history')) }
    }
  },
  {
    id: 'listen',
    name: '听歌排行',
    desc: '你自己的常听歌曲（本地路由 /user/history），需要登录。'
      + '该接口只返回 hash 列表，插件会用 /privilege/lite 按 hash 反查歌名与歌手',
    needLogin: true,
    infinite: false,
    async fetch(ctx) {
      const body = await localRoute(ctx, '/user/history', {})
      let raw = pickTrackArray(body)
      if (!raw.length) return { raw, tracks: [] }

      // 实测该接口只给 { hash, size, bitrate, privilege, level }，没有任何名称字段，
      // 所以对「没有名称信息」的记录做一次批量反查，再合并回原记录（原字段保留）。
      const needEnrich = raw.filter((r) => !hasNameLike(r))
      let debug = null

      if (needEnrich.length) {
        const res = await enrichByHash(ctx, needEnrich.map((r) => firstOf(r, ['hash'])))
        if (res.ok) {
          raw = raw.map((r) => {
            const h = str(firstOf(r, ['hash'])).toLowerCase()
            const hit = res.map.get(h)
            return hit ? { ...r, ...hit } : r
          })
        }
        const filled = raw.filter(hasNameLike).length
        // 注意：SOURCES 是模块级常量，拿不到 activate 里的 log 闭包，
        // 所以这里只把诊断塞进 debug 由 UI/诊断输出呈现（写 log() 会直接 ReferenceError）。
        debug = {
          route: res.route,
          requested: needEnrich.length,
          matched: res.ok ? res.map.size : 0,
          filled,
          error: res.ok ? '' : res.error,
          errorCode: res.errorCode || 0,
          httpStatus: res.httpStatus || 0,
          keys: res.keys || '',
          snippet: res.snippet || ''
        }
      }

      return { raw, tracks: raw.map((r) => normalizeTrack(r, 'listen')), debug }
    }
  }
]

function getSource(id) {
  return SOURCES.find((s) => s.id === id) || SOURCES[0]
}

/**
 * 抓一份「上游原始形态」摘要。
 * 归一化失败时（歌名/歌手没认出来）光看「未知歌曲」是没法修的 ——
 * 必须知道上游到底把字段放在哪一层、叫什么名字。所以把第一个原始条目
 * 的键名（剥壳前 + 剥壳后）与截断后的 JSON 一起带出来，通过「复制诊断」反馈即可精确校准。
 */
function rawShape(rawList) {
  const first = (rawList || [])[0]
  if (!isObj(first)) return { rawKeys: '', songKeys: '', rawSnippet: '' }
  const song = unwrapSong(first)
  let snippet = ''
  try {
    snippet = clipText(JSON.stringify(first), 480)
  } catch {
    snippet = '(无法序列化)'
  }
  return {
    rawKeys: Object.keys(first).slice(0, 40).join(','),
    songKeys: isObj(song) ? Object.keys(song).slice(0, 40).join(',') : '',
    rawSnippet: snippet
  }
}

/** 网络层临时失败的自动重试次数（业务错误不重试，见 isTransientError） */
const MAX_SOURCE_ATTEMPTS = 2
const RETRY_DELAY_MS = 700

/**
 * 执行一次取数；永远不抛异常，把失败信息结构化返回，便于健康检查与 UI 展示。
 * 网络层临时失败（连接被重置 / 超时）会自动重试一次 —— 实测 `/user/history`
 * 会偶发 `net::ERR_CONNECTION_RESET`，重试即可成功，不该直接判「该源不可用」。
 */
async function fetchSource(ctx, sourceId, opts) {
  const src = getSource(sourceId)
  const o = opts || {}
  const t0 = Date.now()

  let attempt = 0
  let last = null

  while (attempt < MAX_SOURCE_ATTEMPTS) {
    attempt += 1
    try {
      const out = await src.fetch(ctx, o)
      // 按「歌曲级」身份去重：同一首歌的多个 hash 变体（不同音质/版本）只留一条
      const tracks = uniqBy((out.tracks || []).filter(Boolean), (t) => t.songKey || t.dedupeKey)
      return {
        ok: true,
        sourceId: src.id,
        sourceName: src.name,
        tracks,
        rawCount: (out.raw || []).length,
        ms: Date.now() - t0,
        attempts: attempt,
        httpStatus: 200,
        errorCode: 0,
        error: '',
        // 归一化质量：歌名/歌手没认出来的条数（>0 说明该源的字段名/嵌套层还没对齐，
        // 或该接口本身只返回 hash 列表、需要按 hash 反查）
        unknownCount: tracks.filter((t) => t.title === '未知歌曲' || t.artist === '未知歌手').length,
        debug: out.debug || null,
        ...rawShape(out.raw)
      }
    } catch (e) {
      const message = (e && e.message) || String(e)
      const httpStatus = num(e && e.httpStatus, 0)
      const errorCode = num(e && e.errorCode, 0)
      last = {
        ok: false,
        sourceId: src.id,
        sourceName: src.name,
        tracks: [],
        rawCount: 0,
        ms: Date.now() - t0,
        attempts: attempt,
        httpStatus,
        errorCode,
        needsLogin: !!(e && e.needsLogin),
        error: message
      }
      const canRetry = attempt < MAX_SOURCE_ATTEMPTS && isTransientError(message, httpStatus, errorCode)
      if (!canRetry) return last
      await sleep(RETRY_DELAY_MS)
    }
  }
  return last
}

/* ========================================================================== *
 * 插件本体
 * ========================================================================== */

let ctxRef = null
let runtime = null

export async function activate(ctx) {
  ctxRef = ctx

  const V = ctx.vue
  const { h, reactive, ref, computed, onMounted, watch } = V

  const log = (...args) => {
    if (runtime && runtime.settings && runtime.settings.debug) console.log('[推荐电台]', ...args)
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
    out.defaultSource = getSource(str(out.defaultSource)).id
    out.batchSize = clamp(out.batchSize, 5, 100)
    out.refillThreshold = clamp(out.refillThreshold, 1, 10)
    out.tags = str(out.tags)
    out.historyDate = str(out.historyDate)
    out.autoRefreshOnSwitch = !!out.autoRefreshOnSwitch
    out.autoRadio = !!out.autoRadio
    out.dedupe = !!out.dedupe
    out.filterBlocked = !!out.filterBlocked
    out.shuffle = !!out.shuffle
    out.showQuality = !!out.showQuality
    out.showCover = !!out.showCover
    out.sidebarEntry = !!out.sidebarEntry
    out.toastOnRadio = !!out.toastOnRadio
    out.debug = !!out.debug
    return out
  }

  const [savedSettings, savedMarks, savedStats] = await Promise.all([
    readStorage(KEY_SETTINGS, null),
    readStorage(KEY_MARKS, null),
    readStorage(KEY_STATS, null)
  ])

  const state = reactive({
    settings: normalizeSettings(savedSettings),
    view: 'feed', // feed | liked
    sourceId: getSource(str(savedSettings && savedSettings.defaultSource)).id,
    tags: str(savedSettings && savedSettings.tags),
    historyDate: str(savedSettings && savedSettings.historyDate),
    /**
     * 每个推荐源各自保留自己的列表 —— 像多标签页一样。
     * key = 源 id，value = { tracks, page, at }（page 用于无限流翻页，at 是拉取时间）
     * 切回某个源时**直接恢复它上次的列表**，不重新请求；要刷新请点「换一批」。
     * 只在本次会话内缓存（不落盘）：8 个源 × 最多 300 首没必要写进宿主 KV。
     */
    lists: {},
    liked: Array.isArray(savedMarks && savedMarks.liked) ? savedMarks.liked.slice(0, MAX_LIKED) : [],
    blocked: Array.isArray(savedMarks && savedMarks.blocked) ? savedMarks.blocked.slice(0, MAX_BLOCKED) : [],
    seen: [],
    loading: false,
    error: '',
    notice: '',
    radio: false,
    health: null,
    checking: false,
    stats: {
      fetched: num(savedStats && savedStats.fetched, 0),
      played: num(savedStats && savedStats.played, 0),
      liked: num(savedStats && savedStats.liked, 0),
      blocked: num(savedStats && savedStats.blocked, 0),
      refills: num(savedStats && savedStats.refills, 0)
    }
  })

  runtime = state

  const persistSettings = () => writeStorage(KEY_SETTINGS, { ...state.settings })
  const persistMarks = () => writeStorage(KEY_MARKS, { liked: state.liked.slice(0, MAX_LIKED), blocked: state.blocked.slice(0, MAX_BLOCKED) })
  const persistStats = () => writeStorage(KEY_STATS, { ...state.stats })

  /* ---------------- 每个源各自的列表（多标签页式缓存） ---------------- */

  const EMPTY_LIST = []

  /** 读某个源的列表；不存在时返回空数组常量（不要在渲染期创建 bucket） */
  function listOf(id) {
    const b = state.lists[id]
    return b && Array.isArray(b.tracks) ? b.tracks : EMPTY_LIST
  }

  /**
   * 写某个源的列表前先拿到 bucket。
   *
   * ⚠️ 必须「先写进响应式容器、再从容器读回来」，不能直接 return 刚 new 出来的那个对象：
   * 从 reactive 对象里读出来的才是 Proxy；直接持有原始对象的话，后续
   * `bucket.tracks = ...` 会绕过 Proxy 的 set 陷阱 → 依赖它的 computed 不失效、
   * 缓存住旧值 → 界面一直显示旧列表，直到别的依赖（如 sourceId）变化才刷新。
   * 真机表现就是「点换一批后新歌不显示，切到别的源再切回来才出现」。
   */
  function bucketOf(id) {
    const cur = state.lists[id]
    if (!isObj(cur) || !Array.isArray(cur.tracks)) {
      state.lists[id] = isObj(cur) ? { ...cur, tracks: [] } : { tracks: [], page: 1, at: 0 }
    }
    return state.lists[id]
  }

  function cacheCount(id) {
    return listOf(id).length
  }

  /** 「3 分钟前」这种相对时间，用于说明缓存的新鲜度 */
  function relativeTime(ts) {
    const t = num(ts, 0)
    if (!t) return ''
    const diff = Date.now() - t
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return Math.round(diff / 60_000) + ' 分钟前'
    if (diff < 86_400_000) return Math.round(diff / 3_600_000) + ' 小时前'
    return Math.round(diff / 86_400_000) + ' 天前'
  }

  function clearAllCaches() {
    state.lists = {}
    ctx.toast.success('已清空各推荐源的列表缓存')
  }

  /* ---------------- 过滤 / 去重 ---------------- */

  const blockedSet = computed(() => new Set(state.blocked))
  const seenSet = computed(() => new Set(state.seen))
  const likedSet = computed(() => new Set(state.liked.map((t) => t && t.dedupeKey).filter(Boolean)))
  const activeSource = computed(() => getSource(state.sourceId))

  /** 应用屏蔽 / 去重规则；radio 续杯时去重更严格（不要和已入选的重复） */
  function applyFilters(tracks, opts) {
    const o = opts || {}
    let list = (tracks || []).slice()
    if (state.settings.filterBlocked) {
      const b = blockedSet.value
      list = list.filter((t) => t && !b.has(t.dedupeKey))
    }
    if (o.dedupe !== false && (state.settings.dedupe || o.forceDedupe)) {
      const seen = seenSet.value
      list = list.filter((t) => t && (!seen.has(t.dedupeKey) || o.allowRepeats))
    }
    if (o.exclude) {
      const ex = o.exclude instanceof Set ? o.exclude : new Set(o.exclude)
      list = list.filter((t) => t && !ex.has(t.dedupeKey))
    }
    return list
  }

  function markSeen(tracks) {
    const next = state.seen.slice()
    for (const t of tracks || []) {
      if (t && t.dedupeKey && next.indexOf(t.dedupeKey) === -1) next.push(t.dedupeKey)
    }
    state.seen = next.length > MAX_SEEN ? next.slice(next.length - MAX_SEEN) : next
  }

  /* ---------------- 取数 ---------------- */

  /**
   * 一批推荐结果的清洗：
   * - 无限流（频道漫游 / 猜你喜欢 / AI / 新歌）走严格去重，这样「换一批」才真的换新
   * - 有限流（每日推荐 / 听歌排行 / 每日历史）允许重复，否则一天之内再点就是空列表
   */
  function cleanBatch(result, src, opts) {
    const o = opts || {}
    const useDedupe = o.forceDedupe || o.append || src.infinite
    let list = applyFilters(result.tracks, {
      dedupe: !!useDedupe,
      forceDedupe: !!o.forceDedupe,
      exclude: o.exclude
    })
    if (state.settings.shuffle) list = shuffleCopy(list)
    return list.slice(0, state.settings.batchSize)
  }

  async function loadBatch(opts) {
    const o = opts || {}
    const src = getSource(o.sourceId || state.sourceId)
    if (state.loading) return { ok: false, error: '正在加载中' }

    const bucket = bucketOf(src.id)

    state.loading = true
    state.error = ''
    state.notice = ''
    if (!o.append) bucket.page = 1

    let page = src.infinite ? Math.max(1, num(o.page, bucket.page)) : 1
    let result = await fetchSource(ctx, src.id, {
      tags: state.tags,
      historyDate: state.historyDate,
      size: state.settings.batchSize,
      page
    })

    let tracks = result.ok ? cleanBatch(result, src, o) : []

    // 无限流：本页被去重/屏蔽规则吃干净时自动再翻一页，避免「换一批」卡在同一页
    let retry = 0
    while (result.ok && !tracks.length && src.infinite && result.rawCount > 0 && retry < 2) {
      retry += 1
      page += 1
      result = await fetchSource(ctx, src.id, {
        tags: state.tags,
        historyDate: state.historyDate,
        size: state.settings.batchSize,
        page
      })
      if (result.ok) tracks = cleanBatch(result, src, o)
    }

    state.loading = false

    if (!result.ok) {
      state.error = result.error + (result.needsLogin ? '（该源需要登录）' : '')
      state.radio = false
      log('取数失败', src.id, result)
      return result
    }

    // 取数成功就推进页码（哪怕本批为空），否则分页型无限流会一直停在同页
    bucket.page = page
    bucket.at = Date.now()

    if (!tracks.length) {
      state.notice = result.rawCount
        ? '本批 ' + result.rawCount + ' 首全部命中去重/屏蔽规则，再点一次「换一批」可拉到更新的内容'
        : '该源本次没有返回歌曲'
      state.radio = false
      return { ...result, tracks: [] }
    }

    markSeen(tracks)
    if (o.append) {
      bucket.tracks = uniqBy(bucket.tracks.concat(tracks), (t) => t.songKey || t.dedupeKey).slice(0, LIST_RENDER_LIMIT)
    } else {
      bucket.tracks = tracks
    }
    state.stats.fetched += tracks.length

    log('取数成功', src.id, tracks.length, '首', result.ms + 'ms')
    return { ...result, tracks }
  }

  async function loadMore() {
    const src = activeSource.value
    if (!src.infinite) {
      state.notice = '「' + src.name + '」不是无限流，请点「换一批」'
      return
    }
    return loadBatch({ append: true, page: bucketOf(src.id).page + 1, allowRepeats: false })
  }

  /* ---------------- 播放 ---------------- */

  function markPlayed() {
    state.stats.played += 1
    persistStats()
  }

  async function playTrack(track) {
    if (!track) return false
    try {
      // 单曲播放要按「这首歌所属的那个源的列表」轮转，而不是当前显示的列表
      // （比如从「我喜欢」视图点播一首歌时，队列顺序仍应贴合它原本所在的源）
      const own = listOf(track.sourceId)
      const displayed = state.view === 'liked' ? state.liked : listOf(state.sourceId)
      const list = (own.length ? own : displayed.length ? displayed : [track]).slice()
      const i = list.findIndex((t) => t.dedupeKey === track.dedupeKey)
      const ordered = i > 0 ? list.slice(i).concat(list.slice(0, i)) : list
      await ctx.playlist.replaceAndPlay(ordered, { requestedSong: track })
      markPlayed()
      return true
    } catch (e) {
      ctx.toast.danger('播放失败：' + ((e && e.message) || e))
      log('播放失败', e)
      return false
    }
  }

  async function playAll() {
    const list = visibleTracks.value
    if (!list.length) {
      ctx.toast.info('暂无歌曲')
      return false
    }
    try {
      await ctx.playlist.replaceAndPlay(list)
      markPlayed()
      return true
    } catch (e) {
      ctx.toast.danger('播放失败：' + ((e && e.message) || e))
      return false
    }
  }

  async function playNext(track) {
    if (!track) return false
    try {
      await ctx.playlist.playNext(track)
      ctx.toast.success('已加入下一首播放')
      return true
    } catch (e) {
      ctx.toast.danger('加入队列失败')
      return false
    }
  }

  async function appendToQueue(track) {
    if (!track) return false
    try {
      await ctx.playlist.append([track])
      return true
    } catch {
      return false
    }
  }

  /* ---------------- 喜欢 / 不感兴趣 ---------------- */

  function toggleLike(track) {
    if (!track) return
    const i = state.liked.findIndex((t) => t && t.dedupeKey === track.dedupeKey)
    if (i >= 0) {
      state.liked = state.liked.slice(0, i).concat(state.liked.slice(i + 1))
      ctx.toast.info('已取消喜欢')
    } else {
      state.liked = [track].concat(state.liked).slice(0, MAX_LIKED)
      state.stats.liked += 1
      ctx.toast.success('已加入「我喜欢」')
    }
    persistMarks()
    persistStats()
  }

  function block(track) {
    if (!track) return
    if (state.blocked.indexOf(track.dedupeKey) === -1) {
      state.blocked = state.blocked.concat([track.dedupeKey]).slice(-MAX_BLOCKED)
      state.stats.blocked += 1
    }
    // 屏蔽是全局的：把这首歌从**所有源的缓存列表**里都摘掉，
    // 否则切回别的源时它还会从缓存里冒出来（显得屏蔽没生效）
    const next = {}
    for (const id of Object.keys(state.lists)) {
      const b = state.lists[id]
      next[id] = { ...b, tracks: (b.tracks || []).filter((t) => t.dedupeKey !== track.dedupeKey) }
    }
    state.lists = next
    state.liked = state.liked.filter((t) => t && t.dedupeKey !== track.dedupeKey)
    persistMarks()
    persistStats()
    ctx.toast.info('已标记不感兴趣：' + (track.title || ''))
  }

  function clearBlocked() {
    state.blocked = []
    persistMarks()
    ctx.toast.success('已清空屏蔽列表')
  }

  function clearSeen() {
    state.seen = []
    ctx.toast.success('已清空去重记录')
  }

  const visibleTracks = computed(() =>
    state.view === 'liked' ? state.liked : listOf(state.sourceId)
  )

  /* ---------------- 电台模式（自动续杯） ---------------- */

  function queueSongs() {
    const p = ctx.playlist
    if (!p) return []
    try {
      const list = typeof p.getQueueSongs === 'function' ? p.getQueueSongs() : null
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  function remainingInQueue() {
    const list = queueSongs()
    if (!list.length) return 0
    const cur = (ctx.player && ctx.player.currentTrack && ctx.player.currentTrack.value) || null
    const curId = str(cur && (cur.id || cur.hash))
    const idx = list.findIndex((t) => t && (str(t.id) === curId || (cur && cur.hash && str(t.hash) === str(cur.hash))))
    if (idx < 0) return list.length
    return Math.max(0, list.length - idx - 1)
  }

  let refillGuard = 0
  let refillInFlight = false

  async function maybeRefill(reason) {
    if (!state.radio || refillInFlight) return
    if (Date.now() - refillGuard < 3000) return
    if (remainingInQueue() > state.settings.refillThreshold) return

    refillInFlight = true
    refillGuard = Date.now()
    try {
      const inQueue = new Set(queueSongs().map((t) => t && t.dedupeKey).filter(Boolean))
      const bucket = bucketOf(state.sourceId)
      const result = await fetchSource(ctx, state.sourceId, {
        tags: state.tags,
        historyDate: state.historyDate,
        size: state.settings.batchSize,
        page: bucket.page + 1
      })
      if (!result.ok) {
        log('电台续杯失败', result.error)
        return
      }
      let fresh = cleanBatch(result, getSource(state.sourceId), { forceDedupe: true, exclude: inQueue })
      if (!fresh.length) return

      markSeen(fresh)
      bucket.page = bucket.page + 1
      state.stats.refills += 1
      state.stats.fetched += fresh.length
      bucket.tracks = uniqBy(bucket.tracks.concat(fresh), (t) => t.songKey || t.dedupeKey).slice(0, LIST_RENDER_LIMIT)
      await ctx.playlist.append(fresh)
      persistStats()
      if (state.settings.toastOnRadio) ctx.toast.info('电台已补充 ' + fresh.length + ' 首（' + reason + '）')
      log('电台续杯', fresh.length, reason)
    } catch (e) {
      log('电台续杯异常', e)
    } finally {
      refillInFlight = false
    }
  }

  async function startRadio() {
    if (state.radio) {
      state.radio = false
      ctx.toast.info('电台已关闭（当前队列继续播放）')
      return
    }
    if (state.view !== 'feed') {
      state.view = 'feed'
    }
    const result = await loadBatch({ sourceId: state.sourceId })
    if (!result.ok || !result.tracks || !result.tracks.length) return
    const ok = await playAll()
    if (!ok) return
    state.radio = true
    ctx.toast.success('推荐电台已开启：队列快播完时会自动补充')
  }

  /* ---------------- 源健康检查 ---------------- */

  async function runHealthCheck() {
    if (state.checking) return
    state.checking = true
    const results = []
    for (const src of SOURCES) {
      const r = await fetchSource(ctx, src.id, {
        tags: state.tags || STYLE_TAG_PRESETS[0].id,
        historyDate: state.historyDate,
        size: 5,
        page: 1
      })
      let sample = ''
      if (!r.ok) sample = clipText(r.error, 120)
      else if (r.tracks[0]) sample = clipText(r.tracks[0].title + ' - ' + r.tracks[0].artist, 120)
      results.push({
        id: src.id,
        name: src.name,
        needLogin: src.needLogin,
        ok: r.ok,
        count: r.tracks.length,
        rawCount: r.rawCount,
        ms: r.ms,
        attempts: num(r.attempts, 1),
        httpStatus: r.httpStatus,
        errorCode: r.errorCode,
        error: r.error,
        unknownCount: num(r.unknownCount, 0),
        debug: r.debug || null,
        rawKeys: r.rawKeys || '',
        songKeys: r.songKeys || '',
        rawSnippet: r.rawSnippet || '',
        sample
      })
    }
    state.checking = false
    state.health = { at: Date.now(), results }
    const okCount = results.filter((r) => r.ok && r.count > 0).length
    if (okCount) ctx.toast.success('推荐源检查完成：' + okCount + '/' + SOURCES.length + ' 可用')
    else ctx.toast.warning('推荐源检查完成：全部不可用，请查看明细')
    return state.health
  }

  async function copyDiagnostics() {
    const payload = {
      plugin: PLUGIN_ID,
      version: ctx.manifest && ctx.manifest.version,
      at: new Date().toISOString(),
      loggedIn: !!readAuth(ctx),
      source: state.sourceId,
      tags: state.tags,
      historyDate: state.historyDate,
      error: state.error,
      notice: state.notice,
      health: state.health,
      // 各源缓存情况：切回某个源不请求时，靠这份数据判断是"缓存命中"而非"卡住了"
      caches: Object.keys(state.lists).reduce((acc, id) => {
        const b = state.lists[id]
        acc[id] = { count: (b.tracks || []).length, page: b.page, at: b.at }
        return acc
      }, {}),
      stats: { ...state.stats }
    }
    const text = JSON.stringify(payload, null, 2)
    let copied = false
    try {
      if (ctx.electron && ctx.electron.share && ctx.electron.share.copy) {
        await ctx.electron.share.copy(text)
        copied = true
      }
    } catch {
      copied = false
    }
    if (!copied) {
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch {
        copied = false
      }
    }
    if (copied) ctx.toast.success('诊断信息已复制')
    else ctx.toast.warning('复制失败，请在控制台查看 [推荐电台] 日志')
    log('诊断信息', payload)
    return text
  }

  /* ---------------- 设置项写入 ---------------- */

  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return
    const next = { ...state.settings, [key]: value }
    state.settings = normalizeSettings(next)
    persistSettings()
    if (key === 'sidebarEntry') applySidebarEntry(state.settings.sidebarEntry)
    if (key === 'defaultSource') state.sourceId = state.settings.defaultSource
  }

  /* ---------------- 页面组件 ---------------- */

  const ICON_PLAY =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.14v13.72L19 12 8 5.14z"/></svg>'
  const ICON_PAUSE =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
  const ICON_HEART =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 20s-7-4.6-7-9.4A4.1 4.1 0 0 1 12 7a4.1 4.1 0 0 1 7 3.6C19 15.4 12 20 12 20z"/></svg>'
  const ICON_HEART_FILLED =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 20s-7-4.6-7-9.4A4.1 4.1 0 0 1 12 7a4.1 4.1 0 0 1 7 3.6C19 15.4 12 20 12 20z"/></svg>'
  const ICON_BAN =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5 17.5 6.5"/></svg>'
  const ICON_NEXT =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l8 6-8 6z" fill="currentColor"/><path d="M18 6v12"/></svg>'

  const RecommendPage = V.defineComponent({
    name: 'KugouRecommendPage',
    setup() {
      onMounted(() => {
        if (!listOf(state.sourceId).length && !state.loading) {
          loadBatch({ sourceId: state.sourceId })
        }
      })

      const currentId = computed(() => {
        const cur = (ctx.player && ctx.player.currentTrack && ctx.player.currentTrack.value) || null
        return str(cur && (cur.hash || cur.id))
      })
      const isPlaying = computed(() => !!(ctx.player && ctx.player.isPlaying && ctx.player.isPlaying.value))

      function trackIsCurrent(t) {
        const c = currentId.value
        if (!c) return false
        return c === str(t.hash) || c === str(t.id)
      }

      function toastIfEmpty(action) {
        if (!visibleTracks.value.length) {
          ctx.toast.warning('还没有推荐内容，先点「换一批」')
          return true
        }
        if (action === 'more' && !activeSource.value.infinite) return false
        return false
      }

      function onTitleClick(t) {
        if (!trackIsCurrent(t) || !isPlaying.value) playTrack(t)
        else if (ctx.player && typeof ctx.player.toggle === 'function') ctx.player.toggle()
      }

      /**
       * 切换推荐源。
       *
       * 每个源各自保留自己的列表（像多标签页）：
       *   - 该源已有列表 → **直接恢复缓存，不重新请求**（并说明是缓存 + 新鲜度）
       *   - 该源还没有列表 → 「切源自动刷新」开则立即拉一批，关则给提示让用户手动点「换一批」
       */
      function switchSource(s) {
        const changed = state.sourceId !== s.id
        state.sourceId = s.id
        state.settings = { ...state.settings, defaultSource: s.id }
        persistSettings()
        state.error = ''

        const bucket = state.lists[s.id]
        const cached = bucket && Array.isArray(bucket.tracks) ? bucket.tracks : EMPTY_LIST

        // 重复点当前源：开自动刷新时当作「刷新」，否则什么都不做
        if (!changed) {
          if (state.settings.autoRefreshOnSwitch && cached.length > 0) {
            return loadBatch({ sourceId: s.id })
          }
          state.notice = '「' + s.name + '」已是当前推荐源'
          return null
        }

        if (cached.length) {
          const age = relativeTime(bucket.at)
          state.notice = '已切换到「' + s.name + '」，恢复上次的 ' + cached.length + ' 首' +
            (age ? '（' + age + '）' : '') + ' —— 点「换一批」可刷新'
          return null
        }

        if (!state.settings.autoRefreshOnSwitch) {
          state.notice = '已切换到「' + s.name + '」，该源还没有列表 —— 点「换一批」加载'
          return null
        }

        state.notice = ''
        return loadBatch({ sourceId: s.id })
      }

      function toggleAutoRefresh() {
        setSetting('autoRefreshOnSwitch', !state.settings.autoRefreshOnSwitch)
        if (!state.settings.autoRefreshOnSwitch) {
          state.notice = '已关闭「切源自动刷新」：切换推荐源只换源，不会立即拉取'
        } else {
          state.notice = '已开启「切源自动刷新」：切换推荐源会立即拉一批'
        }
      }

      /* ---- 头部 ---- */
      function renderHeader() {
        const src = activeSource.value
        return h('header', { class: 'kr-head' }, [
          h('div', { class: 'kr-title-row' }, [
            h('div', { class: 'kr-title-block' }, [
              h('h2', { class: 'kr-title' }, state.view === 'liked' ? '我喜欢' : '推荐电台'),
              h('p', { class: 'kr-subtitle' }, state.view === 'liked'
                ? '本地收藏，共 ' + state.liked.length + ' 首'
                : src.desc + (src.needLogin && !readAuth(ctx) ? '（需要登录）' : ''))
            ]),
            h('div', { class: 'kr-head-actions' }, [
              h('button', {
                class: 'kr-btn',
                'data-action': 'view-feed',
                'data-on': state.view === 'feed' ? '1' : '0',
                onClick: () => { state.view = 'feed' }
              }, '推荐'),
              h('button', {
                class: 'kr-btn',
                'data-action': 'view-liked',
                'data-on': state.view === 'liked' ? '1' : '0',
                onClick: () => { state.view = 'liked' }
              }, '我喜欢 ' + state.liked.length),
              h('button', {
                class: 'kr-btn',
                'data-action': 'refresh',
                disabled: state.loading || state.view === 'liked',
                onClick: () => loadBatch({ sourceId: state.sourceId })
              }, state.loading ? '加载中…' : '换一批'),
              h('button', {
                class: 'kr-btn',
                'data-action': 'more',
                disabled: state.loading || state.view === 'liked' || !src.infinite,
                onClick: () => loadMore()
              }, '再来一批'),
              h('button', {
                class: 'kr-btn kr-btn-primary',
                'data-action': 'play-all',
                disabled: !visibleTracks.value.length,
                onClick: () => playAll()
              }, '播放全部'),
              h('button', {
                class: 'kr-btn' + (state.radio ? ' kr-btn-danger' : ''),
                'data-action': 'radio',
                'data-on': state.radio ? '1' : '0',
                onClick: () => startRadio()
              }, state.radio ? '关闭电台' : '开启电台')
            ])
          ]),
          h('div', { class: 'kr-sources' }, SOURCES.map((s) => {
            const n = cacheCount(s.id)
            return h('button', {
              class: 'kr-chip',
              'data-source': s.id,
              'data-on': state.sourceId === s.id ? '1' : '0',
              // 显式暴露缓存条数：既让用户看出「这个源已经拉过、切回去会恢复」，
              // 也让测试能直接断言各源缓存互不干扰
              'data-cache': String(n),
              title: s.desc + (s.needLogin ? '（需要登录）' : '') +
                (n ? '｜已缓存 ' + n + ' 首，切回时恢复' : '｜暂无列表'),
              onClick: () => switchSource(s)
            }, [
              h('span', { class: 'kr-chip-name' }, s.name),
              n ? h('span', { class: 'kr-chip-cache' }, String(n)) : null,
              s.needLogin ? h('span', { class: 'kr-chip-lock', title: '需要登录' }, '登录') : null,
              s.infinite ? h('span', { class: 'kr-chip-inf', title: '无限流' }, '∞') : null
            ])
          })),
          h('div', { class: 'kr-toolbar' }, [
            src.usesTags
              ? h('label', { class: 'kr-field' }, [
                  h('span', { class: 'kr-field-label' }, src.id === 'style' ? '曲风 tagids' : '标签'),
                  h('input', {
                    class: 'kr-input',
                    'data-role': 'tags',
                    placeholder: src.id === 'style' ? '如 1 或 1,2（曲风 id）' : '如 1,2（标签 id）',
                    value: state.tags,
                    onInput: (e) => { state.tags = e.target.value }
                  })
                ])
              : null,
            src.id === 'style'
              ? h('div', { class: 'kr-tag-presets' }, STYLE_TAG_PRESETS.map((t) =>
                  h('button', {
                    class: 'kr-tag',
                    'data-tag': t.id,
                    onClick: () => {
                      state.tags = state.tags ? state.tags + ',' + t.id : t.id
                      return loadBatch({ sourceId: state.sourceId })
                    }
                  }, t.label)))
              : null,
            src.id === 'history'
              ? h('label', { class: 'kr-field' }, [
                  h('span', { class: 'kr-field-label' }, '日期'),
                  h('input', {
                    class: 'kr-input',
                    'data-role': 'history-date',
                    placeholder: 'YYYY-MM-DD，留空=最新',
                    value: state.historyDate,
                    onInput: (e) => { state.historyDate = e.target.value }
                  })
                ])
              : null,
            h('button', {
              class: 'kr-btn',
              'data-action': 'toggle-auto-refresh',
              'data-on': state.settings.autoRefreshOnSwitch ? '1' : '0',
              title: '切换推荐源时是否立即拉一批；关闭后只切源，由你决定何时加载',
              onClick: () => toggleAutoRefresh()
            }, '切源自动刷新：' + (state.settings.autoRefreshOnSwitch ? '开' : '关')),
            h('button', {
              class: 'kr-btn kr-btn-ghost',
              'data-action': 'health',
              disabled: state.checking,
              onClick: () => runHealthCheck()
            }, state.checking ? '检查中…' : '源健康检查'),
            h('button', {
              class: 'kr-btn kr-btn-ghost',
              'data-action': 'copy-diag',
              onClick: () => copyDiagnostics()
            }, '复制诊断')
          ]),
          state.error ? h('div', { class: 'kr-banner kr-banner-error', 'data-role': 'error' }, state.error) : null,
          state.notice ? h('div', { class: 'kr-banner', 'data-role': 'notice' }, state.notice) : null,
          state.radio ? h('div', { class: 'kr-banner kr-banner-live', 'data-role': 'radio' }, [
            h('span', { class: 'kr-dot' }),
            '电台进行中：队列剩余 ' + remainingInQueue() + ' 首，低于 ' + state.settings.refillThreshold + ' 首时自动补充'
          ]) : null
        ])
      }

      /* ---- 列表行 ---- */
      function renderRow(t, idx) {
        const cur = trackIsCurrent(t)
        const liked = likedSet.value.has(t.dedupeKey)
        const cover = state.settings.showCover ? h('img', {
          class: 'kr-cover',
          src: t.coverUrl || '',
          alt: '',
          loading: 'lazy',
          onError: (e) => { e.target.style.visibility = 'hidden' }
        }) : null

        return h('div', {
          class: 'kr-row' + (cur ? ' is-current' : ''),
          key: t.dedupeKey,
          'data-track-id': t.id,
          'data-dedupe': t.dedupeKey,
          onDblclick: () => playTrack(t)
        }, [
          h('button', {
            class: 'kr-idx',
            'data-action': 'play',
            'data-track-id': t.id,
            title: cur && isPlaying.value ? '暂停' : '播放',
            onClick: () => onTitleClick(t)
          }, [
            h('span', { class: 'kr-idx-inner', innerHTML: cur && isPlaying.value ? ICON_PAUSE : ICON_PLAY }),
            h('span', { class: 'kr-idx-num' }, String(idx + 1))
          ]),
          cover,
          h('div', { class: 'kr-meta' }, [
            h('div', { class: 'kr-name' }, t.title),
            h('div', { class: 'kr-artist' }, [t.artist, t.albumName ? h('span', { class: 'kr-album' }, ' · ' + t.albumName) : null])
          ]),
          h('div', { class: 'kr-badges' }, [
            state.settings.showQuality && t.qualityLabel ? h('span', { class: 'kr-q' }, t.qualityLabel) : null,
            h('span', { class: 'kr-src' }, getSource(t.sourceId).name)
          ]),
          h('div', { class: 'kr-time' }, formatDuration(t.duration)),
          h('div', { class: 'kr-ops' }, [
            h('button', {
              class: 'kr-op',
              'data-action': 'next',
              'data-track-id': t.id,
              title: '下一首播放',
              onClick: () => playNext(t)
            }, h('span', { innerHTML: ICON_NEXT })),
            h('button', {
              class: 'kr-op' + (liked ? ' is-on' : ''),
              'data-action': 'like',
              'data-track-id': t.id,
              'data-on': liked ? '1' : '0',
              title: liked ? '取消喜欢' : '喜欢',
              onClick: () => toggleLike(t)
            }, h('span', { innerHTML: liked ? ICON_HEART_FILLED : ICON_HEART })),
            h('button', {
              class: 'kr-op kr-op-danger',
              'data-action': 'block',
              'data-track-id': t.id,
              title: '不感兴趣',
              onClick: () => block(t)
            }, h('span', { innerHTML: ICON_BAN }))
          ])
        ])
      }

      function renderList() {
        const list = visibleTracks.value
        if (state.loading && !list.length) {
          return h('div', { class: 'kr-empty' }, '正在获取推荐…')
        }
        if (!list.length) {
          return h('div', { class: 'kr-empty' }, state.view === 'liked'
            ? '还没有喜欢的歌，在推荐列表里点 ♥ 就能收藏到这里'
            : '暂无推荐内容。点「换一批」拉取，或先跑一次「源健康检查」看看哪个源可用。')
        }
        return h('div', { class: 'kr-list', 'data-role': 'list' }, list.slice(0, LIST_RENDER_LIMIT).map(renderRow))
      }

      function renderHealth() {
        const health = state.health
        if (!health) return null
        const okCount = health.results.filter((r) => r.ok && r.count > 0).length
        return h('section', { class: 'kr-card kr-health', 'data-role': 'health' }, [
          h('div', { class: 'kr-card-head' }, [
            h('h3', null, '推荐源健康检查'),
            h('span', { class: 'kr-muted' }, okCount + '/' + health.results.length + ' 可用 · ' + new Date(health.at).toLocaleTimeString())
          ]),
          h('table', { class: 'kr-table' }, [
            h('thead', null, h('tr', null, [
              h('th', null, '推荐源'),
              h('th', null, '结果'),
              h('th', null, '条数'),
              h('th', null, 'HTTP'),
              h('th', null, 'error_code'),
              h('th', null, '耗时'),
              h('th', null, '样本 / 原因')
            ])),
            h('tbody', null, health.results.map((r) => h('tr', {
              key: r.id,
              'data-health': r.id,
              'data-ok': r.ok && r.count > 0 ? '1' : '0'
            }, [
              h('td', null, [h('span', null, r.name), r.needLogin ? h('span', { class: 'kr-muted' }, ' · 需登录') : null]),
              h('td', null, r.ok && r.count > 0
                ? h('span', { class: 'kr-ok' }, '✓ 可用')
                : h('span', { class: 'kr-bad' }, r.ok ? '• 空结果' : '✕ 不可用')),
              h('td', null, [
                String(r.count) + (r.rawCount && r.rawCount !== r.count ? ' / ' + r.rawCount : ''),
                r.unknownCount
                  ? h('span', { class: 'kr-warn', 'data-warn': r.id }, ' ⚠' + r.unknownCount + ' 首未识别')
                  : null
              ]),
              h('td', null, r.httpStatus ? String(r.httpStatus) : '—'),
              h('td', null, r.errorCode ? String(r.errorCode) : '—'),
              h('td', null, r.ms + 'ms' + (num(r.attempts, 1) > 1 ? '（重试后）' : '')),
              h('td', {
                class: 'kr-cell-clip',
                'data-raw-keys': r.rawKeys || '',
                'data-debug': r.debug
                  ? JSON.stringify({ route: r.debug.route, requested: r.debug.requested, matched: r.debug.matched, filled: r.debug.filled })
                  : '',
                title: [
                  r.error || r.sample || '',
                  r.debug
                    ? '反查 ' + r.debug.route + '：请求 ' + r.debug.requested + ' 个 hash，命中 ' + r.debug.matched +
                      (r.debug.error ? '，失败原因：' + r.debug.error : '')
                    : '',
                  r.debug && r.debug.keys ? '反查条目键名：' + r.debug.keys : '',
                  r.debug && r.debug.snippet ? '反查首条：' + r.debug.snippet : '',
                  r.rawSnippet ? '原始首条：' + r.rawSnippet : ''
                ]
                  .filter(Boolean)
                  .join('\n\n')
              }, r.error || r.sample || '—')
            ])))
          ])
        ])
      }

      function renderStats() {
        const s = state.stats
        return h('section', { class: 'kr-card' }, [
          h('div', { class: 'kr-card-head' }, h('h3', null, '统计与维护')),
          h('div', { class: 'kr-stats' }, [
            h('div', { class: 'kr-stat' }, [h('b', null, String(s.fetched)), h('span', null, '累计取数')]),
            h('div', { class: 'kr-stat' }, [h('b', null, String(s.played)), h('span', null, '播放次数')]),
            h('div', { class: 'kr-stat' }, [h('b', null, String(s.liked)), h('span', null, '累计喜欢')]),
            h('div', { class: 'kr-stat' }, [h('b', null, String(s.blocked)), h('span', null, '累计屏蔽')]),
            h('div', { class: 'kr-stat' }, [h('b', null, String(s.refills)), h('span', null, '电台续杯')])
          ]),
          h('div', { class: 'kr-toolbar' }, [
            h('button', { class: 'kr-btn kr-btn-ghost', 'data-action': 'clear-seen', onClick: () => clearSeen() }, '清空去重记录（' + state.seen.length + '）'),
            h('button', { class: 'kr-btn kr-btn-ghost', 'data-action': 'clear-blocked', onClick: () => clearBlocked() }, '清空屏蔽（' + state.blocked.length + '）'),
            h('button', {
              class: 'kr-btn kr-btn-ghost',
              'data-action': 'clear-caches',
              'data-caches': String(Object.keys(state.lists).length),
              title: '清空各推荐源已缓存的列表，下次切换源会重新拉取',
              onClick: () => clearAllCaches()
            }, '清空各源缓存（' + Object.keys(state.lists).length + '）'),
            h('span', { class: 'kr-muted' }, '队列剩余 ' + remainingInQueue() + ' 首')
          ])
        ])
      }

      return () =>
        h('div', { class: 'kr-page', 'data-view': state.view, 'data-radio': state.radio ? '1' : '0' }, [
          renderHeader(),
          renderList(),
          renderHealth(),
          renderStats()
        ])
    }
  })

  /* ---------------- 设置面板组件 ---------------- */

  const SettingsPanel = V.defineComponent({
    name: 'KugouRecommendSettings',
    setup() {
      function row(key, label, hint, control) {
        return h('div', { class: 'kr-set-row', 'data-setting': key }, [
          h('div', { class: 'kr-set-text' }, [
            h('div', { class: 'kr-set-label' }, label),
            hint ? h('div', { class: 'kr-set-hint' }, hint) : null
          ]),
          h('div', { class: 'kr-set-control' }, control)
        ])
      }

      function toggle(key, label, hint) {
        const on = !!state.settings[key]
        return row(key, label, hint, h('button', {
          class: 'kr-switch',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'data-on': on ? '1' : '0',
          onClick: () => setSetting(key, !state.settings[key])
        }, h('span', { class: 'kr-switch-knob' })))
      }

      function numberInput(key, label, hint, min, max) {
        return row(key, label, hint, h('input', {
          class: 'kr-input kr-input-sm',
          type: 'number',
          min: String(min),
          max: String(max),
          value: String(state.settings[key]),
          onChange: (e) => setSetting(key, clamp(e.target.value, min, max))
        }))
      }

      function textInput(key, label, hint, placeholder) {
        return row(key, label, hint, h('input', {
          class: 'kr-input',
          placeholder: placeholder || '',
          value: String(state.settings[key] || ''),
          onChange: (e) => setSetting(key, str(e.target.value))
        }))
      }

      return () =>
        h('div', { class: 'kr-settings' }, [
          h('section', { class: 'kr-card' }, [
            h('div', { class: 'kr-card-head' }, h('h3', null, '推荐')),
            row('defaultSource', '默认推荐源', '启动时用哪个源拉取推荐', h('select', {
              class: 'kr-input kr-input-sm',
              value: state.settings.defaultSource,
              onChange: (e) => setSetting('defaultSource', e.target.value)
            }, SOURCES.map((s) => h('option', { value: s.id, selected: state.settings.defaultSource === s.id }, s.name)))),
            numberInput('batchSize', '每批数量', '一次拉取并展示多少首（5–100）', 5, 100),
            toggle('autoRefreshOnSwitch', '切换推荐源时自动刷新', '开启：点推荐源 chip 立即拉一批（默认）；关闭：只切源并保留当前列表，需手动点「换一批」'),
            textInput('tags', '标签 / 曲风 tagids', '频道漫游的标签、曲风推荐的 tagids，逗号分隔', '如 1,2'),
            textInput('historyDate', '每日历史日期', '「每日历史」源指定回看日期，留空取最新', 'YYYY-MM-DD'),
            toggle('shuffle', '随机打散', '拉回后打乱顺序，避免每次顺序雷同'),
            toggle('dedupe', '跨批次去重', '同一会话内不重复推荐同一首（按 hash）'),
            toggle('filterBlocked', '过滤已屏蔽', '不再推荐标记过「不感兴趣」的歌')
          ]),
          h('section', { class: 'kr-card' }, [
            h('div', { class: 'kr-card-head' }, h('h3', null, '电台模式')),
            toggle('autoRadio', '默认开启自动续杯', '开启电台后，队列快播完时自动补充下一批'),
            numberInput('refillThreshold', '续杯阈值', '队列剩余多少首时触发自动补充（1–10）', 1, 10),
            toggle('toastOnRadio', '续杯时弹提示', '每次自动补充都弹 toast，默认关闭以免打断')
          ]),
          h('section', { class: 'kr-card' }, [
            h('div', { class: 'kr-card-head' }, h('h3', null, '界面')),
            toggle('sidebarEntry', '侧边栏显示入口', '关闭后可从插件管理页重新打开；立即生效'),
            toggle('showCover', '显示封面', '关闭可略微提升长列表渲染速度'),
            toggle('showQuality', '显示音质标签', 'FLAC / 320K / HQ，来自音频可用音质'),
            toggle('debug', '调试日志', '在控制台输出取数与续杯细节')
          ]),
          h('p', { class: 'kr-muted kr-footnote' },
            '本插件只读写自己命名空间下的存储；网络请求只有两个去向：宿主内置的酷狗接口通道，以及酷狗概念版网关。不上传任何数据。')
        ])
    }
  })

  /* ---------------- 注册 ---------------- */

  let sidebarDispose = null
  let settingsDispose = null

  function applySidebarEntry(enabled) {
    if (enabled) {
      if (sidebarDispose) return true
      try {
        const dispose =
          ctx.ui && ctx.ui.sidebar && typeof ctx.ui.sidebar.addItem === 'function'
            ? ctx.ui.sidebar.addItem({
                id: 'kugou-recommend-entry',
                title: '推荐',
                icon: 'tabler:radio',
                pageId: 'recommend',
                section: 'plugins',
                sectionTitle: '插件',
                order: 30
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

  // 页面不带 sidebar：入口用 sidebar.addItem 动态增删，设置开关才能立即生效
  ctx.ui.addPage({
    id: 'recommend',
    title: '推荐',
    icon: 'tabler:radio',
    component: RecommendPage
  })

  applySidebarEntry(state.settings.sidebarEntry)

  settingsDispose = ctx.ui.settings.define({
    title: '推荐电台 设置',
    description: '推荐源、批大小、电台续杯与界面选项。',
    component: SettingsPanel
  })

  /* ---------------- 播放事件 → 自动续杯 ---------------- */

  const eventDisposers = []

  function bindEvent(fn) {
    if (typeof fn !== 'function') return
    try {
      const d = fn(() => maybeRefill('播放事件'))
      if (typeof d === 'function') eventDisposers.push(d)
    } catch (e) {
      log('绑定播放事件失败', e)
    }
  }

  if (ctx.events) {
    bindEvent(ctx.events.onEnded)
    bindEvent(ctx.events.onTrackChange)
  }

  // 队列本身变短时也补一次（例如用户手动清队列）
  if (ctx.stores && ctx.stores.playlist && typeof watch === 'function') {
    try {
      const stop = watch(
        () => {
          const q = ctx.stores.playlist.activeQueue
          return q && Array.isArray(q.songs) ? q.songs.length : 0
        },
        () => { if (state.radio) maybeRefill('队列变化') }
      )
      if (typeof stop === 'function') eventDisposers.push(stop)
    } catch (e) {
      log('监听队列失败', e)
    }
  }

  // 宿主里切歌后清理过期状态（避免长时间运行后 seen 无界增长）
  if (ctx.events && typeof ctx.events.onTrackChange === 'function') {
    try {
      const d = ctx.events.onTrackChange((track) => {
        if (track && track.hash) log('当前播放', track.hash)
      })
      if (typeof d === 'function') eventDisposers.push(d)
    } catch (e) {
      log('监听切歌失败', e)
    }
  }

  ctx.dispose(() => {
    for (const d of eventDisposers) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* ignore */
      }
    }
    eventDisposers.length = 0
    if (typeof sidebarDispose === 'function') {
      try {
        sidebarDispose()
      } catch {
        /* ignore */
      }
    }
    sidebarDispose = null
    if (typeof settingsDispose === 'function') {
      try {
        settingsDispose()
      } catch {
        /* ignore */
      }
    }
    settingsDispose = null
    state.radio = false
    log('已停用并回收资源')
  })

  log('已启用，v' + ((ctx.manifest && ctx.manifest.version) || '?'))
  return { ok: true }
}

export async function deactivate() {
  if (runtime) runtime.radio = false
  ctxRef = null
  runtime = null
}
