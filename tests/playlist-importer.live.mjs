/**
 * 歌单导入增强 (playlist-importer) 真实网络冒烟
 * ===========================================================================
 * 为什么需要它：无头集成测试用的是**夹具**，能证明「逻辑对」，
 * 但证明不了「上游真实响应形态能被归一化对」—— 这两件事的风险是独立的。
 * 本仓库的历史教训：大写 hash、上游根本不返回时长，都只有打真实接口才会暴露。
 *
 * 这里只覆盖**不依赖登录**的直连来源（网易云 / QQ 音乐 / 酷我）。
 * 走宿主本地路由的来源（酷狗本身、以及所有写入操作）在 Node 里连不上
 * —— 那要走主进程注入签名与设备指纹，只能在真机验证。
 *
 * 用法：  node tests/playlist-importer.live.mjs
 * 退出码：0 = 至少一个来源成功且归一化结果干净；1 = 全部来源失败，或拿到数据却归一化失败。
 *
 * 注意：这不是 CI 项。平台改版、地域限制、风控都会让它失败，那是**信号**不是 bug。
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN_ENTRY = process.env.PI_PLUGIN_ENTRY
  ? path.resolve(process.env.PI_PLUGIN_ENTRY)
  : path.join(ROOT, 'playlist-importer', 'index.js')

const mod = await import(pathToFileURL(PLUGIN_ENTRY).href + '?t=' + Date.now())

/* --------------------------------------------------------------------------
 * 真实 fetch 版的 ctx.net.request（宿主契约：{url,status,statusText,headers,data}）
 * ------------------------------------------------------------------------ */

function makeLiveCtx() {
  const calls = []
  return {
    calls,
    ctx: {
      net: {
        async request(config) {
          calls.push(config.url)
          const headers = Object.assign(
            { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
            config.headers || {}
          )
          const init = { method: config.method || 'GET', headers, redirect: 'follow' }
          if (config.body) {
            init.body = config.body
            init.method = config.method || 'POST'
          }
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), 25000)
          init.signal = ac.signal
          try {
            const res = await fetch(config.url, init)
            const text = await res.text()
            return {
              url: res.url || config.url,
              status: res.status,
              statusText: res.statusText,
              headers: {},
              data: text
            }
          } finally {
            clearTimeout(timer)
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ 断言 */

let pass = 0
const failures = []
const notes = []

function ok(cond, name, extra) {
  if (cond) {
    pass++
    return true
  }
  failures.push(name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300)))
  return false
}

function note(s) {
  notes.push(s)
}

/* -------------------------------------------------------- 归一化质量断言 */

/**
 * 「拿到真实数据之后，归一化结果干不干净」。
 * 这是这个脚本唯一真正要守的东西 —— 抓不到上游数据本身不算缺陷。
 */
function checkPlaylist(providerName, playlist) {
  ok(!!playlist, providerName + '：返回了歌单对象')
  if (!playlist) return
  ok(playlist.tracks.length > 0, providerName + '：至少解析出 1 首', { n: playlist.tracks.length })
  ok(playlist.name.length > 0, providerName + '：歌单名非空', { name: playlist.name })

  const head = playlist.tracks.slice(0, 20)
  const unknownTitle = head.filter((t) => t.title === '未知歌曲').length
  const unknownArtist = head.filter((t) => t.artist === '未知歌手').length
  ok(unknownTitle === 0, providerName + '：前 20 首没有「未知歌曲」', {
    unknownTitle,
    first: head[0] && head[0].title
  })
  ok(unknownArtist === 0, providerName + '：前 20 首没有「未知歌手」', {
    unknownArtist,
    first: head[0] && head[0].artist
  })

  // 标题里不该混进 "[object Object]"（name 是对象时最容易翻车）
  const objectLeak = head.filter((t) => /\[object|\bundefined\b|\bnull\b/.test(t.title + ' ' + t.artist)).length
  ok(objectLeak === 0, providerName + '：标题/歌手里没有 [object Object] / undefined 泄漏', { objectLeak })

  // 时长：0 允许（上游可能没给），但不允许出现毫秒级的离谱值
  const absurd = head.filter((t) => t.duration > 3600).length
  ok(absurd === 0, providerName + '：没有把毫秒当时长（>3600 秒）', {
    absurd,
    sample: head.find((t) => t.duration > 3600)
  })

  const withDuration = head.filter((t) => t.duration > 0).length
  note(
    providerName +
      '：' +
      playlist.tracks.length +
      ' 首，前 20 首里 ' +
      withDuration +
      ' 首带时长；样例「' +
      head[0].title +
      ' - ' +
      head[0].artist +
      '」' +
      (head[0].duration ? ' · ' + head[0].duration + 's' : '')
  )
}

/* ---------------------------------------------------------------- 跑各源 */

console.log('')
console.log('歌单导入增强 · 真实网络冒烟（只覆盖免登录的直连来源）')
console.log('='.repeat(72))

const results = {}

/* --- 网易云：热歌榜（公开、稳定） --- */
{
  const { ctx, calls } = makeLiveCtx()
  try {
    const r = await mod.resolveLink(ctx, 'https://music.163.com/#/playlist?id=3778678', 'netease', {})
    results.netease = r.ok
    if (!r.ok) {
      note('网易云：取数失败 —— ' + r.error)
    } else {
      ok(r.playlist.source === 'netease', '网易云：source 标记正确')
      ok(r.playlist.tracks.length > 20, '网易云：热歌榜解析出多于 20 首', { n: r.playlist.tracks.length })
      checkPlaylist('网易云', r.playlist)
    }
    console.log('  · 网易云       ' + (r.ok ? '✓ ' + r.playlist.tracks.length + ' 首' : '✗ ' + r.error))
    console.log('    请求 ' + calls.length + ' 次：' + calls.map((u) => u.slice(0, 72)).join(' , '))
  } catch (e) {
    results.netease = false
    note('网易云：抛异常 —— ' + ((e && e.message) || String(e)))
    console.log('  · 网易云       ✗ ' + ((e && e.message) || String(e)))
  }
}

/* --- QQ 音乐：用一个长期存在的公开歌单 --- */
{
  const { ctx, calls } = makeLiveCtx()
  const url = 'https://y.qq.com/n/ryqq/playlist/8037613424'
  try {
    const r = await mod.resolveLink(ctx, url, 'qqmusic', {})
    results.qqmusic = r.ok
    if (!r.ok) {
      note('QQ 音乐：取数失败 —— ' + r.error)
    } else {
      ok(r.playlist.source === 'qqmusic', 'QQ 音乐：source 标记正确')
      checkPlaylist('QQ 音乐', r.playlist)
      // QQ 的 interval 是秒，不该被当成毫秒再除一次
      const d = r.playlist.tracks.find((t) => t.duration > 0)
      ok(!d || (d.duration > 30 && d.duration < 1200), 'QQ 音乐：时长落在合理区间（秒，不做二次换算）', {
        duration: d && d.duration
      })
    }
    console.log('  · QQ 音乐      ' + (r.ok ? '✓ ' + r.playlist.tracks.length + ' 首' : '✗ ' + r.error))
    console.log('    请求 ' + calls.length + ' 次：' + calls.map((u) => u.slice(0, 72)).join(' , '))
  } catch (e) {
    results.qqmusic = false
    note('QQ 音乐：抛异常 —— ' + ((e && e.message) || String(e)))
    console.log('  · QQ 音乐      ✗ ' + ((e && e.message) || String(e)))
  }
}

/* --- 酷我：先从一个真实的公开歌单 id 探一个出来（pid 不能瞎编） --- */
{
  const { ctx, calls } = makeLiveCtx()
  let pid = ''
  try {
    const res = await ctx.net.request({
      url: 'http://wapi.kuwo.cn/api/www/rcm/index/playlist?id=3083&pn=1&rn=5&httpsStatus=1',
      headers: { Referer: 'http://www.kuwo.cn/' }
    })
    const j = JSON.parse(res.data)
    const list = (j && j.data && j.data.list) || []
    const hit = list.find((x) => x && (x.pid || x.id))
    pid = String((hit && (hit.pid || hit.id)) || '')
    if (pid) note('酷我：从榜单接口探到公开歌单 pid = ' + pid + '（uid ' + (hit.uid || hit.userid || '?') + '）')
  } catch (e) {
    note('酷我：探 pid 失败 —— ' + ((e && e.message) || String(e)))
  }

  if (!pid) {
    results.kuwo = false
    note('酷我：没有探到可用的歌单 id，跳过（这不代表插件的酷我解析坏了）')
    console.log('  · 酷我         ⚠ 没探到可用 pid，跳过')
  } else {
    try {
      const r = await mod.resolveLink(ctx, 'https://www.kuwo.cn/playlist_detail/' + pid, 'kuwo', {})
      results.kuwo = r.ok
      if (!r.ok) {
        note('酷我：取数失败 —— ' + r.error)
      } else {
        ok(r.playlist.source === 'kuwo', '酷我：source 标记正确')
        checkPlaylist('酷我', r.playlist)
      }
      console.log('  · 酷我         ' + (r.ok ? '✓ ' + r.playlist.tracks.length + ' 首' : '✗ ' + r.error))
      console.log('    请求 ' + calls.length + ' 次')
    } catch (e) {
      results.kuwo = false
      note('酷我：抛异常 —— ' + ((e && e.message) || String(e)))
      console.log('  · 酷我         ✗ ' + ((e && e.message) || String(e)))
    }
  }
}

/* ---------------------------------------------------------------- 汇总 */

const attempted = Object.keys(results)
const succeeded = attempted.filter((k) => results[k])

console.log('-'.repeat(72))
for (const n of notes) console.log('  · ' + n)
console.log('-'.repeat(72))
console.log(
  '直达来源：' +
    succeeded.length +
    ' / ' +
    attempted.length +
    ' 可用（' +
    attempted.map((k) => k + (results[k] ? '✓' : '✗')).join(' ') +
    '）'
)
console.log(
  (failures.length ? '✗' : '✓') +
    ' 归一化质量断言：' +
    pass +
    ' 通过 / ' +
    failures.length +
    ' 失败'
)
if (failures.length) {
  console.log('')
  console.log('失败明细：')
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f))
}
console.log('='.repeat(72))

// 退出码语义：只要有**一个**来源成功、且没有任何归一化质量问题，就算通过。
// 全部来源都拿不到（网络/地域/风控）才是失败 —— 但那是环境问题，报告里会写清楚。
const normalizationBad = failures.length > 0
const allDown = succeeded.length === 0
process.exitCode = normalizationBad || allDown ? 1 : 0
