/**
 * 歌曲下载 (song-downloader) 变异测试（mutation check）
 * ---------------------------------------------------------------------------
 * 作用：把「已修好的关键行为」故意改回 bug 版本，确认无头集成测试真的会失败。
 * 如果改坏了测试还全绿，说明那条断言是无效的（假安全）。
 *
 * 用法： node tests/song-downloader.mutate.mjs
 * 退出码：0 = 每个变异都被抓到；1 = 有变异没被抓到（说明断言要补）
 *
 * 依赖 tests/song-downloader.smoke.mjs 支持 SD_PLUGIN_ENTRY 环境变量指向插件副本。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'song-downloader', 'index.js')
const TEST = path.join(HERE, 'song-downloader.smoke.mjs')
const TMP_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'sd-mutants')
const NODE = process.execPath

/** 每个变异：名字 + 「原文 → 改坏后」的替换对（必须能在原文里精确命中） */
const MUTANTS = [
  {
    name: '128 档不走「主 hash」特例（直接取 relateGoods 第一条，会拿到别的音质的文件）',
    from: `  if (!main || quality === '128') return main`,
    to: `  if (!main) return main`
  },
  {
    name: '音质不逐级降级（请求 flac 失败就直接报错）',
    from: `  const list = []
  for (let i = start; i >= 0; i--) list.push(QUALITY_LADDER[i])
  return list.length ? list : ['128']`,
    to: `  return [QUALITY_LADDER[start] || '128']`
  },
  {
    name: '候选地址不剔除图片（封面 URL 混进来后会把 jpg 当歌曲存盘）',
    from: `  const audio = out.filter((u) => !isImage(u))`,
    to: `  const audio = out.slice()`
  },
  {
    name: '失败文案丢掉 HTTP 状态（用户只看到「接口返回失败」，无法定位）',
    from: `  return status && status !== 200 ? 'HTTP ' + status : '接口返回失败'`,
    to: `  return '接口返回失败'`
  },
  {
    name: '分片下载路径被短路（永远一次性下载，进度与速度消失）',
    from: `  if (status === 206 && total > 0 && total > chunkSize) {`,
    to: `  if (false) {`
  },
  {
    name: '不传 maxResponseBytes: 0（默认 32 MiB 会截断大 FLAC）',
    from: `      responseType: 'arrayBuffer',
      maxResponseBytes: 0,`,
    to: `      responseType: 'arrayBuffer',
      maxResponseBytes: 32 * 1024 * 1024,`
  },
  {
    name: '落盘时不带 <a download>（浏览器会直接跳转播放而不是下载）',
    from: `  a.download = fileName`,
    to: `  a.dataset.skip = fileName`
  },
  {
    name: '不清洗文件名里的非法字符（Windows 上写入直接失败）',
    from: `    .replace(/[\\\\/:*?"<>|\\u0000-\\u001f]/g, '_')`,
    to: `    .replace(/\\u0000/g, '_')`
  },
  {
    name: 'createTask 返回原始对象而不是响应式代理（界面看不到状态更新）',
    from: `    const idx = state.tasks.findIndex((x) => x.id === task.id)
    return idx >= 0 ? state.tasks[idx] : null`,
    to: `    return task`
  },
  {
    name: '不拦截本地/云盘歌曲（会拿空 hash 去请求上游）',
    from: `    if (UNSUPPORTED_SOURCES.includes(t.source)) return { ...t, unsupported: '本地文件 / 云盘歌曲暂不支持下载' }`,
    to: `    if (false) return { ...t, unsupported: '本地文件 / 云盘歌曲暂不支持下载' }`
  },
  {
    name: '开关不作用于侧边栏入口（设置项变成摆设）',
    from: `    if (key === 'sidebarEntry') applySidebarEntry(!!value)`,
    to: `    void applySidebarEntry`
  },
  {
    name: 'notice 只改状态不弹提示（失败时用户毫无察觉）',
    from: `    try {
      ctx.toast.info(state.notice)
    } catch {
      /* 忽略 */
    }`,
    to: `    void state.notice`
  }
]

const original = fs.readFileSync(SRC, 'utf8')
fs.mkdirSync(TMP_DIR, { recursive: true })

const rows = []
let missed = 0
let skipped = 0

for (const mutant of MUTANTS) {
  if (!original.includes(mutant.from)) {
    skipped += 1
    rows.push('⚠ 跳过（原文没命中，需更新变异定义）：' + mutant.name)
    continue
  }
  const file = path.join(TMP_DIR, 'mutant-' + Math.abs(hashCode(mutant.name)) + '.js')
  const patched = original.replace(mutant.from, mutant.to)
  if (patched === original) {
    skipped += 1
    rows.push('⚠ 跳过（替换后内容不变）：' + mutant.name)
    continue
  }
  fs.writeFileSync(file, patched, 'utf8')

  let caught = false
  let evidence = ''
  try {
    execFileSync(NODE, [TEST], {
      env: { ...process.env, SD_PLUGIN_ENTRY: file, SD_REPORT: path.join(TMP_DIR, 'report.txt') },
      encoding: 'utf8',
      stdio: 'pipe'
    })
  } catch (error) {
    caught = true
    const out = String(error.stdout || '')
    evidence = out
      .split('\n')
      .filter((line) => line.trim().startsWith('✗') || line.includes('失败：') || line.includes('测试进程异常'))
      .slice(0, 2)
      .map((line) => line.trim())
      .join(' | ')
  }
  if (!caught) missed += 1
  rows.push((caught ? '✓ 被测试抓到' : '✗ 没被抓到（假安全！）') + ' :: ' + mutant.name + (evidence ? '\n      ' + evidence : ''))
}

function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

const lines = [
  '',
  '='.repeat(66),
  '歌曲下载 变异测试：确认关键断言真的能抓到回归',
  '='.repeat(66),
  ...rows,
  '-'.repeat(66),
  missed
    ? '结果: ' + (MUTANTS.length - missed - skipped) + '/' + (MUTANTS.length - skipped) + ' 个变异被抓到，' + missed + ' 个漏网 ✗'
    : '结果: ' + (MUTANTS.length - skipped) + '/' + (MUTANTS.length - skipped) + ' 个变异全部被抓到 ✓',
  '='.repeat(66)
]

const report = lines.join('\n')
// 自己落盘：PowerShell 的重定向会按 OEM 代码页解码 stdout，中文会变成乱码
try {
  fs.writeFileSync(path.join(ROOT, '.workbuddy', 'tmp', 'song-downloader-mutate-report.txt'), report, 'utf8')
} catch (error) {
  void error
}
console.log(report)

// 注意：不要用 process.exit()，它会抢在 writeFileSync 落盘之前结束进程
process.exitCode = missed ? 1 : 0
