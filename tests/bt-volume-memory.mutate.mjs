/**
 * 音量记忆 (bt-volume-memory) 变异测试（mutation check）
 * ---------------------------------------------------------------------------
 * 作用：把「已修好的关键行为」故意改回 bug 版本，确认无头集成测试真的会失败。
 * 如果改坏了测试还全绿，说明那条断言是无效的（假安全）。
 *
 * 用法： node tests/bt-volume-memory.mutate.mjs
 * 退出码：0 = 每个变异都被抓到；1 = 有变异没被抓到（说明断言要补）
 *
 * 依赖 tests/bt-volume-memory.smoke.mjs 支持 BVM_PLUGIN_ENTRY / BVM_REPORT_FILE。
 * 变异跑的冒烟报告写到 .workbuddy/tmp/bvm-mutants/ 下，不会覆盖正式报告。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'bt-volume-memory', 'index.js')
const TEST = path.join(HERE, 'bt-volume-memory.smoke.mjs')
const TMP_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'bvm-mutants')
const REPORT = path.join(ROOT, '.workbuddy', 'tmp', 'bt-volume-memory-mutate-report.txt')
const NODE = process.execPath

/**
 * 每个变异：名字 + 「原文 → 改坏后」。原文必须能在插件源码里精确命中。
 * 覆盖的都是**与 EarTrumpet 对齐的行为契约**和**真实踩过的坑**，不是随便挑几行。
 */
const MUTANTS = [
  {
    name: '音量 0 也能被记忆（蓝牙栈断开时打的 0 会被记住 → 还用户一副静音耳机）',
    from: 'const isUsableMemory = (v) => Number.isFinite(v) && v >= MIN_REMEMBERED && v <= MAX_REMEMBERED',
    to: 'const isUsableMemory = (v) => Number.isFinite(v) && v >= 0 && v <= MAX_REMEMBERED'
  },
  {
    name: '不设上限（坏数据被记下 → 下次重连炸到满音量）',
    from: 'const isUsableMemory = (v) => Number.isFinite(v) && v >= MIN_REMEMBERED && v <= MAX_REMEMBERED',
    to: 'const isUsableMemory = (v) => Number.isFinite(v) && v >= MIN_REMEMBERED'
  },
  {
    name: '去掉防抖（拖动滑条每步都落盘 + 每次都推配置）',
    from: 'function scheduleSave() {\n  if (saveTimer) clearTimeout(saveTimer)',
    to: 'function scheduleSave() {\n  persist()\n  if (saveTimer) clearTimeout(saveTimer)'
  },
  {
    name: '不看 announce（启动时已经连着的设备也弹浮层 → 每次开程序都弹）',
    from: '    if (ev.announce === true) showOsd({',
    to: '    if (true) showOsd({'
  },
  {
    name: '恢复后按“请求值”而不是“实际生效值”记账（端点 snap 后每次重连都要再修一次）',
    from: '    rememberVolume(ev.key, ev.appliedVolume, {',
    to: '    rememberVolume(ev.key, ev.rememberedVolume, {'
  },
  {
    name: '浮层不合并（A2DP + 免手持同时恢复时叠两层）',
    from: '  const coalesce = now - lastOsdAt < OSD_COALESCE_MS',
    to: '  const coalesce = false'
  },
  {
    name: '浮层不自动隐藏（贴在界面上不走了）',
    from: '  }, OSD_HIDE_MS)',
    to: '  }, 10)'
  },
  {
    name: '恢复后不立刻落盘（走防抖，用户马上关程序就丢）',
    from: '    persist()\n    await pushConfig()\n  } else if (learned) {',
    to: '    await pushConfig()\n  } else if (learned) {'
  },
  {
    name: '不处理 restoredEvents（重连恢复了却不告诉用户，记忆也不更新）',
    from: '  for (const ev of data.restoredEvents || []) {',
    to: '  for (const ev of []) {'
  },
  {
    name: 'token 不落盘（插件一重载就认不出自己的 helper → 重复拉起并留孤儿进程）',
    from: '      helperToken: S.helper.token',
    to: "      helperToken: ''"
  },
  {
    name: '停用时不去关 helper（宿主禁用插件不会杀子进程 → 留下幽灵进程）',
    from: "    await helperCall('/shutdown', { method: 'POST', timeoutMs: 1500 })",
    to: '    void 0'
  },
  {
    name: '用户取消授权后静默（不给文案也不给重试入口）',
    from: "        setHelperError('你取消了「允许插件启动本地程序」。音量记忆需要这个 helper 才能读写系统音频端点。')",
    to: '        void 0'
  },
  {
    name: '作用范围不下发（切到「所有输出设备」实际仍只处理蓝牙）',
    from: '        scope: S.scope,',
    to: "        scope: 'bth',"
  },
  {
    name: '设备列表只列在线设备（未连接的记录看不到，也没法「忘记」）',
    from: '        const keys = new Set([...Object.keys(S.memories), ...Object.keys(index)])',
    to: '        const keys = new Set([...Object.keys(index)])'
  },
  {
    name: '「忘记」不通知 helper（helper 侧记录残留 → 下次重连照样恢复，看起来像没生效）',
    from: "            await helperCall('/forget', { method: 'POST', form: { key } })",
    to: '            void 0'
  }
]

const original = fs.readFileSync(SRC, 'utf8')
fs.mkdirSync(TMP_DIR, { recursive: true })

function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

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
  fs.writeFileSync(file, original.replace(mutant.from, mutant.to), 'utf8')

  let caught = false
  let evidence = ''
  try {
    execFileSync(NODE, [TEST], {
      env: { ...process.env, BVM_PLUGIN_ENTRY: file, BVM_REPORT_FILE: path.join(TMP_DIR, 'mutant-smoke-report.txt') },
      encoding: 'utf8',
      stdio: 'pipe'
    })
  } catch (error) {
    caught = true
    evidence = String(error.stdout || '')
      .split('\n')
      .filter((line) => line.trim().startsWith('- ['))
      .slice(0, 2)
      .map((line) => line.trim())
      .join(' | ')
  }
  if (!caught) missed += 1
  rows.push(
    (caught ? '✓ 被测试抓到' : '✗ 没被抓到（假安全！）') + ' :: ' + mutant.name + (evidence ? '\n      ' + evidence : '')
  )
}

const lines = [
  '',
  '='.repeat(70),
  '音量记忆 变异测试：确认关键断言真的能抓到回归',
  '='.repeat(70),
  ...rows,
  '-'.repeat(70),
  missed
    ? '结果: ' + (MUTANTS.length - skipped - missed) + '/' + (MUTANTS.length - skipped) + ' 个变异被抓到，' + missed + ' 个漏网 ✗'
    : '结果: ' + (MUTANTS.length - skipped) + '/' + (MUTANTS.length - skipped) + ' 个变异全部被抓到 ✓' +
      (skipped ? '（另 ' + skipped + ' 个定义未命中）' : ''),
  '='.repeat(70)
]

const report = lines.join('\n')
// 自己落盘：PowerShell 的重定向会按 OEM 代码页解码 stdout，中文会变成乱码
try {
  fs.writeFileSync(REPORT, report, 'utf8')
} catch (error) {
  void error
}
console.log(report)

// 注意：不要用 process.exit()，它会抢在 writeFileSync 落盘之前结束进程
process.exitCode = missed ? 1 : 0
