/**
 * 插件标签筛选 (tag-filter) 变异测试（mutation check）
 * ---------------------------------------------------------------------------
 * 作用：把「已修好的关键行为」故意改回 bug 版本，确认无头集成测试真的会失败。
 * 如果改坏了测试还全绿，说明那条断言是无效的（假安全）。
 *
 * 用法： node tests/tag-filter.mutate.mjs
 * 退出码：0 = 每个变异都被抓到；1 = 有变异没被抓到（说明断言要补）
 *
 * 依赖 tests/tag-filter.smoke.mjs 支持 TF_PLUGIN_ENTRY 环境变量指向插件副本。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'tag-filter', 'index.js')
const TEST = path.join(HERE, 'tag-filter.smoke.mjs')
const TMP_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'tf-mutants')
const NODE = process.execPath

/** 每个变异：名字 + 「原文 → 改坏后」的替换对（必须能在原文里精确命中） */
const MUTANTS = [
  {
    name: '不跳过骨架屏网格（加载期间把占位标签当成真标签聚合出来）',
    from: `      // 骨架屏网格：里面的 .plugin-card 是占位卡片，标签也是假的
      if (isBusyGrid(grid)) continue`,
    to: `      // 骨架屏网格：里面的 .plugin-card 是占位卡片，标签也是假的`
  },
  {
    name: '用 class 而不是行内 style 隐藏卡片（宿主重写 className 后筛选失效）',
    from: `        const want = hide ? 'none' : ''
        if (el.style.display !== want) el.style.display = want`,
    to: `        el.className = hide ? 'plugin-card etf-hidden' : 'plugin-card'`
  },
  {
    name: '标签不去重（同一 key 出现两次，chip 计数翻倍）',
    from: `      const tags = dedupeTags(record.tags)`,
    to: `      const tags = record.tags`
  },
  {
    name: '标签键不做小写归一（Lyrics 与 lyrics 变成两个标签）',
    from: `  return normalizeTag(value).toLowerCase()`,
    to: `  return normalizeTag(value)`
  },
  {
    name: '「全部」模式退化成「任一」模式',
    from: `  if (mode === 'all') {
    for (const key of keys) if (!tags.has(key)) return false
    return true
  }`,
    to: `  if (mode === 'all') {
    return true
  }`
  },
  {
    name: '没有选择时把所有卡片都判为不命中',
    from: `  if (keys.length === 0) return true`,
    to: `  if (keys.length === 0) return false`
  },
  {
    name: '不给「没有任何标签的插件」伪造「未标注」身份（这些插件永远筛不出来）',
    from: `    if (entity.tags.length === 0) {
      entity.tags = [{ key: UNTAGGED_KEY, label: UNTAGGED_LABEL, untagged: true }]
      entity.tagKeys = new Set([UNTAGGED_KEY])
    }`,
    to: `    if (false) {
      entity.tags = [{ key: UNTAGGED_KEY, label: UNTAGGED_LABEL, untagged: true }]
      entity.tagKeys = new Set([UNTAGGED_KEY])
    }`
  },
  {
    name: 'chip 计数不累加（每个标签都显示 1）',
    from: `      if (current) current.count += 1`,
    to: `      if (current) current.count += 0`
  },
  {
    name: '不标记「加上也匹配不到」的标签（用户看不到哪些标签是死路）',
    from: `      dead: alive === 0 && !selectedSet.has(entry.key)`,
    to: `      dead: false`
  },
  {
    name: '关掉筛选条时不还原已隐藏的卡片（列表会一直停在被筛过的状态）',
    from: `      // 关掉筛选条时不能只是不注入：已经隐藏的卡片必须还原
      dropAllHosts()
      liveEntities = []
      restoreAll()`,
    to: `      // 关掉筛选条时不能只是不注入：已经隐藏的卡片必须还原
      dropAllHosts()
      liveEntities = []`
  },
  {
    name: '停用时忘了还原被隐藏的卡片',
    from: `    dropAllHosts()
    restoreAll()
    if (typeof sidebarDispose === 'function') sidebarDispose()`,
    to: `    dropAllHosts()
    if (typeof sidebarDispose === 'function') sidebarDispose()`
  },
  {
    name: '不恢复上次的选择（重启后筛选状态丢失）',
    from: `    if (saved && settings.persistSelection) {`,
    to: `    if (false) {`
  },
  {
    name: '改「默认匹配方式」后不生效（设置项变成摆设）',
    from: `      mode = MATCH_MODES[value] ? value : DEFAULT_SETTINGS.defaultMode`,
    to: `      mode = mode`
  },
  {
    name: '关掉侧边栏入口时不移除（用户以为开关坏了）',
    from: `    if (typeof sidebarDispose === 'function') {
      try {
        sidebarDispose()
      } catch (error) {
        log('移除侧边栏入口失败', error)
      }
    }
    sidebarDispose = null
    return true
  }`,
    to: `    return true
  }`
  },
  {
    name: '宿主没给标签时不提示（用户面对只有一个「未标注」的筛选条无从判断）',
    from: `    if (view.tagCount > 0 || view.total === 0) return null`,
    to: `    return null`
  },
  {
    name: '快照派生失效（面板离开后独立页面永远显示「还没采集到标签」）',
    from: `    if (snapshotCacheKey !== snapshot.items) {
      snapshotCacheKey = snapshot.items
      snapshotCacheValue = snapshot.items.length ? entitiesFromSnapshot(snapshot.items) : []
    }`,
    to: `    if (false) {
      snapshotCacheKey = snapshot.items
      snapshotCacheValue = snapshot.items.length ? entitiesFromSnapshot(snapshot.items) : []
    }`
  }
]

const original = fs.readFileSync(SRC, 'utf8')
fs.mkdirSync(TMP_DIR, { recursive: true })

const rows = []
let missed = 0

for (const mutant of MUTANTS) {
  if (!original.includes(mutant.from)) {
    rows.push('⚠ 跳过（原文没命中，需更新变异定义）：' + mutant.name)
    continue
  }
  const file = path.join(TMP_DIR, 'mutant-' + Math.abs(hashCode(mutant.name)) + '.js')
  fs.writeFileSync(file, original.replace(mutant.from, mutant.to), 'utf8')

  let caught = false
  let evidence = ''
  try {
    execFileSync(NODE, [TEST], {
      env: { ...process.env, TF_PLUGIN_ENTRY: file },
      encoding: 'utf8',
      stdio: 'pipe'
    })
  } catch (error) {
    caught = true
    evidence = String(error.stdout || '')
      .split('\n')
      .filter((line) => line.includes('失败明细') || line.trim().startsWith('- ['))
      .slice(0, 2)
      .map((line) => line.trim())
      .join(' | ')
  }
  if (!caught) missed += 1
  rows.push(
    (caught ? '✓ 被测试抓到' : '✗ 没被抓到（假安全！）') + ' :: ' + mutant.name + (evidence ? '\n      ' + evidence : '')
  )
}

function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

const lines = [
  '',
  '='.repeat(66),
  '变异测试：确认关键断言真的能抓到回归',
  '='.repeat(66),
  ...rows,
  '-'.repeat(66),
  missed
    ? '结果: ' + (MUTANTS.length - missed) + '/' + MUTANTS.length + ' 个变异被抓到，' + missed + ' 个漏网 ✗'
    : '结果: ' + MUTANTS.length + '/' + MUTANTS.length + ' 个变异全部被抓到 ✓',
  '='.repeat(66)
]

const report = lines.join('\n')
// 自己落盘：PowerShell 的重定向会按 OEM 代码页解码 stdout，中文会变成乱码
try {
  fs.writeFileSync(path.join(ROOT, '.workbuddy', 'tmp', 'tag-filter-mutate-report.txt'), report, 'utf8')
} catch (error) {
  void error
}
console.log(report)

// 注意：不要用 process.exit()，它会抢在 writeFileSync 落盘之前结束进程
process.exitCode = missed ? 1 : 0
