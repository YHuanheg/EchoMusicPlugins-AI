/**
 * 歌单导入增强 (playlist-importer) —— EchoMusic 插件
 * ===========================================================================
 * 把「其他音乐软件」的歌单导入到 EchoMusic。
 *
 * ## 为什么要做这个插件（宿主已经有「导入外部歌单」）
 *
 * EchoMusic v2.3.2-beta.6 侧边栏「新建 → 导入外部歌单」已经支持 7 个平台的**链接**与
 * **截图 OCR** 导入。但那套流程是"一键黑盒"：匹配过程不可见、低置信结果无法人工干预、
 * 不支持本地歌单文件、失败清单拿不出来。本插件补齐的正是这几块：
 *
 *   1. **本地歌单文件导入** —— JSON（网易云 / QQ 音乐导出）/ CSV / TXT / M3U / M3U8，
 *      外加直接粘贴文本与拖拽文件；宿主只支持链接和截图。
 *   2. **匹配预演（dry-run）** —— 逐首搜索并给出 top-N 候选与三因子分数（标题 / 歌手 / 时长），
 *      用户可人工改选、可跳过、可单条重试，**确认之后才真正写库**。
 *   3. **重复处理** —— 批内按歌曲级 key 折叠（UP-08），并可选检测目标歌单里已有的 hash。
 *   4. **失败可回收** —— 失败 / 低分清单可导出 CSV / JSON，支持「只重试失败项」。
 *   5. **目标可选** —— 新建歌单（自定义名称、撞名有兜底）或导入到已有歌单。
 *
 * 链接导入（网易云 / QQ 音乐 / 酷我 / 酷狗 / Spotify / 汽水）作为入口保留，
 * 但复用同一套「读取 → 预演 → 导入」链路，不依赖宿主那个对话框。
 *
 * ## 落点事实（决定了整个设计）
 *
 * EchoMusic 本地库（`%APPDATA%\echo-music\echomusic.sqlite`）只有
 * `app_kv` / `play_history` / `playback_queues` / `queue_items` / `songs` 五张表，
 * **没有本地歌单表** —— EchoMusic 里的「歌单」就是**酷狗云端歌单**。
 * 所以导入的落点必然是：
 *   新建歌单  POST /playlist/add         （module/playlist_add.js → /cloudlist.service/v5/add_list）
 *   加歌      POST /playlist/tracks/add  （module/playlist_tracks_add.js → /cloudlist.service/v6/add_song）
 *   列歌单    GET  /user/playlist        （module/user_playlist.js → /v7/get_all_list）
 *   歌单歌曲  GET  /playlist/track/all   （用于「目标歌单已有歌曲」去重）
 * 全部走 `ctx.electron.api.request` 本地路由（宿主注入设备指纹与 cookie），
 * **不要自己拼签名**（KG-02 / KG-05）。
 *
 * ## 硬约束（踩过才有这段注释）
 *
 * - 单文件 ESM、**禁止 bare import**；Vue 从 `ctx.vue` 取。
 * - 只要调本地路由，就必须声明 `capabilities.kugouVerification` 并写风控兜底（KG-07）。
 * - 直连网易云 / QQ 音乐等需要 `capabilities.unrestrictedNetwork`（否则渲染进程被 CORS 拦，
 *   表现为"连不上"，是假阴性）。
 * - 读本地文件刻意**不用** `ctx.fs` / `localFiles` 能力：走 `<input type=file>` + `File.text()`，
 *   这是宿主自己导入截图时用的同一条路（能力最小化）。
 */

const PLUGIN_ID = 'playlist-importer'
const PLUGIN_VERSION = '1.0.0'

/* ========================================================================== *
 * 常量
 * ========================================================================== */

/** 接受阈值 —— 对齐宿主导入实现里用的 0.72，用户可在设置里调 */
const DEFAULT_ACCEPT = 0.72
/** 低于此分当作「未匹配」；介于 ACCEPT 与它之间是「低置信」（可人工确认后导入） */
const LOW_SCORE = 0.55

/** 单次 /playlist/tracks/add 最多几首（对齐宿主实现里的 50，模块端 `slow_upload: 1`） */
const ADD_BATCH_SIZE = 50
/** 批与批之间的间隔，别把上游打爆 */
const ADD_BATCH_INTERVAL_MS = 400
/** 每个关键词最多取几个候选（预演表里的"备选"） */
const SEARCH_PAGE_SIZE = 6
/** 每首最多试几个关键词（第一个够好就停） */
const SEARCH_MAX_KEYWORDS = 3
/** 搜索并发（本地路由是主进程串行化的，开太高只会互相排队） */
const SEARCH_CONCURRENCY = 2
/** 两次搜索之间的最小间隔 */
const SEARCH_INTERVAL_MS = 220
/** 预演表默认最多渲染多少行（超过就折叠，避免一次渲染几百行 vnode） */
const DEFAULT_RENDER_LIMIT = 60
/** 拉「目标歌单已有歌曲」时最多翻几页 × 每页 300 */
const EXISTING_MAX_PAGES = 4

/** 时长接近度分档（秒） */
const DURATION_BANDS = [
  [3, 1],
  [8, 0.85],
  [15, 0.55],
  [30, 0.2]
]

/** 权重：标题 > 歌手 > 时长（时长只在两边都知道时参与，见 scoreCandidate） */
const W_TITLE = 0.55
const W_ARTIST = 0.3
const W_DURATION = 0.15

/** 本地路由（宿主内置服务器，路由由 module/<file>.js 的文件名生成：下划线 → 斜杠） */
const ROUTE = {
  search: '/search',
  userPlaylist: '/user/playlist',
  playlistAdd: '/playlist/add',
  playlistTracksAdd: '/playlist/tracks/add',
  playlistTrackAll: '/playlist/track/all',
  playlistTrackAllNew: '/playlist/track/all/new'
}

/** 任务中心条目 id —— 不能以 `echo:` 开头（宿主保留） */
const TASK_ID = PLUGIN_ID + ':import'

/* ========================================================================== *
 * 通用工具
 * （照 skills/echomusic-plugin-dev/assets/lib/upstream.md，可复制片段）
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

/**
 * 只接受「标量」的取值器。
 * 为什么不用 firstOf：外部歌单导出格式里 `name` 常常是**嵌套对象**（如 `{song:{name}}`），
 * 直接 `str(obj)` 会得到 "[object Object]" 混进歌名里 —— 这是最容易翻车的一处。
 */
function scalarOf(obj, paths) {
  if (!isObj(obj)) return ''
  for (const p of paths) {
    const v = pathGet(obj, p)
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

/**
 * 在对象图里按候选键名做一次「限深广度优先」查找，返回第一个非空标量。
 *
 * BFS 天然优先命中最浅层，所以调用方只要把「精确键名」放第一次调用、
 * 把「泛化键名」（name / title）放到第二次调用，就能避免"先撞上旁边的无关字段"。
 *
 * ⚠️ 对外只暴露两个参数，递归深度是内部状态 —— 本仓库踩过
 * `deepFind(body, keys, "")` 把 fallback 传成 depth、导致深层字段静默查不到的坑。
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
 * 深度优先找「第一个满足条件的对象」（找 `{playlistInfo, medias}` 这类载荷用）。
 * trim 同一层能避免深挖无关分支。
 */
function findObjectDeep(obj, pred, depth) {
  const maxDepth = Number.isFinite(depth) ? depth : 6
  const queue = [{ node: obj, d: 0 }]
  let visited = 0
  while (queue.length && visited < 1500) {
    const cur = queue.shift()
    visited++
    const node = cur.node
    if (!isObj(node) || cur.d > maxDepth) continue
    if (!Array.isArray(node) && pred(node)) return node
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (isObj(v)) queue.push({ node: v, d: cur.d + 1 })
    }
  }
  return null
}

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

function uniqStrings(arr) {
  return uniqBy(arr || [], (s) => str(s))
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(num(seconds, 0)))
  if (!s) return ''
  const m = Math.floor(s / 60)
  const r = s % 60
  return m + ':' + String(r).padStart(2, '0')
}

/**
 * 把各种「时长」写法统一成**秒**。
 * 上游两种单位都存在：网易云 `dt` 是毫秒，QQ 音乐 `interval` 是秒。
 * 阈值取 60000：没有任何一首歌是 1000 分钟长，所以「> 60000 就是毫秒」是安全的判别。
 */
function durationSeconds(v) {
  const n = num(v, 0)
  if (n <= 0) return 0
  return n > 60000 ? Math.round(n / 1000) : Math.round(n)
}

/** 可中断的 sleep：每 200ms 检查一次 abort 标志（长流程必备，KG-06） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sleepAbortable(ms, isAborted) {
  if (ms <= 0) return !(isAborted && isAborted())
  const step = 100
  let waited = 0
  while (waited < ms) {
    if (isAborted && isAborted()) return false
    const chunk = Math.min(step, ms - waited)
    await sleep(chunk)
    waited += chunk
  }
  return !(isAborted && isAborted())
}

/* ========================================================================== *
 * 上游归一化：识别一首歌 / 挑出歌曲数组 / 抓原始形态
 * ========================================================================== */

const HASH_MIN_LEN = 16
const HASH_FIELDS = ['hash', 'hash_128', 'hash_320', 'hash_flac', 'hash_high', 'file_hash', 'FileHash']

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

/** 一首歌可能是裸对象，也可能被包在 item.song 里 */
function unwrapSong(raw) {
  if (!isObj(raw)) return null
  const s = raw.song
  if (isObj(s) && (isObj(s.base) || isObj(s.audio_info) || hasHashLike(s))) return s
  return raw
}

/**
 * 「名称类」字段名。
 * ⚠️ **必须同时收录首字母大写的形式** —— 酷狗搜索接口（`/search` → `/v2/search/song`）返回的就是
 * `SongName` / `SingerName` / `FileName` / `AlbumName` 这种驼峰头大写，
 * 而概念版网关接口给小写。少收了就会让 `pickTrackArray` 的"带名称信息"加权失效，
 * 于是一个响应里同时存在「纯 hash 列表」和「带完整信息的列表」时会**随机挑到光秃秃那个**。
 */
const NAME_FIELDS = [
  'songname', 'song_name', 'songName', 'SongName', 'Songname',
  'audio_name', 'audioName', 'audioName',
  'filename', 'fileName', 'FileName',
  'author_name', 'authorName', 'AuthorName',
  'singername', 'singer_name', 'singerName', 'SingerName',
  'singer', 'Singer', 'artist', 'Artist',
  'AlbumName', 'albumname', 'album_name',
  'name', 'Name', 'title', 'Title'
]

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

/**
 * 从任意上游响应里把「歌曲数组」找出来。
 * 不同接口的载荷层级差异很大（`data` / `data.songs` / `data.song_list` / `data.info` /
 * `data.list[].songs` …）。打分：带名称信息的条目数 >> 命中 hash 的条目数 > 数组长度 ——
 * 名称信息是比 hash 更强的「这是一首歌」信号（UP-07）。
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
        const hits = objs.filter((o) => hasHashLike(unwrapSong(o)) || hasHashLike(o)).length
        if (hits > 0) {
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
 * 只有当分隔符**左侧与歌手完全一致**、且右侧还有内容时才剥 ——
 * 否则会误伤本身带连字符的正常歌名（`A - B`）。
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

/** 主 hash 的取值顺序：`hash` / `hash_128` 才是规范标识，320/flac 属于 relateGoods（UP-10） */
function pickMainHash(s) {
  const base = isObj(s.base) ? s.base : s
  const ai = isObj(s.audio_info) ? s.audio_info : isObj(s.audioInfo) ? s.audioInfo : {}
  // 酷狗不同接口返回的 hash 大小写还不一致，统一转小写，否则同一首歌跨源会被当成两首
  return (
    str(scalarOf(ai, ['hash', 'hash_128'])) ||
    str(scalarOf(base, ['hash', 'file_hash', 'hash_128', 'FileHash'])) ||
    str(scalarOf(s, ['hash', 'file_hash', 'FileHash'])) ||
    str(findFieldDeep(s, ['hash'])) ||
    str(scalarOf(ai, ['hash_320', 'hash_flac', 'hash_high'])) ||
    str(scalarOf(base, ['hash_320', 'hash_flac'])) ||
    ''
  ).toLowerCase()
}

/**
 * 抓一份「上游原始形态」摘要。
 * 归一化失败时光看「未知歌曲」是修不了的 —— 必须知道上游把字段放在哪一层、叫什么名。
 * 通过界面上的「复制诊断」回传，一次就能校准。
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

/**
 * 判断是不是「网络层」的临时失败（而不是业务错误）。
 * 酷狗的业务错误**一定带非零 error_code**（20010 / 21001 / 20018 …），
 * 所以「HTTP 502 但 error_code 为 0」= 根本没走到业务层，是上游连接被重置，
 * 重试一次通常就好；业务拒绝重试多少次都一样，不该重试（徒增风控风险）。
 */
function isTransientError(message, httpStatus, errorCode) {
  const m = String(message || '')
  if (
    /^net::|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK|ERR_SOCKET|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|网关请求失败/i.test(
      m
    )
  ) {
    return true
  }
  return num(httpStatus, 0) === 502 && num(errorCode, 0) === 0
}

const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 700

/* ========================================================================== *
 * 文本归一化与相似度（匹配打分的地基）
 * ========================================================================== */

/** 噪声词：不同平台的同一首歌常带这些后缀，去掉之后相似度才准 */
const NOISE_RE = /feat\.?|ft\.?|featuring|remaster(ed)?|instrumental|伴奏|纯音乐|无损|高音质|试听版|现场版|抖音版|正式版|原唱/gi

/** 括号（中英文圆括号 / 方括号 / 书名号 / 花括号），成对剥离时用 */
const BRACKET_PAIR_RE = /[（(\[【《{][^（(\[【《{）)\]】》}]*[）)\]】》}]/g
const BRACKET_ANY_RE = /[（(\[【《{）)\]】》}]/g

/**
 * 归一化歌名/歌手，用于比较（**不要**用于显示）。
 * 处理全角 → 半角、去括号内容、去噪声词、去标点空白、小写。
 *
 * 括号剥离必须**迭代**：`光年之外（电影《太空旅客》推广曲）` 里的外层圆括号内含书名号，
 * 一次替换只能吃掉最内层的 `《太空旅客》`，剩下的 `（电影 推广曲）` 要去掉外层还得再来一轮。
 * 单轮实现的结果是歌名里残留 「推广曲」，直接影响匹配分数。
 */
function normalizeText(input) {
  let t = str(input).toLowerCase()
  // 全角 ASCII → 半角
  t = t.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  t = t.replace(/\u3000/g, ' ')
  // 迭代剥括号：先吃最内层，外层下一轮自然露出来
  let prev = ''
  let guard = 0
  while (t !== prev && guard < 8) {
    prev = t
    t = t.replace(BRACKET_PAIR_RE, ' ')
    guard++
  }
  t = t.replace(BRACKET_ANY_RE, ' ')
  t = t.replace(NOISE_RE, ' ')
  // 其余非字母数字（含中日韩文字以外的标点）统一成空格
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ')
  return t.trim().replace(/\s+/g, ' ')
}

/**
 * Dice 系数（二元组）。
 * 选它而不是编辑距离：歌名常有"词序调换""多一个副标题"这类差异，
 * 二元组重合度对这类噪声更稳，且对长度差异天然归一化到 0..1。
 */
function dice(a, b) {
  const A = str(a).replace(/\s+/g, '')
  const B = str(b).replace(/\s+/g, '')
  if (!A || !B) return 0
  if (A === B) return 1
  if (A.length < 2 || B.length < 2) return 0

  const grams = new Map()
  for (let i = 0; i < A.length - 1; i++) {
    const g = A.slice(i, i + 2)
    grams.set(g, (grams.get(g) || 0) + 1)
  }
  let hit = 0
  for (let i = 0; i < B.length - 1; i++) {
    const g = B.slice(i, i + 2)
    const c = grams.get(g) || 0
    if (c > 0) {
      hit++
      grams.set(g, c - 1)
    }
  }
  return (2 * hit) / (A.length - 1 + (B.length - 1))
}

/**
 * 歌名相似度。
 * 归一化后相等 → 1；否则 Dice，并对「短的是长的子串且占比 ≥ 0.6」给 0.92 的下限
 * （覆盖 `告白气球` vs `告白气球 (Live)` 这类：括号被去掉后其实是同一个串，
 *  以及 `起风了` vs `起风了 - 买辣椒也用券` 这类前缀式标题）。
 */
function scoreTitle(a, b) {
  const A = normalizeText(a)
  const B = normalizeText(b)
  if (!A || !B) return 0
  if (A === B) return 1
  const d = dice(A, B)
  // 包含关系要在**去掉空白之后**判断：normalizeText 会把标点折成单个空格，
  // 拿带空格的串算占比会把分母撑大（`告白气球 独唱` 的 4/7 = 0.571 就够不到 0.6 了）。
  const As = A.replace(/\s+/g, '')
  const Bs = B.replace(/\s+/g, '')
  const short = As.length <= Bs.length ? As : Bs
  const long = As.length <= Bs.length ? Bs : As
  if (short.length >= 2 && long.includes(short) && short.length / long.length >= 0.6) {
    return Math.max(d, 0.92)
  }
  return d
}

/** 歌手名拆分：`A / B`、`A、B`、`A & B`、`A feat. B` 都要拆开比 */
function splitArtists(v) {
  return uniqStrings(
    String(str(v) || '')
      .split(/[/、,;&·]|feat\.?|ft\.?|vs\.?|\s{2,}/i)
      .map((s) => normalizeText(s))
      .filter(Boolean)
  )
}

/**
 * 歌手相似度：两边任一未知 → 中性 0.5（**不能给 0**，否则「歌手字段缺失」会直接判死）。
 * 拆开后取最佳配对；任一对有包含关系（`周杰伦` vs `周杰伦 jay`）则给 0.85 下限。
 */
function scoreArtist(a, b) {
  const rawA = str(a)
  const rawB = str(b)
  if (!rawA || !rawB || rawA === '未知歌手' || rawB === '未知歌手') return 0.5

  const A = splitArtists(rawA)
  const B = splitArtists(rawB)
  if (!A.length || !B.length) return 0.5

  let best = 0
  let contained = false
  for (const x of A) {
    for (const y of B) {
      if (x === y) return 1
      best = Math.max(best, dice(x, y))
      if (y.includes(x) || x.includes(y)) contained = true
    }
  }
  return contained ? Math.max(best, 0.85) : best
}

/** 时长接近度；任一边未知 → `null`（调用方据此重新分配权重，而不是当 0 分） */
function scoreDuration(a, b) {
  const A = num(a, 0)
  const B = num(b, 0)
  if (!A || !B) return null
  const diff = Math.abs(A - B)
  for (const band of DURATION_BANDS) {
    if (diff <= band[0]) return band[1]
  }
  return 0
}

/**
 * 三因子打分。
 * 时长未知时按剩余权重重新归一化 —— 直接把缺失项当 0 会把大量正常匹配打到阈值以下
 * （网易云导出的歌单经常没有时长）。
 */
function scoreCandidate(ext, cand) {
  const ts = scoreTitle(ext && ext.title, cand && cand.title)
  const as = scoreArtist(ext && ext.artist, cand && cand.artist)
  const ds = scoreDuration(ext && ext.duration, cand && cand.duration)

  let total
  if (ds === null) {
    total = (ts * W_TITLE + as * W_ARTIST) / (W_TITLE + W_ARTIST)
  } else {
    total = ts * W_TITLE + as * W_ARTIST + ds * W_DURATION
  }
  return { total, title: ts, artist: as, duration: ds }
}

/**
 * 匹配档位。
 * `success` 可直接导入；`low` 需要用户勾选"包含低置信"才导入（默认不导入，宁可少也不能错）；
 * `null` 表示未匹配。
 */
function matchTierOf(score, accept) {
  const s = num(score, 0)
  const a = num(accept, DEFAULT_ACCEPT)
  if (s >= a) return 'success'
  if (s >= LOW_SCORE) return 'low'
  return null
}

/**
 * 关键词生成（最多 MAX_KEYWORDS 个，按"信息量"从高到低）。
 * 第一个「歌名 + 首位歌手」命中率最高；第二个用去括号的干净歌名；
 * 第三个退化成只搜歌名（歌手名翻译不一致时反而更准）。
 */
function buildKeywords(track) {
  const title = str(track && track.title)
  const bare = str(track && track.title).replace(/[（(\[【《][^）)\]】》]*[）)\]】》}]/g, ' ').trim()
  const artists = String(str(track && track.artist) || '')
    .split(/[/、,;&·]|feat\.?|ft\.?/i)
    .map((s) => s.trim())
    .filter(Boolean)
  const first = artists[0] || ''

  const out = []
  if (title && first) out.push(title + ' ' + first)
  if (bare && bare !== title) out.push(first ? bare + ' ' + first : bare)
  if (title) out.push(title)
  if (bare && !out.includes(bare)) out.push(bare)
  return uniqStrings(out).slice(0, SEARCH_MAX_KEYWORDS)
}

/* ========================================================================== *
 * 统一歌单模型
 * --------------------------------------------------------------------------
 * 所有来源（6 个平台 + 4 种文件格式 + 粘贴文本）最后都必须落成这一个形状，
 * 这样「预演 / 去重 / 导入」三层的代码完全不关心来源差异。
 * ========================================================================== */

/** 外部曲目：`duration` 一律是**秒**，0 表示未知（未知就不要参与打分，别硬塞 0 当"零秒"） */
function makeExternalTrack(fields, fallbackIndex) {
  const title = str(fields && fields.title)
  return {
    index: Number.isFinite(fallbackIndex) ? fallbackIndex : 0,
    title: title || '未知歌曲',
    artist: str(fields && fields.artist) || '未知歌手',
    album: str(fields && fields.album),
    duration: Math.max(0, Math.round(num(fields && fields.duration, 0))),
    externalId: str(fields && fields.externalId)
  }
}

function joinNames(v) {
  if (Array.isArray(v)) {
    return v
      .map((x) =>
        isObj(x) ? str(scalarOf(x, ['name', 'title', 'nickname', 'author_name', 'singerName'])) : str(x)
      )
      .filter(Boolean)
      .join(' / ')
  }
  if (isObj(v)) return str(scalarOf(v, ['name', 'title', 'nickname']))
  return str(v)
}

const ARTIST_KEYS = [
  'artist', 'artists', 'ar', 'singer', 'singers', 'singername', 'singerName',
  'singer_name', 'author', 'author_name', 'authorName', 'nickname'
]

function artistOf(raw) {
  if (!isObj(raw)) return ''
  for (const k of ARTIST_KEYS) {
    const v = raw[k]
    if (v === undefined || v === null) continue
    const s = joinNames(v)
    if (s) return s
  }
  return str(findFieldDeep(raw, ['singername', 'author_name', 'singerName', 'authorName'])) || ''
}

const ALBUM_KEYS = ['album', 'alb', 'al', 'albumname', 'albumName', 'album_name', 'albumTitle', 'albumtitle']

function albumOf(raw) {
  if (!isObj(raw)) return ''
  for (const k of ALBUM_KEYS) {
    const v = raw[k]
    if (v === undefined || v === null) continue
    const s = typeof v === 'string' ? str(v) : joinNames(v)
    if (s) return s
  }
  return str(findFieldDeep(raw, ['albumname', 'album_name', 'albumName'])) || ''
}

const TITLE_KEYS = [
  'title', 'name', 'songname', 'song_name', 'songName', 'song', 'audio_name', 'audioName',
  'track_name', 'trackName', 'filename', 'fileName', 'musicName'
]

/**
 * 把任意来源的一条原始记录归一化成外部曲目。
 * 三层兜底：精确键名（scalarOf，只用标量）→ 限深 BFS 按精确键名 → 限深 BFS 按泛化键名。
 * 第三层必须单独走一遍，否则「同层但旁边的对象」可能先命中 `name`，把专辑名当歌名。
 */
function normalizeExternalTrack(raw, sourceHint) {
  if (!isObj(raw)) return null
  const title =
    scalarOf(raw, TITLE_KEYS) ||
    str(findFieldDeep(raw, ['songname', 'song_name', 'songName', 'audio_name', 'filename'])) ||
    str(findFieldDeep(raw, ['title', 'name'])) ||
    ''
  const artist = artistOf(raw)
  const album = albumOf(raw)
  const duration = durationSeconds(
    scalarOf(raw, ['duration', 'dt', 'interval', 'timelength', 'time', 'duration_ms', 'length'])
  )
  const externalId = scalarOf(raw, ['id', 'songmid', 'rid', 'uri', 'mid', 'songid', 'externalId', 'song_id'])

  if (!title && !artist) return null
  return { title: cleanupTitle(title || '未知歌曲', artist), artist: artist || '未知歌手', album, duration, externalId, sourceHint }
}

function makePlaylist(fields) {
  const tracks = (fields && fields.tracks) || []
  return {
    source: str(fields && fields.source) || 'unknown',
    sourceName: str(fields && fields.sourceName) || '未知来源',
    sourceId: str(fields && fields.sourceId),
    name: str(fields && fields.name) || '导入的歌单',
    creator: str(fields && fields.creator),
    coverUrl: normalizeCover(fields && fields.coverUrl),
    description: clipText(fields && fields.description, 200),
    tracks: tracks.map((t, i) => ({ ...t, index: i + 1 })),
    rawSample: (fields && fields.rawSample) || []
  }
}

/** 一个对象看起来像不像「外部曲目」（用于在导出文件里挑歌曲数组） */
function looksLikeExternalTrack(o) {
  if (!isObj(o) || Array.isArray(o)) return false
  const title = scalarOf(o, TITLE_KEYS)
  if (!title) return false
  // 纯目录 / 元信息对象也会带 name，用「同时有歌手或时长或 id」再筛一道
  return !!(artistOf(o) || scalarOf(o, ['duration', 'dt', 'interval', 'timelength', 'songmid', 'rid']))
}

/** 在导出文件里挑出「最像歌曲列表」的数组（按 命中数 × 1000 + 长度 打分） */
function findExternalTrackArray(body) {
  if (Array.isArray(body)) {
    if (body.some(looksLikeExternalTrack)) return body
    return []
  }
  if (!isObj(body)) return []
  const queue = [{ node: body, depth: 0 }]
  const candidates = []
  let visited = 0
  while (queue.length && visited < 3000) {
    const cur = queue.shift()
    visited++
    const node = cur.node
    if (!isObj(node) || cur.depth > 6) continue
    if (Array.isArray(node)) {
      const objs = node.filter(isObj)
      const hits = objs.filter(looksLikeExternalTrack).length
      if (hits > 0) candidates.push({ arr: objs, score: hits * 1000 + objs.length })
      for (const x of objs.slice(0, 40)) queue.push({ node: x, depth: cur.depth + 1 })
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

/* ========================================================================== *
 * 本地歌单文件解析
 * --------------------------------------------------------------------------
 * 宿主只支持「链接 / 截图」，**不支持文件** —— 这是本插件最主要的那块缺口。
 * 覆盖用户实际最可能拿到的四种形态：
 *   JSON  网易云 / QQ 音乐「导出歌单」下载下来的 json
 *   CSV   自己整理的表格（带表头或不带）
 *   TXT   一行一首："歌名 - 歌手" / "歌手 - 歌名" / 只有歌名
 *   M3U   播放列表文件（#EXTINF:时长,歌手 - 歌名）
 * ========================================================================== */

function fileExt(name) {
  const m = String(str(name)).toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

/** 先看扩展名，扩展名不可信时再看内容特征 */
function detectFormat(filename, text) {
  const ext = fileExt(filename)
  if (ext === 'json') return 'json'
  if (ext === 'm3u' || ext === 'm3u8') return 'm3u'
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (ext === 'txt') return 'txt'

  const head = String(text || '').replace(/^\uFEFF/, '').trimStart()
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  if (/^#EXTM3U/i.test(head)) return 'm3u'
  const firstLine = head.split(/\r?\n/).find((l) => l.trim()) || ''
  if (/,(?=.*[a-zA-Z\u4e00-\u9fa5])/.test(firstLine) || /\t/.test(firstLine)) return 'csv'
  return 'txt'
}

function parseJsonPlaylist(text, filename) {
  const data = safeJson(text)
  if (!data) throw new Error('JSON 解析失败：文件不是合法 JSON（是否被截断？）')
  const tracks = findExternalTrackArray(data)
  if (!tracks.length) {
    throw new Error('JSON 里没找到歌曲数组：支持网易云 / QQ 音乐导出的歌单文件，或形如 [{name, artist}, …] 的数组')
  }
  const wrapper = isObj(data.playlist) ? data.playlist : isObj(data.result) ? data.result : data
  const first = Array.isArray(data.cdlist) ? data.cdlist[0] : null
  const meta = isObj(first) ? first : wrapper
  return makePlaylist({
    source: 'file',
    sourceName: '本地文件',
    name: scalarOf(meta, ['name', 'dissname', 'title', 'playlistName', 'playlist.name']) || baseName(filename),
    creator: joinNames(meta.creator || meta.nickname) || '',
    coverUrl: scalarOf(meta, ['coverImgUrl', 'logo', 'cover', 'picUrl']),
    description: scalarOf(meta, ['description', 'desc', 'introduction']),
    tracks: tracks.map((raw) => normalizeExternalTrack(raw, 'file')).filter(Boolean),
    rawSample: tracks.slice(0, 1)
  })
}

/** CSV 一行 → 字段数组（支持引号包裹与 "" 转义） */
function splitCsvLine(line, sep) {
  const out = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuote = false
      } else cur += c
    } else if (c === '"') inQuote = true
    else if (c === sep) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

const CSV_TITLE_KEYS = ['title', 'name', 'song', 'songname', '歌名', '歌曲', '歌曲名', '标题']
const CSV_ARTIST_KEYS = ['artist', 'singer', 'singers', '歌手', '艺人', '演唱者']
const CSV_ALBUM_KEYS = ['album', '专辑', '唱片']
const CSV_DURATION_KEYS = ['duration', 'time', 'length', '时长', '时间']

function headerIndex(header, keys) {
  for (let i = 0; i < header.length; i++) {
    const h = normalizeText(header[i])
    if (!h) continue
    if (keys.some((k) => h === normalizeText(k) || h.includes(normalizeText(k)))) return i
  }
  return -1
}

function parseCsvPlaylist(text, filename) {
  const rows = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
  if (!rows.length) throw new Error('CSV 是空的')
  const sep = rows[0].includes('\t') ? '\t' : ','

  const header = splitCsvLine(rows[0], sep)
  const tIdx = headerIndex(header, CSV_TITLE_KEYS)
  const aIdx = headerIndex(header, CSV_ARTIST_KEYS)
  const alIdx = headerIndex(header, CSV_ALBUM_KEYS)
  const dIdx = headerIndex(header, CSV_DURATION_KEYS)
  const hasHeader = tIdx >= 0

  const body = hasHeader ? rows.slice(1) : rows
  const tracks = []
  for (const line of body) {
    const cells = splitCsvLine(line, sep)
    if (!cells.length) continue
    if (hasHeader) {
      const title = str(cells[tIdx])
      if (!title) continue
      tracks.push(
        makeExternalTrack({
          title,
          artist: aIdx >= 0 ? cells[aIdx] : '',
          album: alIdx >= 0 ? cells[alIdx] : '',
          duration: dIdx >= 0 ? durationSeconds(cells[dIdx]) : 0
        })
      )
    } else {
      // 无表头：按「歌名, 歌手, 专辑」两列/三列处理
      const title = str(cells[0])
      if (!title) continue
      tracks.push(
        makeExternalTrack({ title, artist: cells[1] || '', album: cells[2] || '', duration: 0 })
      )
    }
  }
  if (!tracks.length) throw new Error('CSV 里没解析出任何歌曲（首行当作表头处理了？）')
  return makePlaylist({ source: 'file', sourceName: '本地文件', name: baseName(filename), tracks })
}

function parseM3uPlaylist(text, filename) {
  const lines = String(text).split(/\r?\n/)
  const tracks = []
  let current = null
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^#EXTINF:/i.test(line)) {
      // #EXTINF:240,歌手 - 歌名
      const rest = line.replace(/^#EXTINF:/i, '')
      const commaIdx = rest.indexOf(',')
      const durRaw = commaIdx >= 0 ? rest.slice(0, commaIdx) : rest
      const label = commaIdx >= 0 ? rest.slice(commaIdx + 1).trim() : ''
      current = parseLabelLine(label)
      current.duration = durationSeconds(durRaw)
      continue
    }
    if (line.startsWith('#')) continue
    if (current) {
      tracks.push(makeExternalTrack(current))
      current = null
    } else {
      // 没有 #EXTINF 的裸路径行：只从文件名里猜歌名
      const base = line.split(/[\\/]/).pop() || ''
      const guess = base.replace(/\.[a-z0-9]+$/i, '')
      if (guess) tracks.push(makeExternalTrack(parseLabelLine(guess)))
    }
  }
  if (current) tracks.push(makeExternalTrack(current))
  if (!tracks.length) throw new Error('M3U 里没解析出任何歌曲')
  return makePlaylist({ source: 'file', sourceName: '本地文件', name: baseName(filename), tracks })
}

/** "歌手 - 歌名" / "歌名 - 歌手" / 只有歌名。分隔符两侧都有内容才当分隔符用。 */
function parseLabelLine(label) {
  const t = str(label)
  if (!t) return { title: '', artist: '' }
  for (const sep of [' - ', ' – ', ' — ', '－', '|', '\t']) {
    const i = t.indexOf(sep)
    if (i <= 0) continue
    const left = t.slice(0, i).trim()
    const right = t.slice(i + sep.length).trim()
    if (!left || !right) continue
    // 约定：`歌名 - 歌手` 更常见（大部分软件的导出就是这个顺序）
    return { title: left, artist: right }
  }
  return { title: t, artist: '' }
}

function parseLinesPlaylist(text, filename) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const tracks = []
  for (const line of lines) {
    // 纯文本里也允许带个序号前缀："1. 歌名 - 歌手" / "1 歌名"
    const cleaned = line.replace(/^\d+[.、)]?\s+/, '')
    const parsed = parseLabelLine(cleaned)
    if (!parsed.title) continue
    tracks.push(makeExternalTrack(parsed))
  }
  if (!tracks.length) throw new Error('文本里没解析出任何歌曲（每行一首，格式："歌名 - 歌手"）')
  return makePlaylist({ source: 'text', sourceName: '粘贴文本', name: baseName(filename) || '粘贴的歌单', tracks })
}

function baseName(filename) {
  const s = str(filename)
  if (!s) return ''
  return (s.split(/[\\/]/).pop() || '').replace(/\.[a-z0-9]+$/i, '')
}

/** 统一入口：任意文本 + 文件名 → 歌单模型 */
function parsePlaylistText(text, filename) {
  const raw = String(text === null || text === undefined ? '' : text)
  if (!raw.trim()) throw new Error('内容为空')
  const fmt = detectFormat(filename, raw)
  if (fmt === 'json') return parseJsonPlaylist(raw, filename)
  if (fmt === 'm3u') return parseM3uPlaylist(raw, filename)
  if (fmt === 'csv') return parseCsvPlaylist(raw, filename)
  return parseLinesPlaylist(raw, filename)
}

/* ========================================================================== *
 * 外部平台的 HTTP 取数
 * --------------------------------------------------------------------------
 * 走 `ctx.net.request`（主进程 Axios）—— 需要 capabilities.unrestrictedNetwork，
 * 否则渲染进程的 fetch 会被 CORS 拦掉，探针报"连不上"是假阴性。
 * ========================================================================== */

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const UA_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

function hasNetRequest(ctx) {
  return !!(ctx && ctx.net && typeof ctx.net.request === 'function')
}

async function httpRequest(ctx, url, opts) {
  const o = opts || {}
  if (!hasNetRequest(ctx)) {
    throw new Error('宿主未提供网络通道（需要 capabilities.unrestrictedNetwork）')
  }
  const res = await ctx.net.request({
    url,
    method: o.method || 'GET',
    headers: o.headers || {},
    body: o.body,
    responseType: o.responseType || 'text',
    timeoutMs: num(o.timeoutMs, 20000),
    maxResponseBytes: num(o.maxResponseBytes, 16 * 1024 * 1024),
    maxRedirects: 5
  })
  if (!res || !Number.isFinite(num(res.status, NaN))) {
    throw new Error('请求没有返回（网络不可达或已被拦截）')
  }
  if (res.status >= 400) {
    throw new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''))
  }
  return res
}

function responseJson(res) {
  const d = res && res.data
  if (isObj(d)) return d
  const parsed = safeJson(d)
  if (parsed) return parsed
  throw new Error('返回内容不是合法 JSON（可能被风控返回了 HTML 页面）')
}

function responseText(res) {
  const d = res && res.data
  if (typeof d === 'string') return d
  if (d === undefined || d === null) return ''
  try {
    return JSON.stringify(d)
  } catch {
    return ''
  }
}

/** 从 HTML 里用「花括号配对」抠出一个完整 JSON 对象（跳过字符串里的括号） */
function extractJsonByBrace(text, fromIndex) {
  const src = String(text || '')
  let depth = 0
  let inStr = false
  let esc = false
  let started = false
  for (let i = Math.max(0, fromIndex); i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') {
      depth++
      started = true
    } else if (c === '}') {
      depth--
      if (started && depth === 0) return src.slice(fromIndex, i + 1)
    }
  }
  return ''
}

/**
 * 从 HTML 页面里抠载荷对象（Spotify / 汽水这种"页面里塞 JSON"的来源用）。
 * 逐段 script 尝试，任一能 JSON.parse 并且 predicate 命中就返回。
 */
function extractPayloadFromHtml(html, pred) {
  const src = String(html || '')
  if (!src) return null
  const markers = ['__NEXT_DATA__', '__pace_f', 'window.__INITIAL_STATE__', 'loaderData', 'playlistInfo']
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi
  const blobs = []
  let m
  while ((m = scriptRe.exec(src))) {
    const body = m[1]
    if (body && body.length > 200) blobs.push(body)
  }
  // 整体也试一次（有的页面把 JSON 放在属性里）
  blobs.push(src)

  for (const body of blobs) {
    const tries = []
    const direct = safeJson(body.trim())
    if (direct) tries.push(direct)
    for (const marker of markers) {
      const at = body.indexOf(marker)
      if (at < 0) continue
      const braceAt = body.indexOf('{', at)
      if (braceAt < 0) continue
      const chunk = extractJsonByBrace(body, braceAt)
      if (!chunk) continue
      const parsed = safeJson(chunk)
      if (parsed) tries.push(parsed)
    }
    for (const candidate of tries) {
      const hit = findObjectDeep(candidate, pred, 8)
      if (hit) return hit
    }
  }
  return null
}

/* ========================================================================== *
 * 来源平台注册表
 * --------------------------------------------------------------------------
 * 每个 provider 只负责「输入 → 统一歌单模型」，不认识的一律抛带可读文案的 Error。
 * 数据驱动，加平台只要往数组里塞一条。
 * ========================================================================== */

/** 从链接里抠出一个 id：先跑专用正则，再用通用 query 参数兜底 */
function pickId(input, patterns, queryKeys) {
  const t = str(input)
  for (const re of patterns || []) {
    const m = t.match(re)
    if (m && m[1]) return m[1]
  }
  for (const k of queryKeys || []) {
    const m = t.match(new RegExp('[?&#]' + k + '=([^&#]+)', 'i'))
    if (m && m[1]) return decodeURIComponent(m[1])
  }
  // 纯 id 直接给
  if (/^[A-Za-z0-9_-]{2,64}$/.test(t)) return t
  return ''
}

const NETEASE_ID_RES = [
  /music\.163\.com\/[^\s]*?[?#&]id=(\d+)/i,
  /music\.163\.com\/[^\s]*?playlist[/=](\d+)/i,
  /playlist[/=](\d+)/i
]

/**
 * 网易云歌单。
 * 注意两个坑：
 *  1. 大歌单的 `playlist.tracks` 会被截断（只给前若干首），完整列表要用 `trackIds` +
 *     `/api/v3/song/detail` 分批补 —— 不补的话 1000 首的歌单只会导入几百首。
 *  2. 接口要带 `Referer`，否则拿不到。
 */
async function resolveNetease(ctx, input) {
  let target = str(input)
  if (/163cn\.tv/i.test(target)) {
    try {
      const res = await httpRequest(ctx, target, { headers: { 'User-Agent': UA_SAFARI } })
      const finalUrl = str(res.url) || ''
      const body = responseText(res)
      const m = body.match(/https?:\/\/[^\s"']*music\.163\.com[^\s"']*/)
      if (finalUrl && /music\.163\.com/.test(finalUrl)) target = finalUrl
      else if (m) target = m[0]
    } catch {
      /* 短链解析失败就继续用原串试 */
    }
  }
  const id = pickId(target, NETEASE_ID_RES, ['id'])
  if (!id) throw new Error('未能从输入中识别网易云歌单 ID（支持 music.163.com/#/playlist?id=… 与 163cn.tv 短链）')

  const headers = { Referer: 'https://music.163.com/', 'User-Agent': UA_SAFARI }
  const res = await httpRequest(ctx, 'https://music.163.com/api/v6/playlist/detail?id=' + id + '&n=100000', { headers })
  const payload = responseJson(res)
  const p = payload && payload.playlist
  if (!p) throw new Error('网易云返回数据为空，可能歌单不存在或为私密歌单')

  let rawTracks = Array.isArray(p.tracks) ? p.tracks.slice() : []
  const trackIds = Array.isArray(p.trackIds) ? p.trackIds.map((x) => str(x && x.id)).filter(Boolean) : []

  // tracks 被截断时用 /api/v3/song/detail 补齐（500 首一批）
  if (trackIds.length > rawTracks.length) {
    const have = new Set(rawTracks.map((t) => String(t && t.id)))
    const missing = trackIds.filter((x) => !have.has(x))
    const filled = []
    for (let i = 0; i < missing.length; i += 500) {
      const chunk = missing.slice(i, i + 500)
      try {
        const detail = await httpRequest(ctx, 'https://music.163.com/api/v3/song/detail', {
          method: 'POST',
          headers: {
            Referer: 'https://music.163.com/',
            'User-Agent': UA_SAFARI,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'c=' + encodeURIComponent(JSON.stringify(chunk.map((x) => ({ id: x }))))
        })
        const dj = responseJson(detail)
        if (Array.isArray(dj && dj.songs)) filled.push(...dj.songs)
      } catch {
        /* 补不到就少几首，不要整单失败 */
      }
    }
    rawTracks = rawTracks.concat(filled)
  }

  if (!rawTracks.length) throw new Error('该网易云歌单没有歌曲（或全部为不可播放曲目）')

  const byId = new Map(rawTracks.map((t) => [String(t && t.id), t]))
  const ordered = trackIds.length
    ? trackIds.map((x) => byId.get(x)).filter(Boolean)
    : rawTracks

  return makePlaylist({
    source: 'netease',
    sourceName: '网易云',
    sourceId: id,
    name: str(p.name) || '网易云歌单',
    creator: str(p.creator && p.creator.nickname),
    coverUrl: p.coverImgUrl,
    description: p.description,
    tracks: ordered.map((raw) => normalizeExternalTrack(raw, 'netease')).filter(Boolean),
    rawSample: ordered.slice(0, 1)
  })
}

const QQ_ID_RES = [/disstid=(\d+)/i, /playlist[/=](\d+)/i, /taoge\/detail[/=](\d+)/i, /id=(\d+)/i]

async function resolveQqmusic(ctx, input) {
  const id = pickId(input, QQ_ID_RES, ['disstid', 'id'])
  if (!id) throw new Error('未能从输入中识别 QQ 音乐歌单 ID（支持 y.qq.com/n/ryqq/playlist/… 与 ?id=… ）')
  const url =
    'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&disstid=' +
    encodeURIComponent(id) +
    '&format=json&utf8=1&outCharset=utf-8&onlysong=0&new_format=1'
  const res = await httpRequest(ctx, url, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': UA_SAFARI } })
  const data = responseJson(res)
  const cd = Array.isArray(data && data.cdlist) && data.cdlist.length ? data.cdlist[0] : null
  if (!cd) throw new Error('QQ 音乐返回数据为空，可能歌单不存在或为私密歌单')
  const list = Array.isArray(cd.songlist) ? cd.songlist : []
  if (!list.length) throw new Error('该 QQ 音乐歌单没有歌曲')
  return makePlaylist({
    source: 'qqmusic',
    sourceName: 'QQ 音乐',
    sourceId: id,
    name: str(cd.dissname) || 'QQ 音乐歌单',
    creator: str(cd.nickname),
    coverUrl: cd.logo,
    description: cd.desc,
    tracks: list.map((raw) => normalizeExternalTrack(raw, 'qqmusic')).filter(Boolean),
    rawSample: list.slice(0, 1)
  })
}

/** 酷我：分页接口，必须翻完；`code !== 200` 是它表达"歌单不存在/私密"的方式 */
async function resolveKuwo(ctx, input) {
  const id = pickId(input, [/playlist_detail\/(\d+)/i, /play_detail\/(\d+)/i, /playlist\/(\d+)/i], ['pid', 'id'])
  if (!id) throw new Error('未能从输入中识别酷我音乐歌单 ID')
  const headers = { 'User-Agent': UA_DESKTOP, Referer: 'http://www.kuwo.cn/' }
  const tracks = []
  let meta = null
  let total = 0
  for (let page = 1; page <= 50; page++) {
    const url = 'http://wapi.kuwo.cn/api/www/playlist/playListInfo?pid=' + encodeURIComponent(id) + '&pn=' + page + '&rn=100'
    const res = await httpRequest(ctx, url, { headers })
    const data = responseJson(res)
    if (num(data && data.code, -1) !== 200) {
      throw new Error('酷我音乐返回失败：' + (str(data && data.msg) || '歌单不存在或为私密歌单'))
    }
    const d = (data && data.data) || {}
    if (page === 1) {
      meta = d
      total = num(d.total, 0)
    }
    const list = Array.isArray(d.musicList) ? d.musicList : []
    if (!list.length) break
    tracks.push(...list)
    if ((total > 0 && tracks.length >= total) || list.length < 100) break
  }
  if (!tracks.length) throw new Error('酷我音乐返回数据为空')
  return makePlaylist({
    source: 'kuwo',
    sourceName: '酷我',
    sourceId: id,
    name: str(meta && meta.name) || '酷我歌单',
    creator: str(meta && (meta.nickname || meta.uname)),
    coverUrl: str(meta && (meta.img500 || meta.pic)),
    description: meta && meta.info,
    tracks: tracks.map((raw) => normalizeExternalTrack(raw, 'kuwo')).filter(Boolean),
    rawSample: tracks.slice(0, 1)
  })
}

/** 酷狗：走宿主本地路由读（别人的公开歌单也能读），比直连稳 */
async function resolveKugou(ctx, input, deps) {
  const id = pickId(
    input,
    [/global_collection_id=([^&#]+)/i, /special\/single\/(\d+)/i, /plist\/list\/(\d+)/i, /share\/[^/]*\/?(\d+)/i],
    ['global_collection_id', 'listid', 'id']
  )
  if (!id) throw new Error('未能从输入中识别酷狗歌单 ID（支持 global_collection_id / special/single/… ）')
  const route = (deps && deps.localRoute) || null
  if (!route) throw new Error('酷狗歌单需要宿主本地路由（请确认宿主版本 ≥ 2.3.2-beta.2）')

  // `collection_3_1234_0_0` 这种是「别人的歌单」→ /playlist/track/all（按 global_collection_id）
  // 纯数字多半是自己歌单的 listid → /playlist/track/all/new（按 listid）
  const byGid = /^collection_/i.test(id)
  const routePath = byGid ? ROUTE.playlistTrackAll : ROUTE.playlistTrackAllNew
  const paramName = byGid ? 'id' : 'listid'

  const raw = []
  let meta = {}
  let page = 1
  while (page <= 40) {
    const params = {}
    params[paramName] = id
    params.page = page
    params.pagesize = 300
    const r = await route(ctx, routePath, params)
    const body = r && r.body
    const chunk = pickTrackArray(body)
    if (page === 1) {
      meta = findObjectDeep(body, (o) => !!scalarOf(o, ['list_name', 'name', 'global_collection_id']), 5) || {}
    }
    if (!chunk.length) break
    raw.push(...chunk)
    if (chunk.length < 300) break
    page++
  }
  if (!raw.length) throw new Error('没读到该酷狗歌单的歌曲（歌单可能为空、私密或已删除）')
  return makePlaylist({
    source: 'kugou',
    sourceName: '酷狗',
    sourceId: id,
    name: scalarOf(meta, ['list_name', 'name', 'playlist_name']) || '酷狗歌单',
    creator: scalarOf(meta, ['nickname', 'username', 'list_create_username']),
    coverUrl: scalarOf(meta, ['imgurl', 'cover', 'pic']),
    tracks: raw.map((r) => {
      const item = unwrapSong(r)
      const hash = pickMainHash(item)
      const title = scalarOf(item, ['songname', 'SongName', 'FileName', 'audio_name'])
      const artist = artistOf(item) || scalarOf(item, ['singername', 'SingerName', 'author_name'])
      return makeExternalTrack({
        title: title || '未知歌曲',
        artist,
        album: scalarOf(item, ['album_name', 'AlbumName']),
        duration: durationSeconds(scalarOf(item, ['timelength', 'Duration', 'duration'])),
        externalId: hash
      })
    }),
    rawSample: raw.slice(0, 1)
  })
}

/** Spotify：embed 页里塞了 __NEXT_DATA__ */
async function resolveSpotify(ctx, input) {
  const id = pickId(input, [/playlist\/([A-Za-z0-9]{22})/, /spotify:playlist:([A-Za-z0-9]{22})/], [])
  if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) throw new Error('未能从输入中识别 Spotify 歌单 ID（22 位）')
  const res = await httpRequest(ctx, 'https://open.spotify.com/embed/playlist/' + id, { headers: { 'User-Agent': UA_DESKTOP } })
  const html = responseText(res)
  const payload = extractPayloadFromHtml(html, (o) => Array.isArray(o.trackList) || (str(o.type) === 'playlist' && o.name))
  if (!payload) throw new Error('无法从 Spotify 页面提取数据（页面结构可能已变更）')
  const entity = isObj(payload.entity) ? payload.entity : payload
  const list = Array.isArray(entity.trackList) ? entity.trackList : []
  if (!list.length) throw new Error('该 Spotify 歌单没有歌曲或为私密歌单')
  return makePlaylist({
    source: 'spotify',
    sourceName: 'Spotify',
    sourceId: id,
    name: str(entity.name) || 'Spotify 歌单',
    creator: str(entity.subtitle) || '',
    coverUrl: str(entity.coverArt && (entity.coverArt.url || entity.coverArt.sources && entity.coverArt.sources[0] && entity.coverArt.sources[0].url)),
    tracks: list.map((raw) => normalizeExternalTrack(raw, 'spotify')).filter(Boolean),
    rawSample: list.slice(0, 1)
  })
}

/** 汽水音乐：同样靠页面里的 JSON，做通用抠取 + 明确失败文案 */
async function resolveQishui(ctx, input) {
  const id = pickId(input, [/qishui\/share\/playlist\/(\w+)/i, /share\/playlist\/(\w+)/i], ['id', 'playlist_id'])
  const url = id
    ? 'https://qishui.douyin.com/s/i' + encodeURIComponent(id) + '/'
    : str(input)
  if (!/^https?:/i.test(url)) throw new Error('未能从输入中识别汽水音乐歌单链接')
  const res = await httpRequest(ctx, url, { headers: { 'User-Agent': UA_DESKTOP } })
  const html = responseText(res)
  const payload = extractPayloadFromHtml(
    html,
    (o) => isObj(o.playlistInfo) || (Array.isArray(o.medias) && o.medias.length > 0)
  )
  if (!payload) throw new Error('无法从汽水音乐页面提取歌单数据（页面结构可能已变更，建议改用导出文件导入）')
  const info = isObj(payload.playlistInfo) ? payload.playlistInfo : payload
  const medias = Array.isArray(payload.medias) ? payload.medias : []
  if (!medias.length) throw new Error('该汽水音乐歌单没有歌曲或为私密歌单')
  return makePlaylist({
    source: 'qishui',
    sourceName: '汽水音乐',
    sourceId: id,
    name: str(info.title) || str(info.name) || '汽水音乐歌单',
    creator: str(info.owner && (info.owner.nickname || info.owner.public_name)),
    coverUrl: info.url_cover,
    tracks: medias.map((raw) => normalizeExternalTrack(raw, 'qishui')).filter(Boolean),
    rawSample: medias.slice(0, 1)
  })
}

const PROVIDERS = [
  { id: 'netease', name: '网易云', test: /163\.com|163cn\.tv/i, resolve: resolveNetease },
  { id: 'qqmusic', name: 'QQ 音乐', test: /y\.qq\.com|qq\.com\/n\/ryqq|c\.y\.qq\.com/i, resolve: resolveQqmusic },
  { id: 'kuwo', name: '酷我', test: /kuwo\.cn|kuwo\.com/i, resolve: resolveKuwo },
  { id: 'kugou', name: '酷狗', test: /kugou\.com|global_collection_id|special\/single/i, resolve: resolveKugou },
  { id: 'spotify', name: 'Spotify', test: /open\.spotify\.com|spotify:playlist/i, resolve: resolveSpotify },
  { id: 'qishui', name: '汽水音乐', test: /qishui\.douyin\.com|music\.douyin\.com\/qishui/i, resolve: resolveQishui }
]

function providerById(id) {
  const key = str(id)
  if (!key || key === 'auto') return null
  return PROVIDERS.find((p) => p.id === key) || null
}

/** 自动识别来源；识别不出返回 null（调用方给"请手动选择平台"的文案） */
function detectProvider(input) {
  const t = str(input)
  if (!t) return null
  return PROVIDERS.find((p) => p.test.test(t)) || null
}

/**
 * 链接 → 歌单模型。
 * `providerId` 为 `auto` 时自动识别；显式指定时**优先按指定平台解析**，
 * 但解析失败会带着两个错误一起报出来（用户手选错平台时能看出来）。
 */
async function resolveLink(ctx, input, providerId, deps) {
  const raw = str(input)
  if (!raw) return { ok: false, error: '请先填入歌单链接', providerId: 'auto' }

  const explicit = providerById(providerId)
  const detected = detectProvider(raw)
  const order = []
  if (explicit) order.push(explicit)
  if (detected && (!explicit || detected.id !== explicit.id)) order.push(detected)
  if (!order.length) {
    return {
      ok: false,
      providerId: 'auto',
      error:
        '没能识别这个链接属于哪个平台。请在上方手动选择平台，或改用「本地文件 / 粘贴文本」导入。当前支持：' +
        PROVIDERS.map((p) => p.name).join(' / ')
    }
  }

  const errors = []
  for (const p of order) {
    try {
      const playlist = await p.resolve(ctx, raw, deps)
      return { ok: true, playlist, providerId: p.id }
    } catch (e) {
      errors.push(p.name + '：' + ((e && e.message) || String(e)))
    }
  }
  return { ok: false, error: errors.join(' ｜ '), providerId: order[0].id }
}

/* ========================================================================== *
 * 酷狗本地路由层
 * --------------------------------------------------------------------------
 * 路由由 `resources/server/module/<file>.js` 的文件名生成（下划线 → 斜杠），
 * 主进程会注入设备指纹与 cookie，**插件不要自己拼签名**（KG-01 / KG-02）。
 * 关键语义：4xx/5xx **不抛异常**，业务错误统一是 `HTTP 502 + 顶层 error_code`，
 * 所以判断成功要看 `body.status === 1`，不能看 HTTP 200。
 * ========================================================================== */

function hasHostApi(ctx) {
  return !!(ctx && ctx.electron && ctx.electron.api && typeof ctx.electron.api.request === 'function')
}

/** 本地路由调用：**不**带风控兜底，内部用；业务侧请走 guardedRoute */
async function rawRoute(ctx, url, params, data) {
  return ctx.electron.api.request({
    method: 'GET', // method 会被宿主忽略，模块自己决定上游方法（KG-02 第 1 条）
    url,
    params: params || {},
    headers: {},
    data: data || {}
  })
}

/** KG-09 ①：`error_code` 为 0 表示「没有业务错误码」，绝不能拿它去查错误码表 */
function routeErrorText(body, res) {
  const b = isObj(body) ? body : {}
  const code = num(b.error_code, 0)
  const upstream = str(b.error || b.msg || b.message || b.error_msg)
  if (upstream) return upstream
  if (code) return '酷狗返回错误码 ' + code
  const status = num(res && res.status, 0)
  if (status && status !== 200) return 'HTTP ' + status
  return '接口返回失败'
}

/**
 * 风控兜底（**只要调本地路由就必须写**，KG-07）。
 * 主进程会把上游的 ssa-code 同时写进 `headers['ssa-code']` 与 `body.ssaCode`，
 * 但**插件这一侧没有任何自动兜底** —— 漏了的表现是"每一首都失败：本次请求需要验证"，
 * 看着像接口坏了。判定必须带「请求确实失败」：某些接口成功响应里也会带 ssaCode
 * （仅提示需要二次验证），那种情况不该弹窗。
 */
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

async function tryKugouVerify(ctx, eventId, log) {
  const api = ctx && ctx.kugouVerification
  if (!api || typeof api.request !== 'function') {
    return {
      ok: false,
      error: '宿主未提供安全验证通道（需要 manifest 声明 capabilities.kugouVerification）'
    }
  }
  try {
    const r = await api.request(eventId)
    if (r && r.ok) return { ok: true }
    return { ok: false, error: (r && r.error) || '安全验证未通过', canceled: !!(r && r.canceled) }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    if (log) log('安全验证异常', msg)
    return { ok: false, error: msg, canceled: /已取消/.test(msg) }
  }
}

/** 一轮（一次用户动作）只弹一次验证窗：第一档没验过就别再弹 */
function makeVerifyState() {
  return { done: false, ok: false, error: '' }
}

async function guardedRoute(ctx, url, params, data, verifyState, log) {
  let res = await rawRoute(ctx, url, params, data)
  const eventId = verificationEventId(res)
  if (!eventId) return res

  if (verifyState && verifyState.done) return res
  if (verifyState) verifyState.done = true

  const v = await tryKugouVerify(ctx, eventId, log)
  if (verifyState) {
    verifyState.ok = !!v.ok
    verifyState.error = v.canceled ? '已取消安全验证' : v.error || '安全验证未通过'
  }
  if (v.ok) res = await rawRoute(ctx, url, params, data)
  return res
}

/** 登录态：两种 pinia 实现都兼容，别写死一层 */
function readLogin(ctx) {
  const root = (ctx && ctx.pinia && ctx.pinia.state && ctx.pinia.state.value) || (ctx && ctx.pinia && ctx.pinia.state) || {}
  const user = (root.user && root.user.info) || {}
  const device = (root.device && root.device.info) || (root.device && root.device) || {}
  return {
    token: str(user.token),
    userid: str(user.userid || user.userId),
    nickname: str(user.nickname),
    dfid: str(device.dfid),
    mid: str(device.mid)
  }
}

/* ---------------------------------------------------------------- 读：搜索 */

/** 搜索返回条目 → 归一化候选（字段名照宿主自己的解析器核对过） */
function normalizeSearchItem(item) {
  const s = unwrapSong(item)
  if (!isObj(s)) return null
  const hash = pickMainHash(s)
  if (!hash) return null
  const artist = artistOf(s) || scalarOf(s, ['SingerName', 'singername', 'author_name'])
  const title = scalarOf(s, ['SongName', 'FileName', 'songname', 'song_name', 'audio_name'])
  return {
    hash,
    title: cleanupTitle(title || '未知歌曲', artist),
    artist: artist || '未知歌手',
    album: scalarOf(s, ['AlbumName', 'album_name', 'albumname']),
    duration: durationSeconds(scalarOf(s, ['Duration', 'timelength', 'duration'])),
    albumId: num(scalarOf(s, ['AlbumID', 'album_id', 'AlbumId', 'albumid']), 0),
    mixSongId: num(scalarOf(s, ['MixSongID', 'mixsongid', 'EMixSongID', 'album_audio_id', 'Audioid']), 0),
    audioId: num(scalarOf(s, ['Audioid', 'audio_id', 'audioId']), 0),
    privilege: num(scalarOf(s, ['Privilege', 'privilege', 'pay_type']), 0)
  }
}

/** 歌曲级身份（UP-08）：`albumAudioId || hash` —— 把同一首歌的多份文件塌成一条 */
function songKeyOf(t) {
  const mid = num(t && t.mixSongId, 0)
  if (mid > 0) return 'm' + mid
  return 'h' + str(t && t.hash).toLowerCase()
}

/** 单次搜索。返回 `errorCode` / `httpStatus` 是为了让上层能分辨「业务拒绝」与「网络层失败」。 */
async function searchOnce(ctx, keyword, pageSize, deps) {
  const res = await deps.route(ctx, ROUTE.search, {
    keywords: keyword,
    type: 'song',
    page: 1,
    pagesize: pageSize
  })
  const body = res && res.body
  const httpStatus = num(res && res.status, 0)
  const errorCode = num(isObj(body) ? body.error_code : 0, 0)
  if (!isObj(body)) {
    return { items: [], error: routeErrorText(body, res), httpStatus, errorCode }
  }
  if (num(body.status, 1) !== 1 && !Array.isArray(body.lists) && !body.data) {
    return { items: [], error: routeErrorText(body, res), httpStatus, errorCode }
  }
  const lists = Array.isArray(body.lists) ? body.lists : pickTrackArray(body)
  const items = lists.map(normalizeSearchItem).filter(Boolean)
  return { items, error: '', httpStatus, errorCode }
}

/**
 * 搜索一首歌的候选。
 * 只对**网络层临时失败**重试一次（KG-09 ②）：酷狗的业务错误一定带非零 `error_code`，
 * 「HTTP 502 且 error_code = 0」才是上游连接被重置，值得重试；
 * 业务拒绝重试多少次都一样，只会徒增风控风险。
 */
async function searchCandidates(ctx, keyword, pageSize, deps) {
  let last = { items: [], error: '', httpStatus: 0, errorCode: 0 }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    last = await searchOnce(ctx, keyword, pageSize, deps)
    if (last.items.length || !isTransientError(last.error, last.httpStatus, last.errorCode)) return last
    if (attempt >= MAX_ATTEMPTS - 1) break
    if (deps && deps.stats) deps.stats.retry = num(deps.stats.retry, 0) + 1
    if (deps && deps.retryDelayMs) {
      const keep = await sleepAbortable(deps.retryDelayMs, deps.isAborted)
      if (!keep) return last
    }
  }
  return last
}

/* ------------------------------------------------------- 读：用户歌单列表 */

function normalizeUserPlaylist(p) {
  if (!isObj(p)) return null
  const listid = num(scalarOf(p, ['listid', 'list_id', 'id']), 0)
  const gid = scalarOf(p, ['global_collection_id', 'list_create_gid', 'gid'])
  if (!listid && !gid) return null
  const name = scalarOf(p, ['name', 'list_name', 'playlist_name']) || '未命名歌单'
  const source = num(scalarOf(p, ['source']), 0)
  return {
    listid,
    gid,
    name,
    count: num(scalarOf(p, ['count', 'songcount', 'song_count', 'total']), 0),
    source,
    creator: scalarOf(p, ['list_create_username', 'nickname', 'username']),
    isDefault: scalarOf(p, ['is_default']) === '1' || num(scalarOf(p, ['is_default']), 0) === 1
  }
}

/**
 * 拉用户歌单（分页，页大小 30 —— `user_playlist.js` 的默认值）。
 * `status !== 1` 就停，别把错误当空列表。
 */
async function listUserPlaylists(ctx, deps) {
  const out = []
  let page = 1
  while (page <= 10) {
    const res = await deps.route(ctx, ROUTE.userPlaylist, { page, pagesize: 30 })
    const body = res && res.body
    if (!isObj(body) || num(body.status, 0) !== 1) {
      if (page === 1) return { ok: false, items: [], error: routeErrorText(body, res) }
      break
    }
    const arr =
      (Array.isArray(body.data) && body.data) ||
      (Array.isArray(body.data && body.data.info) && body.data.info) ||
      (Array.isArray(body.info) && body.info) ||
      []
    if (!arr.length) break
    out.push(...arr.map(normalizeUserPlaylist).filter(Boolean))
    if (arr.length < 30) break
    page++
  }
  return { ok: true, items: dedupePlaylists(out), error: '' }
}

function dedupePlaylists(items) {
  const seen = new Set()
  const out = []
  for (const p of items) {
    const key = String(p.listid || p.gid) + '|' + p.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/* ------------------------------------------------------------- 写：建歌单 */

async function createPlaylist(ctx, name, deps) {
  const playlistName = str(name)
  if (!playlistName) return { ok: false, listid: 0, error: '歌单名不能为空' }
  const login = readLogin(ctx)
  const res = await deps.route(ctx, ROUTE.playlistAdd, {
    name: playlistName,
    type: 0, // type 0 = 自建歌单；非 0 是「收藏别人的歌单」
    is_pri: 0,
    source: 1,
    list_create_userid: login.userid || 0,
    list_create_listid: 0,
    list_create_gid: ''
  })
  const body = res && res.body
  const listid = num(scalarOf(body, ['data.listid', 'data.list_id', 'data.id', 'listid']), 0)
  if (num(body && body.status, 0) === 1 && listid > 0) return { ok: true, listid, error: '' }
  return { ok: false, listid, error: routeErrorText(body, res) }
}

/* --------------------------------------------------------------- 写：加歌 */

/**
 * `/playlist/tracks/add` 的 `data` 是 `名字|hash|albumId|mixSongId` 逗号分隔的**复合串**，
 * 模块端用 `split(',')` + `split('|')` 解析 —— 所以歌名里的 `,` 和 `|` 必须清掉，
 * 否则一首歌的名字会把后面所有字段错位（这是协议格式，不是转义问题）。
 */
function sanitizeField(v) {
  return str(v).replace(/[,|]/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildAddPayload(entries) {
  return (entries || [])
    .map((e) =>
      [sanitizeField(e.name) || '未知歌曲', str(e.hash), num(e.albumId, 0) || 0, num(e.mixSongId, 0) || 0].join('|')
    )
    .join(',')
}

function chunkArray(arr, size) {
  const out = []
  const n = Math.max(1, num(size, 1))
  for (let i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function addTracksToPlaylist(ctx, listid, entries, deps) {
  const id = num(listid, 0)
  if (!id) return { ok: false, error: '缺少目标歌单 id' }
  if (!entries || !entries.length) return { ok: true, error: '' }
  const res = await deps.route(ctx, ROUTE.playlistTracksAdd, {
    listid: id,
    data: buildAddPayload(entries)
  })
  const body = res && res.body
  const ok = num(body && body.status, 0) === 1
  return { ok, error: ok ? '' : routeErrorText(body, res), httpStatus: num(res && res.status, 0) }
}

/** 目标歌单里已有的 hash 集合（用于「跳过重复」）。失败就返回空集合并把原因带出来 —— 去重失败不该中断导入。 */
async function fetchExistingHashes(ctx, target, deps, maxPages) {
  const set = new Set()
  const limit = Math.max(1, num(maxPages, EXISTING_MAX_PAGES))
  const byGid = !!str(target && target.gid)
  const path = byGid ? ROUTE.playlistTrackAll : ROUTE.playlistTrackAllNew
  let error = ''
  for (let page = 1; page <= limit; page++) {
    const params = { page, pagesize: 300 }
    if (byGid) params.id = target.gid
    else params.listid = target.listid
    try {
      const res = await deps.route(ctx, path, params)
      const arr = pickTrackArray(res && res.body)
      if (!arr.length) break
      for (const it of arr) {
        const h = pickMainHash(unwrapSong(it))
        if (h) set.add(h)
      }
      if (arr.length < 300) break
    } catch (e) {
      error = (e && e.message) || String(e)
      break
    }
  }
  return { hashes: set, error }
}

/* ========================================================================== *
 * 匹配引擎
 * ========================================================================== */

/** 通用并发池：可中断 + 条目间节流（本地路由是主进程串行化的，开太高只会互相排队） */
async function runPool(items, worker, opts) {
  const list = items || []
  if (!list.length) return
  const concurrency = Math.max(1, Math.min(num(opts && opts.concurrency, 1), list.length))
  const isAborted = (opts && opts.isAborted) || (() => false)
  let cursor = 0
  const runner = async () => {
    for (;;) {
      if (isAborted()) return
      const i = cursor++
      if (i >= list.length) return
      await worker(list[i], i)
      if (i < list.length - 1 && opts && opts.gapMs) {
        const keepGoing = await sleepAbortable(opts.gapMs, isAborted)
        if (!keepGoing) return
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner))
}

/**
 * 单首匹配：按关键词依次搜索，任一候选达到接受阈值就提前收手（对应宿主的 shouldStopEarly）。
 * 无论是否提前收手，返回里都带上 top-N 候选供人工改选。
 */
async function matchOne(ctx, ext, opts, deps) {
  const keywords = buildKeywords(ext)
  const tried = []
  const pool = []
  const seen = new Set()
  let best = null
  let bestScore = -1
  let lastError = ''

  for (const kw of keywords) {
    if (deps.isAborted && deps.isAborted()) break
    let items = []
    try {
      const r = await searchCandidates(ctx, kw, opts.pageSize, deps)
      items = r.items
      if (r.error) lastError = r.error
    } catch (e) {
      lastError = (e && e.message) || String(e)
      items = []
    }
    tried.push({ keyword: kw, count: items.length })

    for (const c of items) {
      const key = songKeyOf(c)
      if (seen.has(key)) continue
      seen.add(key)
      const s = scoreCandidate(ext, c)
      const scored = { ...c, score: Number(s.total.toFixed(4)), breakdown: s }
      pool.push(scored)
      if (s.total > bestScore) {
        bestScore = s.total
        best = scored
      }
    }
    if (bestScore >= opts.accept) break
    if (deps.gapMs) {
      const keep = await sleepAbortable(deps.gapMs, deps.isAborted)
      if (!keep) break
    }
  }

  pool.sort((a, b) => b.score - a.score)
  const candidates = pool.slice(0, Math.max(1, opts.pageSize))
  const tier = matchTierOf(bestScore, opts.accept)
  const top = candidates.find((c) => c.score === bestScore) || candidates[0] || null

  return {
    candidates,
    chosen: tier ? top : null,
    score: bestScore >= 0 ? Number(bestScore.toFixed(4)) : null,
    tier,
    keywords,
    tried,
    error: pool.length ? '' : lastError
  }
}

/* ========================================================================== *
 * 导入计划（纯函数，好测）
 * --------------------------------------------------------------------------
 * 三类"不加"必须给出**可读的原因**，否则用户只知道"少了几首"：
 *   手动跳过 / 未匹配（或低置信未启用）/ 批内重复 / 目标歌单已有
 * ========================================================================== */

function fmtScore(v) {
  // ⚠️ 不能直接用 num()：`Number(null)` 是 0，会把「没有分数」显示成 0.00，
  //    看起来像"匹配度 0%"而不是"还没匹配"。
  if (v === null || v === undefined || v === '') return '-'
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(2) : '-'
}

function planImport(rows, options, existing) {
  const opts = options || {}
  const exist = existing instanceof Set ? existing : new Set()
  const seen = new Map()
  const addable = []
  let skipped = 0
  let dupInBatch = 0
  let dupExisting = 0

  for (const row of rows || []) {
    row.importStatus = ''
    row.importReason = ''

    if (row.manualSkip) {
      row.importStatus = 'skipped'
      row.importReason = '手动跳过'
      skipped++
      continue
    }
    if (!row.tier) {
      row.importStatus = 'skipped'
      row.importReason = row.searchError ? '搜索失败：' + row.searchError : '未匹配到足够相似的歌曲'
      skipped++
      continue
    }
    if (row.tier === 'low' && !opts.acceptLow) {
      row.importStatus = 'skipped'
      row.importReason = '低置信（' + fmtScore(row.score) + '），未勾选「包含低置信」'
      skipped++
      continue
    }
    const chosen = row.chosen
    if (!chosen || !chosen.hash) {
      row.importStatus = 'skipped'
      row.importReason = '匹配结果缺少 hash'
      skipped++
      continue
    }

    const key = songKeyOf(chosen)
    if (opts.dedupeBatch && seen.has(key)) {
      row.importStatus = 'skipped'
      row.importReason = '与第 ' + seen.get(key) + ' 首是同一首歌（批内重复）'
      skipped++
      dupInBatch++
      continue
    }
    if (opts.skipExisting && exist.has(str(chosen.hash).toLowerCase())) {
      row.importStatus = 'skipped'
      row.importReason = '目标歌单里已经有这首'
      skipped++
      dupExisting++
      continue
    }
    if (opts.dedupeBatch) seen.set(key, row.index)
    addable.push(row)
  }

  return { addable, skipped, dupInBatch, dupExisting }
}

/* ========================================================================== *
 * 导入执行引擎
 * --------------------------------------------------------------------------
 * 与 UI 解耦：只通过 `onEvent` 往外报事件，所以测试可以直接驱动它。
 * 事件类型：phase / target / existing / planned / progress / done
 * ========================================================================== */

async function runImportEngine(input) {
  const ctx = input.ctx
  const rows = input.rows || []
  const options = input.options || {}
  const deps = input.deps || {}
  const isAborted = input.isAborted || (() => false)
  const emit = input.onEvent || (() => {})
  const startedAt = Date.now()

  const summary = {
    total: rows.length,
    matched: 0,
    low: 0,
    unmatched: 0,
    skipped: 0,
    added: 0,
    failed: 0,
    dupInBatch: 0,
    dupExisting: 0,
    targetName: '',
    listid: 0,
    error: '',
    elapsedMs: 0
  }

  for (const r of rows) {
    if (r.tier === 'success') summary.matched++
    else if (r.tier === 'low') summary.low++
    else summary.unmatched++
  }

  const target = input.target || { mode: 'new', listid: 0, gid: '', name: '' }
  let listid = num(target.listid, 0)
  let gid = str(target.gid)
  let targetName = str(target.name)

  if (!hasHostApi(ctx)) {
    summary.error = '宿主未提供酷狗本地路由（需要 EchoMusic ≥ 2.3.2-beta.2）'
    return { ok: false, summary, phase: 'target' }
  }

  /* --- 目标歌单 ------------------------------------------------------- */
  emit({ type: 'phase', phase: 'target' })
  if (target.mode === 'new') {
    const name = str(target.name) || str(input.playlistName) || '导入的歌单'
    const created = await createPlaylist(ctx, name, deps)
    if (!created.ok) {
      summary.error = '创建歌单失败：' + created.error
      summary.elapsedMs = Date.now() - startedAt
      emit({ type: 'phase', phase: 'error', error: summary.error })
      return { ok: false, summary, phase: 'target' }
    }
    listid = created.listid
    targetName = name
  } else {
    if (!listid && !gid) {
      summary.error = '请先选择目标歌单'
      emit({ type: 'phase', phase: 'error', error: summary.error })
      return { ok: false, summary, phase: 'target' }
    }
    if (!targetName) targetName = '已有歌单'
  }
  summary.listid = listid
  summary.targetName = targetName
  emit({ type: 'target', listid, gid, name: targetName })

  if (isAborted()) {
    summary.elapsedMs = Date.now() - startedAt
    emit({ type: 'phase', phase: 'aborted' })
    return { ok: true, summary, phase: 'aborted' }
  }

  /* --- 目标歌单已有歌曲（去重） --------------------------------------- */
  let existing = new Set()
  let existingError = ''
  if (options.skipExisting) {
    emit({ type: 'phase', phase: 'dedupe' })
    const r = await fetchExistingHashes(ctx, { listid, gid }, deps, options.existingMaxPages)
    existing = r.hashes
    existingError = r.error
    emit({ type: 'existing', count: existing.size, error: existingError })
  }

  /* --- 计划 ------------------------------------------------------------ */
  emit({ type: 'phase', phase: 'planning' })
  const plan = planImport(rows, options, existing)
  summary.skipped = plan.skipped
  summary.dupInBatch = plan.dupInBatch
  summary.dupExisting = plan.dupExisting
  emit({ type: 'planned', addable: plan.addable.length, skipped: plan.skipped })

  if (!plan.addable.length) {
    summary.elapsedMs = Date.now() - startedAt
    emit({ type: 'phase', phase: 'done' })
    return { ok: true, summary, phase: 'done' }
  }

  /* --- 分批写入 -------------------------------------------------------- */
  emit({ type: 'phase', phase: 'adding' })
  const batchSize = clamp(options.addBatchSize, 1, ADD_BATCH_SIZE)
  const batches = chunkArray(plan.addable, batchSize)
  const intervalMs = Math.max(0, num(options.addBatchIntervalMs, ADD_BATCH_INTERVAL_MS))
  let done = 0
  let aborted = false

  for (let bi = 0; bi < batches.length; bi++) {
    if (isAborted()) {
      aborted = true
      break
    }
    const batch = batches[bi]
    for (const row of batch) row.importStatus = 'adding'
    emit({
      type: 'progress',
      done,
      total: plan.addable.length,
      percent: Math.floor((done / plan.addable.length) * 100),
      batch: bi + 1,
      batches: batches.length
    })

    const entries = batch.map((row) => ({
      name: row.chosen && row.chosen.title,
      hash: row.chosen && row.chosen.hash,
      albumId: row.chosen && row.chosen.albumId,
      mixSongId: row.chosen && row.chosen.mixSongId
    }))

    let res
    try {
      res = await addTracksToPlaylist(ctx, listid, entries, deps)
    } catch (e) {
      res = { ok: false, error: (e && e.message) || String(e) }
    }

    for (const row of batch) {
      if (res.ok) {
        row.importStatus = 'added'
        row.importReason = ''
        summary.added++
      } else {
        row.importStatus = 'failed'
        row.importReason = res.error || '写入失败'
        summary.failed++
      }
    }
    done += batch.length
    emit({
      type: 'progress',
      done,
      total: plan.addable.length,
      percent: Math.floor((done / plan.addable.length) * 100),
      batch: bi + 1,
      batches: batches.length,
      lastError: res.ok ? '' : res.error
    })

    if (bi < batches.length - 1) {
      const keep = await sleepAbortable(intervalMs, isAborted)
      if (!keep) {
        aborted = true
        break
      }
    }
  }

  summary.elapsedMs = Date.now() - startedAt
  const phase = aborted ? 'aborted' : 'done'
  emit({ type: 'phase', phase })
  return { ok: true, summary, phase }
}

/* ========================================================================== *
 * 结果导出
 * ========================================================================== */

function resultRows(rows) {
  return (rows || []).map((r) => ({
    index: r.index,
    externalTitle: r.external ? r.external.title : '',
    externalArtist: r.external ? r.external.artist : '',
    externalAlbum: r.external ? r.external.album : '',
    externalDuration: formatDuration(r.external ? r.external.duration : 0),
    matchedTitle: r.chosen ? r.chosen.title : '',
    matchedArtist: r.chosen ? r.chosen.artist : '',
    matchedAlbum: r.chosen ? r.chosen.album : '',
    score: r.score === null || r.score === undefined ? '' : num(r.score, 0).toFixed(3),
    tier: r.tier || 'none',
    importStatus: r.importStatus || '',
    reason: r.importReason || ''
  }))
}

const CSV_HEADERS = [
  '序号', '外部歌名', '外部歌手', '外部专辑', '时长',
  '匹配歌名', '匹配歌手', '匹配专辑', '分数', '档位', '导入状态', '原因'
]

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function toCsv(rows) {
  const data = resultRows(rows)
  const lines = [CSV_HEADERS.join(',')]
  for (const r of data) {
    lines.push(
      [
        r.index, r.externalTitle, r.externalArtist, r.externalAlbum, r.externalDuration,
        r.matchedTitle, r.matchedArtist, r.matchedAlbum, r.score, r.tier, r.importStatus, r.reason
      ]
        .map(csvCell)
        .join(',')
    )
  }
  // 加 BOM，Excel 打开中文才不乱码
  return '\uFEFF' + lines.join('\r\n')
}

/** 触发一次浏览器下载（Chromium 行为：落到系统下载目录）。无 DOM 时返回 false。 */
function downloadText(filename, text, mime) {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    if (a.remove) a.remove()
    setTimeout(() => {
      try {
        URL.revokeObjectURL(href)
      } catch {
        /* 忽略 */
      }
    }, 4000)
    return true
  } catch {
    return false
  }
}

/** 导出用的时间戳（本地时间，文件名里可读） */
function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
}

/* ========================================================================== *
 * 诊断快照（真机排障的唯一入口：带登录态的载荷只能在 renderer 里拿到）
 * ========================================================================== */

function buildDiagnostics(state, deps, settings) {
  const st = state || {}
  const opts = state && state.options ? state.options : {}
  const cfg = settings || {}
  const playlist = st.playlist
  const rows = st.rows || []
  const shape = playlist ? rawShape(playlist.rawSample) : { rawKeys: '', songKeys: '', rawSnippet: '' }
  const unknown = (playlist ? playlist.tracks : []).filter(
    (t) => t.title === '未知歌曲' || t.artist === '未知歌手'
  ).length
  return {
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    at: new Date().toISOString(),
    entry: { mode: st.mode, provider: st.providerId },
    playlist: playlist
      ? {
          source: playlist.source,
          sourceName: playlist.sourceName,
          sourceId: playlist.sourceId,
          name: playlist.name,
          creator: playlist.creator,
          trackCount: playlist.tracks.length,
          unknownCount: unknown
        }
      : null,
    rawShape: shape,
    match: {
      total: rows.length,
      success: rows.filter((r) => r.tier === 'success').length,
      low: rows.filter((r) => r.tier === 'low').length,
      none: rows.filter((r) => !r.tier).length,
      failed: rows.filter((r) => !!r.searchError).length,
      accept: num(cfg.accept, DEFAULT_ACCEPT),
      keywordSample: rows.slice(0, 3).map((r) => ({ title: r.external && r.external.title, keywords: r.keywords }))
    },
    target: {
      mode: st.target ? st.target.mode : '',
      name: st.target ? st.target.name : '',
      listid: st.target ? st.target.listid : 0,
      gid: st.target ? st.target.gid : '',
      userPlaylistCount: (st.playlists || []).length
    },
    options: { ...opts },
    settings: { ...cfg },
    import: st.summary,
    routes: deps && deps.stats ? { ...deps.stats } : null,
    env: deps && deps.env ? { ...deps.env } : null,
    errors: deps && deps.errors ? deps.errors.slice(-12) : []
  }
}

/* ========================================================================== *
 * 插件入口
 * ========================================================================== */

/** 从 input[type=file] / 拖拽事件里读一个文件为文本（优先 File.text()，老环境退回 FileReader） */
async function readFileText(file) {
  if (!file) throw new Error('没有拿到文件')
  if (typeof file.text === 'function') return await file.text()
  if (typeof FileReader === 'undefined') throw new Error('当前环境不支持读取本地文件')
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

function formatBytes(n) {
  const v = num(n, 0)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let x = v
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return (x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)) + ' ' + units[i]
}

/** 候选的下拉选项值：`hash|mixSongId`（同一首歌的两个查询结果不会撞值） */
function candidateValue(c) {
  if (!c) return ''
  return str(c.hash) + '|' + num(c.mixSongId, 0)
}

function candidateLabel(c) {
  const title = str(c.title) || '未知歌曲'
  const artist = str(c.artist) || '未知歌手'
  const dur = formatDuration(c.duration)
  return fmtScore(c.score) + ' · ' + title + ' - ' + artist + (dur ? ' · ' + dur : '')
}

const ROW_STATUS_LABEL = {
  pending: '待匹配',
  matching: '匹配中',
  success: '已匹配',
  low: '低置信',
  unmatched: '未匹配',
  failed: '搜索失败',
  skipped: '已跳过'
}

const IMPORT_STATUS_LABEL = {
  '': '',
  adding: '写入中',
  added: '已导入',
  skipped: '跳过',
  failed: '失败'
}

export function activate(ctx) {
  const { h, reactive, computed } = ctx.vue
  const disposers = []

  /* ------------------------------------------------------------------ 日志 */

  function log(...args) {
    try {
      if (ctx.log && typeof ctx.log === 'function') ctx.log('[' + PLUGIN_ID + ']', ...args)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  /* ---------------------------------------------------------------- 设置项 */

  const SETTING_DEFAULTS = {
    accept: DEFAULT_ACCEPT,
    candidates: SEARCH_PAGE_SIZE,
    concurrency: SEARCH_CONCURRENCY,
    searchGapMs: SEARCH_INTERVAL_MS,
    retryDelayMs: RETRY_DELAY_MS,
    addBatchSize: ADD_BATCH_SIZE,
    addBatchIntervalMs: ADD_BATCH_INTERVAL_MS,
    existingMaxPages: EXISTING_MAX_PAGES,
    renderLimit: DEFAULT_RENDER_LIMIT,
    acceptLow: false,
    skipExisting: true,
    dedupeBatch: true
  }

  const storedSettings = ctx.storage.get('settings')
  const settings = reactive({ ...SETTING_DEFAULTS, ...(isObj(storedSettings) ? storedSettings : {}) })

  function saveSettings() {
    const snapshot = {}
    for (const k of Object.keys(SETTING_DEFAULTS)) snapshot[k] = settings[k]
    ctx.storage.set('settings', snapshot)
    // 页面上的三个快捷开关与设置面板共享同一个 setter，两边联动
    state.options.acceptLow = !!settings.acceptLow
    state.options.skipExisting = !!settings.skipExisting
    state.options.dedupeBatch = !!settings.dedupeBatch
  }

  /**
   * 数字型设置项的取值范围。
   * ⚠️ `addBatchSize` 的上限**必须**是 `ADD_BATCH_SIZE` —— 上游模块 `/playlist/tracks/add`
   * 就是按这个量级设计的（`slow_upload: 1`），让用户填 999 只会得到一个静默被夹住的值。
   */
  const SETTING_RANGE = {
    accept: [0.5, 0.98, 0.01],
    candidates: [1, 10, 1],
    concurrency: [1, 6, 1],
    searchGapMs: [0, 2000, 10],
    retryDelayMs: [0, 5000, 50],
    addBatchSize: [1, ADD_BATCH_SIZE, 1],
    addBatchIntervalMs: [0, 5000, 50],
    existingMaxPages: [1, 20, 1],
    renderLimit: [10, 2000, 10]
  }

  function setNumSetting(key, value) {
    const range = SETTING_RANGE[key]
    if (!range) return
    const v = clamp(value, range[0], range[1])
    settings[key] = key === 'accept' ? Number(v.toFixed(2)) : Math.round(v)
    saveSettings()
  }

  /* ------------------------------------------------------- 依赖（注入一次） */

  /**
   * 依赖容器：只放**统计 / 诊断 / 风控状态 / 环境探测**这几件跨调用共享的东西。
   * 注意：`route` 函数本身是单独传下去的（`runDeps()` 的结果），不要把这里的对象
   * 当成"通用 deps"传给模块级的取数函数 —— 它们要的 `route` / `isAborted` / `gapMs`
   * 是**每次运行各自一份**的（否则上一轮的 abort 标志会污染下一轮）。
   */
  const deps = {
    verifyState: makeVerifyState(),
    stats: { total: 0, byRoute: {}, retry: 0 },
    errors: [],
    env: {
      hasHostApi: hasHostApi(ctx),
      hasNetRequest: hasNetRequest(ctx),
      hasVerify: !!(ctx.kugouVerification && typeof ctx.kugouVerification.request === 'function'),
      hasTasks: !!(ctx.tasks && typeof ctx.tasks.register === 'function'),
      platform: str(ctx.electron && ctx.electron.platform)
    }
  }

  /** 统计 + 风控兜底都在这里收口，任何取数都必须走它 */
  async function route(c, url, params, data) {
    deps.stats.total++
    deps.stats.byRoute[url] = (deps.stats.byRoute[url] || 0) + 1
    const res = await guardedRoute(c, url, params, data, deps.verifyState, log)
    const body = res && res.body
    if (isObj(body) && num(body.error_code, 0) !== 0) {
      deps.errors.push({
        at: new Date().toISOString(),
        route: url,
        httpStatus: num(res.status, 0),
        errorCode: num(body.error_code, 0),
        text: routeErrorText(body, res)
      })
      if (deps.errors.length > 40) deps.errors.shift()
    }
    return res
  }

  function resetVerify() {
    deps.verifyState = makeVerifyState()
  }

  function runDeps() {
    return {
      route,
      isAborted: () => state.abortAll || state.previewAbort || state.importAbort,
      gapMs: 0,
      retryDelayMs: Math.max(0, num(settings.retryDelayMs, RETRY_DELAY_MS))
    }
  }

  /* ------------------------------------------------------------------ 状态 */

  const state = reactive({
    mode: 'link',
    providerId: 'auto',
    linkInput: '',
    pasteText: '',
    fileName: '',
    fileText: '',
    busy: false,
    loading: false,
    loadingLabel: '',
    playlist: null,
    rows: [],
    matchProgress: { done: 0, total: 0, running: false },
    previewRunning: false,
    previewAbort: false,
    target: { mode: 'new', name: '', listid: 0, gid: '', gidName: '' },
    playlists: [],
    playlistsLoading: false,
    playlistsError: '',
    options: {
      acceptLow: !!settings.acceptLow,
      skipExisting: !!settings.skipExisting,
      dedupeBatch: !!settings.dedupeBatch
    },
    importProgress: { phase: 'idle', done: 0, total: 0, percent: null, label: '' },
    importRunning: false,
    importAbort: false,
    abortAll: false,
    summary: null,
    notice: null,
    showAllRows: false,
    diagText: ''
  })

  saveSettings()

  function setNotice(level, text) {
    state.notice = text ? { level, text: str(text) } : null
  }

  const unknownCount = computed(() => {
    const p = state.playlist
    if (!p) return 0
    return p.tracks.filter((t) => t.title === '未知歌曲' || t.artist === '未知歌手').length
  })

  const visibleRows = computed(() => {
    const all = state.rows
    if (state.showAllRows) return all
    const limit = clamp(settings.renderLimit, 10, 2000)
    return all.length > limit ? all.slice(0, limit) : all
  })

  const planStats = computed(() => {
    const rows = state.rows
    return {
      total: rows.length,
      success: rows.filter((r) => r.tier === 'success').length,
      low: rows.filter((r) => r.tier === 'low').length,
      none: rows.filter((r) => !r.tier && !r.manualSkip).length,
      manualSkip: rows.filter((r) => r.manualSkip).length,
      failed: rows.filter((r) => !!r.searchError).length
    }
  })

  const matchPercent = computed(() => {
    const p = state.matchProgress
    if (!p.total) return null
    const v = Math.min(99, Math.floor((p.done / p.total) * 100))
    return p.done >= p.total ? 100 : v
  })

  /* -------------------------------------------------------------- 歌单载入 */

  function loadPlaylist(playlist, noticeText) {
    state.playlist = playlist
    state.rows = []
    state.summary = null
    state.showAllRows = false
    state.importProgress = { phase: 'idle', done: 0, total: 0, percent: null, label: '' }
    state.target.name = str(playlist.name) || ''
    setNotice('ok', noticeText || '已读取：' + playlist.name + ' · ' + playlist.tracks.length + ' 首')
  }

  async function readLink() {
    if (state.busy) return false
    state.busy = true
    state.loading = true
    state.loadingLabel = '正在读取歌单…'
    setNotice('info', '正在读取歌单…')
    try {
      const r = await resolveLink(ctx, state.linkInput, state.providerId, { localRoute: route })
      if (!r.ok) {
        setNotice('error', r.error)
        return false
      }
      loadPlaylist(r.playlist)
      return true
    } catch (e) {
      const msg = (e && e.message) || String(e)
      deps.errors.push({ at: new Date().toISOString(), route: 'link', text: msg })
      setNotice('error', '读取失败：' + msg)
      return false
    } finally {
      state.loading = false
      state.busy = false
    }
  }

  function parseText(text, filename) {
    try {
      const playlist = parsePlaylistText(text, filename)
      loadPlaylist(playlist, '已解析 ' + (filename || '文本') + '：' + playlist.name + ' · ' + playlist.tracks.length + ' 首')
      return true
    } catch (e) {
      setNotice('error', (e && e.message) || String(e))
      return false
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    const file = files[0]
    if (num(file.size, 0) > 8 * 1024 * 1024) {
      setNotice('error', '文件超过 8 MB（' + formatBytes(file.size) + '），请拆分后再导入')
      return
    }
    try {
      const text = await readFileText(file)
      state.fileText = text
      state.fileName = str(file.name)
      state.mode = 'file'
      parseText(text, file.name)
    } catch (e) {
      setNotice('error', '读取文件失败：' + ((e && e.message) || String(e)))
    }
  }

  const fileInput = { el: null }

  function pickFile() {
    const el = fileInput.el
    if (el && typeof el.click === 'function') el.click()
  }

  /* ---------------------------------------------------------------- 匹配 */

  async function runPreview() {
    if (state.busy) return false
    const playlist = state.playlist
    if (!playlist || !playlist.tracks.length) {
      setNotice('warn', '请先读取歌单（链接 / 文件 / 粘贴文本）')
      return false
    }
    resetVerify()
    state.busy = true
    state.previewRunning = true
    state.previewAbort = false
    state.summary = null
    state.showAllRows = false

    state.rows = playlist.tracks.map((t, i) => ({
      index: i + 1,
      external: t,
      status: 'pending',
      tier: null,
      candidates: [],
      chosen: null,
      score: null,
      keywords: [],
      searchError: '',
      manual: false,
      manualSkip: false,
      importStatus: '',
      importReason: ''
    }))
    state.matchProgress = { done: 0, total: state.rows.length, running: true }
    setNotice('info', '正在匹配 ' + state.rows.length + ' 首…可随时点「停止匹配」')

    const accept = num(settings.accept, DEFAULT_ACCEPT)
    const pageSize = clamp(settings.candidates, 1, 10)
    const d = runDeps()

    try {
      await runPool(
        state.rows,
        async (row) => {
          row.status = 'matching'
          const r = await matchOne(ctx, row.external, { accept, pageSize }, d)
          row.candidates = r.candidates
          row.chosen = r.chosen
          row.tier = r.tier
          row.score = r.score
          row.keywords = r.keywords
          row.searchError = r.error || ''
          row.status = r.tier === 'success' ? 'success' : r.tier === 'low' ? 'low' : r.error && !r.candidates.length ? 'failed' : 'unmatched'
          state.matchProgress.done++
        },
        {
          concurrency: clamp(settings.concurrency, 1, 6),
          gapMs: Math.max(0, num(settings.searchGapMs, SEARCH_INTERVAL_MS)),
          isAborted: () => state.previewAbort || state.abortAll
        }
      )
    } finally {
      state.matchProgress.running = false
      state.previewRunning = false
      state.busy = false
    }

    const s = planStats.value
    const stopped = state.previewAbort
    setNotice(
      stopped ? 'warn' : s.success ? 'ok' : 'warn',
      (stopped ? '已停止匹配。' : '匹配完成。') +
        '已匹配 ' + s.success + ' 首' +
        (s.low ? '，低置信 ' + s.low + ' 首' : '') +
        (s.none ? '，未匹配 ' + s.none + ' 首' : '') +
        (s.failed ? '，搜索失败 ' + s.failed + ' 首' : '') +
        '。可在右侧下拉里人工改选，然后开始导入。'
    )
    refreshDiag()
    return true
  }

  function stopPreview() {
    state.previewAbort = true
    setNotice('warn', '正在停止匹配…')
  }

  function findRow(index) {
    return state.rows.find((r) => r.index === index) || null
  }

  function onRowSelect(index, value) {
    const row = findRow(index)
    if (!row) return
    if (value === '__skip__') {
      row.manualSkip = true
      row.manual = false
      row.chosen = null
      row.tier = null
      row.status = 'skipped'
      row.importStatus = ''
      row.importReason = '手动跳过'
      return
    }
    if (!value) {
      row.manualSkip = false
      row.manual = false
      row.chosen = null
      row.tier = null
      row.score = null
      row.status = 'unmatched'
      return
    }
    const cand = row.candidates.find((c) => candidateValue(c) === value)
    if (!cand) return
    row.manualSkip = false
    row.manual = true
    row.chosen = cand
    row.score = cand.score
    // 人工选定即视为可信 —— 用户看过这个候选了，不该再被阈值判成低置信
    row.tier = 'success'
    row.status = 'success'
  }

  async function retryRow(index) {
    const row = findRow(index)
    if (!row || state.busy) return
    resetVerify()
    row.status = 'matching'
    const d = runDeps()
    const r = await matchOne(ctx, row.external, { accept: num(settings.accept, DEFAULT_ACCEPT), pageSize: clamp(settings.candidates, 1, 10) }, d)
    row.candidates = r.candidates
    row.chosen = r.chosen
    row.tier = r.tier
    row.score = r.score
    row.searchError = r.error || ''
    row.manual = false
    row.status = r.tier === 'success' ? 'success' : r.tier === 'low' ? 'low' : r.error && !r.candidates.length ? 'failed' : 'unmatched'
  }

  function selectAllLow(tier) {
    for (const row of state.rows) {
      if (row.tier === 'low' && !row.manual) row.status = tier === 'skip' ? 'skipped' : 'low'
      if (tier === 'skip' && row.tier === 'low' && !row.manual) {
        row.manualSkip = true
        row.status = 'skipped'
      }
    }
  }

  /* ---------------------------------------------------------------- 导入 */

  function openTaskCenter() {
    const api = ctx.tasks
    if (!api || typeof api.register !== 'function') return null
    try {
      const handle = api.register({
        id: TASK_ID,
        name: '导入歌单 · ' + ((state.playlist && state.playlist.name) || '未命名'),
        status: 'pending',
        progress: { label: '准备中' },
        actions: [
          {
            id: 'cancel',
            label: '停止',
            variant: 'ghost',
            onClick: () => {
              state.importAbort = true
            }
          }
        ],
        retention: {
          completed: { mode: 'auto', delayMs: 8000 },
          error: { mode: 'manual' },
          aborted: { mode: 'auto', delayMs: 3000 }
        }
      })
      if (handle && typeof handle.start === 'function') handle.start({})
      return handle
    } catch (e) {
      log('任务中心注册失败', e && e.message)
      return null
    }
  }

  function taskLabel(summary) {
    const parts = ['成功 ' + summary.added]
    if (summary.dupInBatch + summary.dupExisting > 0) parts.push('跳过重复 ' + (summary.dupInBatch + summary.dupExisting))
    if (summary.skipped - summary.dupInBatch - summary.dupExisting > 0) {
      parts.push('未导入 ' + (summary.skipped - summary.dupInBatch - summary.dupExisting))
    }
    if (summary.failed > 0) parts.push('失败 ' + summary.failed)
    return parts.join(' · ')
  }

  async function startImport() {
    if (state.busy) return false
    if (!state.rows.length) {
      setNotice('warn', '还没有匹配结果，请先点「匹配预演」')
      return false
    }
    if (!hasHostApi(ctx)) {
      setNotice('error', '宿主未提供酷狗本地路由（需要 EchoMusic ≥ 2.3.2-beta.2）')
      return false
    }
    const login = readLogin(ctx)
    if (!login.userid) {
      setNotice('error', '未检测到登录态 —— 导入需要写到你的酷狗云歌单，请先在 EchoMusic 里登录')
      return false
    }

    resetVerify()
    state.busy = true
    state.importRunning = true
    state.importAbort = false
    state.summary = null
    state.importProgress = { phase: 'target', done: 0, total: 0, percent: null, label: '准备目标歌单…' }

    const task = openTaskCenter()
    const playlistName = state.playlist ? state.playlist.name : ''

    const handleEvent = (e) => {
      if (!e) return
      if (e.type === 'phase') {
        const label =
          e.phase === 'target' ? '准备目标歌单…'
          : e.phase === 'dedupe' ? '检查目标歌单已有歌曲…'
          : e.phase === 'planning' ? '生成导入计划…'
          : e.phase === 'adding' ? '正在写入…'
          : e.phase === 'aborted' ? '已停止'
          : e.phase === 'error' ? (e.error || '出错了')
          : '完成'
        state.importProgress = { ...state.importProgress, phase: e.phase, label }
        if (task && typeof task.update === 'function' && e.phase !== 'error') {
          task.update({ progress: { label } })
        }
      } else if (e.type === 'target') {
        state.target.listid = num(e.listid, 0)
        state.target.gid = str(e.gid)
        state.target.gidName = str(e.name)
      } else if (e.type === 'existing') {
        if (e.error) log('读取目标歌单已有歌曲失败（去重降级）', e.error)
      } else if (e.type === 'planned') {
        state.importProgress.total = num(e.addable, 0)
        state.importProgress.label = '待写入 ' + num(e.addable, 0) + ' 首（跳过 ' + num(e.skipped, 0) + ' 首）'
      } else if (e.type === 'progress') {
        state.importProgress.done = num(e.done, 0)
        state.importProgress.total = num(e.total, 0)
        state.importProgress.percent = e.percent === null || e.percent === undefined ? null : num(e.percent, 0)
        state.importProgress.label = '第 ' + num(e.batch, 0) + ' / ' + num(e.batches, 0) + ' 批 · ' + num(e.done, 0) + ' / ' + num(e.total, 0) + ' 首'
        if (task && typeof task.update === 'function') {
          task.update({
            progress: { percent: state.importProgress.percent, label: state.importProgress.label }
          })
        }
      }
    }

    let result
    try {
      result = await runImportEngine({
        ctx,
        rows: state.rows,
        playlistName,
        target: { ...state.target },
        options: {
          acceptLow: !!state.options.acceptLow,
          skipExisting: !!state.options.skipExisting,
          dedupeBatch: !!state.options.dedupeBatch,
          addBatchSize: clamp(settings.addBatchSize, 1, ADD_BATCH_SIZE),
          addBatchIntervalMs: Math.max(0, num(settings.addBatchIntervalMs, ADD_BATCH_INTERVAL_MS)),
          existingMaxPages: clamp(settings.existingMaxPages, 1, 20)
        },
        deps: runDeps(),
        isAborted: () => state.importAbort || state.abortAll,
        onEvent: handleEvent
      })
    } catch (e) {
      const msg = (e && e.message) || String(e)
      deps.errors.push({ at: new Date().toISOString(), route: 'import', text: msg })
      result = { ok: false, summary: { total: state.rows.length, error: msg }, phase: 'error' }
    } finally {
      state.importRunning = false
      state.busy = false
    }

    state.summary = result.summary
    const summary = result.summary || {}
    const okRun = !!result.ok
    const stopped = result.phase === 'aborted'

    if (task) {
      if (!okRun) {
        task.finish('error', { error: summary.error || '导入失败', progress: { label: '失败' } })
      } else if (stopped) {
        task.finish('aborted', { progress: { label: '已停止 · ' + taskLabel(summary) } })
      } else {
        task.finish('completed', {
          progress: { percent: 100, label: taskLabel(summary) },
          actions: []
        })
      }
    }

    if (!okRun) {
      setNotice('error', summary.error || '导入失败')
      if (ctx.toast && ctx.toast.danger) ctx.toast.danger('导入失败：' + (summary.error || '未知错误'))
      return false
    }
    const label = taskLabel(summary)
    if (summary.failed > 0) {
      setNotice('warn', '导入结束：' + label + '。可点「导出结果」留档，或「只重试失败项」再来一次。')
      if (ctx.toast && ctx.toast.warning) ctx.toast.warning('导入结束：' + label)
    } else if (stopped) {
      setNotice('warn', '已停止：' + label)
    } else {
      setNotice('ok', '导入完成：' + label)
      if (ctx.toast && ctx.toast.success) ctx.toast.success('导入完成：' + label)
    }
    // 导入完刷新一下用户歌单列表（新建的歌单要能立刻在下拉里看到）
    await refreshPlaylists()
    refreshDiag()
    return true
  }

  function stopImport() {
    state.importAbort = true
    setNotice('warn', '正在停止…（当前批次写完后生效）')
  }

  /* ------------------------------------------------------- 用户歌单 & 目标 */

  async function refreshPlaylists() {
    if (state.playlistsLoading || !hasHostApi(ctx)) return
    state.playlistsLoading = true
    state.playlistsError = ''
    try {
      const r = await listUserPlaylists(ctx, { route })
      if (r.ok) {
        state.playlists = r.items
        if (!state.target.name && state.playlist) state.target.name = str(state.playlist.name)
      } else {
        state.playlistsError = r.error
      }
    } catch (e) {
      state.playlistsError = (e && e.message) || String(e)
    } finally {
      state.playlistsLoading = false
    }
  }

  /** 目标歌单重名检测：酷狗允许重名，但用户多半是想要"新建一个不撞名的" */
  function targetNameConflict(name) {
    const n = str(name).toLowerCase()
    if (!n) return null
    return (state.playlists || []).find((p) => str(p.name).toLowerCase() === n) || null
  }

  /* -------------------------------------------------------------- 结果导出 */

  function exportResult(format) {
    const rows = state.rows
    if (!rows.length) {
      setNotice('warn', '没有可导出的结果')
      return false
    }
    const name = (state.playlist ? state.playlist.name : '歌单导入').replace(/[\\/:*?"<>|]/g, '_')
    if (format === 'json') {
      const payload = {
        exportedAt: new Date().toISOString(),
        playlist: state.playlist
          ? { source: state.playlist.source, sourceName: state.playlist.sourceName, name: state.playlist.name, trackCount: state.playlist.tracks.length }
          : null,
        summary: state.summary,
        target: { mode: state.target.mode, name: state.target.name, listid: state.target.listid },
        rows: resultRows(rows)
      }
      return downloadText(name + '-导入结果-' + stampName() + '.json', JSON.stringify(payload, null, 2), 'application/json')
    }
    return downloadText(name + '-导入结果-' + stampName() + '.csv', toCsv(rows), 'text/csv;charset=utf-8')
  }

  function retryFailedOnly() {
    const failed = state.rows.filter((r) => r.importStatus === 'failed')
    if (!failed.length) {
      setNotice('info', '没有失败项')
      return false
    }
    // 把非失败项标成手动跳过，再整体重跑一遍（已成功的不重复写）
    for (const row of state.rows) row.manualSkip = row.importStatus !== 'failed'
    setNotice('info', '已把 ' + failed.length + ' 首失败项之外的全部标记为跳过，点「开始导入」重试')
    return true
  }

  function copyDiagnostics() {
    const payload = JSON.stringify(buildDiagnostics(state, deps, settings), null, 2)
    state.diagText = payload
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(payload)
        setNotice('ok', '诊断信息已复制到剪贴板')
        return true
      }
    } catch {
      /* 落到下面的兜底 */
    }
    setNotice('info', '环境不支持自动复制，请从下方「诊断快照」手动选取')
    return false
  }

  /**
   * 诊断快照**按需生成**，不做成 computed。
   * 原因：`buildDiagnostics` 要遍历全部行并 `JSON.stringify`，做成 computed 会在
   * 匹配阶段**每完成一行就重算一次** → 大歌单（几百上千首）下是 O(n²) 的字符串化，
   * 界面直接卡顿。而这正是本插件分页渲染（renderLimit）想避免的那件事。
   */
  function refreshDiag() {
    try {
      state.diagText = JSON.stringify(buildDiagnostics(state, deps, settings), null, 2)
    } catch (e) {
      state.diagText = '诊断生成失败：' + ((e && e.message) || String(e))
    }
  }

  /* ------------------------------------------------------------------ 页面 */

  function renderHead() {
    return h('div', { class: 'pi-head' }, [
      h('div', { class: 'pi-title' }, '歌单导入增强'),
      h('span', { class: 'pi-version', 'data-role': 'version' }, 'v' + PLUGIN_VERSION),
      h(
        'div',
        { class: 'pi-sub' },
        '从其他音乐软件导入歌单：链接 / 本地文件 / 粘贴文本 → 匹配预演（可人工改选）→ 写入酷狗云歌单。'
      )
    ])
  }

  function renderNotice() {
    if (!state.notice) return null
    return h('div', { class: 'pi-notice', 'data-role': 'notice', 'data-level': state.notice.level }, state.notice.text)
  }

  function renderModeTabs() {
    const modes = [
      ['link', '链接导入'],
      ['file', '本地文件'],
      ['paste', '粘贴文本']
    ]
    return h(
      'div',
      { class: 'pi-tabs' },
      modes.map((m) =>
        h(
          'button',
          {
            class: 'pi-tab',
            'data-role': 'tab',
            'data-mode': m[0],
            'data-active': state.mode === m[0] ? '1' : '0',
            onClick: () => {
              state.mode = m[0]
              setNotice(null)
            }
          },
          m[1]
        )
      )
    )
  }

  function renderPlatformChips() {
    const options = [{ id: 'auto', name: '自动识别' }].concat(PROVIDERS.map((p) => ({ id: p.id, name: p.name })))
    return h(
      'div',
      { class: 'pi-plats' },
      options.map((o) =>
        h(
          'button',
          {
            class: 'pi-plat',
            'data-role': 'platform',
            'data-plat': o.id,
            'data-active': state.providerId === o.id ? '1' : '0',
            onClick: () => {
              state.providerId = o.id
            }
          },
          o.name
        )
      )
    )
  }

  function renderLinkPane() {
    const detected = detectProvider(state.linkInput)
    return h('div', null, [
      renderPlatformChips(),
      h('input', {
        class: 'pi-input',
        type: 'text',
        value: state.linkInput,
        placeholder: '粘贴歌单链接，例如 https://music.163.com/#/playlist?id=3778678',
        'data-role': 'link-input',
        onInput: (e) => {
          state.linkInput = (e && e.target && e.target.value) || ''
        }
      }),
      h('div', { class: 'pi-kv' }, [
        h('b', null, '识别结果：'),
        h(
          'span',
          { 'data-role': 'detected' },
          state.providerId === 'auto'
            ? detected
              ? detected.name
              : '未识别（请手动选平台）'
            : (providerById(state.providerId) || {}).name || '-'
        )
      ]),
      h(
        'div',
        { class: 'pi-btn-row' },
        [
          h(
            'button',
            {
              class: 'pi-btn',
              'data-variant': 'primary',
              'data-action': 'resolve',
              disabled: state.busy || !str(state.linkInput),
              onClick: () => readLink()
            },
            state.loading ? state.loadingLabel : '读取歌单'
          ),
          h(
            'button',
            {
              class: 'pi-btn',
              'data-variant': 'ghost',
              'data-action': 'clear-link',
              onClick: () => {
                state.linkInput = ''
                setNotice(null)
              }
            },
            '清空'
          )
        ]
      )
    ])
  }

  function renderFilePane() {
    return h('div', null, [
      h('input', {
        type: 'file',
        accept: '.json,.csv,.tsv,.txt,.m3u,.m3u8',
        style: { display: 'none' },
        'data-role': 'file-input',
        ref: (el) => {
          fileInput.el = el
        },
        onChange: (e) => {
          const files = e && e.target && e.target.files
          return handleFiles(files)
        }
      }),
      h(
        'div',
        {
          class: 'pi-file-drop',
          'data-role': 'file-drop',
          'data-over': '0',
          onClick: () => pickFile(),
          onDrop: (e) => {
            if (e && e.preventDefault) e.preventDefault()
            const dt = e && e.dataTransfer
            return handleFiles(dt && dt.files)
          }
        },
        [
          h('div', null, '点击选择，或把歌单文件拖到这里'),
          h('div', null, '支持 JSON（网易云 / QQ 音乐导出）、CSV、TXT（每行「歌名 - 歌手」）、M3U / M3U8')
        ]
      ),
      state.fileName
        ? h('div', { class: 'pi-file-name', 'data-role': 'file-name' }, '当前文件：' + state.fileName)
        : null,
      h(
        'div',
        { class: 'pi-btn-row' },
        [
          h(
            'button',
            {
              class: 'pi-btn',
              'data-action': 'pick-file',
              onClick: () => pickFile()
            },
            '选择文件'
          ),
          h(
            'button',
            {
              class: 'pi-btn',
              'data-variant': 'ghost',
              'data-action': 'reparse-file',
              disabled: !state.fileText,
              onClick: () => parseText(state.fileText, state.fileName)
            },
            '重新解析'
          )
        ]
      )
    ])
  }

  function renderPastePane() {
    return h('div', null, [
      h('textarea', {
        class: 'pi-textarea',
        value: state.pasteText,
        placeholder: '每行一首，例如：\n告白气球 - 周杰伦\n起风了 - 买辣椒也用券\n也可以直接粘贴 CSV 或 JSON 内容',
        'data-role': 'paste-input',
        onInput: (e) => {
          state.pasteText = (e && e.target && e.target.value) || ''
        }
      }),
      h(
        'div',
        { class: 'pi-btn-row' },
        [
          h(
            'button',
            {
              class: 'pi-btn',
              'data-variant': 'primary',
              'data-action': 'parse-text',
              disabled: !str(state.pasteText),
              onClick: () => parseText(state.pasteText, '')
            },
            '解析文本'
          ),
          h(
            'button',
            {
              class: 'pi-btn',
              'data-variant': 'ghost',
              'data-action': 'clear-paste',
              onClick: () => {
                state.pasteText = ''
                setNotice(null)
              }
            },
            '清空'
          )
        ]
      )
    ])
  }

  function renderEntryCard() {
    return h('div', { class: 'pi-card' }, [
      h('div', { class: 'pi-card-head' }, [
        h('div', { class: 'pi-card-title' }, '① 选择来源'),
        h('div', { class: 'pi-card-hint' }, '链接需要插件直连对应平台；本地文件与粘贴不联网')
      ]),
      renderModeTabs(),
      state.mode === 'link' ? renderLinkPane() : state.mode === 'file' ? renderFilePane() : renderPastePane()
    ])
  }

  function renderPlaylistCard() {
    const p = state.playlist
    if (!p) {
      return h('div', { class: 'pi-card' }, [
        h('div', { class: 'pi-card-head' }, [h('div', { class: 'pi-card-title' }, '② 歌单概览')]),
        h('div', { class: 'pi-empty', 'data-role': 'playlist-empty' }, '还没有读取歌单')
      ])
    }
    const raw = rawShape(p.rawSample)
    return h('div', { class: 'pi-card' }, [
      h('div', { class: 'pi-card-head' }, [
        h('div', { class: 'pi-card-title' }, '② 歌单概览'),
        h('div', { class: 'pi-card-hint', 'data-role': 'playlist-source' }, p.sourceName)
      ]),
      h('div', { class: 'pi-list' }, [
        h('div', { class: 'pi-kv', 'data-role': 'playlist-name' }, [h('b', null, '名称：'), h('span', null, p.name)]),
        p.creator ? h('div', { class: 'pi-kv' }, [h('b', null, '创建者：'), h('span', null, p.creator)]) : null,
        h('div', { class: 'pi-kv' }, [
          h('b', null, '曲目数：'),
          h('span', { 'data-role': 'playlist-count' }, String(p.tracks.length))
        ]),
        unknownCount.value
          ? h('div', { class: 'pi-kv' }, [
              h('b', null, '⚠ 未识别：'),
              h('span', { 'data-role': 'unknown-count' }, unknownCount.value + ' 首（歌名/歌手没解析出来，建议导出诊断反馈）')
            ])
          : null,
        h('div', { class: 'pi-kv' }, [
          h('b', null, '前几首：'),
          h('span', null, p.tracks.slice(0, 3).map((t) => t.title + ' - ' + t.artist).join('；') || '-')
        ]),
        raw.rawKeys
          ? h('div', { class: 'pi-kv' }, [h('b', null, '原始键名：'), h('span', null, clipText(raw.rawKeys, 160))])
          : null
      ]),
      h(
        'div',
        { class: 'pi-btn-row' },
        [
          h(
            'button',
            {
              class: 'pi-btn',
              'data-variant': 'primary',
              'data-action': 'match',
              disabled: state.busy || !p.tracks.length,
              onClick: () => runPreview()
            },
            state.previewRunning ? '匹配中…' : '匹配预演（' + p.tracks.length + ' 首）'
          ),
          state.previewRunning
            ? h('button', { class: 'pi-btn', 'data-action': 'stop-preview', onClick: () => stopPreview() }, '停止匹配')
            : null
        ]
      )
    ])
  }

  function renderTargetPane() {
    const isNew = state.target.mode === 'new'
    const conflict = isNew ? targetNameConflict(state.target.name) : null
    const options = (state.playlists || []).map((pl) =>
      h(
        'option',
        { value: String(pl.listid || pl.gid), selected: String(state.target.listid) === String(pl.listid) && !state.target.gid },
        pl.name + '（' + pl.count + ' 首）'
      )
    )
    return h('div', null, [
      h('div', { class: 'pi-btn-row' }, [
        h(
          'button',
          {
            class: 'pi-tab',
            'data-role': 'target-mode',
            'data-target': 'new',
            'data-active': isNew ? '1' : '0',
            onClick: () => {
              state.target.mode = 'new'
              state.target.listid = 0
              state.target.gid = ''
            }
          },
          '新建歌单'
        ),
        h(
          'button',
          {
            class: 'pi-tab',
            'data-role': 'target-mode',
            'data-target': 'existing',
            'data-active': isNew ? '0' : '1',
            onClick: () => {
              state.target.mode = 'existing'
              refreshPlaylists()
            }
          },
          '导入到已有歌单'
        ),
        h(
          'button',
          { class: 'pi-btn pi-btn-sm', 'data-action': 'refresh-playlists', onClick: () => refreshPlaylists() },
          state.playlistsLoading ? '刷新中…' : '刷新歌单'
        )
      ]),
      isNew
        ? h('input', {
            class: 'pi-input',
            type: 'text',
            value: state.target.name,
            placeholder: '新歌单名称',
            'data-role': 'new-name',
            onInput: (e) => {
              state.target.name = (e && e.target && e.target.value) || ''
            }
          })
        : h(
            'select',
            {
              class: 'pi-select',
              'data-role': 'target-playlist',
              value: String(state.target.listid || ''),
              onChange: (e) => {
                const v = (e && e.target && e.target.value) || ''
                const hit = state.playlists.find((pl) => String(pl.listid || pl.gid) === String(v))
                state.target.listid = num(hit && hit.listid, 0)
                state.target.gid = str(hit && hit.gid)
                state.target.name = str(hit && hit.name)
              }
            },
            [h('option', { value: '' }, '请选择目标歌单'), ...options]
          ),
      state.playlistsError
        ? h('div', { class: 'pi-notice', 'data-level': 'warn' }, '读取歌单列表失败：' + state.playlistsError)
        : null,
      conflict && isNew
        ? h(
            'div',
            { class: 'pi-notice', 'data-level': 'warn', 'data-role': 'name-conflict' },
            '已有同名歌单「' + conflict.name + '」（' + conflict.count + ' 首）。酷狗允许重名，你也可以换个名字避免混淆。'
          )
        : null
    ])
  }

  function renderOptionSwitches() {
    const items = [
      ['acceptLow', '包含低置信', '匹配分数介于 0.55~阈值之间的也导入'],
      ['skipExisting', '跳过目标歌单已有', '会先读一次目标歌单的 hash 列表去重'],
      ['dedupeBatch', '批内去重', '同一首歌在歌单里出现多次时只导入一条']
    ]
    return h(
      'div',
      { class: 'pi-btn-row' },
      items.map((it) =>
        h(
          'button',
          {
            class: 'pi-switch',
            role: 'switch',
            'aria-checked': state.options[it[0]] ? 'true' : 'false',
            'data-on': state.options[it[0]] ? '1' : '0',
            'data-action': it[0],
            title: it[2],
            onClick: () => {
              state.options[it[0]] = !state.options[it[0]]
              if (it[0] in SETTING_DEFAULTS) {
                settings[it[0]] = state.options[it[0]]
                saveSettings()
              }
            }
          },
          [h('span', { class: 'pi-switch-dot' }), it[1]]
        )
      )
    )
  }

  function renderMatchProgress() {
    const p = state.matchProgress
    if (!p.total) return null
    const pct = matchPercent.value
    return h('div', null, [
      h(
        'div',
        { class: 'pi-progress', 'data-role': 'match-progress', 'data-percent': String(pct === null ? '' : pct) },
        [h('div', { class: 'pi-progress-bar', style: { width: (pct === null ? 0 : pct) + '%' } })]
      ),
      h('div', { class: 'pi-progress-label' }, [
        h('span', null, (p.running ? '匹配中' : '匹配完成') + ' ' + p.done + ' / ' + p.total),
        h('span', null, pct === null ? '' : pct + '%')
      ])
    ])
  }

  function renderTableHead() {
    return h('div', { class: 'pi-th' }, [
      h('div', null, '#'),
      h('div', null, '外部曲目'),
      h('div', null, '匹配结果（可改选）'),
      h('div', null, '分数'),
      h('div', null, '状态')
    ])
  }

  function renderRow(row) {
    const value = row.manualSkip ? '__skip__' : row.chosen ? candidateValue(row.chosen) : ''
    const opts = [h('option', { value: '' }, '（不导入）')]
    for (const c of row.candidates || []) {
      opts.push(h('option', { value: candidateValue(c) }, candidateLabel(c)))
    }
    opts.push(h('option', { value: '__skip__' }, '跳过这首'))

    return h(
      'div',
      {
        class: 'pi-row',
        'data-role': 'row',
        'data-index': String(row.index),
        'data-status': row.importStatus || row.status
      },
      [
        h('div', { class: 'pi-idx' }, String(row.index)),
        h('div', { class: 'pi-cell' }, [
          h('div', { class: 'pi-cell' }, row.external.title),
          h(
            'div',
            { class: 'pi-cell-sub' },
            [row.external.artist, row.external.album, formatDuration(row.external.duration)].filter(Boolean).join(' · ') ||
              '-'
          )
        ]),
        h('div', { class: 'pi-cell' }, [
          h(
            'select',
            {
              class: 'pi-select',
              'data-role': 'row-select',
              'data-index': String(row.index),
              value,
              disabled: row.status === 'matching',
              onChange: (e) => onRowSelect(row.index, (e && e.target && e.target.value) || '')
            },
            opts
          ),
          row.importReason ? h('div', { class: 'pi-cell-sub', 'data-role': 'row-reason' }, row.importReason) : null
        ]),
        h(
          'div',
          { class: 'pi-cell', 'data-role': 'row-score' },
          row.score === null || row.score === undefined ? '-' : fmtScore(row.score)
        ),
        h('div', { class: 'pi-cell' }, [
          h(
            'span',
            { class: 'pi-badge', 'data-status': row.importStatus === 'added' ? 'success' : row.importStatus || row.status },
            IMPORT_STATUS_LABEL[row.importStatus] || ROW_STATUS_LABEL[row.status] || row.status
          ),
          h(
            'button',
            {
              class: 'pi-btn pi-btn-sm',
              'data-role': 'row-retry',
              'data-index': String(row.index),
              disabled: state.busy,
              onClick: () => retryRow(row.index)
            },
            '重试'
          )
        ])
      ]
    )
  }

  function renderPreviewCard() {
    const rows = visibleRows.value
    const s = planStats.value
    const truncated = !state.showAllRows && state.rows.length > rows.length
    return h('div', { class: 'pi-card' }, [
      h('div', { class: 'pi-card-head' }, [
        h('div', { class: 'pi-card-title' }, '③ 匹配预演与目标'),
        h(
          'div',
          { class: 'pi-card-hint', 'data-role': 'plan-stats' },
          '已匹配 ' + s.success + ' · 低置信 ' + s.low + ' · 未匹配 ' + s.none + ' · 手动跳过 ' + s.manualSkip
        )
      ]),
      renderTargetPane(),
      renderOptionSwitches(),
      renderMatchProgress(),
      state.rows.length
        ? h('div', { class: 'pi-table' }, [renderTableHead(), ...rows.map((r) => renderRow(r))])
        : h('div', { class: 'pi-empty', 'data-role': 'preview-empty' }, '还没有匹配结果 —— 点上面的「匹配预演」'),
      truncated
        ? h(
            'div',
            { class: 'pi-btn-row' },
            [
              h(
                'button',
                { class: 'pi-btn', 'data-action': 'show-all', onClick: () => (state.showAllRows = true) },
                '显示全部 ' + state.rows.length + ' 行'
              ),
              h('div', { class: 'pi-card-hint' }, '当前只渲染前 ' + rows.length + ' 行（避免一次渲染几百行卡顿）')
            ]
          )
        : null,
      h(
        'div',
        { class: 'pi-btn-row' },
        [
          h(
            'button',
            {
              class: 'pi-btn',
              'data-variant': 'primary',
              'data-action': 'start-import',
              disabled: state.busy || !state.rows.length,
              onClick: () => startImport()
            },
            state.importRunning ? '导入中…' : '开始导入'
          ),
          state.importRunning
            ? h('button', { class: 'pi-btn', 'data-variant': 'danger', 'data-action': 'cancel-import', onClick: () => stopImport() }, '停止')
            : null,
          h(
            'button',
            { class: 'pi-btn', 'data-action': 'skip-all-low', onClick: () => selectAllLow('skip') },
            '全部跳过低置信'
          )
        ]
      )
    ])
  }

  function renderImportCard() {
    const p = state.importProgress
    const s = state.summary
    const hasProgress = p.phase && p.phase !== 'idle'
    return h('div', { class: 'pi-card' }, [
      h('div', { class: 'pi-card-head' }, [
        h('div', { class: 'pi-card-title' }, '④ 导入结果'),
        h('div', { class: 'pi-card-hint' }, s ? s.targetName || '' : '')
      ]),
      hasProgress
        ? h('div', null, [
            h(
              'div',
              {
                class: 'pi-progress',
                'data-role': 'import-progress',
                'data-phase': p.phase,
                'data-percent': String(p.percent === null || p.percent === undefined ? '' : p.percent)
              },
              [
                h('div', {
                  class: 'pi-progress-bar',
                  style: { width: (p.percent === null || p.percent === undefined ? 0 : p.percent) + '%' }
                })
              ]
            ),
            h('div', { class: 'pi-progress-label' }, [
              h('span', { 'data-role': 'import-label' }, p.label || ''),
              h('span', null, p.percent === null || p.percent === undefined ? '' : p.percent + '%')
            ])
          ])
        : null,
      s
        ? h('div', { class: 'pi-list' }, [
            h(
              'div',
              { class: 'pi-summary', 'data-role': 'summary' },
              [
                ['导入成功', s.added],
                ['未导入', Math.max(0, (s.skipped || 0))],
                ['批内重复', s.dupInBatch || 0],
                ['目标已有', s.dupExisting || 0],
                ['失败', s.failed || 0],
                ['耗时', Math.round((s.elapsedMs || 0) / 1000) + 's']
              ].map((kv) =>
                h('div', null, [h('b', null, String(kv[1])), h('span', null, ' ' + kv[0])])
              )
            ),
            s.error ? h('div', { class: 'pi-notice', 'data-level': 'error' }, s.error) : null
          ])
        : null,
      h(
        'div',
        { class: 'pi-btn-row' },
        [
          h(
            'button',
            { class: 'pi-btn', 'data-action': 'export-csv', disabled: !state.rows.length, onClick: () => exportResult('csv') },
            '导出 CSV'
          ),
          h(
            'button',
            { class: 'pi-btn', 'data-action': 'export-json', disabled: !state.rows.length, onClick: () => exportResult('json') },
            '导出 JSON'
          ),
          h(
            'button',
            { class: 'pi-btn', 'data-action': 'retry-failed', onClick: () => retryFailedOnly() },
            '只重试失败项'
          )
        ]
      )
    ])
  }

  function renderDiagCard() {
    return h('div', { class: 'pi-card' }, [
      h('div', { class: 'pi-card-head' }, [
        h('div', { class: 'pi-card-title' }, '诊断'),
        h('div', { class: 'pi-btn-row', style: { marginTop: '0' } }, [
          h(
            'button',
            { class: 'pi-btn pi-btn-sm', 'data-action': 'refresh-diag', onClick: () => refreshDiag() },
            '刷新诊断'
          ),
          h(
            'button',
            { class: 'pi-btn pi-btn-sm', 'data-action': 'copy-diag', onClick: () => copyDiagnostics() },
            '复制诊断'
          )
        ])
      ]),
      h('div', { class: 'pi-diag', 'data-role': 'diag' }, state.diagText || '（点「刷新诊断」生成）')
    ])
  }

  const Page = {
    setup() {
      return () =>
        h('div', { class: 'pi-page', 'data-role': 'page' }, [
          renderHead(),
          renderNotice(),
          renderEntryCard(),
          renderPlaylistCard(),
          renderPreviewCard(),
          renderImportCard(),
          renderDiagCard()
        ])
    }
  }

  ctx.ui.addPage({
    id: 'main',
    title: '歌单导入增强',
    icon: 'tabler:playlist-add',
    component: Page
  })
  disposers.push(
    ctx.ui.sidebar.addItem({
      id: PLUGIN_ID + '-entry',
      title: '歌单导入增强',
      icon: 'tabler:playlist-add',
      pageId: 'main',
      section: 'plugins',
      sectionTitle: '插件',
      order: 26
    })
  )

  /* -------------------------------------------------------------- 设置面板 */

  /** [键, 标题, 说明] —— 取值范围统一从 SETTING_RANGE 取，避免两处不一致 */
  const NUM_FIELDS = [
    ['accept', '匹配接受阈值', '标题 0.55 + 歌手 0.30 + 时长 0.15 的加权分。≥ 此值直接导入，0.55~此值算低置信'],
    ['candidates', '每首候选数', '预演表下拉里最多列几个备选（供人工改选）'],
    ['concurrency', '搜索并发', '同时搜几首。本地路由是主进程串行化的，开太高只会互相排队'],
    ['searchGapMs', '搜索间隔（ms）', '同一并发槽内两次搜索之间的间隔，防上游限流'],
    ['retryDelayMs', '临时失败重试间隔（ms）', '只对网络层失败（ECONNRESET / 502 + error_code=0）重试一次'],
    ['addBatchSize', '加歌批大小', '单次 /playlist/tracks/add 最多几首（上游模块的上限就是 50）'],
    ['addBatchIntervalMs', '加歌批间隔（ms）', '批次之间的间隔'],
    ['existingMaxPages', '已有歌曲检查页数', '「跳过目标歌单已有」时最多翻几页（每页 300 首）'],
    ['renderLimit', '预演表渲染上限', '超过这个行数就折叠，避免一次渲染几百行卡顿']
  ]

  /** 设置面板里的一个开关（附「已开启 / 已关闭」文字，状态不靠原生 checkbox） */
  function settingsSwitch(key, label) {
    return h(
      'button',
      {
        class: 'pi-switch',
        role: 'switch',
        'aria-checked': settings[key] ? 'true' : 'false',
        'data-on': settings[key] ? '1' : '0',
        'data-setting': key,
        onClick: () => {
          settings[key] = !settings[key]
          saveSettings()
        }
      },
      [h('span', { class: 'pi-switch-dot' }), label + (settings[key] ? '：已开启' : '：已关闭')]
    )
  }

  const SETTING_SWITCHES = [
    ['acceptLow', '包含低置信'],
    ['skipExisting', '跳过目标歌单已有'],
    ['dedupeBatch', '批内去重']
  ]

  function settingsNumberField(f) {
    const range = SETTING_RANGE[f[0]] || [0, 100, 1]
    return h('div', { class: 'pi-settings-group' }, [
      h('div', { class: 'pi-settings-label' }, f[1]),
      h('div', { class: 'pi-settings-desc' }, f[2]),
      h('input', {
        class: 'pi-input',
        type: 'number',
        min: String(range[0]),
        max: String(range[1]),
        step: String(range[2]),
        value: String(settings[f[0]]),
        'data-setting': f[0],
        onChange: (e) => setNumSetting(f[0], (e && e.target && e.target.value) || 0)
      })
    ])
  }

  const Settings = {
    setup() {
      return () =>
        h('div', { class: 'pi-settings' }, [
          h('div', { class: 'pi-settings-group' }, [
            h('div', { class: 'pi-settings-label' }, '默认行为'),
            h(
              'div',
              { class: 'pi-settings-row' },
              SETTING_SWITCHES.map((it) => settingsSwitch(it[0], it[1]))
            )
          ]),
          ...NUM_FIELDS.map(settingsNumberField)
        ])
    }
  }

  ctx.ui.settings.define({
    title: '歌单导入增强',
    description: '匹配阈值、并发与批量参数；改动即时保存',
    component: Settings
  })

  /* ------------------------------------------------------------------ 回收 */

  function applySettings() {
    settings.accept = clamp(settings.accept, 0.5, 0.98)
    settings.addBatchSize = clamp(settings.addBatchSize, 1, ADD_BATCH_SIZE)
    state.options.acceptLow = !!settings.acceptLow
    state.options.skipExisting = !!settings.skipExisting
    state.options.dedupeBatch = !!settings.dedupeBatch
  }

  ctx.dispose(() => {
    state.abortAll = true
    disposers.splice(0).forEach((d) => {
      try {
        if (typeof d === 'function') d()
      } catch (e) {
        log('dispose 失败', e && e.message)
      }
    })
  })

  applySettings()
  refreshDiag()
  log('activated', { hasHostApi: deps.env.hasHostApi, hasNetRequest: deps.env.hasNetRequest })

  // 供无头测试直接驱动内部逻辑（不对外承诺稳定，改动时同步改测试）
  return { _internals: { ctx, settings, state, deps, runPreview, startImport, matchOne, runImportEngine, planImport } }
}

export async function deactivate() {
  // 宿主会在禁用时自动跑 ctx.dispose 注册的清理函数（置 abortAll + 摘入口）
}

/* 纯函数导出：让测试可以只测真实文件里的算法（TST-10），不用复制代码 */
export {
  PLUGIN_VERSION,
  DEFAULT_ACCEPT,
  LOW_SCORE,
  ADD_BATCH_SIZE,
  PROVIDERS,
  normalizeText,
  dice,
  scoreTitle,
  scoreArtist,
  scoreDuration,
  scoreCandidate,
  matchTierOf,
  buildKeywords,
  splitArtists,
  durationSeconds,
  parsePlaylistText,
  detectFormat,
  parseLabelLine,
  toCsv,
  resultRows,
  buildAddPayload,
  sanitizeField,
  chunkArray,
  planImport,
  runImportEngine,
  matchOne,
  runPool,
  normalizeSearchItem,
  normalizeUserPlaylist,
  pickMainHash,
  pickTrackArray,
  rawShape,
  cleanupTitle,
  normalizeCover,
  isTransientError,
  verificationEventId,
  findFieldDeep,
  scalarOf,
  joinNames,
  artistOf,
  albumOf,
  normalizeExternalTrack,
  findExternalTrackArray,
  findObjectDeep,
  extractJsonByBrace,
  extractPayloadFromHtml,
  detectProvider,
  providerById,
  resolveLink,
  makePlaylist,
  songKeyOf,
  candidateValue,
  candidateLabel,
  formatDuration,
  fmtScore,
  formatBytes,
  routeErrorText
}
