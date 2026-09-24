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
const SRC_CSS = path.join(ROOT, 'song-downloader', 'style.css')
const TEST = path.join(HERE, 'song-downloader.smoke.mjs')
const TMP_DIR = path.join(ROOT, '.workbuddy', 'tmp', 'sd-mutants')
const NODE = process.execPath

/** 每个变异：名字 + 「原文 → 改坏后」的替换对（必须能在原文里精确命中）
 *  file: 'js'（默认，插件主文件）| 'css'（样式：测试通过 SD_CSS_ENTRY 读副本） */
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
  },
  {
    name: '设置根节点又变成自带滚动（宿主弹窗里整页滚不动 —— 1.0.0 的真实 bug）',
    file: 'css',
    from: `.sd-settings {
  display: block;
  padding: 2px 0 10px;
}`,
    to: `.sd-settings {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  display: block;
  padding: 2px 0 10px;
}`
  },
  {
    name: '插件页不再自己滚（.plugin-page-host 有确定高度，内容会被裁掉）',
    file: 'css',
    from: `.sd-page {
  height: 100%;
  min-height: 0;
  overflow-y: auto;`,
    to: `.sd-page {
  min-height: 0;`
  },
  {
    name: '确认框被绕过（点下载直接开下，用户改不了音质/位置）',
    from: `    if (!state.settings.confirmBeforeDownload) {`,
    to: `    if (true) {`
  },
  {
    name: '确认框的音质选择被忽略（用设置里的旧值去下载）',
    from: `    const quality = dlg.quality
    const useHandle = dlg.destination === 'picker' ? saveHandleRef : null`,
    to: `    const quality = state.settings.quality
    const useHandle = dlg.destination === 'picker' ? saveHandleRef : null`
  },
  {
    name: '「记住这些选项」失效（勾了也不写回设置）',
    from: `    if (dlg.remember) {
      setSetting('quality', quality)`,
    to: `    if (false) {
      setSetting('quality', quality)`
  },
  {
    name: 'Esc 不关确认框',
    from: `    if (e.key === 'Escape') {
      if (typeof e.preventDefault === 'function') e.preventDefault()`,
    to: `    if (false) {
      if (typeof e.preventDefault === 'function') e.preventDefault()`
  },
  {
    name: '播放栏按钮不做去重（重复回调会挂出第二个按钮）',
    from: `    if (host.querySelector('.sd-bar-btn')) return`,
    to: `    if (false) return`
  },
  {
    name: '去掉播放栏重渲染兜底（宿主重渲一次按钮就永远消失）',
    from: `          barMutation = new MutationObserver(() => scheduleEnsureBarButton())`,
    to: `          barMutation = new MutationObserver(() => {})`
  },
  {
    name: '关掉播放栏开关时不卸载（按钮留在界面上，开关变成摆设）',
    from: `    barMountDispose = null
    if (typeof barObserveDispose === 'function') {`,
    to: `    barMountDispose = null
    if (false) {`
  },
  {
    name: '设置里切播放栏开关不生效',
    from: `    if (key === 'playerBarButton') applyPlayerBarButton(!!value)`,
    to: `    void (key === 'playerBarButton')`
  },
  {
    name: '不做安全验证兜底（风控时只会干巴巴报「本次请求需要验证」）',
    from: `  let res = await callLocalRoute(ctx, '/song/url', params, 'GET')
  let verifyError = ''
  const eventId = verificationEventId(res)`,
    to: `  let res = await callLocalRoute(ctx, '/song/url', params, 'GET')
  let verifyError = ''
  const eventId = ''`
  },
  {
    name: '验证判定过宽（成功响应里的 ssaCode 也弹验证窗）',
    from: `  if (errorCode !== 20028 && bizStatus !== 0) return ''`,
    to: `  if (false && errorCode !== 20028 && bizStatus !== 0) return ''`
  },
  {
    name: '每档音质都弹一次验证窗（flac/320/128 连弹三次）',
    from: `    if (verifyState && verifyState.done) {`,
    to: `    if (false) {`
  },
  {
    name: '验证失败也当成功继续（会把「没拿到地址」误判成可以下载）',
    from: `        if (!resolved.ok) {
          dlg.error = '解析失败：' + resolved.error + '（没有创建任何文件）'
          return
        }`,
    to: `        if (false) {
          dlg.error = ''
          return
        }`
  },
  {
    name: '「另存为…」先弹保存对话框再解析（失败就留下 0 KB 空文件 —— 用户报的真实问题）',
    from: `    if (!resolved.ok) {
      notice('解析失败：' + resolved.error + '（没有创建任何文件）')
      return null
    }`,
    to: `    if (false) {
      notice('')
      return null
    }`
  },
  {
    name: '失败/取消时不清理已建出来的空文件（0 KB 残骸留一地）',
    from: `      if (typeof handle.remove === 'function') {`,
    to: `      if (false) {`
  },
  {
    name: '失败任务不标记 needsVerify（界面不再提示去完成验证）',
    from: `      const needsVerify = !!(e && e.needsVerify)`,
    to: `      const needsVerify = false`
  },
  {
    name: '完全不复用宿主已解析地址（风控账号下永远下载不了正在播的歌）',
    from: `  const hostUsable = options.preferHostUrl !== false && host.current && host.allowed`,
    to: `  const hostUsable = false`
  },
  {
    name: '不校验「是不是当前曲目」就用缓存地址（会把旧曲目的地址当当前的用）',
    from: `  if (isCurrent && primary) {`,
    to: `  if (primary) {`
  },
  {
    name: '不比对音质（请求 FLAC 也拿宿主的 320K 地址糊弄）',
    from: `    out.allowed = hostQualityCovers(out.quality, preferredQuality)`,
    to: `    out.allowed = true`
  },
  {
    name: '归一化时丢掉 audioUrl（「上游失败 → 残留地址兜底」永远走不到 —— 真被测试抓到过）',
    from: `    audioUrl: str(raw.audioUrl),
    source: str(raw.source).toLowerCase(),`,
    to: `    audioUrl: '',
    source: str(raw.source).toLowerCase(),`
  },
  {
    name: '宿主地址失效后不回退到 /song/url（地址一过期就彻底失败）',
    from: `      if (!result.ok && !result.canceled && usedCached && !isCanceled()) {`,
    to: `      if (false) {`
  },
  {
    name: '上游全部失败时不用残留的宿主地址兜底',
    from: `  if (host.urls.length && !host.current) {`,
    to: `  if (false) {`
  }
]

const originals = { js: fs.readFileSync(SRC, 'utf8'), css: fs.readFileSync(SRC_CSS, 'utf8') }
fs.mkdirSync(TMP_DIR, { recursive: true })

const rows = []
let missed = 0
let skipped = 0

for (const mutant of MUTANTS) {
  const kind = mutant.file || 'js'
  const original = originals[kind]
  if (!original.includes(mutant.from)) {
    skipped += 1
    rows.push('⚠ 跳过（原文没命中，需更新变异定义）：' + mutant.name)
    continue
  }
  const patched = original.replace(mutant.from, mutant.to)
  if (patched === original) {
    skipped += 1
    rows.push('⚠ 跳过（替换后内容不变）：' + mutant.name)
    continue
  }
  const file = path.join(TMP_DIR, 'mutant-' + Math.abs(hashCode(mutant.name)) + (kind === 'css' ? '.css' : '.js'))
  fs.writeFileSync(file, patched, 'utf8')

  const env = { ...process.env, SD_REPORT: path.join(TMP_DIR, 'report-' + Math.abs(hashCode(mutant.name)) + '.txt') }
  if (kind === 'css') {
    // 样式变异走 SD_CSS_ENTRY（测试按这个路径读 CSS 副本），插件本体仍用真文件
    delete env.SD_PLUGIN_ENTRY
    env.SD_CSS_ENTRY = file
  } else {
    delete env.SD_CSS_ENTRY
    env.SD_PLUGIN_ENTRY = file
  }

  let caught = false
  let evidence = ''
  try {
    execFileSync(NODE, [TEST], { env, encoding: 'utf8', stdio: 'pipe' })
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
