// kugou-daily-vip v1.0.0 —— 酷狗概念版「每日自动领取 VIP」
//
// 架构（与 auto-team-vip 同源，入口同为软件顶部 ⭐）：
//   - 宿主内置了 KuGouMusicApi 本地服务（resources/server/module/*.js），
//     路由规则 = 模块文件名去掉 .js 后把 "_" 换成 "/"：
//       youth_listen_song.js → /youth/listen/song
//       youth_vip.js         → /youth/vip
//       youth_day_vip.js     → /youth/day/vip
//       user_vip_detail.js   → /user/vip/detail
//     签名（lite 盐值）、设备指纹（dfid/mid/webgl）、RSA/AES 加密全部由宿主完成，
//     插件只负责「编排 + 展示」，不重复实现任何加密逻辑。
//   - 插件通过 ctx.electron.api.request 走宿主 IPC（api:request）。该通道把
//     headers.Authorization 按 "k=v; k=v" 解析成 cookie 注入本地服务，
//     因此鉴权只需拼出 token/userid（dfid/t1 有则带上）。
//   - 宿主原生认证包装器不做验证码兜底，所以按 auto-team-vip 的成熟做法自己处理
//     ssaCode/eventId → ctx.kugouVerification.request() → 重试一次。
//
// 领取链路（每一步都幂等，重复调用只会得到「今日已领取」）：
//   ① GUARD   登录态
//   ② RECORD  本月领取记录（只读）
//   ③ LISTEN  /youth/listen/song            听歌领取 1 天   error 130012 = 今日已领
//   ④ AD      /youth/vip  × N（默认 30s 间隔）每次 1 天     error 30002  = 次数用光
//   ⑤ DAYVIP  /youth/day/vip?receive_day=… 天天签到领 1 天  error 131001 = 今日已领
//   ⑥ UPGRADE /youth/day/vip/upgrade        升级概念版 VIP（可选，默认关）
//   ⑦ VERIFY  /user/vip/detail              读取 VIP 到期时间
//   ⑧ PERSIST 写入当日记录 + 历史（驱动跨天自动补领）

const ROUTE = {
  detail: "/user/detail",
  monthRecord: "/youth/month/vip/record",
  listenSong: "/youth/listen/song",
  adVip: "/youth/vip",
  dayVip: "/youth/day/vip",
  dayVipUpgrade: "/youth/day/vip/upgrade",
  vipDetail: "/user/vip/detail",
};

// 酷狗业务错误码（概念版活动实测 + 社区已知值）
const ERR = {
  notLogin: [51002, 20018], // 未登录 / token 失效
  alreadyListen: 130012, // 听歌领取：今日已领取
  alreadyDayVip: 131001, // 天天签到：今日已领取
  adExhausted: 30002, // 广告领取：今日次数已用光
  risk: 20028, // 账号风控，需要安全验证
};

const TICK_MS = 30_000; // 跨天巡检周期（纯本地判断，不发请求）
const STARTUP_DELAY_MS = 6_000; // 启动首查延迟（等 pinia 设备信息就绪）
const LOGIN_DELAY_MS = 4_000; // 登录后首查延迟
const MANUAL_COOLDOWN_MS = 60_000; // 手动领取节流
const MIN_RUN_GAP_MS = 15_000; // 两次完整流程之间的最小间隔
const REFRESH_THROTTLE_MS = 3_000; // 「刷新」按钮节流
const MAX_HISTORY = 14;

const DEFAULT_SETTINGS = {
  autoDaily: true, // 每日自动领取（跨天补领）
  listenSong: true, // 听歌领取
  adVip: true, // 广告领取
  adCount: 8, // 广告领取次数上限
  adIntervalSec: 30, // 广告领取间隔（秒）
  dayVip: true, // 天天签到领取
  autoUpgrade: false, // 领取后自动升级概念版 VIP
  toastOnDone: true, // 完成时弹提示
  receiveDayFormat: "auto", // auto | day | date —— 签到 receive_day 的取值形态
};

let PLUGIN_VERSION = "0.0.0";

const _DEBUG = false;
function dlog(...args) {
  if (_DEBUG) console.log("[kugou-daily-vip]", ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// ---------- 北京时间 ----------

function beijingNow() {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60_000 + 8 * 3_600_000);
}

function beijingDateKey() {
  const d = beijingNow();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function beijingDay() {
  return beijingNow().getDate();
}

// ---------- 运行期状态 ----------

let uiState = null;
let runChain = null;
let running = false;
let abortRequested = false;
let lastRunStartedAt = 0;
let lastManualAt = 0;
let tickTimer = null;
let stopTokenWatch = null;
let startupTimers = [];
let dialogOpen = null;
let cssDispose = null;
let teleportDispose = null;
let toolbarDispose = null;
let settingsReady = null;

// ---------- 通用小工具 ----------

function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== "object") return fallback;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

// 深度查找第一个满足 key 的标量值（酷狗活动接口字段名漂移频繁，用这个兜底）。
// 注意：对外只暴露两个参数——内部递归深度不开放给调用方，避免误当 fallback 传进来。
function deepFind(obj, keys) {
  return deepFindAt(obj, keys, 0);
}

function deepFindAt(obj, keys, depth) {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  if (!Array.isArray(obj)) {
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== "" && typeof value !== "object") return value;
    }
  }
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  for (const value of values) {
    const found = deepFindAt(value, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function deepFindArray(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  for (const value of values) {
    const found = deepFindArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// 把宿主返回的 { status, body } 归一成业务判定。
// 宿主把上游业务错误统一映射成 HTTP 502 + 顶层 error_code，且不会抛异常；
// 但也见过正常 HTTP 200 却 body.status=0 的包法，所以两者都认。
function normalizeResponse(reply) {
  const body = reply?.body;
  const status = Number(pick(body, ["status"], NaN));
  const errorCode = Number(pick(body, ["error_code", "errcode", "code"], 0));
  // 话术字段名各接口不统一（error_msg / error_message / msg / message / error / err_msg）
  const message = String(pick(body, ["error_msg", "msg", "message", "error", "err_msg", "error_message"], ""));
  return { ok: status === 1, errorCode, message, body };
}

// 活动奖池已空 / 已达上限 / 该权益不可再升 这类「不是错误但拿不到东西」的返回。
// 真机实测升级接口会答「无法升级奖励」——这是活动侧的常态，不该把整轮判成失败。
function isNoQuotaReply(code, message) {
  const text = String(message || "");
  if (/已用光|已领完|已抢完|已发放完|次数已用完|已达到上限|已达上限|上限|没有可领取|暂无可领取/.test(text)) return true;
  if (/无法升级|不可升级|升级失败|无升级|不支持升级|已升级|已是最新|已是最高/.test(text)) return true;
  // 常见「库存/上限」类错误码（含广告次数用光 30002）
  return [30002, 30003, 30004, 30005, 30006, 30007, 30008].includes(Number(code));
}

// 从 /user/vip/detail 的 data.busi_vip[] 里挑出真正要看的那条到期时间。
// 真机返回是一个数组，同时含 svip / tvip 等多条业务线，且顶层 vip_end_time 为空串——
// 靠深度优先碰运气会「恰好正确但语义不明」，所以这里显式按业务线挑。
function pickVipEntry(body) {
  const list = deepFindArray(body);
  const items = Array.isArray(list) ? list.filter((it) => it && typeof it === "object") : [];
  const read = (it) =>
    String(pick(it, ["vip_end_time", "end_time", "vipEndTime", "expire_time", "endTime"], "")).trim();

  const score = (it) => {
    const type = String(pick(it, ["product_type", "busi_type", "type", "vip_type", "product_name"], "")).toLowerCase();
    const name = String(pick(it, ["vip_name", "busi_vip_name", "name", "product_name"], ""));
    // 畅听 / 概念版优先；tvip（听书等其它权益）降权
    if (/concept|youth|lite|concept_vip/.test(type)) return 0;
    if (/tvip|listen_book|book|audiobook/.test(type)) return 3;
    if (/svip/.test(type)) return 1;
    if (/svip|超级|畅听|概念/.test(name)) return 1;
    return 2;
  };

  const sorted = items
    .filter((it) => read(it))
    .map((it, i) => ({ it, i, s: score(it) }))
    .sort((a, b) => (a.s - b.s) || (a.i - b.i));

  const main = sorted[0];
  const others = sorted.slice(1).map((x) => ({ name: String(pick(x.it, ["vip_name", "busi_vip_name", "name"], "")) || "其它权益", endTime: read(x.it) }));

  if (main) {
    return {
      endTime: read(main.it),
      level: String(pick(main.it, ["vip_name", "busi_vip_name", "name"], "")),
      others,
    };
  }
  // 数组形态没命中就退回旧的深度查找（老版本宿主可能是扁平结构）
  return {
    endTime: String(deepFind(body, ["vip_end_time", "end_time", "vipEndTime"]) || ""),
    level: String(deepFind(body, ["vip_name", "vip_level_name", "busi_vip_name"]) || ""),
    others: [],
  };
}

// 从 /youth/month/vip/record 的 data.list[] 里取出「已领取的日期」。
// 真机字段是 day: "2026-06-20"（**完整日期字符串**，不是日号），早期实现用
// Number("2026-06-20") → NaN → 全部被过滤掉，界面上就显示成 "-"。
function normalizeRecordDay(value) {
  if (value === undefined || value === null || value === "") return "";
  const text = String(value).trim();
  if (!text) return "";
  // 完整日期：>=8 位的 yyyy-MM-dd / yyyy/MM/dd / yyyyMMdd
  const full = text.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/);
  if (full) return `${full[1]}-${pad2(Number(full[2]))}-${pad2(Number(full[3]))}`;
  // 纯日号：2026-06-20 之外的 1~2 位
  if (/^\d{1,2}$/.test(text)) return text;
  // 时间戳（毫秒 / 秒）
  if (/^\d{10,13}$/.test(text)) {
    const ms = text.length === 13 ? Number(text) : Number(text) * 1000;
    const d = new Date(ms + new Date(ms).getTimezoneOffset() * 60_000 + 8 * 3_600_000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return text.slice(0, 10);
}

function isNotLogin(code) {
  return ERR.notLogin.includes(Number(code));
}

// ---------- 鉴权 ----------

// 宿主暴露的是 pinia 状态 ref（`ctx.pinia.state.value`）。这里对「ref 形态」与
// 「直接是对象」两种宿主实现都做兼容，避免宿主内部结构调整时插件整体失效。
function piniaState(ctx) {
  const state = ctx.pinia?.state;
  if (!state) return null;
  return state.value !== undefined ? state.value : state;
}

function readAuth(ctx) {
  const root = piniaState(ctx);
  if (!root) return null;
  const u = root.user?.info;
  const d = root.device?.info;
  if (!u?.token || !u?.userid) return null;
  return {
    token: u.token,
    userid: u.userid,
    nickname: String(pick(u, ["nickname", "name"], "")),
    t1: pick(u, ["t1"], ""),
    dfid: pick(d, ["dfid"], ""),
    mid: pick(d, ["mid"], ""),
    uuid: pick(d, ["uuid"], ""),
    guid: pick(d, ["guid"], ""),
    serverDev: pick(d, ["serverDev"], ""),
    mac: pick(d, ["mac"], ""),
  };
}

function buildAuthHeader(auth) {
  const parts = [];
  if (auth.token) parts.push(`token=${auth.token}`);
  if (auth.userid) parts.push(`userid=${auth.userid}`);
  if (auth.t1) parts.push(`t1=${auth.t1}`);
  if (auth.dfid) parts.push(`dfid=${auth.dfid}`);
  if (auth.mid) parts.push(`KUGOU_API_MID=${auth.mid}`);
  if (auth.uuid) parts.push(`uuid=${auth.uuid}`);
  if (auth.guid) parts.push(`KUGOU_API_GUID=${auth.guid}`);
  if (auth.serverDev) parts.push(`KUGOU_API_DEV=${auth.serverDev}`);
  if (auth.mac) parts.push(`KUGOU_API_MAC=${auth.mac}`);
  return parts.join(";");
}

// ---------- 酷狗请求（含安全验证兜底） ----------

async function kgRequest(ctx, method, url, params, data) {
  if (typeof ctx.electron?.api?.request !== "function") {
    return { ok: false, error: "宿主未提供酷狗接口通道（electron.api.request）" };
  }
  const auth = readAuth(ctx);
  if (!auth) return { ok: false, error: "not_logged_in" };

  const config = {
    method,
    url,
    params: params || {},
    headers: { Authorization: buildAuthHeader(auth) },
  };
  if (data !== undefined && data !== null) config.data = data;

  dlog("[请求]", method, url, params);

  let res;
  try {
    res = await ctx.electron.api.request(config);
  } catch (e) {
    dlog("[异常]", url, String(e?.message || e));
    return { ok: false, error: String(e?.message || e) };
  }

  const body = res?.body;
  const eventId = pick(body, ["ssaCode", "eventId"], "") || pick(res?.headers, ["ssa-code", "SSA-CODE"], "");
  const errorCode = Number(pick(body, ["error_code", "errcode", "code"], 0));
  const failed = Number(pick(body, ["status"], 1)) === 0;

  // 需要安全验证（验证码 / 滑块）：交给宿主内置的酷狗验证组件，通过后重试一次。
  // 20028（风控）显式触发；其余失败只要带 eventId 也试一次，不通过只是白跑一趟。
  if (eventId && (errorCode === ERR.risk || failed)) {
    dlog("[需验证]", url, "eventId:", eventId, "errorCode:", errorCode);
    try {
      const verified = await ctx.kugouVerification.request(eventId);
      dlog("[验证结果]", verified);
      if (verified?.ok) {
        res = await ctx.electron.api.request(config);
        dlog("[重试]", url, "status:", res?.status);
      } else {
        return { ok: false, error: "账号需要安全验证，请在弹窗中完成验证后重试", body };
      }
    } catch (e) {
      console.warn("[kugou-daily-vip] verification failed:", e);
    }
  }

  return { ok: true, httpStatus: res?.status, body, headers: res?.headers };
}

// ---------- 只读查询 ----------

async function fetchUserDetail(ctx) {
  const r = await kgRequest(ctx, "GET", ROUTE.detail);
  if (!r.ok) return { ok: false, error: r.error };
  const n = normalizeResponse(r);
  // token 失效时服务端返回 status 0 / error_code 20018（未登录）或 51002，
  // 以此判定登录态；nickname 只用于展示，不能作为唯一判据（账号可能没设昵称）。
  if (!n.ok) {
    if (isNotLogin(n.errorCode)) return { ok: false, error: "登录已过期，请重新登录" };
    return { ok: false, error: n.message || "读取账号信息失败" };
  }
  return { ok: true, nickname: String(deepFind(r.body, ["nickname", "nick_name"]) || "") || "已登录账号" };
}

async function fetchVipDetail(ctx) {
  const r = await kgRequest(ctx, "GET", ROUTE.vipDetail);
  if (!r.ok) return { ok: false, error: r.error };
  const picked = pickVipEntry(r.body);
  return {
    ok: true,
    endTime: picked.endTime,
    level: picked.level,
    others: picked.others,
    raw: r.body,
  };
}

async function fetchMonthRecord(ctx) {
  const r = await kgRequest(ctx, "GET", ROUTE.monthRecord, { latest_limit: 100 });
  if (!r.ok) return { ok: false, error: r.error };
  const list = deepFindArray(r.body) || [];
  const seen = new Set();
  for (const item of list) {
    const raw = typeof item === "object" && item !== null
      ? deepFind(item, ["day", "receive_day", "vip_day", "date", "receive_date", "claim_date"])
      : item;
    const day = normalizeRecordDay(raw);
    if (day) seen.add(day);
  }
  const days = [...seen].sort();
  return { ok: true, count: list.length, days, raw: r.body };
}

// ---------- 领取步骤 ----------

// ③ 听歌领取（1 天）
async function stepListen(ctx) {
  const r = await kgRequest(ctx, "GET", ROUTE.listenSong);
  if (!r.ok) return { state: "fail", message: r.error || "请求失败" };
  const n = normalizeResponse(r);
  if (n.ok) return { state: "ok", message: "听歌领取成功 +1 天" };
  if (n.errorCode === ERR.alreadyListen) return { state: "already", message: "今日已领取（听歌）" };
  if (isNotLogin(n.errorCode)) return { state: "fail", message: "登录已过期，请重新登录", fatal: true };
  return {
    state: "fail",
    message: n.message || `听歌领取失败（error_code=${n.errorCode || "未知"}）`,
    body: n.body,
  };
}

// ④ 广告领取（每次 1 天，间隔可配，最多 8 次）
//
// 等待阶段是整条链路里最长的部分（默认 8 次 × 30s ≈ 3.5 分钟），期间界面上
// 如果只有一句静态文案，用户既不知道还剩多久、也不知道插件是不是卡死了。
// 所以这里把等待拆成可观测的倒计时：每 500ms 上报一次「还剩几秒」，
// 面板据此渲染「等待 24s」并画出进度条。
//
// 节奏说明（真机校正）：前一次的等待与下一次的请求是**并行**的——
// 发完第 i 次请求起就开始倒计时，倒计时结束正好发第 i+1 次请求。
// 早期实现是「请求 → 阻塞等 30s → 请求」，白等一个间隔，整轮凭空多花 30s。
//
// onProgress 载荷：
//   { phase:'wait', index, nextIndex, total, claimed, waitTotal, waitRemain }  等待下一轮
//   { phase:'claim', index, total, claimed }                                   发请求
//   { phase:'done', claimed, attempts, message, noQuota }                      收尾
async function stepAd(ctx, settings, onProgress, waitFn = sleepAbortable) {
  const total = Math.min(8, Math.max(1, Math.round(Number(settings.adCount) || 8)));
  const gapMs = Math.max(0, Math.round(Number(settings.adIntervalSec) || 0) * 1000);
  let claimed = 0;
  let attempts = 0;
  let message = "";
  let noQuota = false;

  const emit = (payload) => {
    if (typeof onProgress === "function") onProgress(payload);
  };

  for (let i = 1; i <= total; i++) {
    if (abortRequested) {
      message = `已手动停止（广告 ${claimed} 次）`;
      break;
    }
    attempts = i;
    emit({ phase: "claim", index: i, total, claimed });

    const r = await kgRequest(ctx, "GET", ROUTE.adVip);
    if (!r.ok) {
      message = r.error || "请求失败";
      break;
    }
    const n = normalizeResponse(r);
    if (n.ok) {
      claimed += 1;
      message = `广告领取 ${claimed} 次（+${claimed} 天）`;
    } else if (n.errorCode === ERR.adExhausted || isNoQuotaReply(n.errorCode, n.message)) {
      // 「今日次数已用光」是正常终点，不是失败
      noQuota = true;
      message = claimed > 0
        ? `广告领取 ${claimed} 次（${n.message || "次数已用光"}）`
        : `今日广告${n.message || "次数已用光"}`;
      break;
    } else if (isNotLogin(n.errorCode)) {
      return { state: "fail", claimed, attempts, message: "登录已过期，请重新登录", fatal: true };
    } else {
      message = n.message || `广告领取失败（error_code=${n.errorCode || "未知"}）`;
      break;
    }

    // 次数未用满且还有下一轮 → 立即进入倒计时
    if (i < total) {
      emit({
        phase: "wait",
        index: i,
        nextIndex: i + 1,
        total,
        claimed,
        waitTotal: gapMs,
        waitRemain: gapMs,
      });
      const finished = await waitFn(gapMs, (remainMs) => {
        emit({
          phase: "wait",
          index: i,
          nextIndex: i + 1,
          total,
          claimed,
          waitTotal: gapMs,
          waitRemain: remainMs,
        });
      });
      if (!finished) {
        message = `已手动停止（广告 ${claimed} 次）`;
        break;
      }
    }
  }

  emit({ phase: "done", claimed, attempts, total, message, noQuota });
  if (claimed > 0) return { state: "ok", claimed, attempts, message, noQuota };
  if (noQuota) return { state: "already", claimed, attempts, message, noQuota };
  if (!message) message = "未领取到广告 VIP";
  return { state: "fail", claimed, attempts, message };
}

// 可中断、可观测的等待：每 500ms 回调一次剩余毫秒数。
async function sleepAbortable(ms, onTick) {
  if (ms <= 0) return !abortRequested;
  const step = 500;
  let waited = 0;
  while (waited < ms) {
    if (abortRequested) return false;
    const chunk = Math.min(step, ms - waited);
    await sleep(chunk);
    waited += chunk;
    if (typeof onTick === "function") onTick(Math.max(0, ms - waited));
  }
  return !abortRequested;
}

// 倒计时文案（步骤行里复用的短格式）
function formatWait(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${pad2(s)}` : `${s}s`;
}

// ⑤ 天天签到领取（1 天）
// receive_day 官方未公开文档（「日号」与「完整日期」两种说法都有），因此按
// 「先按设置试 → 报错提到日期就换另一种 → 记住成功的那种」自校准。
async function stepDayVip(ctx, settings) {
  const stored = await ctx.storage.get("receiveDayFormat");
  const preferred = pick(settings, ["receiveDayFormat"], "auto");
  const order =
    preferred === "day"
      ? ["day", "date"]
      : preferred === "date"
        ? ["date", "day"]
        : stored === "date"
          ? ["date", "day"]
          : ["day", "date"];

  const attempts = [];
  for (const format of order) {
    const receiveDay = format === "date" ? beijingDateKey() : beijingDay();
    const r = await kgRequest(ctx, "GET", ROUTE.dayVip, { receive_day: receiveDay });
    if (!r.ok) return { state: "fail", message: r.error || "请求失败", attempts };
    const n = normalizeResponse(r);
    if (n.ok) {
      await ctx.storage.set("receiveDayFormat", format);
      return { state: "ok", message: `签到领取成功 +1 天（receive_day=${receiveDay}）`, attempts };
    }
    if (n.errorCode === ERR.alreadyDayVip) {
      await ctx.storage.set("receiveDayFormat", format);
      return { state: "already", message: "今日已领取（签到）", attempts };
    }
    if (isNotLogin(n.errorCode)) {
      return { state: "fail", message: "登录已过期，请重新登录", fatal: true, attempts };
    }
    attempts.push({ format, receiveDay, errorCode: n.errorCode, message: n.message });
    // 只有错误与「日期」有关时才换形态重试，避免把真正的业务错误重跑一遍
    if (!/日期|day|date/i.test(n.message)) break;
  }
  const last = attempts[attempts.length - 1];
  return {
    state: "fail",
    message: last?.message || `签到领取失败（error_code=${last?.errorCode || "未知"}）`,
    attempts,
  };
}

// ⑥ 升级概念版 VIP
//
// 真机实测：活动期已过 / 今天已经升过 / 本期无升级额度时，接口会答
// 「无法升级奖励」这类业务拒绝。这既不是登录问题也不是插件故障，
// 更不该把整轮领取判成「部分失败」，所以统一归到 state:'skip'（中性展示）。
async function stepUpgrade(ctx) {
  const r = await kgRequest(ctx, "GET", ROUTE.dayVipUpgrade);
  if (!r.ok) return { state: "fail", message: r.error || "请求失败" };
  const n = normalizeResponse(r);
  if (n.ok) return { state: "ok", message: "已升级概念版 VIP" };
  if (isNotLogin(n.errorCode)) {
    return { state: "fail", message: "登录已过期，请重新登录", fatal: true };
  }
  if (isNoQuotaReply(n.errorCode, n.message)) {
    return {
      state: "skip",
      neutral: true,
      message: `暂无升级额度（${n.message || "无法升级奖励"}）`,
      errorCode: n.errorCode,
    };
  }
  return {
    state: "fail",
    message: n.message || `升级失败（error_code=${n.errorCode || "未知"}）`,
    errorCode: n.errorCode,
  };
}

// ---------- uiState 同步 ----------

function setStage(text) {
  if (uiState) uiState.stage = text || "";
}

function setError(message, code, detail) {
  if (!uiState) return;
  uiState.lastMessage = message;
  uiState.lastError = code ? { code, message, detail: detail || {} } : null;
}

function setAdProgress(patch) {
  if (!uiState) return;
  const base = uiState.ad || emptyAdProgress();
  uiState.ad = { ...base, ...patch };
}

function resetAdProgress() {
  if (!uiState) return;
  uiState.ad = emptyAdProgress();
}

function emptySteps() {
  return {
    listen: { state: "idle", text: "待领取" },
    ad: { state: "idle", text: "待领取" },
    dayVip: { state: "idle", text: "待领取" },
    upgrade: { state: "idle", text: "待领取" },
  };
}

function makeTodayRecord(dateKey, nickname) {
  return {
    dateKey,
    at: Date.now(),
    listen: "idle",
    listenText: "",
    adClaimed: 0,
    adText: "",
    adNoQuota: false,
    dayVip: "idle",
    dayVipText: "",
    upgrade: "idle",
    upgradeText: "",
    vipExpire: "",
    vipOthers: [],
    nickname: nickname || "",
    message: "",
  };
}

// 广告步骤的实时进度（含倒计时）。null 表示当前没有广告流程在跑。
function emptyAdProgress() {
  return {
    phase: "idle", // idle | claim | wait | done | stopped
    index: 0,
    nextIndex: 0,
    total: 0,
    claimed: 0,
    waitTotal: 0,
    waitRemain: null,
  };
}

function applyRecordToState(record) {
  if (!uiState || !record) return;
  uiState.today = record;
  uiState.todayKey = record.dateKey || beijingDateKey();
  uiState.gainedToday =
    (record.listen === "ok" || record.listen === "already" ? 1 : 0) +
    (Number(record.adClaimed) || 0) +
    (record.dayVip === "ok" || record.dayVip === "already" ? 1 : 0);
  if (record.vipExpire) uiState.vipExpire = record.vipExpire;
  if (record.nickname) uiState.nickname = record.nickname;
  if (record.message) uiState.lastMessage = record.message;
  uiState.steps = {
    listen: { state: record.listen || "idle", text: record.listenText || "待领取" },
    ad: { state: adStepState(record), text: record.adText || "待领取" },
    dayVip: { state: record.dayVip || "idle", text: record.dayVipText || "待领取" },
    upgrade: { state: record.upgrade || "idle", text: record.upgradeText || "待领取" },
  };
}

// 广告步骤的历史状态：领到过就算 ok；「没有额度/已用光」算 already（中性）；
// 其余带文案的失败才算 fail。
function adStepState(record) {
  if (!record) return "idle";
  if (Number(record.adClaimed) > 0) return "ok";
  if (!record.adText) return "idle";
  if (record.adNoQuota) return "already";
  if (/已用光|次数已用完|已关闭|已停止|已达上限|暂无可领取/.test(record.adText)) return "already";
  return "fail";
}

// ---------- 只读刷新（打开面板 / 点刷新时用，不发领取请求） ----------

async function refreshStatus(ctx) {
  const auth = readAuth(ctx);
  if (!auth) {
    setError("未登录 EchoMusic，请先登录", "not_logged_in");
    if (uiState) {
      uiState.nickname = "";
      uiState.userid = "";
    }
    return;
  }
  if (uiState) uiState.userid = String(auth.userid);

  const detail = await fetchUserDetail(ctx);
  if (!detail.ok) {
    setError(detail.error || "读取账号信息失败", "session_expired");
    return;
  }
  if (uiState) uiState.nickname = detail.nickname;

  const record = await fetchMonthRecord(ctx);
  if (uiState) {
    uiState.monthCount = record.ok ? record.count : null;
    uiState.monthDays = record.ok ? record.days : [];
    uiState.monthRaw = record.ok ? record.raw : null;
  }

  const vip = await fetchVipDetail(ctx);
  if (vip.ok && uiState) {
    uiState.vipExpire = vip.endTime;
    uiState.vipLevelName = vip.level;
    uiState.vipOthers = vip.others || [];
    uiState.vipRaw = vip.raw;
  }

  // 本地记录：不是今天的就清空展示，避免把昨天的结果当成今天
  if (uiState) {
    const stored = await ctx.storage.get("lastClaim");
    const todayKey = beijingDateKey();
    if (stored && stored.dateKey === todayKey) applyRecordToState(stored);
    else if (uiState.todayKey !== todayKey) {
      uiState.todayKey = todayKey;
      uiState.today = null;
      uiState.gainedToday = 0;
      uiState.steps = emptySteps();
      uiState.lastMessage = "今日尚未领取";
      uiState.lastError = null;
    }
  }
}

// ---------- 主流程（会真实发起领取请求） ----------

async function runClaim(ctx, reason, opts = {}) {
  const force = Boolean(opts.force);
  if (running) return;
  if (!force && Date.now() - lastRunStartedAt < MIN_RUN_GAP_MS) return;

  const auth = readAuth(ctx);
  if (!auth) {
    setError("未登录 EchoMusic，请先登录后再领取", "not_logged_in");
    return;
  }

  running = true;
  abortRequested = false;
  lastRunStartedAt = Date.now();
  try {
    const settings = await getSettings(ctx);
    const dateKey = beijingDateKey();
    if (uiState) {
      uiState.running = true;
      uiState.todayKey = dateKey;
      uiState.userid = String(auth.userid);
      uiState.steps = emptySteps();
      resetAdProgress();
      uiState.lastError = null;
      uiState.lastMessage = "正在领取…";
    }

    // ① GUARD
    setStage("校验登录状态…");
    const detail = await fetchUserDetail(ctx);
    if (!detail.ok) {
      setError(detail.error || "登录已过期，请在 EchoMusic 中重新登录", "session_expired");
      if (uiState) uiState.lastMessage = "登录已过期，请在 EchoMusic 中重新登录";
      return;
    }
    if (uiState) uiState.nickname = detail.nickname;

    const today = makeTodayRecord(dateKey, detail.nickname);

    // ② RECORD（只读，失败不阻断）
    setStage("读取本月领取记录…");
    const record = await fetchMonthRecord(ctx);
    if (uiState) {
      uiState.monthCount = record.ok ? record.count : null;
      uiState.monthDays = record.ok ? record.days : [];
      uiState.monthRaw = record.ok ? record.raw : null;
    }

    // ③ 听歌领取
    if (settings.listenSong) {
      setStage("听歌领取 VIP…");
      if (uiState) uiState.steps.listen = { state: "running", text: "领取中…" };
      const r = await stepListen(ctx);
      today.listen = r.state;
      today.listenText = r.message;
      if (uiState) uiState.steps.listen = { state: r.state, text: r.message };
      if (r.fatal) {
        setError(r.message, "session_expired");
        await finishClaim(ctx, today, { settings, aborted: false });
        return;
      }
    } else {
      today.listen = "skip";
      today.listenText = "已关闭";
      if (uiState) uiState.steps.listen = { state: "skip", text: "已关闭" };
    }

    // ④ 广告领取
    if (settings.adVip && !abortRequested) {
      setStage("领取广告 VIP…");
      resetAdProgress();
      if (uiState) uiState.steps.ad = { state: "running", text: "领取中…" };
      const r = await stepAd(ctx, settings, (p) => {
        if (p.phase === "claim") {
          setAdProgress({ phase: "claim", index: p.index, nextIndex: p.index, total: p.total, claimed: p.claimed, waitRemain: null });
          setStage(`广告领取中（第 ${p.index}/${p.total} 次，已得 ${p.claimed} 天）…`);
          if (uiState) uiState.steps.ad = { state: "running", text: `第 ${p.index}/${p.total} 次 · 已得 ${p.claimed} 天` };
        } else if (p.phase === "wait") {
          setAdProgress({
            phase: "wait",
            index: p.index,
            nextIndex: p.nextIndex,
            total: p.total,
            claimed: p.claimed,
            waitTotal: p.waitTotal,
            waitRemain: p.waitRemain,
          });
          const text = `已得 ${p.claimed} 天 · 等待 ${formatWait(p.waitRemain)}`;
          setStage(`广告领取中 · ${text}（第 ${p.nextIndex}/${p.total} 次）`);
          if (uiState) uiState.steps.ad = { state: "running", text };
        } else if (p.phase === "done") {
          setAdProgress({ phase: "done", waitRemain: null, total: p.total, claimed: p.claimed });
        }
      });
      today.adClaimed = r.claimed;
      today.adText = r.message;
      today.adNoQuota = Boolean(r.noQuota);
      if (uiState) uiState.steps.ad = { state: r.state, text: r.message };
      if (r.fatal) {
        setError(r.message, "session_expired");
        await finishClaim(ctx, today, { settings, aborted: false });
        return;
      }
    } else {
      today.adClaimed = 0;
      today.adNoQuota = false;
      today.adText = settings.adVip ? "已停止" : "已关闭";
      if (uiState) uiState.steps.ad = { state: "skip", text: today.adText };
    }
    resetAdProgress();

    // ⑤ 天天签到
    if (settings.dayVip && !abortRequested) {
      setStage("签到领取 VIP…");
      if (uiState) uiState.steps.dayVip = { state: "running", text: "领取中…" };
      const r = await stepDayVip(ctx, settings);
      today.dayVip = r.state;
      today.dayVipText = r.message;
      if (uiState) uiState.steps.dayVip = { state: r.state, text: r.message };
      if (r.state === "fail") dlog("[签到失败]", r.message, r.attempts);
    } else {
      today.dayVip = "skip";
      today.dayVipText = settings.dayVip ? "已停止" : "已关闭";
      if (uiState) uiState.steps.dayVip = { state: "skip", text: today.dayVipText };
    }

    // ⑥ 升级
    if (settings.autoUpgrade && !abortRequested) {
      setStage("升级概念版 VIP…");
      if (uiState) uiState.steps.upgrade = { state: "running", text: "升级中…" };
      const r = await stepUpgrade(ctx);
      today.upgrade = r.state;
      today.upgradeText = r.message;
      if (uiState) uiState.steps.upgrade = { state: r.state, text: r.message };
    } else {
      today.upgrade = "skip";
      today.upgradeText = settings.autoUpgrade ? "已停止" : "已关闭";
      if (uiState) uiState.steps.upgrade = { state: "skip", text: today.upgradeText };
    }

    // ⑦ VIP 到期时间
    setStage("读取 VIP 状态…");
    const vip = await fetchVipDetail(ctx);
    if (vip.ok) {
      today.vipExpire = vip.endTime;
      today.vipOthers = vip.others || [];
      if (uiState) {
        uiState.vipExpire = vip.endTime;
        uiState.vipLevelName = vip.level;
        uiState.vipOthers = vip.others || [];
        uiState.vipRaw = vip.raw;
      }
    }

    await finishClaim(ctx, today, { settings, aborted: abortRequested });
  } catch (e) {
    console.warn("[kugou-daily-vip] runClaim error:", e?.message || e);
    setError("领取流程异常：" + String(e?.message || e), "run_error");
  } finally {
    running = false;
    if (uiState) uiState.running = false;
    setStage("");
  }
}

// 写入当日记录 + 历史 + 总结文案
//
// 判定原则（真机数据校正）：
//   - 「已领取」与「走完但没额度」都是正常结果，不算失败；
//   - 升级是可选增强项，「暂时无法升级」不该把整轮拖成「部分失败」——
//     真机就是这样报出「部分失败（升级），听歌(已领)，签到(已领)」误导用户的。
async function finishClaim(ctx, today, { settings, aborted }) {
  const gained =
    (today.listen === "ok" || today.listen === "already" ? 1 : 0) +
    (Number(today.adClaimed) || 0) +
    (today.dayVip === "ok" || today.dayVip === "already" ? 1 : 0);

  const got = [];
  if (today.listen === "ok") got.push("听歌+1");
  else if (today.listen === "already") got.push("听歌(已领)");
  if (today.adClaimed > 0) got.push(`广告+${today.adClaimed}`);
  if (today.dayVip === "ok") got.push("签到+1");
  else if (today.dayVip === "already") got.push("签到(已领)");
  if (today.upgrade === "ok") got.push("已升级");

  const failed = [];
  if (today.listen === "fail") failed.push("听歌");
  if (Number(today.adClaimed) === 0 && today.adText && adStepState(today) === "fail") failed.push("广告");
  if (today.dayVip === "fail") failed.push("签到");
  if (today.upgrade === "fail") failed.push("升级");

  // 中性提示（不参与「失败」判定，只在成功文案后补一句说明）
  const notes = [];
  if (today.adText && Number(today.adClaimed) === 0 && adStepState(today) === "already") notes.push("广告已无额度");
  else if (Number(today.adClaimed) > 0 && /已用光|次数已用完|已达上限/.test(today.adText || "")) notes.push("广告额度已用尽");
  if (today.upgrade === "skip") {
    if (today.upgradeText && !/已关闭|已停止/.test(today.upgradeText)) notes.push("本次无可升级额度");
  }

  let message;
  if (aborted) message = `已停止领取${got.length ? "，" + got.join("，") : ""}`;
  else if (failed.length > 0) message = `部分失败（${failed.join("/")}）${got.length ? "，" + got.join("，") : ""}`;
  else if (got.length > 0) message = `今日已领取：${got.join("，")}${notes.length ? "（" + notes.join("；") + "）" : ""}`;
  else if (notes.length > 0) message = `今日额度已领完：${notes.join("；")}`;
  else message = "今日暂无可领取的 VIP 额度";

  today.message = message;
  today.at = Date.now();

  // 诊断信息：把升级/广告的原始拒绝原因保留下来，便于后续对齐官方话术
  if (uiState) uiState.diagNotes = { notes, adText: today.adText, upgradeText: today.upgradeText };

  if (failed.length === 0) {
    if (uiState) {
      uiState.lastError = null;
      uiState.lastMessage = message;
    }
  } else {
    setError(message, "partial_failure", { today });
  }
  if (uiState) {
    applyRecordToState(today);
    uiState.history = upsertHistory(uiState.history, today);
  }

  await ctx.storage.set("lastClaim", today);
  await ctx.storage.set("history", (uiState?.history || []).slice(0, MAX_HISTORY));
  // 只有完整跑完才记「今天已完成」，中止/失败下轮跨天巡检仍会重试
  if (!aborted && failed.length === 0) await ctx.storage.set("lastDoneDate", today.dateKey);

  if (settings.toastOnDone) {
    if (failed.length > 0) ctx.toast.warning(message);
    else if (gained > 0) ctx.toast.success(message);
    else ctx.toast.info(message);
  }
}

function upsertHistory(history, today) {
  const list = Array.isArray(history) ? history.filter((h) => h && h.dateKey !== today.dateKey) : [];
  return [today, ...list].sort((a, b) => (b.dateKey > a.dateKey ? 1 : -1)).slice(0, MAX_HISTORY);
}

// 所有触发点（启动 / 登录 / 跨天巡检 / 手动）汇入同一条串行链
function requestClaim(ctx, reason, opts = {}) {
  if (!runChain) runChain = Promise.resolve();
  const run = opts.statusOnly ? () => refreshStatus(ctx) : () => runClaim(ctx, reason, opts);
  runChain = runChain.then(run).catch((e) => console.warn("[kugou-daily-vip] run chain error:", e?.message || e));
  return runChain;
}

// ---------- 设置 ----------

async function getSettings(ctx) {
  const saved = await ctx.storage.get("settings");
  const base = saved && typeof saved === "object" ? saved : {};
  return { ...DEFAULT_SETTINGS, ...base };
}

async function updateSettings(ctx, patch) {
  const prev = await ctx.storage.get("settings");
  const base = prev && typeof prev === "object" ? prev : {};
  const next = { ...base, ...patch };
  await ctx.storage.set("settings", next);
  return next;
}

// ---------- 诊断复制 ----------

async function copyDiagnostics(ctx) {
  const today = uiState?.today || null;
  const ad = uiState?.ad || null;
  const days = uiState?.monthDays || [];
  const lines = [
    "=== EchoMusic 概念版每日领VIP 诊断 ===",
    "时间: " + new Date().toLocaleString(),
    "插件版本: " + PLUGIN_VERSION,
    "账号: " + (uiState?.nickname || "-") + " (" + (uiState?.userid || "-") + ")",
    "北京日期: " + beijingDateKey() + " / 本地记录日期: " + (uiState?.todayKey || "-"),
    "VIP 到期: " + (uiState?.vipExpire || "未知") + (uiState?.vipLevelName ? "（" + uiState.vipLevelName + "）" : ""),
    "本月记录条数: " + (uiState?.monthCount ?? "读取失败"),
    "本月已领取日期: " + (days.length ? `${days.length} 天 → ${days.join(",")}` : "-"),
    "",
    "-- 今日各步骤 --",
    `听歌: ${today?.listen || "-"} ${today?.listenText || ""}`,
    `广告: ${today?.adClaimed ?? 0} 次 ${today?.adText || ""}`,
    `签到: ${today?.dayVip || "-"} ${today?.dayVipText || ""}`,
    `升级: ${today?.upgrade || "-"} ${today?.upgradeText || ""}`,
  ];
  if (uiState?.vipOthers?.length) {
    lines.push("", "-- 其它权益到期（未作为主到期展示）--", ...uiState.vipOthers.map((o) => `${o.name}: ${o.endTime}`));
  }
  if (ad && ad.total) {
    lines.push("", "-- 广告进度 --", `阶段: ${ad.phase} 第 ${ad.index}/${ad.total} 次 已得 ${ad.claimed} 天` + (ad.waitRemain !== null && ad.waitRemain !== undefined ? ` 剩余 ${Math.ceil(ad.waitRemain / 1000)}s` : ""));
  }
  if (uiState?.diagNotes) {
    lines.push("", "-- 中性提示 --", JSON.stringify(uiState.diagNotes));
  }
  if (uiState?.lastError?.detail) {
    lines.push("", "-- 错误详情 --", JSON.stringify(uiState.lastError.detail, null, 2));
  }
  if (uiState?.vipRaw) {
    lines.push("", "-- /user/vip/detail 原始响应 --", JSON.stringify(uiState.vipRaw, null, 2).slice(0, 3000));
  }
  if (uiState?.monthRaw) {
    lines.push("", "-- /youth/month/vip/record 原始响应 --", JSON.stringify(uiState.monthRaw, null, 2).slice(0, 3000));
  }
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    ctx.toast.success("诊断信息已复制");
  } catch {
    console.log(text);
    ctx.toast.warning("复制失败，已输出到控制台");
  }
}

// ---------- 运行时释放 ----------

function releaseRuntime() {
  if (toolbarDispose) {
    toolbarDispose();
    toolbarDispose = null;
  }
  if (teleportDispose) {
    teleportDispose();
    teleportDispose = null;
  }
  if (cssDispose) {
    cssDispose();
    cssDispose = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (stopTokenWatch) {
    stopTokenWatch();
    stopTokenWatch = null;
  }
  for (const t of startupTimers) clearTimeout(t);
  startupTimers = [];
  if (dialogOpen) dialogOpen.value = false;
  uiState = null;
  dialogOpen = null;
  settingsReady = null;
  runChain = null;
  running = false;
  abortRequested = false;
  lastRunStartedAt = 0;
  lastManualAt = 0;
}

// ---------- 样式 ----------

const DIALOG_CSS = `
.kdv-mask {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.35);
  display: flex; align-items: center; justify-content: center;
  animation: kdv-fade 0.15s ease;
}
.kdv-dialog {
  --kdv-warn: #b45309;
  --kdv-warn-bg: rgba(180,83,9,0.12);
  --kdv-ok: #15803d;
  --kdv-ok-bg: rgba(21,128,61,0.12);
  background: var(--color-bg-elevated, #ffffff);
  color: var(--color-text-main, #1f2329);
  border: 1px solid var(--border-subtle, rgba(127,127,127,0.18));
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  width: 460px; max-width: calc(100vw - 48px);
  max-height: calc(100vh - 80px);
  overflow: auto;
  padding: 20px;
  position: relative;
  animation: kdv-pop 0.18s cubic-bezier(0.34,1.56,0.64,1);
  scrollbar-width: thin;
}
.kdv-dialog * { box-sizing: border-box; }
@keyframes kdv-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes kdv-pop { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
.dark .kdv-dialog, body.dark .kdv-dialog, html.dark .kdv-dialog {
  --kdv-warn: #f0b93c; --kdv-warn-bg: rgba(255,185,60,0.15);
  --kdv-ok: #4ade80; --kdv-ok-bg: rgba(74,222,128,0.14);
}
`;

const CARD_STYLE =
  "padding: 10px 12px; border-radius: 10px; background: var(--control-muted-bg, rgba(127,127,127,0.08)); border: 1px solid var(--border-subtle, rgba(127,127,127,0.14));";
const ROW_STYLE = "display: flex; gap: 8px; align-items: center; justify-content: space-between;";
const LABEL_STYLE = "font-size: 12px; opacity: 0.62;";
const INPUT_STYLE =
  "height: 28px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--border-subtle, rgba(127,127,127,0.2)); background: var(--control-muted-bg, rgba(127,127,127,0.08)); color: var(--color-text-main, #1f2329); font-size: 13px; outline: none;";

function stepColor(state) {
  if (state === "ok") return "var(--kdv-ok)";
  if (state === "already") return "var(--color-primary, #2563eb)";
  if (state === "fail") return "var(--kdv-warn)";
  if (state === "running") return "var(--color-primary, #2563eb)";
  return "var(--color-text-secondary, #6b7280)";
}

function stepMark(state) {
  if (state === "ok") return "✓";
  if (state === "already") return "•";
  if (state === "fail") return "!";
  if (state === "running") return "…";
  if (state === "skip") return "—";
  return "·";
}

// ---------- activate ----------

export async function activate(ctx) {
  PLUGIN_VERSION = ctx.manifest?.version || "0.0.0";

  const { h, ref, reactive, defineComponent, defineAsyncComponent } = ctx.vue;

  uiState = reactive({
    running: false,
    stage: "",
    todayKey: beijingDateKey(),
    today: null,
    steps: emptySteps(),
    ad: emptyAdProgress(),
    nickname: "",
    userid: "",
    vipExpire: "",
    vipLevelName: "",
    vipOthers: [],
    vipRaw: null,
    monthCount: null,
    monthDays: [],
    monthRaw: null,
    gainedToday: 0,
    history: [],
    lastMessage: "",
    lastError: null,
    diagNotes: null,
  });

  dialogOpen = ref(false);
  const settingsRef = reactive({ ...DEFAULT_SETTINGS });
  let lastRefreshAt = 0;
  let lastTickDate = beijingDateKey();

  // 宿主的 ui.components 是异步组件 loader；缺失时退回原生元素，
  // 避免「宿主版本差异 → defineAsyncComponent(undefined) 直接抛错、插件整体不可用」。
  const asyncComponent = (key, fallbackTag) => {
    const source = ctx.ui?.components?.[key];
    if (source) return defineAsyncComponent(source);
    return {
      name: `Fallback${key}`,
      setup(props, { slots, attrs }) {
        return () => h(fallbackTag, attrs, slots.default ? slots.default() : []);
      },
    };
  };
  const Button = asyncComponent("Button", "button");
  const Switch = asyncComponent("Switch", "button");

  // 读设置 + 本地历史 + 当日记录
  settingsReady = (async () => {
    try {
      Object.assign(settingsRef, await getSettings(ctx));
      const history = await ctx.storage.get("history");
      if (Array.isArray(history)) uiState.history = history;
      const lastClaim = await ctx.storage.get("lastClaim");
      if (lastClaim && typeof lastClaim === "object" && lastClaim.dateKey === beijingDateKey()) {
        applyRecordToState(lastClaim);
      } else {
        uiState.lastMessage = "今日尚未领取";
      }
    } catch (e) {
      console.warn("[kugou-daily-vip] settings load failed:", e);
    }
  })();

  // ---- 操作 ----

  const onManualClaim = async () => {
    if (uiState.running) {
      ctx.toast.info("领取正在进行中…");
      return;
    }
    const now = Date.now();
    if (now - lastManualAt < MANUAL_COOLDOWN_MS) {
      ctx.toast.info("刚领取过，请稍后再试");
      return;
    }
    lastManualAt = now;
    await requestClaim(ctx, "manual", { force: true });
  };

  const onStop = () => {
    if (!uiState.running) return;
    abortRequested = true;
    ctx.toast.info("已请求停止，将在当前步骤结束后中断");
  };

  const onRefresh = async () => {
    if (Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) {
      ctx.toast.info("刷新过于频繁，请稍后再试");
      return;
    }
    lastRefreshAt = Date.now();
    await requestClaim(ctx, "refresh", { statusOnly: true });
    ctx.toast.success("已刷新");
  };

  const setSetting = async (key, value) => {
    settingsRef[key] = value;
    Object.assign(settingsRef, await updateSettings(ctx, { [key]: value }));
    if (key === "receiveDayFormat" && value !== "auto") {
      await ctx.storage.set("receiveDayFormat", value);
    }
  };

  // ---- 面板 ----

  const Panel = defineComponent({
    setup() {
      const toggleRow = (label, key, hint) =>
        h("div", { style: CARD_STYLE + " " + ROW_STYLE, "data-setting": key }, [
          h("div", { style: "min-width: 0;" }, [
            h("div", { style: "font-size: 13px;" }, label),
            hint ? h("div", { style: LABEL_STYLE + " margin-top: 2px;" }, hint) : null,
          ]),
          h(Switch, {
            modelValue: Boolean(settingsRef[key]),
            "data-switch": key,
            "onUpdate:modelValue": (v) => setSetting(key, Boolean(v)),
          }),
        ]);

      const numberRow = (label, key, min, max, suffix, hint) =>
        h("div", { style: CARD_STYLE + " " + ROW_STYLE, "data-setting": key }, [
          h("div", { style: "min-width: 0;" }, [
            h("div", { style: "font-size: 13px;" }, label),
            hint ? h("div", { style: LABEL_STYLE + " margin-top: 2px;" }, hint) : null,
          ]),
          h("div", { style: "display: flex; align-items: center; gap: 6px; flex-shrink: 0;" }, [
            h("input", {
              type: "number",
              min,
              max,
              "data-input": key,
              value: settingsRef[key],
              onInput: (e) => {
                const raw = Number(e.target.value);
                if (Number.isFinite(raw)) settingsRef[key] = Math.min(max, Math.max(min, Math.round(raw)));
              },
              onChange: (e) => {
                const raw = Number(e.target.value);
                const v = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : DEFAULT_SETTINGS[key];
                e.target.value = String(v);
                setSetting(key, v);
              },
              style: INPUT_STYLE + " width: 58px;",
            }),
            h("span", { style: LABEL_STYLE }, suffix),
          ]),
        ]);

      const formatRow = () =>
        h("div", { style: CARD_STYLE + " " + ROW_STYLE, "data-setting": "receiveDayFormat" }, [
          h("div", { style: "min-width: 0;" }, [
            h("div", { style: "font-size: 13px;" }, "签到日期形态"),
            h("div", { style: LABEL_STYLE + " margin-top: 2px;" }, "官方无公开文档，报错会换形态重试"),
          ]),
          h(
            "select",
            {
              value: settingsRef.receiveDayFormat,
              "data-input": "receiveDayFormat",
              onChange: (e) => setSetting("receiveDayFormat", e.target.value),
              style: INPUT_STYLE + " flex-shrink: 0; font-size: 12px;",
            },
            [
              h("option", { value: "auto" }, "自动"),
              h("option", { value: "day" }, "日号"),
              h("option", { value: "date" }, "完整日期"),
            ],
          ),
        ]);

      const stepRow = (title, id, step) =>
        h("div", { style: "display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px;", "data-step": id }, [
          h(
            "span",
            {
              style: "width: 16px; flex-shrink: 0; text-align: center; font-weight: 700; color: " + stepColor(step?.state),
              "data-mark": step?.state || "idle",
            },
            stepMark(step?.state),
          ),
          h("span", { style: "flex-shrink: 0; min-width: 60px; opacity: 0.85;" }, title),
          h(
            "span",
            { style: "flex: 1; min-width: 0; word-break: break-all; color: " + stepColor(step?.state) },
            step?.text || "待领取",
          ),
        ]);

      // 广告领取倒计时：8 次 × 30s ≈ 3.5 分钟，没有这个进度条用户只能干等，
      // 分不清「在等待」和「卡死了」。这里把剩余秒数、第几次、进度条一次给全。
      const adProgressBar = () => {
        const ad = uiState?.ad;
        if (!ad || ad.phase !== "wait") return null;
        const remain = Number(ad.waitRemain) || 0;
        const total = Number(ad.waitTotal) || 1;
        const pct = Math.min(100, Math.max(0, Math.round(((total - remain) / total) * 100)));
        const secs = Math.ceil(remain / 1000);
        return h(
          "div",
          {
            "data-ad-countdown": String(secs),
            style:
              "padding: 8px 10px; border-radius: 10px; font-size: 12px; " +
              "background: var(--control-muted-bg, rgba(127,127,127,0.08)); " +
              "border: 1px solid var(--border-subtle, rgba(127,127,127,0.14));",
          },
          [
            h("div", { style: ROW_STYLE + " margin-bottom: 6px;" }, [
              h("span", { style: "font-size: 12px; opacity: 0.85;" },
                `广告领取中 · 已得 ${ad.claimed} 天，等待第 ${ad.nextIndex}/${ad.total} 次`),
              h("span", { style: "font-variant-numeric: tabular-nums; font-weight: 700; color: var(--color-primary, #2563eb);" },
                `${secs}s`),
            ]),
            h("div", { style: "height: 4px; border-radius: 2px; overflow: hidden; background: var(--border-subtle, rgba(127,127,127,0.18));" }, [
              h("div", {
                style:
                  `height: 100%; width: ${pct}%; border-radius: 2px; ` +
                  "background: var(--color-primary, #2563eb); transition: width 0.45s linear;",
              }),
            ]),
            h("div", { style: LABEL_STYLE + " margin-top: 6px;" },
              `本轮共 ${ad.total} 次 · 每 ${Math.round(total / 1000)}s 一次 · 可随时点「停止」`),
          ],
        );
      };

      const historyBlock = () => {
        const list = Array.isArray(uiState?.history) ? uiState.history.slice(0, 7) : [];
        if (list.length === 0) return h("div", { style: LABEL_STYLE }, "暂无记录");
        return h(
          "div",
          { style: "display: grid; gap: 6px;" },
          list.map((item) => {
            const tags = [];
            if (item.listen === "ok") tags.push("听歌+1");
            else if (item.listen === "already") tags.push("听歌已领");
            else if (item.listen === "fail") tags.push("听歌失败");
            if (item.adClaimed > 0) tags.push(`广告+${item.adClaimed}`);
            if (item.dayVip === "ok") tags.push("签到+1");
            else if (item.dayVip === "already") tags.push("签到已领");
            else if (item.dayVip === "fail") tags.push("签到失败");
            return h("div", { style: "display: flex; gap: 8px; align-items: baseline; font-size: 12px;" }, [
              h("span", { style: "flex-shrink: 0; width: 44px; opacity: 0.6;" }, String(item.dateKey || "").slice(5)),
              h("span", { style: "flex: 1; min-width: 0;" }, tags.length ? tags.join(" · ") : item.message || "无领取"),
              item.vipExpire
                ? h("span", { style: "flex-shrink: 0; opacity: 0.5; font-size: 11px;" }, "到期 " + String(item.vipExpire).slice(0, 16))
                : null,
            ]);
          }),
        );
      };

      return () =>
        h("div", { style: "display: grid; gap: 14px;", "data-panel": "kugou-daily-vip" }, [
          h("div", { style: CARD_STYLE, "data-card": "status" }, [
            h("div", { style: ROW_STYLE + " margin-bottom: 6px;" }, [
              h("span", { style: "font-size: 13px; font-weight: 600;" }, uiState?.nickname || "未登录"),
              h("span", { style: LABEL_STYLE }, uiState?.userid ? "UID " + uiState.userid : ""),
            ]),
            h("div", { style: "font-size: 12.5px; margin-bottom: 3px;" },
              "VIP 到期：" + (uiState?.vipExpire || "未知") + (uiState?.vipLevelName ? "（" + uiState.vipLevelName + "）" : "")),
            uiState?.vipOthers?.length
              ? h("div", { style: LABEL_STYLE + " margin-bottom: 3px;" },
                  "其它权益：" + uiState.vipOthers.map((o) => `${o.name} ${String(o.endTime).slice(0, 10)}`).join(" · "))
              : null,
            h("div", { style: LABEL_STYLE + " margin-bottom: 3px;" },
              "本月记录：" +
                (uiState?.monthCount === null || uiState?.monthCount === undefined
                  ? "读取失败"
                  : uiState.monthCount + " 条" + (uiState.monthDays?.length ? "（已领 " + uiState.monthDays.length + " 天：" + uiState.monthDays.map((d) => String(d).slice(5)).join(",") + "）" : ""))),
            h("div", { style: LABEL_STYLE },
              "北京日期：" + beijingDateKey() + "　本地记录：" + (uiState?.todayKey || "-")),
          ]),

          h("div", { style: "display: grid; gap: 6px;" }, [
            h("div", { style: "font-size: 12px; font-weight: 600; opacity: 0.75;" }, "今日领取"),
            stepRow("听歌领取", "listen", uiState?.steps?.listen),
            stepRow("广告领取", "ad", uiState?.steps?.ad),
            adProgressBar(),
            stepRow("天天签到", "dayVip", uiState?.steps?.dayVip),
            stepRow("升级VIP", "upgrade", uiState?.steps?.upgrade),
          ]),

          uiState?.lastMessage
            ? h(
                "div",
                {
                  "data-role": uiState?.lastError ? "error" : "ok",
                  style:
                    "font-size: 12px; padding: 8px 10px; border-radius: 8px; word-break: break-all; " +
                    (uiState?.lastError
                      ? "background: var(--kdv-warn-bg); color: var(--color-warning, var(--kdv-warn));"
                      : "background: var(--kdv-ok-bg); color: var(--kdv-ok);"),
                },
                uiState.lastMessage,
              )
            : null,

          h("div", { style: "display: flex; gap: 8px;" }, [
            h(
              Button,
              {
                size: "sm",
                variant: "primary",
                disabled: uiState?.running,
                "data-action": "claim",
                onClick: onManualClaim,
                style: "flex: 1;",
              },
              { default: () => (uiState?.running ? "领取中…" : "一键领取今日 VIP") },
            ),
            h(
              Button,
              { size: "sm", variant: "outline", disabled: !uiState?.running, "data-action": "stop", onClick: onStop },
              { default: () => "停止" },
            ),
          ]),

          h("div", { style: "display: grid; gap: 8px;" }, [
            h("div", { style: "font-size: 12px; font-weight: 600; opacity: 0.75;" }, "设置"),
            toggleRow("每日自动领取", "autoDaily", "软件运行期间跨天自动补领"),
            toggleRow("听歌领取（1 天）", "listenSong"),
            toggleRow("广告领取（每次 1 天）", "adVip"),
            numberRow("广告领取次数上限", "adCount", 1, 8, "次"),
            numberRow("广告领取间隔", "adIntervalSec", 0, 120, "秒", "过短可能触发风控"),
            toggleRow("天天签到领取（1 天）", "dayVip", "即「天天签到领VIP」"),
            formatRow(),
            toggleRow("领取后自动升级概念版 VIP", "autoUpgrade"),
            toggleRow("完成时弹提示", "toastOnDone"),
          ]),

          h("div", { style: "display: grid; gap: 8px;" }, [
            h("div", { style: "font-size: 12px; font-weight: 600; opacity: 0.75;" }, "领取记录（最近 7 天）"),
            historyBlock(),
          ]),

          h("div", { style: "display: flex; gap: 8px; align-items: center;" }, [
            h("span", { style: LABEL_STYLE + " flex: 1;" }, "v" + PLUGIN_VERSION + " · 走宿主内置酷狗接口"),
            h(
              Button,
              { size: "xs", variant: "ghost", "data-action": "diag", onClick: () => copyDiagnostics(ctx) },
              { default: () => "复制诊断" },
            ),
            h(
              Button,
              { size: "xs", variant: "ghost", "data-action": "refresh", onClick: onRefresh },
              { default: () => "刷新" },
            ),
          ]),

          h("div", { style: LABEL_STYLE }, "领取走酷狗官方活动接口，存在账号风控可能，请自行评估使用。"),
        ]);
    },
  });

  const DialogRoot = defineComponent({
    setup() {
      return () =>
        dialogOpen.value
          ? h(
              "div",
              {
                class: "kdv-mask",
                onClick: (e) => {
                  if (e.target === e.currentTarget) dialogOpen.value = false;
                },
              },
              [
                h("div", { class: "kdv-dialog" }, [
                  h("div", { style: "display: flex; align-items: center; margin-bottom: 14px; padding-right: 36px;" }, [
                    h("span", { style: "font-size: 15px; font-weight: 700;" }, "概念版每日领VIP"),
                    uiState?.stage ? h("span", { style: "font-size: 11px; opacity: 0.5; margin-left: 8px;" }, uiState.stage) : null,
                  ]),
                  h(
                    "div",
                    {
                      style:
                        "position: absolute; top: 16px; right: 16px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 50%; cursor: pointer; opacity: 0.5; font-size: 18px; user-select: none;",
                      onClick: () => {
                        dialogOpen.value = false;
                      },
                    },
                    "✕",
                  ),
                  h(Panel),
                ]),
              ],
            )
          : null;
    },
  });

  cssDispose = ctx.css.inject(DIALOG_CSS, { id: "kdv-dialog-style" });
  teleportDispose = ctx.ui.teleport(DialogRoot, { id: "kugou-daily-vip-dialog" });

  // 顶部入口（与 auto-team-vip 的 ⭐ 同一区域）
  if (ctx.ui?.titlebar?.register) {
    toolbarDispose = ctx.ui.titlebar.register({
      id: "kugou-daily-vip",
      title: "每日领VIP",
      icon: "tabler:gift",
      tooltip: "概念版每日领VIP",
      defaultPlacement: "toolbar",
      order: 110,
      onClick: () => {
        if (!dialogOpen.value) dialogOpen.value = true;
        // 打开面板只做只读刷新，绝不在这里发起领取（避免点一下就跑 4 分钟广告流程）
        requestClaim(ctx, "panel_open", { statusOnly: true });
      },
    });
  }

  // 启动 / 登录后补领（等设置读取完成，避免用默认值误判）
  const maybeAutoClaim = async (reason) => {
    await settingsReady;
    if (!settingsRef.autoDaily) return;
    if (abortRequested) abortRequested = false;
    const done = await ctx.storage.get("lastDoneDate");
    if (done === beijingDateKey()) return;
    requestClaim(ctx, reason, { force: true });
  };

  startupTimers.push(setTimeout(() => maybeAutoClaim("startup"), STARTUP_DELAY_MS));

  stopTokenWatch = ctx.vue.watch(
    () => piniaState(ctx)?.user?.info?.token,
    (token) => {
      if (!token) return;
      startupTimers.push(setTimeout(() => maybeAutoClaim("login"), LOGIN_DELAY_MS));
    },
  );

  // 跨天巡检：纯本地判断，只有真正跨天才发请求
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  tickTimer = setInterval(() => {
    if (!uiState) return;
    const key = beijingDateKey();
    if (key === lastTickDate) return;
    lastTickDate = key;
    uiState.todayKey = key;
    if (settingsRef.autoDaily) requestClaim(ctx, "new_day", { force: true });
    else requestClaim(ctx, "new_day_quiet", { statusOnly: true });
  }, TICK_MS);

  ctx.dispose(() => releaseRuntime());
}

export async function deactivate() {
  releaseRuntime();
}
