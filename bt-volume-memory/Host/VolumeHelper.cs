// ============================================================================================
// VolumeHelper —— EchoMusic 插件 bt-volume-memory 的原生 helper
// ============================================================================================
//
// 【为什么需要它】
//   EchoMusic 插件跑在渲染进程里，纯 JS 摸不到 Windows 音频端点（Core Audio 的
//   IAudioEndpointVolume）。宿主对插件的开进程能力只有一条窄缝：ctx.process.launch 只允许
//   启动「插件目录内的 .exe/.com」，而且 spawn 时是 stdio:'ignore' —— **拿不到 stdout**。
//   所以这里做成「常驻进程 + 127.0.0.1 本地 HTTP」，插件用 ctx.net.request 与之通信。
//
// 【契约来源】以下事实全部从已安装宿主的 app.asar 实证挖出（不是文档推断）：
//   * plugins:process:launch  → spawn(exe, args, { shell:false, stdio:'ignore', windowsHide:true })
//                                返回 { ok, pid, executable, cwd, startedAt }；失败 { ok:false, error }
//   * 授权按「插件ID:exe相对路径 + 插件版本 + exe sha256」记账，任一变化都要重新弹窗
//   * 宿主会注入 ECHOMUSIC_PLUGIN_ID / ECHOMUSIC_PLUGIN_DIR 环境变量
//   * **禁用插件不会自动杀掉子进程**（只有 before-quit 和插件安装/更新会批量终止）
//   * ctx.net.request 只校验 protocol ∈ {http:,https:} 且 URL 无凭据，**没有 host 白名单**
//     → 访问 127.0.0.1 合法；默认 timeoutMs=30000、每插件并发上限 64
//
// 【生命周期自保】因为宿主禁用插件时不杀子进程，本进程必须能自己干净退出：
//   ① 空闲超时：idle 秒内没有任何请求 → 退出（默认 20 s，插件每 5 s 发一次 /ping）
//   ② 跟随父进程：--parent-pid 指向的进程消失 → 退出
//   ③ 显式退出：插件 dispose 时 POST /shutdown
//   ④ 重复实例：端口被另一个「本插件的 helper」占用时，安静退出（复用已有实例）
//
// 【协议】查询串传参 + JSON 响应。只有输出需要序列化，输入全部走查询串/表单对，
//   所以不依赖任何 JSON 库，也不需要反序列化。
//
// ============================================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace VolumeHelper
{
    // ------------------------------------------------------------------ 入口

    internal static class Program
    {
        internal const string Version = "1.0.0";

        [MTAThread]
        private static int Main(string[] args)
        {
            Options opt;
            string parseError;
            if (!Options.TryParse(args, out opt, out parseError))
            {
                Log("参数错误: " + parseError);
                PrintUsage();
                return 2;
            }

            if (opt.ShowHelp) { PrintUsage(); return 0; }
            if (opt.ShowVersion) { Console.WriteLine(Version); return 0; }

            // 端口被占用时先确认是不是「本插件的另一个实例」，是就安静退出。
            if (PortProbe.ProbeOurInstance(opt.Port, opt.Token))
            {
                Log("已有本插件的 helper 在监听 " + opt.Port + "，退出。");
                return 0;
            }

            // Core Audio 初始化失败不致命：照样把 HTTP 服务起来，把失败原因挂在 /ping 上，
            // 插件就能给出「helper 起来了但读不到音频端点」这种可定位的文案，而不是干等超时。
            AudioEndpointService audio = null;
            string coreAudioError = null;
            try
            {
                audio = new AudioEndpointService(opt.Scope);
                audio.Prime();
            }
            catch (Exception ex)
            {
                coreAudioError = ex.Message;
                Log("初始化 Core Audio 失败: " + ex.Message);
                if (audio != null) { try { audio.Dispose(); } catch { } audio = null; }
            }

            var bridge = new HttpBridge(opt, audio, coreAudioError);
            string bindError;
            if (!bridge.Start(out bindError))
            {
                Log("监听 127.0.0.1:" + opt.Port + " 失败: " + bindError);
                if (audio != null) audio.Dispose();
                return 3;
            }

            Log("VolumeHelper " + Version + " 已监听 http://127.0.0.1:" + opt.Port + "/ (pid " + Process.GetCurrentProcess().Id + ")");

            Lifecycle.Start(opt, bridge);

            // 阻塞到退出。不用 Console.ReadLine —— stdio 被宿主丢弃，读不到东西。
            Lifecycle.WaitForExit();
            bridge.Stop();
            if (audio != null) audio.Dispose();
            Log("已退出。");
            return 0;
        }

        internal static void Log(string message)
        {
            // stdio 通常被宿主丢弃，但手工运行时很有用；失败也不能让程序崩。
            try { Console.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message); }
            catch { }
        }

        private static void PrintUsage()
        {
            Console.WriteLine("VolumeHelper " + Version);
            Console.WriteLine();
            Console.WriteLine("用法: VolumeHelper.exe --port <1-65535> --token <字符串> [选项]");
            Console.WriteLine();
            Console.WriteLine("选项:");
            Console.WriteLine("  --port <n>          监听端口（只绑 127.0.0.1），必填");
            Console.WriteLine("  --token <s>         请求令牌，所有请求都要带 ?t=<token>，必填");
            Console.WriteLine("  --idle <秒>         空闲多久后自退，默认 20");
            Console.WriteLine("  --parent-pid <n>    该进程退出时本进程跟着退出");
            Console.WriteLine("  --scope <bth|all>   监视范围：仅蓝牙端点（默认）或所有输出端点");
            Console.WriteLine("  --debug             注册 /debug/reconnect（把端点当成刚重连，用于验证恢复链路）");
            Console.WriteLine("  --version           打印版本号");
            Console.WriteLine("  --help              打印本帮助");
        }
    }

    // ------------------------------------------------------------------ 参数

    internal sealed class Options
    {
        internal int Port;
        internal string Token = "";
        internal int IdleSeconds = 20;
        internal int ParentPid;
        internal bool ShowHelp;
        internal bool ShowVersion;
        internal string Scope = "bth";

        /// <summary>
        /// 打开调试端点（/debug/reconnect）。
        /// 存在的理由：真机上要验证「重连 → 恢复 → 弹层」只能靠把耳机真的断电再开机，
        /// 无法自动化。调试端点让这条链路可以被脚本完整跑一遍 ——
        /// 与 EarTrumpet 用 <c>--volume-osd-preview</c> 预览浮层是同一个思路。
        /// 不开这个开关时，调试路由根本不会注册。
        /// </summary>
        internal bool Debug;

        internal static bool TryParse(string[] args, out Options opt, out string error)
        {
            opt = new Options();
            error = null;

            string portRaw = null, tokenRaw = null, idleRaw = null, parentRaw = null, scopeRaw = null;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                switch (a)
                {
                    case "--help": case "-h": opt.ShowHelp = true; break;
                    case "--version": opt.ShowVersion = true; break;
                    case "--debug": opt.Debug = true; break;
                    case "--port": portRaw = Next(args, ref i); break;
                    case "--token": tokenRaw = Next(args, ref i); break;
                    case "--idle": idleRaw = Next(args, ref i); break;
                    case "--parent-pid": parentRaw = Next(args, ref i); break;
                    case "--scope": scopeRaw = Next(args, ref i); break;
                    default:
                        error = "未知参数 " + a;
                        return false;
                }
            }

            if (opt.ShowHelp || opt.ShowVersion) return true;

            int port;
            if (!int.TryParse(portRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out port) || port < 1 || port > 65535)
            {
                error = "--port 必须是 1..65535 的整数（收到 " + (portRaw ?? "空") + "）";
                return false;
            }
            if (string.IsNullOrEmpty(tokenRaw) || tokenRaw.Length > 128)
            {
                error = "--token 必填且不超过 128 字符";
                return false;
            }

            opt.Port = port;
            opt.Token = tokenRaw;

            if (idleRaw != null)
            {
                int idle;
                if (!int.TryParse(idleRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out idle) || idle < 3 || idle > 3600)
                {
                    error = "--idle 必须是 3..3600 的整数秒";
                    return false;
                }
                opt.IdleSeconds = idle;
            }

            if (parentRaw != null)
            {
                int ppid;
                if (!int.TryParse(parentRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out ppid) || ppid <= 0)
                {
                    error = "--parent-pid 必须是正整数";
                    return false;
                }
                opt.ParentPid = ppid;
            }

            if (scopeRaw != null)
            {
                string s = scopeRaw.Trim().ToLowerInvariant();
                if (s != "bth" && s != "all")
                {
                    error = "--scope 只能是 bth 或 all";
                    return false;
                }
                opt.Scope = s;
            }

            return true;
        }

        private static string Next(string[] args, ref int i)
        {
            if (i + 1 >= args.Length) return null;
            return args[++i];
        }
    }

    // ------------------------------------------------------------------ 生命周期

    internal static class Lifecycle
    {
        private static readonly ManualResetEventSlim Exit = new ManualResetEventSlim(false);
        private static volatile bool _exitRequested;

        internal static bool ExitRequested { get { return _exitRequested; } }

        internal static void RequestExit(string reason)
        {
            if (_exitRequested) return;
            _exitRequested = true;
            Program.Log("退出请求: " + reason);
            Exit.Set();
        }

        internal static void WaitForExit()
        {
            Exit.Wait();
        }

        internal static void Start(Options opt, HttpBridge bridge)
        {
            // ① 空闲看门狗
            var idleThread = new Thread(delegate ()
            {
                while (!_exitRequested)
                {
                    if (Exit.Wait(1000)) return;
                    double idleFor = (DateTime.UtcNow - bridge.LastActivityUtc).TotalSeconds;
                    if (idleFor > opt.IdleSeconds)
                    {
                        RequestExit("空闲 " + (int)idleFor + " 秒（阈值 " + opt.IdleSeconds + " 秒），疑似宿主已退出或插件已禁用");
                        return;
                    }
                }
            });
            idleThread.IsBackground = true;
            idleThread.Name = "idle-watchdog";
            idleThread.Start();

            // ② 跟随父进程
            if (opt.ParentPid > 0)
            {
                var parentThread = new Thread(delegate ()
                {
                    try
                    {
                        Process parent = Process.GetProcessById(opt.ParentPid);
                        parent.WaitForExit();
                        RequestExit("父进程 " + opt.ParentPid + " 已退出");
                    }
                    catch (ArgumentException)
                    {
                        RequestExit("父进程 " + opt.ParentPid + " 不存在（启动时已消失？）");
                    }
                    catch (Exception ex)
                    {
                        Program.Log("父进程监视失败（忽略）: " + ex.Message);
                    }
                });
                parentThread.IsBackground = true;
                parentThread.Name = "parent-watch";
                parentThread.Start();
            }
        }
    }

    // ------------------------------------------------------------------ 端口探测 / 重复实例

    internal static class PortProbe
    {
        /// <summary>
        /// 端口上是否已经有**本插件的** helper 在跑。用 token 做身份识别：
        /// 别的程序占用同一个端口时不会认识我们的 token，返回 false，由调用方决定怎么处理。
        /// </summary>
        internal static bool ProbeOurInstance(int port, string token)
        {
            string body;
            if (!HttpProbe.TryGet("http://127.0.0.1:" + port + "/ping?t=" + Uri.EscapeDataString(token), 1200, out body))
            {
                return false;
            }
            return body != null && body.IndexOf("\"signature\":\"volume-helper\"", StringComparison.Ordinal) >= 0;
        }
    }

    internal static class HttpProbe
    {
        /// <summary>极简 GET，只为探测；失败一律返回 false，不抛异常。</summary>
        internal static bool TryGet(string url, int timeoutMs, out string body)
        {
            body = null;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;                       // 本机回环，绝不要走代理
                req.KeepAlive = false;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    body = sr.ReadToEnd();
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }
    }

    // ------------------------------------------------------------------ 极简 HTTP 桥

    internal sealed class Request
    {
        internal string Method = "GET";
        internal string Path = "/";
        internal Dictionary<string, string> Query = new Dictionary<string, string>(StringComparer.Ordinal);
        internal Dictionary<string, string> Form = new Dictionary<string, string>(StringComparer.Ordinal);
        internal string Body = "";

        internal string Get(string key)
        {
            string v;
            if (Query.TryGetValue(key, out v)) return v;
            if (Form.TryGetValue(key, out v)) return v;
            return null;
        }

        internal string Get(string key, string fallback)
        {
            string v = Get(key);
            return v == null ? fallback : v;
        }

        internal bool TryGetInt(string key, out int value)
        {
            value = 0;
            string raw = Get(key);
            return raw != null && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
        }
    }

    internal sealed class Response
    {
        internal int Status = 200;
        internal string Body = "";
        internal string ContentType = "application/json; charset=utf-8";

        internal static Response Json(string json) { return new Response { Status = 200, Body = json }; }
        internal static Response Error(int status, string message)
        {
            return new Response
            {
                Status = status,
                Body = "{\"ok\":false,\"error\":" + JsonWriter.Str(message) + "}"
            };
        }
    }

    internal sealed class HttpBridge
    {
        private readonly Options _opt;
        private readonly AudioEndpointService _audio;
        private readonly string _coreAudioError;
        private readonly Dictionary<string, Func<Request, Response>> _routes =
            new Dictionary<string, Func<Request, Response>>(StringComparer.OrdinalIgnoreCase);

        private TcpListener _listener;
        private Thread _acceptThread;
        private volatile bool _stopping;
        private DateTime _lastActivityUtc = DateTime.UtcNow;

        internal DateTime LastActivityUtc { get { return _lastActivityUtc; } }

        internal HttpBridge(Options opt, AudioEndpointService audio, string coreAudioError)
        {
            _opt = opt;
            _audio = audio;
            _coreAudioError = coreAudioError;

            // 路由表：方法 + 路径。新增能力只往这里加一行。
            _routes["GET /ping"] = delegate (Request r)
            {
                return Response.Json(
                    "{\"ok\":true,\"signature\":\"volume-helper\",\"version\":" + JsonWriter.Str(Program.Version) +
                    ",\"pid\":" + Process.GetCurrentProcess().Id +
                    ",\"scope\":" + JsonWriter.Str(_audio != null ? _audio.Scope : _opt.Scope) +
                    ",\"coreAudioOk\":" + JsonWriter.Bool(_audio != null) +
                    ",\"coreAudioError\":" + JsonWriter.Str(_coreAudioError ?? "") +
                    ",\"enabled\":" + JsonWriter.Bool(_audio != null && _audio.Enabled) +
                    ",\"memoryCount\":" + JsonWriter.Num(_audio != null ? _audio.MemoryCount : 0) +
                    ",\"pendingEvents\":" + JsonWriter.Num(_audio != null ? _audio.PendingEventCountAll : 0) +
                    ",\"uptimeSeconds\":" + JsonWriter.Num((long)(DateTime.UtcNow - _startedUtc).TotalSeconds) + "}");
            };

            _routes["POST /shutdown"] = delegate (Request r)
            {
                Lifecycle.RequestExit("插件请求停止");
                return Response.Json("{\"ok\":true}");
            };

            _routes["GET /"] = delegate (Request r)
            {
                return Response.Json("{\"ok\":true,\"signature\":\"volume-helper\",\"version\":" + JsonWriter.Str(Program.Version) + "}");
            };

            // 当前 ACTIVE 渲染端点的实时快照（音量现读，不缓存）。
            _routes["GET /endpoints"] = delegate (Request r)
            {
                if (_audio == null) return Response.Error(503, "Core Audio 不可用" + (_coreAudioError == null ? "" : "：" + _coreAudioError));
                List<EndpointInfo> list = _audio.ListEndpoints();
                var parts = new List<string>(list.Count);
                int bluetooth = 0;
                foreach (EndpointInfo info in list)
                {
                    if (info.IsBluetooth) bluetooth++;
                    parts.Add(info.ToJson());
                }
                return Response.Json(
                    "{\"ok\":true,\"scope\":" + JsonWriter.Str(_audio.Scope) +
                    ",\"count\":" + JsonWriter.Num(list.Count) +
                    ",\"bluetoothCount\":" + JsonWriter.Num(bluetooth) +
                    ",\"endpoints\":[" + string.Join(",", parts.ToArray()) + "]}");
            };

            // 写入端点音量，返回**回读到的实际值**（端点可能 snap 到自己支持的档位）。
            _routes["POST /set"] = delegate (Request r)
            {
                if (_audio == null) return Response.Error(503, "Core Audio 不可用");
                string key = r.Get("key");
                if (string.IsNullOrEmpty(key)) return Response.Error(400, "缺少 key");
                int requested;
                if (!r.TryGetInt("volume", out requested)) return Response.Error(400, "volume 必须是整数");
                if (requested < 0 || requested > 100) return Response.Error(400, "volume 必须在 0..100");

                int applied = _audio.SetVolume(key, requested);
                if (applied < 0) return Response.Error(409, "端点已不在（key=" + key + "）");
                return Response.Json(
                    "{\"ok\":true,\"key\":" + JsonWriter.Str(key) +
                    ",\"requested\":" + JsonWriter.Num(requested) +
                    ",\"applied\":" + JsonWriter.Num(applied) + "}");
            };

            // 静音开关（EarTrumpet 的 OSD 会显示静音状态，这里也一并支持）。
            _routes["POST /mute"] = delegate (Request r)
            {
                if (_audio == null) return Response.Error(503, "Core Audio 不可用");
                string key = r.Get("key");
                if (string.IsNullOrEmpty(key)) return Response.Error(400, "缺少 key");
                string mutedRaw = r.Get("muted", "1");
                bool muted = mutedRaw != "0" && !string.Equals(mutedRaw, "false", StringComparison.OrdinalIgnoreCase);
                if (!_audio.SetMute(key, muted)) return Response.Error(409, "端点已不在（key=" + key + "）");
                return Response.Json("{\"ok\":true,\"key\":" + JsonWriter.Str(key) + ",\"muted\":" + JsonWriter.Bool(muted) + "}");
            };

            // 插件把开关 / 作用范围 / 整张记忆表推过来。
            // 记忆表编码成**单个**参数（记账键里只会出现 A-Za-z0-9 . { } - _，不含 ':' 与 ';'）：
            //   mems={guid}:40;{guid2}:55      memReset=1 表示先清空再应用（「忘记设备」后整表同步用）
            _routes["POST /config"] = delegate (Request r)
            {
                if (_audio == null) return Response.Error(503, "Core Audio 不可用");

                string enabledRaw = r.Get("enabled", "1");
                bool enabled = !(enabledRaw == "0" || string.Equals(enabledRaw, "false", StringComparison.OrdinalIgnoreCase));
                bool reset = r.Get("memReset", "0") == "1";

                var memories = new Dictionary<string, int>(StringComparer.Ordinal);
                int badEntries = 0;
                string mems = r.Get("mems");
                if (!string.IsNullOrEmpty(mems))
                {
                    foreach (string item in mems.Split(';'))
                    {
                        if (item.Length == 0) continue;
                        int sep = item.LastIndexOf(':');
                        if (sep <= 0) { badEntries++; continue; }
                        int value;
                        if (!int.TryParse(item.Substring(sep + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
                        {
                            badEntries++;
                            continue;
                        }
                        memories[item.Substring(0, sep)] = value;
                    }
                }

                _audio.ApplyConfig(enabled, r.Get("scope", "bth"), reset, memories);
                return Response.Json(
                    "{\"ok\":true,\"enabled\":" + JsonWriter.Bool(_audio.Enabled) +
                    ",\"scope\":" + JsonWriter.Str(_audio.Scope) +
                    ",\"memoryCount\":" + JsonWriter.Num(_audio.MemoryCount) +
                    ",\"badEntries\":" + JsonWriter.Num(badEntries) + "}");
            };

            // 忘记单个设备：只删「下次重连要恢复的值」，设备本身不受影响。
            _routes["POST /forget"] = delegate (Request r)
            {
                if (_audio == null) return Response.Error(503, "Core Audio 不可用");
                string key = r.Get("key");
                if (string.IsNullOrEmpty(key)) return Response.Error(400, "缺少 key");
                bool removed = _audio.Forget(key);
                return Response.Json("{\"ok\":true,\"key\":" + JsonWriter.Str(key) +
                    ",\"removed\":" + JsonWriter.Bool(removed) +
                    ",\"memoryCount\":" + JsonWriter.Num(_audio.MemoryCount) + "}");
            };

            // 调试端点（仅 --debug 时注册）：把指定端点当成「刚重连」跑一遍恢复流程。
            // 真机上验证重连只能靠物理断电重连耳机，无法自动化，所以留这个口子给脚本用。
            if (_opt.Debug)
            {
                _routes["POST /debug/reconnect"] = delegate (Request r)
                {
                    if (_audio == null) return Response.Error(503, "Core Audio 不可用");
                    string id = r.Get("id");
                    if (string.IsNullOrEmpty(id)) return Response.Error(400, "缺少 id（完整端点 id）");
                    _audio.SimulateDeviceArrived(id);
                    return Response.Json("{\"ok\":true,\"simulated\":\"added\",\"id\":" + JsonWriter.Str(id) + "}");
                };
            }

            // 取走并清空自上次调用以来累积的设备增删 / 音量变化事件。
            _routes["GET /events"] = delegate (Request r)
            {
                if (_audio == null) return Response.Error(503, "Core Audio 不可用");

                List<DeviceEvent> deviceEvents = _audio.TakeDeviceEvents();
                List<VolumeEvent> volumeEvents = _audio.TakeVolumeEvents();
                List<AudioEndpointService.RestoredEvent> restoredEvents = _audio.TakeRestoredEvents();

                var devParts = new List<string>(deviceEvents.Count);
                foreach (DeviceEvent e in deviceEvents)
                {
                    devParts.Add("{\"kind\":" + JsonWriter.Str(e.Kind)
                        + ",\"key\":" + JsonWriter.Str(e.Key)
                        + ",\"at\":" + JsonWriter.Str(e.AtUtc.ToString("o"))
                        + ",\"endpoint\":" + (e.Info == null ? "null" : e.Info.ToJson()) + "}");
                }

                var volParts = new List<string>(volumeEvents.Count);
                foreach (VolumeEvent e in volumeEvents)
                {
                    volParts.Add("{\"key\":" + JsonWriter.Str(e.Key)
                        + ",\"volume\":" + JsonWriter.Num(e.Volume)
                        + ",\"muted\":" + JsonWriter.Bool(e.Muted)
                        + ",\"at\":" + JsonWriter.Str(e.AtUtc.ToString("o")) + "}");
                }

                var restoredParts = new List<string>(restoredEvents.Count);
                foreach (AudioEndpointService.RestoredEvent e in restoredEvents)
                {
                    restoredParts.Add("{\"key\":" + JsonWriter.Str(e.Key)
                        + ",\"name\":" + JsonWriter.Str(e.Name)
                        + ",\"enumerator\":" + JsonWriter.Str(e.Enumerator)
                        + ",\"isBluetooth\":" + JsonWriter.Bool(e.IsBluetooth)
                        + ",\"rememberedVolume\":" + JsonWriter.Num(e.RememberedVolume)
                        + ",\"previousVolume\":" + JsonWriter.Num(e.PreviousVolume)
                        + ",\"appliedVolume\":" + JsonWriter.Num(e.AppliedVolume)
                        + ",\"muted\":" + JsonWriter.Bool(e.Muted)
                        + ",\"announce\":" + JsonWriter.Bool(e.Announce)
                        + ",\"at\":" + JsonWriter.Str(e.AtUtc.ToString("o")) + "}");
                }

                return Response.Json(
                    "{\"ok\":true,\"deviceEvents\":[" + string.Join(",", devParts.ToArray()) +
                    "],\"volumeEvents\":[" + string.Join(",", volParts.ToArray()) +
                    "],\"restoredEvents\":[" + string.Join(",", restoredParts.ToArray()) + "]}");
            };
        }

        private readonly DateTime _startedUtc = DateTime.UtcNow;

        internal bool Start(out string error)
        {
            error = null;
            try
            {
                _listener = new TcpListener(IPAddress.Loopback, _opt.Port);
                _listener.Server.ExclusiveAddressUse = true;
                _listener.Start();
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }

            _acceptThread = new Thread(AcceptLoop);
            _acceptThread.IsBackground = true;
            _acceptThread.Name = "http-accept";
            _acceptThread.Start();
            return true;
        }

        internal void Stop()
        {
            _stopping = true;
            try { if (_listener != null) _listener.Stop(); } catch { }
            try { if (_acceptThread != null) _acceptThread.Join(1500); } catch { }
        }

        private void AcceptLoop()
        {
            while (!_stopping)
            {
                TcpClient client = null;
                try { client = _listener.AcceptTcpClient(); }
                catch { if (_stopping) return; continue; }

                // 每个连接一个线程：请求量极低（每几秒一次 + 一次长轮询），不值得上线程池调度。
                TcpClient captured = client;
                var t = new Thread(delegate () { HandleConnection(captured); });
                t.IsBackground = true;
                t.Name = "http-conn";
                t.Start();
            }
        }

        private void HandleConnection(TcpClient client)
        {
            try
            {
                client.ReceiveTimeout = 15000;
                client.SendTimeout = 15000;
                using (client)
                using (NetworkStream stream = client.GetStream())
                {
                    Request req = ReadRequest(stream);
                    if (req == null) return;

                    _lastActivityUtc = DateTime.UtcNow;

                    // 令牌校验放在最前面：既做鉴权，也做「这是不是本插件的 helper」的身份标识。
                    string token = req.Get("t");
                    if (!string.Equals(token, _opt.Token, StringComparison.Ordinal))
                    {
                        WriteResponse(stream, Response.Error(403, "令牌无效"));
                        return;
                    }

                    string key = req.Method + " " + req.Path;
                    Func<Request, Response> handler;
                    Response resp;
                    if (!_routes.TryGetValue(key, out handler))
                    {
                        resp = Response.Error(404, "未知接口 " + key);
                    }
                    else
                    {
                        try
                        {
                            resp = handler(req);
                        }
                        catch (Exception ex)
                        {
                            Program.Log("处理 " + key + " 失败: " + ex);
                            resp = Response.Error(500, ex.Message);
                        }
                    }

                    if (resp == null) resp = Response.Error(500, "处理器返回空");
                    WriteResponse(stream, resp);
                }
            }
            catch (Exception ex)
            {
                Program.Log("连接处理失败（忽略）: " + ex.Message);
            }
        }

        // ---- 极简 HTTP/1.1 解析：只支持我们自己的客户端需要的部分 ----

        private static Request ReadRequest(NetworkStream stream)
        {
            const int maxHeader = 16 * 1024;
            var buffer = new MemoryStream();
            var chunk = new byte[1024];
            int headerEnd = -1;

            while (headerEnd < 0)
            {
                int n = stream.Read(chunk, 0, chunk.Length);
                if (n <= 0) return null;
                buffer.Write(chunk, 0, n);
                if (buffer.Length > maxHeader) throw new InvalidDataException("请求头过大");
                headerEnd = FindHeaderEnd(buffer.GetBuffer(), (int)buffer.Length);
            }

            byte[] all = buffer.GetBuffer();
            string headerText = Encoding.ASCII.GetString(all, 0, headerEnd);
            string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0 || lines[0].Length == 0) return null;

            string[] parts = lines[0].Split(' ');
            if (parts.Length < 3) throw new InvalidDataException("请求行非法: " + lines[0]);

            var req = new Request();
            req.Method = parts[0].ToUpperInvariant();

            string target = parts[1];
            int q = target.IndexOf('?');
            if (q >= 0)
            {
                req.Path = target.Substring(0, q);
                req.Query = ParsePairs(target.Substring(q + 1));
            }
            else
            {
                req.Path = target;
            }

            int contentLength = 0;
            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon <= 0) continue;
                string name = lines[i].Substring(0, colon).Trim();
                string value = lines[i].Substring(colon + 1).Trim();
                if (string.Equals(name, "Content-Length", StringComparison.OrdinalIgnoreCase))
                {
                    int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out contentLength);
                }
            }

            if (contentLength > 0)
            {
                if (contentLength > 1024 * 1024) throw new InvalidDataException("请求体过大");
                int bodyStart = headerEnd + 4;
                var body = new MemoryStream();
                if (all.Length > bodyStart) body.Write(all, bodyStart, all.Length - bodyStart);
                while (body.Length < contentLength)
                {
                    int n = stream.Read(chunk, 0, chunk.Length);
                    if (n <= 0) break;
                    body.Write(chunk, 0, n);
                }
                byte[] bodyBytes = body.GetBuffer();
                int take = Math.Min(contentLength, (int)body.Length);
                req.Body = Encoding.UTF8.GetString(bodyBytes, 0, take);

                string contentType = "";
                for (int i = 1; i < lines.Length; i++)
                {
                    int colon = lines[i].IndexOf(':');
                    if (colon <= 0) continue;
                    if (string.Equals(lines[i].Substring(0, colon).Trim(), "Content-Type", StringComparison.OrdinalIgnoreCase))
                    {
                        contentType = lines[i].Substring(colon + 1).Trim();
                    }
                }
                if (contentType.StartsWith("application/x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase))
                {
                    req.Form = ParsePairs(req.Body);
                }
            }

            return req;
        }

        private static int FindHeaderEnd(byte[] data, int length)
        {
            for (int i = 0; i + 3 < length; i++)
            {
                if (data[i] == 13 && data[i + 1] == 10 && data[i + 2] == 13 && data[i + 3] == 10) return i;
            }
            return -1;
        }

        private static Dictionary<string, string> ParsePairs(string text)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(text)) return map;
            foreach (string pair in text.Split('&'))
            {
                if (pair.Length == 0) continue;
                int eq = pair.IndexOf('=');
                string k = eq >= 0 ? pair.Substring(0, eq) : pair;
                string v = eq >= 0 ? pair.Substring(eq + 1) : "";
                map[UrlDecode(k)] = UrlDecode(v);
            }
            return map;
        }

        private static string UrlDecode(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return Uri.UnescapeDataString(s.Replace("+", " "));
        }

        private static void WriteResponse(NetworkStream stream, Response resp)
        {
            byte[] body = Encoding.UTF8.GetBytes(resp.Body ?? "");
            var head = new StringBuilder();
            head.Append("HTTP/1.1 ").Append(resp.Status).Append(' ').Append(StatusText(resp.Status)).Append("\r\n");
            head.Append("Content-Type: ").Append(resp.ContentType).Append("\r\n");
            head.Append("Content-Length: ").Append(body.Length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            head.Append("Cache-Control: no-store\r\n");
            head.Append("Connection: close\r\n\r\n");
            byte[] headBytes = Encoding.ASCII.GetBytes(head.ToString());
            stream.Write(headBytes, 0, headBytes.Length);
            if (body.Length > 0) stream.Write(body, 0, body.Length);
            stream.Flush();
        }

        private static string StatusText(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 400: return "Bad Request";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 409: return "Conflict";
                case 500: return "Internal Server Error";
                case 503: return "Service Unavailable";
                default: return "Status";
            }
        }
    }

    // ------------------------------------------------------------------ JSON 输出

    internal static class JsonWriter
    {
        internal static string Str(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        internal static string Num(long value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        internal static string Bool(bool value)
        {
            return value ? "true" : "false";
        }
    }
}
