/**
 * 歌单导入增强 (playlist-importer) 变异测试
 * ===========================================================================
 * 作用：把「已修好的关键行为」故意改回 bug 版本，确认无头集成测试真的会失败。
 * 如果改坏了测试还全绿，说明那条断言是无效的（假安全）。
 *
 * 用法：  node tests/playlist-importer.mutate.mjs
 * 退出码：0 = 每个变异都被抓到；1 = 有变异没被抓到（说明断言要补）
 *
 * 依赖 tests/playlist-importer.smoke.mjs 支持：
 *   PI_PLUGIN_ENTRY  指向 index.js 副本
 *   PI_CSS_ENTRY     指向 style.css 副本
 *   PI_REPORT_FILE   把报告写到别处（避免污染正式报告）
 *
 * 每个变异都带「为什么这是 bug」的说明 —— 它们全是这份代码里真实存在过的坑，
 * 或者是对应断言唯一守住的回归点。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC_JS = path.join(ROOT, 'playlist-importer', 'index.js')
const SRC_CSS = path.join(ROOT, 'playlist-importer', 'style.css')
const TEST = path.join(HERE, 'playlist-importer.smoke.mjs')
const TMP_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'pi-mutants')
const NODE = process.execPath

/**
 * 每个变异：名字 + 文件类型 + 「原文 → 改坏后」的替换对（必须能在原文里精确命中）。
 * file: 'js' | 'css'
 */
const MUTANTS = [
  /* ---------------- 归一化与相似度 ---------------- */
  {
    name: 'hash 不做小写归一化（同一首歌跨源会被当成两首，去重直接失效）',
    from: `    str(scalarOf(base, ['hash_320', 'hash_flac'])) ||
    ''
  ).toLowerCase()
}`,
    to: `    str(scalarOf(base, ['hash_320', 'hash_flac'])) ||
    ''
  )
}`
  },
  {
    name: '时长不做毫秒换算（网易云 236000ms 会显示成 236000 秒）',
    from: `  return n > 60000 ? Math.round(n / 1000) : Math.round(n)`,
    to: `  return Math.round(n)`
  },
  {
    name: '时长未知时当 0 分而不是重新分配权重（好匹配被无谓地压到阈值以下）',
    from: `  if (ds === null) {
    total = (ts * W_TITLE + as * W_ARTIST) / (W_TITLE + W_ARTIST)
  } else {`,
    to: `  if (ds === null) {
    total = ts * W_TITLE + as * W_ARTIST
  } else {`
  },
  {
    name: '括号只剥一轮（《太空旅客》嵌套导致歌名残留「推广曲」）',
    from: `  let prev = ''
  let guard = 0
  while (t !== prev && guard < 8) {
    prev = t
    t = t.replace(BRACKET_PAIR_RE, ' ')
    guard++
  }
  t = t.replace(BRACKET_ANY_RE, ' ')`,
    to: `  t = t.replace(BRACKET_PAIR_RE, ' ')`
  },
  {
    name: 'NAME_FIELDS 漏掉首字母大写形式（pickTrackArray 会挑到光秃秃的 hash 列表）',
    from: `  'songname', 'song_name', 'songName', 'SongName', 'Songname',
  'audio_name', 'audioName', 'audioName',
  'filename', 'fileName', 'FileName',
  'author_name', 'authorName', 'AuthorName',
  'singername', 'singer_name', 'singerName', 'SingerName',`,
    to: `  'songname', 'song_name', 'songName',
  'audio_name', 'audioName',
  'filename', 'fileName',
  'author_name', 'authorName',
  'singername', 'singer_name', 'singerName',`
  },
  {
    name: '歌手未知时返回 0 分而不是中性 0.5（歌手字段缺失会被直接判死）',
    from: `  if (!rawA || !rawB || rawA === '未知歌手' || rawB === '未知歌手') return 0.5`,
    to: `  if (!rawA || !rawB || rawA === '未知歌手' || rawB === '未知歌手') return 0`
  },
  {
    name: '包含关系在带空格的串上算占比（分母被撑大，0.92 下限永远够不到）',
    from: `  const As = A.replace(/\\s+/g, '')
  const Bs = B.replace(/\\s+/g, '')
  const short = As.length <= Bs.length ? As : Bs
  const long = As.length <= Bs.length ? Bs : As`,
    to: `  const short = A.length <= B.length ? A : B
  const long = A.length <= B.length ? B : A`
  },
  {
    name: '只生成 1 个关键词（歌手翻译不一致时完全搜不到）',
    from: `  if (title && first) out.push(title + ' ' + first)
  if (bare && bare !== title) out.push(first ? bare + ' ' + first : bare)
  if (title) out.push(title)
  if (bare && !out.includes(bare)) out.push(bare)`,
    to: `  if (title && first) out.push(title + ' ' + first)`
  },
  {
    name: '不剥「歌手 - 歌名」复合前缀（列表会显示成「周杰伦 - 告白气球 - 周杰伦」）',
    from: `    if (i > 0 && t.slice(0, i).trim() === a) {`,
    to: `    if (i > 0) {`
  },
  {
    name: '缺歌手时不给「未知歌手」兜底（打分时被当成空串）',
    from: `    artist: str(fields && fields.artist) || '未知歌手',`,
    to: `    artist: str(fields && fields.artist),`
  },
  {
    name: '时分秒格式化不补零（1:5 而不是 1:05）',
    from: `  return m + ':' + String(r).padStart(2, '0')`,
    to: `  return m + ':' + r`
  },
  {
    name: '缺分数显示成 0.00（看着像"匹配度 0%"而不是"还没匹配"）',
    from: `  if (v === null || v === undefined || v === '') return '-'`,
    to: `  if (false) return '-'`
  },

  /* ---------------- 载体与格式 ---------------- */
  {
    name: 'pickTrackArray 不给「带名称信息」加权（纯 hash 列表会被优先挑中）',
    from: `          candidates.push({ arr: objs, score: rich * 5000 + hits * 1000 + objs.length })`,
    to: `          candidates.push({ arr: objs, score: hits * 1000 + objs.length })`
  },
  {
    name: '复合串不清洗逗号与竖线（一首歌的名字会把后面所有字段错位）',
    from: `  return str(v).replace(/[,|]/g, ' ').replace(/\\s+/g, ' ').trim()`,
    to: `  return str(v).trim()`
  },
  {
    name: 'chunkArray 不分块（几百首挤进一条 URL/表单）',
    from: `  for (let i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n))`,
    to: `  out.push(arr || [])`
  },
  {
    name: 'parseLabelLine 把歌名歌手左右颠倒',
    from: `    return { title: left, artist: right }`,
    to: `    return { title: right, artist: left }`
  },
  {
    name: '外部曲目不做限深 BFS 兜底（嵌套在 song_info 里的字段认不出来）',
    from: `    str(findFieldDeep(raw, ['songname', 'song_name', 'songName', 'audio_name', 'filename'])) ||`,
    to: `    '' ||`
  },
  {
    name: 'name 是对象时不挑标量（歌名变成 "[object Object]"）',
    from: `  if (isObj(v)) return str(scalarOf(v, ['name', 'title', 'nickname']))`,
    to: `  if (isObj(v)) return str(v)`
  },
  {
    name: 'CSV 不做引号转义（歌名里的逗号会把表格列冲散）',
    from: `  return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s`,
    to: `  return s`
  },
  {
    name: 'CSV 不带 BOM（Excel 打开中文乱码）',
    from: `  return '\\uFEFF' + lines.join('\\r\\n')`,
    to: `  return lines.join('\\r\\n')`
  },
  {
    name: 'songKey 用文件级 hash 而不是歌曲级 mixSongId（同歌多音质会重复导入）',
    from: `  const mid = num(t && t.mixSongId, 0)
  if (mid > 0) return 'm' + mid`,
    to: `  const mid = 0
  if (mid > 0) return 'm' + mid`
  },

  /* ---------------- 去重与计划 ---------------- */
  {
    name: '不折叠批内重复（同一首歌在歌单里出现多次就写多次）',
    from: `    if (opts.dedupeBatch && seen.has(key)) {`,
    to: `    if (false && opts.dedupeBatch && seen.has(key)) {`
  },
  {
    name: '低置信也照导（用户没勾「包含低置信」却把不确定的结果写进歌单）',
    from: `    if (row.tier === 'low' && !opts.acceptLow) {`,
    to: `    if (row.tier === 'low' && false) {`
  },
  {
    name: '手动跳过被忽略（用户点了「跳过这首」还是被导入）',
    from: `    if (row.manualSkip) {
      row.importStatus = 'skipped'
      row.importReason = '手动跳过'`,
    to: `    if (false) {
      row.importStatus = 'skipped'
      row.importReason = '手动跳过'`
  },

  /* ---------------- 取数与重试 ---------------- */
  {
    name: '临时失败不重试（上游连接被重置就整首失败）',
    from: `    last = await searchOnce(ctx, keyword, pageSize, deps)
    if (last.items.length || !isTransientError(last.error, last.httpStatus, last.errorCode)) return last`,
    to: `    last = await searchOnce(ctx, keyword, pageSize, deps)
    return last`
  },
  {
    name: '临时失败判别不看 error_code（业务拒绝也被无意义重试，徒增风控风险）',
    from: `  return num(httpStatus, 0) === 502 && num(errorCode, 0) === 0`,
    to: `  return num(httpStatus, 0) === 502`
  },
  {
    name: '临时失败判别一律为真（所有失败都重试）',
    from: `  return num(httpStatus, 0) === 502 && num(errorCode, 0) === 0
}

const MAX_ATTEMPTS = 2`,
    to: `  return true
}

const MAX_ATTEMPTS = 2`
  },
  {
    name: '匹配不做提前收手（每个关键词都搜一遍，请求数翻倍）',
    from: `    if (bestScore >= opts.accept) break`,
    to: `    if (false) break`
  },
  {
    name: 'error_code=0 也当成业务错误码（把 502 的失败显示成「错误码 0」）',
    from: `  if (code) return '酷狗返回错误码 ' + code`,
    to: `  if (true) return '酷狗返回错误码 ' + code`
  },
  {
    name: '网易云 tracks 被截断时不补 /song/detail（1000 首的歌单只导入几百首）',
    from: `  if (trackIds.length > rawTracks.length) {`,
    to: `  if (false) {`
  },
  {
    name: '识别不出平台时抛异常而不是返回失败对象（界面直接炸）',
    from: `    return {
      ok: false,
      providerId: 'auto',
      error:
        '没能识别这个链接属于哪个平台。请在上方手动选择平台，或改用「本地文件 / 粘贴文本」导入。当前支持：' +
        PROVIDERS.map((p) => p.name).join(' / ')
    }`,
    to: `    throw new Error('没能识别这个链接属于哪个平台。当前支持：' + PROVIDERS.map((p) => p.name).join(' / '))`
  },
  {
    name: 'name 是对象的歌手数组不合并（ar:[{name}] 变成空）',
    from: `      .map((x) =>
        isObj(x) ? str(scalarOf(x, ['name', 'title', 'nickname', 'author_name', 'singerName'])) : str(x)
      )`,
    to: `      .map((x) => str(x))`
  },

  /* ---------------- 风控 ---------------- */
  {
    name: '风控判定不带「请求确实失败」（成功响应里带 ssa-code 也弹窗）',
    from: `  if (errorCode !== 20028 && bizStatus !== 0) return ''`,
    to: `  if (false) return ''`
  },

  /* ---------------- 写入与落点 ---------------- */
  {
    name: '加歌不传目标歌单 id（写到未定义的歌单）',
    from: `  const res = await deps.route(ctx, ROUTE.playlistTracksAdd, {
    listid: id,`,
    to: `  const res = await deps.route(ctx, ROUTE.playlistTracksAdd, {
    listid: 0,`
  },
  {
    name: '建歌单不传名字（上游拒绝，整轮导入失败）',
    from: `    name: playlistName,
    type: 0, // type 0 = 自建歌单；非 0 是「收藏别人的歌单」`,
    to: `    name: '',
    type: 0, // type 0 = 自建歌单；非 0 是「收藏别人的歌单」`
  },
  {
    name: '建歌单失败后仍继续加歌（产生一堆无归属的失败行）',
    from: `      summary.error = '创建歌单失败：' + created.error
      summary.elapsedMs = Date.now() - startedAt
      emit({ type: 'phase', phase: 'error', error: summary.error })
      return { ok: false, summary, phase: 'target' }`,
    to: `      summary.error = '创建歌单失败：' + created.error`
  },
  {
    name: '不检查目标歌单已有歌曲（同一批歌重复写进已有歌单）',
    from: `  if (options.skipExisting) {
    emit({ type: 'phase', phase: 'dedupe' })`,
    to: `  if (false) {
    emit({ type: 'phase', phase: 'dedupe' })`
  },
  {
    name: '中止后照样写库（用户点了停止，歌还是进了歌单）',
    from: `    if (isAborted()) {
      aborted = true
      break
    }`,
    to: `    if (false) {
      aborted = true
      break
    }`
  },

  /* ---------------- 任务中心 ---------------- */
  {
    name: '任务中心条目不写 retention（漏了宿主会抛「任务 completed 保留策略无效」）',
    from: `        retention: {
          completed: { mode: 'auto', delayMs: 8000 },
          error: { mode: 'manual' },
          aborted: { mode: 'auto', delayMs: 3000 }
        }`,
    to: `        retention: null`
  },
  {
    name: '任务 id 用了宿主保留的 echo: 前缀（会被宿主拒绝）',
    from: `const TASK_ID = PLUGIN_ID + ':import'`,
    to: `const TASK_ID = 'echo:' + PLUGIN_ID + ':import'`
  },
  {
    name: '失败收尾也报 completed（任务中心显示成功，用户以为都导进去了）',
    from: `      if (!okRun) {
        task.finish('error', { error: summary.error || '导入失败', progress: { label: '失败' } })`,
    to: `      if (false) {
        task.finish('error', { error: summary.error || '导入失败', progress: { label: '失败' } })`
  },

  /* ---------------- 设置 ---------------- */
  {
    name: '加歌批大小不按上游上限收敛（允许填 999，实际被静默夹住）',
    from: `    addBatchSize: [1, ADD_BATCH_SIZE, 1],`,
    to: `    addBatchSize: [1, 5000, 1],`
  },
  {
    name: '页面快捷开关不写回设置（关掉插件再开就丢了）',
    from: `              if (it[0] in SETTING_DEFAULTS) {
                settings[it[0]] = state.options[it[0]]
                saveSettings()
              }`,
    to: `              if (false) {
                settings[it[0]] = state.options[it[0]]
                saveSettings()
              }`
  },

  /* ---------------- CSS 契约 ---------------- */
  {
    name: 'CSS：插件页用 flex column（子项被压扁，既看不到滚动条内容也被挤没）',
    file: 'css',
    from: `  display: block;          /* 不要 flex-direction: column —— 子项会被压扁而不是溢出 */`,
    to: `  display: flex;
  flex-direction: column;`
  },
  {
    name: 'CSS：插件页不自己滚（宿主 .plugin-page-host 只裁剪不滚动 → 谁也滚不了）',
    file: 'css',
    from: `  overflow-y: auto;
  overflow-x: hidden;
  display: block;`,
    to: `  overflow: hidden;
  display: block;`
  },
  {
    name: 'CSS：设置面板写 height + overflow（自己高度=内容高度 → 设置页完全滚不动）',
    file: 'css',
    from: `  display: block; /* ← 不要 height:100%；不要 overflow-y:auto（否则设置页滚不动） */`,
    to: `  display: block;
  height: 100%;
  overflow-y: auto;`
  },
  {
    name: 'CSS：主题变量不写兜底值（宿主变量缺失时文字变黑/看不见）',
    file: 'css',
    from: `  color: var(--color-text-main, #1f2937);
  font-family: var(--font-sans, sans-serif);`,
    to: `  color: var(--color-text-main);
  font-family: var(--font-sans, sans-serif);`
  },
  {
    name: 'CSS：进度条 transition 用 ease（每片末尾减速，进度条更顿）',
    file: 'css',
    from: `  transition: width 200ms linear; /* linear：与快心跳同周期，每跳首尾相接 */`,
    to: `  transition: width 200ms ease;`
  }
]

/* ========================================================================== *
 * 执行
 * ========================================================================== */

function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

const originals = { js: fs.readFileSync(SRC_JS, 'utf8'), css: fs.readFileSync(SRC_CSS, 'utf8') }
fs.mkdirSync(TMP_DIR, { recursive: true })

const rows = []
let missed = 0
let skipped = 0

for (const m of MUTANTS) {
  const kind = m.file === 'css' ? 'css' : 'js'
  const original = originals[kind]
  if (!original.includes(m.from)) {
    skipped++
    rows.push('⚠ 跳过（原文没命中，需更新变异定义）：' + m.name)
    continue
  }
  const id = hashCode(m.name)
  const mutantPath = path.join(TMP_DIR, 'mutant-' + id + '.' + kind)
  fs.writeFileSync(mutantPath, original.replace(m.from, m.to), 'utf8')

  const reportFile = path.join(TMP_DIR, 'mutant-' + id + '-report.txt')
  const env = { ...process.env, PI_REPORT_FILE: reportFile }
  if (kind === 'css') env.PI_CSS_ENTRY = mutantPath
  else env.PI_PLUGIN_ENTRY = mutantPath

  let caught = false
  let evidence = ''
  try {
    execFileSync(NODE, [TEST], { env, encoding: 'utf8', stdio: 'pipe', timeout: 180000 })
  } catch (e) {
    caught = true
    try {
      const rep = fs.readFileSync(reportFile, 'utf8')
      const summaryLine = (rep.match(/[✗✓] playlist-importer 无头集成测试：[^\n]*/) || [''])[0]
      const firstFail = (rep.match(/^\s+1\. \[[^\n]*/m) || [''])[0]
      evidence = [summaryLine.trim(), firstFail.trim()].filter(Boolean).join('  →  ')
    } catch {
      evidence = '（报告未生成）退出码 ' + (e && e.status)
    }
  }
  if (!caught) missed += 1
  rows.push(
    (caught ? '✓ 被测试抓到' : '✗ 没被抓到（假安全！）') +
      ' :: ' +
      m.name +
      (evidence ? '\n      ' + evidence : '')
  )
}

const total = MUTANTS.length
const lines = [
  '',
  '='.repeat(72),
  '变异测试：确认关键断言真的能抓到回归（改坏了必须变红）',
  '='.repeat(72),
  rows.join('\n'),
  '-'.repeat(72),
  missed
    ? '结果: ' + (total - missed - skipped) + '/' + total + ' 个变异被抓到，' + missed + ' 个漏网 ✗' +
      (skipped ? '（另有 ' + skipped + ' 个定义未命中被跳过）' : '')
    : '结果: ' + total + '/' + total + ' 个变异全部被抓到 ✓' +
      (skipped ? '（另有 ' + skipped + ' 个定义未命中被跳过）' : ''),
  '='.repeat(72)
]
const text = lines.join('\n')
fs.writeFileSync(path.join(ROOT, '.workbuddy', 'tmp', 'playlist-importer-mutate-report.txt'), text, 'utf8')
process.exitCode = missed || skipped ? 1 : 0
