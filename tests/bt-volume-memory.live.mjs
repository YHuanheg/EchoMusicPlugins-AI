/**
 * 音量记忆 (bt-volume-memory) 真机核验
 * ---------------------------------------------------------------------------
 * 无头冒烟测不了的东西：**宿主契约之外的那一层** —— 真的起 helper、真的读 Windows 音频端点、
 * 真的写音量、真的观察 COM 回调。这些只能在本机跑。
 *
 * 覆盖：
 *   §1 /ping 字段与身份签名
 *   §2 /endpoints 真实端点：记账键（尾部 GUID）、蓝牙判定、音量/静音
 *   §3 写入往返：读原值 → 写 → 回读 → 还原（`applied` 必须等于请求值或如实反映 snap）
 *   §4 自己写的音量**不该**产生 volumeEvent（防回写回声）
 *   §5 外部改音量**必须**被抓到（用 tests/live-tools/poke-volume 伪造一次用户操作）
 *   §6 重连恢复的完整契约（A–G，即 EarTrumpet 的行为契约）—— 走 --debug 的 /debug/reconnect
 *
 * 安全：只对**被静音**的端点做写入（听不见），并且每个端点结束时还原原音量与静音状态。
 *       没有静音端点时写入类用例会跳过并明确说明；设 BVM_LIVE_ALLOW_AUDIBLE=1 可强制在非静音端点上跑。
 *
 * 用法： node tests/bt-volume-memory.live.mjs [--allow-write]
 * 前置： bt-volume-memory/Host/VolumeHelper.exe 存在（先跑 Host/build.ps1）
 *        §5 需要 tests/live-tools/poke-volume 能编译（会自动 dotnet build，失败则跳过该用例）
 */

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HELPER = process.env.BVM_HELPER_EXE
  ? path.resolve(process.env.BVM_HELPER_EXE)
  : path.join(ROOT, 'bt-volume-memory', 'Host', 'VolumeHelper.exe')
const TMP = path.join(ROOT, '.workbuddy', 'tmp')
const REPORT = path.join(TMP, 'bt-volume-memory-live-report.txt')
const ALLOW_AUDIBLE = process.env.BVM_LIVE_ALLOW_AUDIBLE === '1' || process.argv.includes('--allow-audible')

const NODE = process.execPath
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const failures = []
const lines = []
let section = '(root)'
const say = (s) => lines.push(s)
function sec(name) {
  section = name
  say('')
  say('── ' + name)
}
function ok(cond, name, extra) {
  if (cond) {
    pass++
    say('  ✓ ' + name)
    return true
  }
  failures.push('[' + section + '] ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 240)))
  say('  ✗ ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 240)))
  return false
}
function eq(a, b, name) {
  return ok(a === b, name, { actual: a, expected: b })
}
function skip(name, why) {
  say('  – ' + name + '（跳过：' + why + '）')
}

say('音量记忆 真机核验')
say('helper: ' + HELPER)
say('时间: ' + new Date().toISOString())

if (process.platform !== 'win32') {
  say('')
  say('非 Windows 平台，跳过。')
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log('非 Windows，跳过')
  process.exitCode = 0
} else if (!fs.existsSync(HELPER)) {
  say('')
  say('找不到 helper：' + HELPER + '（先跑 bt-volume-memory/Host/build.ps1）')
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log('找不到 helper')
  process.exitCode = 2
} else {
  const PORT = Number(process.env.BVM_LIVE_PORT || 18989)
  const TOKEN = 'live-' + Date.now()
  const child = spawn(HELPER, ['--port', String(PORT), '--token', TOKEN, '--idle', '120', '--scope', 'all', '--debug'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const childLog = []
  child.stdout.on('data', (d) => childLog.push(String(d)))
  child.stderr.on('data', (d) => childLog.push(String(d)))

  async function api(p, init) {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(TOKEN)}`, {
      signal: AbortSignal.timeout(6000),
      ...init
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 由调用方断言 */
    }
    return { status: res.status, json, text }
  }
  const post = (p, body) =>
    api(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: typeof body === 'string' ? body : new URLSearchParams(body || {}).toString()
    })
  const events = async () => (await api('/events')).json || {}
  const config = async (form) => (await post('/config', form)).json || {}
  const endpoints = async () => ((await api('/endpoints')).json || {}).endpoints || []
  const volumeOf = async (key) => (await endpoints()).find((e) => e.key === key)?.volume

  let ping = null
  for (let i = 0; i < 60; i++) {
    try {
      const r = await api('/ping')
      if (r.json?.ok) {
        ping = r.json
        break
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(120)
  }

  /* ---------------------------------------------------------------- §1 */
  sec('§1 helper /ping')
  ok(!!ping, 'helper 能起来并响应 /ping')
  if (ping) {
    eq(ping.signature, 'volume-helper', '身份签名（插件靠它确认「这是本插件的 helper」）')
    eq(typeof ping.version, 'string', '带版本号')
    eq(ping.coreAudioOk, true, 'Core Audio 可用')
    eq(ping.coreAudioError, '', '没有 Core Audio 错误')
    eq(ping.scope, 'all', '作用范围=all')
    ok(Number.isInteger(ping.pid) && ping.pid > 0, '带进程 id')

    const noTok = await fetch(`http://127.0.0.1:${PORT}/ping`, { signal: AbortSignal.timeout(4000) })
    eq(noTok.status, 403, '不带令牌被拒 403')
    const badRoute = await api('/nope')
    eq(badRoute.status, 404, '未知路由 404')
  }

  /* ---------------------------------------------------------------- §2 */
  sec('§2 真实端点枚举')
  let eps = []
  if (ping) {
    const r = await api('/endpoints')
    eq(r.status, 200, '/endpoints 返回 200')
    eps = (r.json && r.json.endpoints) || []
    ok(eps.length >= 1, '至少枚举到一个输出端点', { count: eps.length })
    eq(r.json && r.json.count, eps.length, 'count 与实际条数一致')

    let keyOk = true
    let rangeOk = true
    let btOk = true
    for (const e of eps) {
      // 记账键必须是端点 id 最后一个 '.' 之后的部分（尾部 GUID）
      if (!e.id.endsWith(e.key)) keyOk = false
      if (!(Number.isInteger(e.volume) && e.volume >= 0 && e.volume <= 100)) rangeOk = false
      // 蓝牙判定 = 枚举器名以 BTH 开头
      if (e.isBluetooth !== /^BTH/i.test(e.enumerator)) btOk = false
      say(`      · [${e.isBluetooth ? 'BT' : '  '}] ${String(e.volume).padStart(3)}%${e.muted ? ' 静音' : '    '} ${e.enumerator.padEnd(10)} ${e.name}`)
      say(`        key=${e.key}`)
    }
    ok(keyOk, '记账键 = 端点 id 的尾部 GUID（适配器容器重建后记忆仍有效）')
    ok(rangeOk, '音量都在 0..100')
    ok(btOk, 'isBluetooth 与枚举器名 BTH* 一致')
  }

  /* ---------------------------------------------------------------- 选安全目标 */
  const safeTarget = ALLOW_AUDIBLE
    ? eps.find((e) => !e.isBluetooth) || eps[0]
    : eps.find((e) => e.muted) || null
  const safeNote = safeTarget
    ? `目标 ${safeTarget.name}（${safeTarget.muted ? '已静音，写入听不见' : '非蓝牙，且已开 ALLOW_AUDIBLE'}）`
    : ALLOW_AUDIBLE
      ? '没有可用端点'
      : '没有已静音的端点'

  /* ---------------------------------------------------------------- §3 */
  sec('§3 写入往返')
  let roundTripOk = false
  if (ping && safeTarget) {
    const original = safeTarget.volume
    const target = original === 37 ? 63 : 37
    const set = await post(`/set?key=${encodeURIComponent(safeTarget.key)}&volume=${target}`)
    eq(set.status, 200, 'POST /set 返回 200')
    eq(set.json && set.json.applied, target, 'applied 等于请求值（该端点不 snap）')
    await sleep(150)
    eq(await volumeOf(safeTarget.key), target, '再读一次确认真的写进去了')
    const back = await post(`/set?key=${encodeURIComponent(safeTarget.key)}&volume=${original}`)
    eq(back.json && back.json.applied, original, '还原成功')
    roundTripOk = true
    say('      ' + safeNote)
  } else {
    skip('写入往返', safeNote)
  }

  /* ---------------------------------------------------------------- §4 */
  sec('§4 自写过滤')
  if (ping && roundTripOk) {
    const ev = await events()
    eq((ev.volumeEvents || []).length, 0, '自己写的音量不产生 volumeEvent（否则恢复动作会被当成用户输入再写回去）')
  } else {
    skip('自写过滤', '需要先完成 §3')
  }

  /* ---------------------------------------------------------------- §5 */
  sec('§5 外部改音量侦测')
  if (ping && safeTarget) {
    /**
     * 跑子进程并拿到输出。
     * 本机实测：某些会话里给子进程**建管道**会直接 EBUSY（连 spawnSync(node, ['--version']) 都返回
     * error=EBUSY / status=null，而且 stderr 是空的，很难定位）。换成用**文件**当 stdio 就一切正常。
     * 同一处置见 skill 的 60-publishing.md（publish.mjs 的 captureNode）。
     */
    const runCaptured = (exe, args, timeoutMs = 180000) => {
      try {
        return execFileSync(exe, args, { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs })
      } catch (e) {
        if (!/EBUSY/i.test(String((e && (e.code || e.message)) || ''))) throw e
        fs.mkdirSync(TMP, { recursive: true })
        const logFile = path.join(TMP, 'subprocess-' + Date.now() + '.log')
        const fd = fs.openSync(logFile, 'w')
        try {
          execFileSync(exe, args, { stdio: ['ignore', fd, fd], timeout: timeoutMs })
        } finally {
          fs.closeSync(fd)
        }
        return fs.readFileSync(logFile, 'utf8')
      }
    }

    // 编译测试用的小工具（用随机 event context 改音量，模拟用户拖音量条）
    const pokeDir = path.join(HERE, 'live-tools', 'poke-volume')
    const pokeExe = path.join(TMP, 'poke-bin', 'Release', 'net462', 'PokeVolume.exe')
    let pokeReady = fs.existsSync(pokeExe)
    if (!pokeReady && fs.existsSync(path.join(pokeDir, 'PokeVolume.csproj'))) {
      try {
        runCaptured('dotnet', [
          'build',
          path.join(pokeDir, 'PokeVolume.csproj'),
          '-c', 'Release', '--nologo', '-v', 'quiet',
          '-p:BaseIntermediateOutputPath=' + path.join(TMP, 'poke-obj') + path.sep,
          '-p:BaseOutputPath=' + path.join(TMP, 'poke-bin') + path.sep
        ])
        pokeReady = fs.existsSync(pokeExe)
      } catch (e) {
        say('      （poke-volume 编译失败：' + String((e && e.message) || e).slice(0, 120) + '）')
      }
    }

    if (!pokeReady) {
      skip('外部改音量侦测', '无法准备 tests/live-tools/poke-volume（需要 dotnet SDK）')
    } else {
      const original = safeTarget.volume
      const poked = original === 42 ? 58 : 42
      await events() // 清空历史事件
      let out = ''
      try {
        out = runCaptured(pokeExe, ['--id', safeTarget.id, '--volume', String(poked)], 20000)
      } catch (e) {
        out = 'ERROR ' + String((e && e.message) || e).slice(0, 120)
      }
      say('      poke: ' + out.trim().replace(/\s+/g, ' ').slice(0, 160))
      let got = null
      for (let i = 0; i < 20; i++) {
        const ev = await events()
        const hit = (ev.volumeEvents || []).find((e) => e.key === safeTarget.key && e.volume === poked)
        if (hit) {
          got = hit
          break
        }
        await sleep(120)
      }
      ok(!!got, '外部改音量被侦测到（COM 回调 → 入队 → /events）', got)
      await post(`/set?key=${encodeURIComponent(safeTarget.key)}&volume=${original}`)
      eq(await volumeOf(safeTarget.key), original, '还原原音量')
    }
  } else {
    skip('外部改音量侦测', safeNote)
  }

  /* ---------------------------------------------------------------- §6 */
  sec('§6 重连恢复契约（EarTrumpet 行为对齐）')
  if (ping && safeTarget) {
    const KEY = safeTarget.key
    const ID = safeTarget.id
    const ORIGINAL = safeTarget.volume
    const A = ORIGINAL === 33 ? 44 : 33

    const reconnect = async () => (await post(`/debug/reconnect?id=${encodeURIComponent(ID)}`)).json

    // A. 无记忆 → 不恢复、不报（对应「首次连接不弹」）
    await events()
    await config({ enabled: '1', scope: 'all', mems: '', memReset: '1' })
    await reconnect()
    await sleep(200)
    let ev = await events()
    eq((ev.restoredEvents || []).length, 0, 'A. 无记忆时的重连不产生恢复事件（首次连接不弹）')
    eq(await volumeOf(KEY), ORIGINAL, 'A. 音量不变')

    // B. 有记忆 → 写回 + announce
    const cfg = await config({ enabled: '1', scope: 'all', mems: `${KEY}:${A}` })
    eq(cfg.memoryCount, 1, 'B. 记忆表被 helper 接收')
    await events()
    await reconnect()
    await sleep(200)
    ev = await events()
    const r1 = (ev.restoredEvents || [])[0]
    ok(!!r1, 'B. 报出 restored 事件', ev.restoredEvents)
    if (r1) {
      eq(r1.announce, true, 'B. announce=true（重连才弹）')
      eq(r1.rememberedVolume, A, 'B. rememberedVolume 正确')
      eq(r1.previousVolume, ORIGINAL, 'B. previousVolume = 重连时的值')
      eq(r1.appliedVolume, A, 'B. appliedVolume 正确')
      ok(typeof r1.name === 'string' && r1.name.length > 0, 'B. 带了设备名（浮层要用）')
    }
    eq(await volumeOf(KEY), A, 'B. 音量真的被写回')

    // C. 记忆值 == 当前值 → 仍然报（浮层是用户知道「现在几格」的唯一途径）
    await events()
    await reconnect()
    await sleep(200)
    ev = await events()
    const r2 = (ev.restoredEvents || [])[0]
    ok(!!r2, 'C. 相等时仍然报恢复事件')
    if (r2) eq(r2.appliedVolume, r2.previousVolume, 'C. applied == previous')

    // D. 开关关闭 → 不恢复、不报
    await config({ enabled: '0', scope: 'all', mems: `${KEY}:${A}` })
    await post(`/set?key=${encodeURIComponent(KEY)}&volume=${ORIGINAL}`)
    await events()
    await reconnect()
    await sleep(200)
    ev = await events()
    eq((ev.restoredEvents || []).length, 0, 'D. 关掉总开关后不恢复也不报')
    eq(await volumeOf(KEY), ORIGINAL, 'D. 关掉后音量没被写回')

    // E. scope=bth 时非蓝牙端点不参与
    if (!safeTarget.isBluetooth) {
      await config({ enabled: '1', scope: 'bth', mems: `${KEY}:${A}` })
      await events()
      await reconnect()
      await sleep(200)
      ev = await events()
      eq((ev.restoredEvents || []).length, 0, 'E. scope=bth 时非蓝牙端点不参与恢复')
      eq((await api('/ping')).json.scope, 'bth', 'E. /ping 反映当前作用范围')
    } else {
      skip('E. 作用范围过滤', '安全目标是蓝牙端点，无法用它验证「非蓝牙被过滤」')
    }

    // F. /forget 之后不再恢复
    await config({ enabled: '1', scope: 'all', mems: `${KEY}:${A}` })
    const f = await post(`/forget?key=${encodeURIComponent(KEY)}`)
    eq(f.json && f.json.removed, true, 'F. /forget 生效')
    await events()
    await reconnect()
    await sleep(200)
    ev = await events()
    eq((ev.restoredEvents || []).length, 0, 'F. 忘记之后的重连不恢复')

    // G. 越界记忆值不算用户选择
    const g0 = await config({ enabled: '1', scope: 'all', mems: `${KEY}:0`, memReset: '1' })
    eq(g0.memoryCount, 0, 'G. mems=0 不入表（蓝牙栈断开时会打出 0）')
    const g1 = await config({ enabled: '1', scope: 'all', mems: `${KEY}:101`, memReset: '1' })
    eq(g1.memoryCount, 0, 'G. mems=101 不入表')
    await events()
    await reconnect()
    await sleep(200)
    ev = await events()
    eq((ev.restoredEvents || []).length, 0, 'G. 越界值不产生恢复事件')

    // H. 坏条目被计数而不是静默吞掉
    const h = await config({ enabled: '1', scope: 'all', memReset: '1', mems: `nonsense;${KEY}:abc;${KEY}:${A}` })
    eq(h.badEntries, 2, 'H. malformed 记忆条目被计数（不静默吞）')
    eq(h.memoryCount, 1, 'H. 同批里的合法条目仍然入表')

    // 收尾还原
    await config({ enabled: '1', scope: 'all', mems: '', memReset: '1' })
    await post(`/set?key=${encodeURIComponent(KEY)}&volume=${ORIGINAL}`)
    eq(await volumeOf(KEY), ORIGINAL, '收尾：原音量已还原')
    say('      ' + safeNote)
  } else {
    skip('重连恢复契约', safeNote)
  }

  /* ---------------------------------------------------------------- 收尾 */
  sec('收尾')
  await post('/shutdown')
  const code = await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000).then(() => 'TIMEOUT')])
  eq(code, 0, 'POST /shutdown 后 helper 干净退出（exit 0）')
  if (code === 'TIMEOUT') child.kill()

  say('')
  const total = pass + failures.length
  say(total ? `${pass}/${total} 通过${failures.length ? `，${failures.length} 项失败` : ''}` : '没有执行任何用例')
  if (failures.length) {
    say('')
    say('失败明细：')
    for (const f of failures) say('  - ' + f)
  }

  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log(`${pass}/${total} 通过，失败 ${failures.length}`)
  if (failures.length) console.log(failures.join('\n'))
  process.exitCode = failures.length ? 1 : 0
}
