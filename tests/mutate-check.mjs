/**
 * 变异测试（mutation check）
 * ---------------------------------------------------------------------------
 * 作用：把「已修好的关键行为」故意改回 bug 版本，确认无头集成测试真的会失败。
 * 如果改坏了测试还全绿，说明那条断言是无效的（假安全）。
 *
 * 用法： node tests/mutate-check.mjs
 * 退出码：0 = 每个变异都被抓到；1 = 有变异没被抓到（说明断言要补）
 *
 * 依赖 tests/kugou-recommend.smoke.mjs 支持 KR_PLUGIN_ENTRY 环境变量指向插件副本。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'kugou-recommend', 'index.js')
const TEST = path.join(HERE, 'kugou-recommend.smoke.mjs')
const TMP_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'mutants')
const NODE = process.execPath

/** 每个变异：名字 + 「原文 → 改坏后」的替换对（必须能在原文里精确命中） */
const MUTANTS = [
  {
    name: 'bucketOf 返回原始对象（真机出现过的响应式 bug：换一批后要切源才刷新）',
    from: `  function bucketOf(id) {
    const cur = state.lists[id]
    if (!isObj(cur) || !Array.isArray(cur.tracks)) {
      state.lists[id] = isObj(cur) ? { ...cur, tracks: [] } : { tracks: [], page: 1, at: 0 }
    }
    return state.lists[id]
  }`,
    to: `  function bucketOf(id) {
    let b = state.lists[id]
    if (!b || !Array.isArray(b.tracks)) {
      b = { tracks: [], page: 1, at: 0 }
      state.lists[id] = b
    }
    return b
  }`
  },
  {
    name: '按文件级 hash 去重（同一首歌的多音质变体会显示成好几条）',
    from: `      const tracks = uniqBy((out.tracks || []).filter(Boolean), (t) => t.songKey || t.dedupeKey)`,
    to: `      const tracks = uniqBy((out.tracks || []).filter(Boolean), (t) => t.dedupeKey)`
  },
  {
    name: '不剥「歌手 - 歌名」复合前缀',
    from: `  const title = cleanupTitle(rawTitle, artist)`,
    to: `  const title = rawTitle`
  },
  {
    name: '主 hash 优先取 hash_320（把另一份音质当歌曲身份）',
    from: `    str(firstOf(ai, ['hash', 'hash_128'])) ||
    str(firstOf(base, ['hash', 'file_hash', 'hash_128'])) ||
    str(firstOf(s, ['hash', 'file_hash'])) ||
    str(findFieldDeep(s, ['hash'])) ||
    str(firstOf(ai, ['hash_320', 'hash_flac', 'hash_high'])) ||
    str(firstOf(base, ['hash_320', 'hash_flac'])) ||`,
    to: `    str(firstOf(ai, ['hash', 'hash_128', 'hash_320', 'hash_flac', 'hash_high'])) ||
    str(firstOf(base, ['hash', 'file_hash', 'hash_128', 'hash_320'])) ||
    str(firstOf(s, ['hash', 'file_hash', 'hash_128', 'hash_320'])) ||`
  },
  {
    name: 'hash 不做小写归一化（跨源去重失效）',
    from: `  ).toLowerCase()
  if (!hash) return null`,
    to: `  )
  if (!hash) return null`
  },
  {
    name: 'error_code=0 时拿错误码表当失败文案（会显示成「成功」）',
    from: `    const text =
      (code ? describeError(code) : '') ||`,
    to: `    const text =
      (describeError(code) || '') ||`
  },
  {
    name: '业务错误也重试（对 20010 这类拒绝做无意义重试）',
    from: `  return num(httpStatus, 0) === 502 && num(errorCode, 0) === 0`,
    to: `  return num(httpStatus, 0) === 502`
  }
]

const original = fs.readFileSync(SRC, 'utf8')
fs.mkdirSync(TMP_DIR, { recursive: true })

const rows = []
let missed = 0

for (const m of MUTANTS) {
  if (!original.includes(m.from)) {
    rows.push('⚠ 跳过（原文没命中，需更新变异定义）：' + m.name)
    continue
  }
  const file = path.join(TMP_DIR, 'mutant-' + Math.abs(hashCode(m.name)) + '.js')
  fs.writeFileSync(file, original.replace(m.from, m.to), 'utf8')

  let caught = false
  let evidence = ''
  try {
    execFileSync(NODE, [TEST], {
      env: { ...process.env, KR_PLUGIN_ENTRY: file },
      encoding: 'utf8',
      stdio: 'pipe'
    })
  } catch (e) {
    caught = true
    evidence = String(e.stdout || '')
      .split('\n')
      .filter((l) => l.includes('结果:') || l.includes('✗'))
      .slice(0, 3)
      .map((l) => l.trim())
      .join(' | ')
  }
  if (!caught) missed += 1
  rows.push((caught ? '✓ 被测试抓到' : '✗ 没被抓到（假安全！）') + ' :: ' + m.name + (evidence ? '\n      ' + evidence : ''))
}

function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

console.log('')
console.log('='.repeat(66))
console.log('变异测试：确认关键断言真的能抓到回归')
console.log('='.repeat(66))
console.log(rows.join('\n'))
console.log('-'.repeat(66))
console.log(
  missed
    ? '结果: ' + (MUTANTS.length - missed) + '/' + MUTANTS.length + ' 个变异被抓到，' + missed + ' 个漏网 ✗'
    : '结果: ' + MUTANTS.length + '/' + MUTANTS.length + ' 个变异全部被抓到 ✓'
)
console.log('='.repeat(66))

process.exit(missed ? 1 : 0)
