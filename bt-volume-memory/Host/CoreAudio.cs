// ============================================================================================
// CoreAudio —— Windows 音频端点（Core Audio）的枚举、音量读写与事件订阅
// ============================================================================================
//
// 【与参考项目的关系】
//   本文件的 COM interop 定义（接口 IID / 方法顺序 / PROPERTYKEY 值 / PropVariant 布局）
//   移植自 EarTrumpet 的 Interop/MMDeviceAPI 与 Interop/PropertyKeys.cs。
//   EarTrumpet 是 MIT 许可（https://github.com/File-New-Project/EarTrumpet），
//   本项目为独立实现，仅沿用其 interface 声明与行为契约。行为契约对照：
//     * 只取渲染端点（eRender）、只取 ACTIVE 状态
//     * 按「端点 GUID」记账：砍掉 id 里最后一个 '.' 之前的部分（{0.0.0.00000000}.{guid}）
//       —— 音频适配器容器重建时，尾部 GUID 仍然有效
//     * 蓝牙判定：端点属性 DEVPKEY_Device_EnumeratorName 以 "BTH" 开头
//       （BTHENUM = A2DP / BTHHFENUM = 免手持 / BTHLEENUM = LE Audio）
//     * 音量走 GetMasterVolumeLevelScalar / SetMasterVolumeLevelScalar（0..1 原始标量）
//     * 写入后必须**回读实际值** —— 端点可能 snap 到自己支持的档位
//     * 写入时带一个固定的 guidEventContext，用于在回调里识别「这是我自己写的」并忽略，
//       否则恢复动作会立刻被当成用户改音量，产生回写回声
//
// ============================================================================================

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace VolumeHelper.Interop
{
    // 这几个类型必须是 public：公开接口 IMMNotificationClient 的方法签名里用到它们，
    // 声明成 internal 会直接编译失败（CS0059/CS0051）。EarTrumpet 里同样是 public。
    public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }

    public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [Flags]
    public enum DeviceState : uint
    {
        ACTIVE = 0x00000001,
        DISABLED = 0x00000002,
        NOTPRESENT = 0x00000004,
        UNPLUGGED = 0x00000008,
        MASK_ALL = 0x0000000F,
    }

    public enum STGM { STGM_READ = 0 }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public UIntPtr pid;
    }

    [StructLayout(LayoutKind.Explicit, Pack = 1)]
    internal struct PropVariant
    {
        [FieldOffset(0)] public VarEnum varType;
        [FieldOffset(2)] public ushort wReserved1;
        [FieldOffset(4)] public ushort wReserved2;
        [FieldOffset(6)] public ushort wReserved3;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    /// <summary>AUDIO_VOLUME_NOTIFICATION_DATA。后面的 afChannelVolumes 是柔性数组，用 IntPtr 占位。</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct AudioVolumeNotificationData
    {
        public Guid guidEventContext;
        public int bMuted;
        public float fMasterVolume;
        public uint nChannels;
        public IntPtr afChannelVolumes;
    }

    internal static class PropertyKeys
    {
        internal static PROPERTYKEY DeviceFriendlyName()
        {
            return new PROPERTYKEY
            {
                fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
                pid = new UIntPtr(14),
            };
        }

        internal static PROPERTYKEY DeviceEnumeratorName()
        {
            return new PROPERTYKEY
            {
                fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
                pid = new UIntPtr(24),
            };
        }
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        PropVariant GetValue(ref PROPERTYKEY key);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PropVariant pv);
        [PreserveSig] int Commit();
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        void Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams,
                      [MarshalAs(UnmanagedType.Interface)] out object ppInterface);
        [return: MarshalAs(UnmanagedType.Interface)]
        IPropertyStore OpenPropertyStore(STGM stgmAccess);
        [return: MarshalAs(UnmanagedType.LPWStr)]
        string GetId();
        DeviceState GetState();
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        uint GetCount();
        [return: MarshalAs(UnmanagedType.Interface)]
        IMMDevice Item(uint nDevice);
    }

    [Guid("1BE09788-6894-4089-8586-9A2A6C265AC5")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMEndpoint
    {
        EDataFlow GetDataFlow();
    }

    [Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMNotificationClient
    {
        void OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId, DeviceState dwNewState);
        void OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId);
        void OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId);
        void OnDefaultDeviceChanged(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.LPWStr)] string pwstrDefaultDeviceId);
        void OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string pwstrDeviceId, PROPERTYKEY key);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [return: MarshalAs(UnmanagedType.Interface)]
        IMMDeviceCollection EnumAudioEndpoints(EDataFlow dataFlow, DeviceState dwStateMask);
        [return: MarshalAs(UnmanagedType.Interface)]
        IMMDevice GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role);
        [return: MarshalAs(UnmanagedType.Interface)]
        IMMDevice GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId);
        void RegisterEndpointNotificationCallback([MarshalAs(UnmanagedType.Interface)] IMMNotificationClient pClient);
        void UnregisterEndpointNotificationCallback([MarshalAs(UnmanagedType.Interface)] IMMNotificationClient pClient);
    }

    [Guid("657804FA-D6AD-4496-8A60-352752AF4F89")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolumeCallback
    {
        void OnNotify(IntPtr pNotify);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        void RegisterControlChangeNotify([MarshalAs(UnmanagedType.Interface)] IAudioEndpointVolumeCallback pNotify);
        void UnregisterControlChangeNotify([MarshalAs(UnmanagedType.Interface)] IAudioEndpointVolumeCallback pNotify);
        uint GetChannelCount();
        void SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        void SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        void GetMasterVolumeLevel(out float pfLevelDB);
        void GetMasterVolumeLevelScalar(out float pfLevel);
        void SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        void SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        void GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        float GetChannelVolumeLevelScalar(uint nChannel);
        void SetMute(int bMute, ref Guid pguidEventContext);
        int GetMute();
        void GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
        void VolumeStepUp(ref Guid pguidEventContext);
        void VolumeStepDown(ref Guid pguidEventContext);
        void QueryHardwareSupport(out uint pdwHardwareSupportMask);
        void GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator { }

    internal static class Ole32
    {
        [DllImport("ole32.dll")]
        internal static extern int PropVariantClear(ref PropVariant pvar);
    }
}

namespace VolumeHelper
{
    using VolumeHelper.Interop;

    /// <summary>一个音频端点对插件可见的全部信息。</summary>
    internal sealed class EndpointInfo
    {
        internal string Key = "";          // 记账键（端点 GUID）
        internal string Id = "";           // 完整端点 id
        internal string Name = "";         // 友好名
        internal string Enumerator = "";   // 枚举器名（BTHENUM / USB / HDAUDIO …）
        internal bool IsBluetooth;
        internal int Volume;               // 0..100
        internal bool Muted;
        internal bool Active;

        internal string ToJson()
        {
            return "{\"key\":" + JsonWriter.Str(Key)
                 + ",\"id\":" + JsonWriter.Str(Id)
                 + ",\"name\":" + JsonWriter.Str(Name)
                 + ",\"enumerator\":" + JsonWriter.Str(Enumerator)
                 + ",\"isBluetooth\":" + JsonWriter.Bool(IsBluetooth)
                 + ",\"volume\":" + JsonWriter.Num(Volume)
                 + ",\"muted\":" + JsonWriter.Bool(Muted)
                 + ",\"active\":" + JsonWriter.Bool(Active)
                 + "}";
        }
    }

    /// <summary>一次音量变化事件（来自用户操作，不含本机自己写入的）。</summary>
    internal sealed class VolumeEvent
    {
        internal string Key = "";
        internal int Volume;
        internal bool Muted;
        internal DateTime AtUtc = DateTime.UtcNow;
    }

    /// <summary>端点增删事件。</summary>
    internal sealed class DeviceEvent
    {
        internal string Kind = "";   // added | removed
        internal string Key = "";
        internal EndpointInfo Info;  // added 时带最新快照
        internal DateTime AtUtc = DateTime.UtcNow;
    }

    /// <summary>
    /// Core Audio 服务：枚举渲染端点、读写音量、订阅端点与音量变化。
    /// 所有 COM 调用都在 try/catch 里 —— 端点随时可能被拔掉，抛异常是常态而不是异常情况。
    /// </summary>
    internal sealed class AudioEndpointService : IDisposable
    {
        /// <summary>
        /// 本服务自己写入音量时使用的事件上下文。
        /// 非空是刻意的：回调里靠它区分「我写的」与「用户改的」，否则恢复动作会被当成用户输入再写回去。
        /// </summary>
        private static readonly Guid SelfEventContext = new Guid("7f2c1d64-9a4b-4f0e-9c31-6b2a5d8e4c77");

        private readonly IMMDeviceEnumerator _enumerator;
        private readonly NotificationClient _notificationClient;

        private readonly object _lock = new object();
        private readonly Dictionary<string, WatchedEndpoint> _watched =
            new Dictionary<string, WatchedEndpoint>(StringComparer.Ordinal);
        private readonly List<DeviceEvent> _deviceEvents = new List<DeviceEvent>();
        private readonly List<VolumeEvent> _volumeEvents = new List<VolumeEvent>();

        /// <summary>早于这个时间点的事件不再保留，防止插件长时间不取导致内存增长。</summary>
        private static readonly TimeSpan EventRetention = TimeSpan.FromMinutes(2);
        private const int MaxQueuedEvents = 500;

        /// <summary>监视范围：bth = 仅蓝牙端点；all = 所有渲染端点。</summary>
        private volatile string _scope = "bth";

        /// <summary>
        /// 记忆开关。关掉时**既不记忆也不恢复** —— 这点很关键：开着记忆但关掉开关时，
        /// 不能拿设备当前碰巧的值去覆盖已有的好值。
        /// </summary>
        private volatile bool _enabled = true;

        /// <summary>
        /// 记忆表：记账键 → 音量百分比（1..100；0 与越界值一律视为「不是用户的选择」）。
        /// 由插件通过 POST /config 推过来；**策略源在插件那边**（持久化在插件存储里），
        /// 这里只保留一份即时可用的副本，因为设备重连必须立刻恢复 —— 等一轮 HTTP 往返
        /// 意味着用户会先被蓝牙栈的默认音量轰一下。
        /// </summary>
        private readonly Dictionary<string, int> _memories = new Dictionary<string, int>(StringComparer.Ordinal);

        /// <summary>EarTrumpet 的取值域：低于 1 或高于 100 都不算用户选择。</summary>
        internal const int MinRememberedVolume = 1;
        internal const int MaxRememberedVolume = 100;

        /// <summary>本端点集合是否已经完成过一次初始枚举（初始枚举不产生 added 事件）。</summary>
        private bool _primed;

        internal AudioEndpointService(string scope)
        {
            _scope = NormalizeScope(scope);
            _enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            _notificationClient = new NotificationClient(this);
            _enumerator.RegisterEndpointNotificationCallback(_notificationClient);
        }

        internal string Scope
        {
            get { return _scope; }
            set { _scope = NormalizeScope(value); }
        }

        private static string NormalizeScope(string scope)
        {
            return string.Equals(scope, "all", StringComparison.OrdinalIgnoreCase) ? "all" : "bth";
        }

        private bool InScope(string enumeratorName)
        {
            if (_scope == "all") return true;
            return IsBluetoothEnumerator(enumeratorName);
        }

        /// <summary>蓝牙音频端点的枚举器名：BTHENUM(A2DP) / BTHHFENUM(免手持) / BTHLEENUM(LE Audio)。</summary>
        internal static bool IsBluetoothEnumerator(string enumeratorName)
        {
            return !string.IsNullOrEmpty(enumeratorName)
                && enumeratorName.StartsWith("BTH", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// 记账键：只取端点 id 最后一个 '.' 之后的部分（即尾部 GUID）。
        /// 前缀 "{0.0.0.00000000}." 标识音频适配器容器，容器重建时尾部 GUID 仍然有效。
        /// 非白名单字符替换为 '_'（这个键会进插件设置存储）。
        /// </summary>
        internal static string GetStorageKey(string deviceId)
        {
            if (string.IsNullOrEmpty(deviceId)) return "";

            int lastDot = deviceId.LastIndexOf('.');
            string unique = lastDot >= 0 ? deviceId.Substring(lastDot + 1) : deviceId;

            char[] chars = unique.ToCharArray();
            for (int i = 0; i < chars.Length; i++)
            {
                char c = chars[i];
                bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                          || c == '.' || c == '{' || c == '}' || c == '-' || c == '_';
                if (!ok) chars[i] = '_';
            }
            return new string(chars);
        }

        // ------------------------------------------------------------ 枚举

        /// <summary>枚举当前 ACTIVE 的渲染端点。读的是实时音量，不做缓存。</summary>
        internal List<EndpointInfo> ListEndpoints()
        {
            var result = new List<EndpointInfo>();
            try
            {
                IMMDeviceCollection collection = _enumerator.EnumAudioEndpoints(EDataFlow.eRender, DeviceState.ACTIVE);
                if (collection == null) return result;
                uint count = collection.GetCount();
                for (uint i = 0; i < count; i++)
                {
                    IMMDevice device = null;
                    try
                    {
                        device = collection.Item(i);
                        if (device == null) continue;

                        string id = device.GetId();
                        string key = GetStorageKey(id);
                        if (string.IsNullOrEmpty(key)) continue;

                        PropertyBag props = ReadProperties(device);
                        if (!InScope(props.Enumerator))
                        {
                            Release(device);
                            continue;
                        }

                        IAudioEndpointVolume volume = ActivateVolume(device);
                        if (volume == null)
                        {
                            Release(device);
                            continue;
                        }

                        var info = new EndpointInfo
                        {
                            Key = key,
                            Id = id,
                            Name = props.Name,
                            Enumerator = props.Enumerator,
                            IsBluetooth = IsBluetoothEnumerator(props.Enumerator),
                            Volume = ReadScalarPercent(volume),
                            Muted = volume.GetMute() != 0,
                            Active = true,
                        };
                        result.Add(info);

                        Release(volume);
                        Release(device);
                    }
                    catch (Exception ex)
                    {
                        Program.Log("枚举端点失败（跳过）: " + ex.Message);
                        if (device != null) Release(device);
                    }
                }
                Release(collection);
            }
            catch (Exception ex)
            {
                Program.Log("EnumAudioEndpoints 失败: " + ex.Message);
            }
            return result;
        }

        /// <summary>按记账键取单个端点的最新快照；不存在返回 null。</summary>
        internal EndpointInfo TryGetEndpoint(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            foreach (EndpointInfo info in ListEndpoints())
            {
                if (string.Equals(info.Key, key, StringComparison.Ordinal)) return info;
            }
            return null;
        }

        // ------------------------------------------------------------ 读写音量

        internal int GetVolume(string key)
        {
            EndpointInfo info = TryGetEndpoint(key);
            return info == null ? -1 : info.Volume;
        }

        /// <summary>
        /// 写入音量并**回读实际值**（端点可能 snap 到自己支持的档位，请求值不一定等于生效值）。
        /// 返回 -1 表示端点已不在。
        /// </summary>
        internal int SetVolume(string key, int percent)
        {
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;

            using (EndpointHandle handle = OpenByKey(key))
            {
                if (handle == null || handle.Volume == null) return -1;
                Guid context = SelfEventContext;
                handle.Volume.SetMasterVolumeLevelScalar(percent / 100f, ref context);
                return ReadScalarPercent(handle.Volume);
            }
        }

        internal bool SetMute(string key, bool muted)
        {
            using (EndpointHandle handle = OpenByKey(key))
            {
                if (handle == null || handle.Volume == null) return false;
                Guid context = SelfEventContext;
                handle.Volume.SetMute(muted ? 1 : 0, ref context);
                return handle.Volume.GetMute() != 0;
            }
        }

        // ------------------------------------------------------------ 事件队列

        internal List<DeviceEvent> TakeDeviceEvents()
        {
            lock (_lock)
            {
                var copy = new List<DeviceEvent>(_deviceEvents);
                _deviceEvents.Clear();
                return copy;
            }
        }

        internal List<VolumeEvent> TakeVolumeEvents()
        {
            lock (_lock)
            {
                var copy = new List<VolumeEvent>(_volumeEvents);
                _volumeEvents.Clear();
                return copy;
            }
        }

        internal int PendingEventCount
        {
            get { lock (_lock) { return _deviceEvents.Count + _volumeEvents.Count; } }
        }

        /// <summary>
        /// 第一次枚举：把已经在的端点订阅起来，但**不**产生 added 事件 ——
        /// 这些设备在插件启动前就已经连着，弹出「已恢复音量」是噪音。
        /// </summary>
        internal void Prime()
        {
            if (_primed) return;
            _primed = true;
            foreach (EndpointInfo info in ListEndpoints())
            {
                Watch(info.Id);
            }
            Program.Log("初始枚举完成，监视 " + _watched.Count + " 个端点（不产生 added 事件）");
        }

        // ------------------------------------------------------------ 内部

        private sealed class PropertyBag
        {
            internal string Name = "";
            internal string Enumerator = "";
        }

        private static PropertyBag ReadProperties(IMMDevice device)
        {
            var bag = new PropertyBag();
            IPropertyStore store = null;
            try
            {
                store = device.OpenPropertyStore(STGM.STGM_READ);
                if (store == null) return bag;
                bag.Name = ReadString(store, PropertyKeys.DeviceFriendlyName());
                bag.Enumerator = ReadString(store, PropertyKeys.DeviceEnumeratorName());
            }
            catch (Exception ex)
            {
                Program.Log("读取端点属性失败: " + ex.Message);
            }
            finally
            {
                Release(store);
            }
            return bag;
        }

        private static string ReadString(IPropertyStore store, PROPERTYKEY key)
        {
            PropVariant pv = default(PropVariant);
            try
            {
                pv = store.GetValue(ref key);
                if (pv.varType == VarEnum.VT_LPWSTR && pv.pwszVal != IntPtr.Zero)
                {
                    return Marshal.PtrToStringUni(pv.pwszVal) ?? "";
                }
                return "";
            }
            catch
            {
                return "";
            }
            finally
            {
                try { Ole32.PropVariantClear(ref pv); } catch { }
            }
        }

        private static IAudioEndpointVolume ActivateVolume(IMMDevice device)
        {
            try
            {
                Guid iid = typeof(IAudioEndpointVolume).GUID;
                object raw;
                device.Activate(ref iid, 0x1 /* CLSCTX_INPROC_SERVER */, IntPtr.Zero, out raw);
                return raw as IAudioEndpointVolume;
            }
            catch (Exception ex)
            {
                Program.Log("Activate(IAudioEndpointVolume) 失败: " + ex.Message);
                return null;
            }
        }

        private static int ReadScalarPercent(IAudioEndpointVolume volume)
        {
            float scalar;
            volume.GetMasterVolumeLevelScalar(out scalar);
            return ToPercent(scalar);
        }

        private static int ToPercent(float scalar)
        {
            float bounded = scalar < 0f ? 0f : (scalar > 1f ? 1f : scalar);
            return (int)Math.Round(bounded * 100f, MidpointRounding.AwayFromZero);
        }

        private sealed class EndpointHandle : IDisposable
        {
            internal IMMDevice Device;
            internal IAudioEndpointVolume Volume;

            public void Dispose()
            {
                if (Volume != null) { Release(Volume); Volume = null; }
                if (Device != null) { Release(Device); Device = null; }
            }
        }

        /// <summary>按记账键打开端点（每次现开现关，端点随时可能消失）。</summary>
        private EndpointHandle OpenByKey(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            try
            {
                IMMDeviceCollection collection = _enumerator.EnumAudioEndpoints(EDataFlow.eRender, DeviceState.ACTIVE);
                if (collection == null) return null;
                try
                {
                    uint count = collection.GetCount();
                    for (uint i = 0; i < count; i++)
                    {
                        IMMDevice device = null;
                        try
                        {
                            device = collection.Item(i);
                            if (device == null) continue;
                            if (!string.Equals(GetStorageKey(device.GetId()), key, StringComparison.Ordinal))
                            {
                                Release(device);
                                continue;
                            }
                            IAudioEndpointVolume volume = ActivateVolume(device);
                            if (volume == null) { Release(device); continue; }
                            return new EndpointHandle { Device = device, Volume = volume };
                        }
                        catch
                        {
                            if (device != null) Release(device);
                        }
                    }
                }
                finally
                {
                    Release(collection);
                }
                return null;
            }
            catch (Exception ex)
            {
                Program.Log("OpenByKey 失败: " + ex.Message);
                return null;
            }
        }

        private sealed class WatchedEndpoint
        {
            internal string Id = "";
            internal IMMDevice Device;
            internal IAudioEndpointVolume Volume;
            internal VolumeChangeSink Sink;
        }

        private void Watch(string deviceId)
        {
            string key = GetStorageKey(deviceId);
            if (string.IsNullOrEmpty(key)) return;

            lock (_lock)
            {
                if (_watched.ContainsKey(key)) return;
            }

            try
            {
                IMMDevice device = _enumerator.GetDevice(deviceId);
                if (device == null) return;

                PropertyBag props = ReadProperties(device);
                if (!InScope(props.Enumerator))
                {
                    Release(device);
                    return;
                }

                IAudioEndpointVolume volume = ActivateVolume(device);
                if (volume == null)
                {
                    Release(device);
                    return;
                }

                var watched = new WatchedEndpoint { Id = deviceId, Device = device, Volume = volume };
                watched.Sink = new VolumeChangeSink(this, key);
                volume.RegisterControlChangeNotify(watched.Sink);

                lock (_lock)
                {
                    if (_watched.ContainsKey(key))
                    {
                        // 竞态：另一个线程已经订阅了同一个端点，回滚这一份。
                        try { volume.UnregisterControlChangeNotify(watched.Sink); } catch { }
                        Release(volume);
                        Release(device);
                        return;
                    }
                    _watched[key] = watched;
                }
            }
            catch (Exception ex)
            {
                Program.Log("订阅端点 " + key + " 失败: " + ex.Message);
            }
        }

        private void Unwatch(string key)
        {
            WatchedEndpoint watched;
            lock (_lock)
            {
                if (!_watched.TryGetValue(key, out watched)) return;
                _watched.Remove(key);
            }
            try { if (watched.Volume != null) watched.Volume.UnregisterControlChangeNotify(watched.Sink); } catch { }
            Release(watched.Volume);
            Release(watched.Device);
        }

        private static void Release(object comObject)
        {
            if (comObject == null) return;
            try { Marshal.ReleaseComObject(comObject); } catch { }
        }

        // ------------------------------------------------------------ 配置（插件推过来）

        private readonly List<RestoredEvent> _restoredEvents = new List<RestoredEvent>();

        /// <summary>
        /// 插件推来开关、作用范围与整张记忆表。记忆表的编码见 HttpBridge 的 /config 路由。
        /// 作用范围变化时不退订已订阅的端点（无副作用），只影响之后新增端点的过滤判定。
        /// </summary>
        internal void ApplyConfig(bool enabled, string scope, bool resetMemories, Dictionary<string, int> memories)
        {
            _enabled = enabled;
            _scope = NormalizeScope(scope);
            lock (_lock)
            {
                if (resetMemories) _memories.Clear();
                if (memories == null) return;
                foreach (KeyValuePair<string, int> pair in memories)
                {
                    // 越界值不进表：0 通常是蓝牙栈在断开过程中打出来的，不是用户的选择。
                    if (pair.Value >= MinRememberedVolume && pair.Value <= MaxRememberedVolume)
                    {
                        _memories[pair.Key] = pair.Value;
                    }
                }
            }
        }

        /// <summary>删掉一个设备的记忆。设备本身一个字节都不动 —— 只删「下次重连时要恢复的值」。
        /// 下次用户再动音量时会重新学到，这正是这个操作的意义：它是给「不再想要的记录」用的，
        /// 不是用来关掉功能的（关功能请用开关）。</summary>
        internal bool Forget(string key)
        {
            lock (_lock)
            {
                return _memories.Remove(key);
            }
        }

        internal bool Enabled { get { return _enabled; } }

        internal int MemoryCount { get { lock (_lock) { return _memories.Count; } } }

        internal int PendingEventCountAll
        {
            get { lock (_lock) { return _deviceEvents.Count + _volumeEvents.Count + _restoredEvents.Count; } }
        }

        internal List<RestoredEvent> TakeRestoredEvents()
        {
            lock (_lock)
            {
                var copy = new List<RestoredEvent>(_restoredEvents);
                _restoredEvents.Clear();
                return copy;
            }
        }

        /// <summary>一次「重连后把记忆音量写回去了」的记录，插件拿它弹浮层。</summary>
        internal sealed class RestoredEvent
        {
            internal string Key = "";
            internal string Name = "";
            internal string Enumerator = "";
            internal bool IsBluetooth;
            internal int RememberedVolume;
            internal int PreviousVolume;
            internal int AppliedVolume;
            internal bool Muted;
            internal bool Announce;
            internal DateTime AtUtc = DateTime.UtcNow;
        }

        /// <summary>
        /// 调试用入口：把某个端点当成「刚刚重新连上」走一遍完整流程（订阅 + 恢复 + 报事件）。
        /// 只有 <c>--debug</c> 时 <c>/debug/reconnect</c> 会调它；生产链路上没有任何调用点。
        /// </summary>
        internal void SimulateDeviceArrived(string deviceId)
        {
            OnDeviceArrived(deviceId);
        }

        // ---- 由 COM 回调线程调用：只做必要的写回，其余入队后立刻返回 ----

        private void OnDeviceArrived(string deviceId)
        {
            string key = GetStorageKey(deviceId);
            if (string.IsNullOrEmpty(key)) return;

            Watch(deviceId);
            lock (_lock)
            {
                if (!_watched.ContainsKey(key)) return;    // 不在作用范围内
            }

            EndpointInfo info = TryGetEndpoint(key);
            if (info != null)
            {
                TryRestoreOnReconnect(key, info);
            }

            lock (_lock)
            {
                _deviceEvents.Add(new DeviceEvent { Kind = "added", Key = key, Info = info });
                Trim();
            }
        }

        /// <summary>
        /// 端点重新出现且有记忆音量时把它写回去。
        ///
        /// **必须在这里、立刻做**：蓝牙耳机断电时端点被销毁、重连时重建，Windows 为端点维护的音量
        /// 随之丢失，重连后通常是蓝牙栈决定的默认值（往往大得吓人）。如果等插件那一轮 HTTP 往返，
        /// 用户会先被这个默认音量轰一下再被调回来。
        ///
        /// 与 EarTrumpet 的取舍一致：即使当前值已经等于记忆值也要报事件 ——
        /// 浮层是用户知道「它现在是几格」的唯一途径。
        /// </summary>
        private void TryRestoreOnReconnect(string key, EndpointInfo info)
        {
            if (!_enabled) return;

            int remembered;
            lock (_lock)
            {
                if (!_memories.TryGetValue(key, out remembered)) return;
            }
            if (remembered < MinRememberedVolume || remembered > MaxRememberedVolume) return;

            int current = info.Volume;
            int applied = remembered;

            if (current != remembered)
            {
                applied = SetVolume(key, remembered);
                if (applied < 0)
                {
                    Program.Log("恢复 " + key + " 失败：端点已消失");
                    return;
                }

                // 端点可能 snap 到自己支持的档位，而不是我们请求的那个值。
                // 这时**观察到的才是事实**，按它更新记忆，否则每次重连都要再 snap 一次。
                if (applied != remembered && applied >= MinRememberedVolume && applied <= MaxRememberedVolume)
                {
                    lock (_lock) { _memories[key] = applied; }
                }
            }

            Program.Log("恢复 " + key + "：「" + info.Name + "」当前 " + current + "% -> " + applied + "%（记忆 " + remembered + "%）");

            lock (_lock)
            {
                _restoredEvents.Add(new RestoredEvent
                {
                    Key = key,
                    Name = info.Name,
                    Enumerator = info.Enumerator,
                    IsBluetooth = info.IsBluetooth,
                    RememberedVolume = remembered,
                    PreviousVolume = current,
                    AppliedVolume = applied,
                    Muted = info.Muted,
                    // 走到这里必然是「重连 + 有记忆音量」；启动时就已经连着的设备由 Prime() 兜住，不会到这里。
                    Announce = true,
                });
                while (_restoredEvents.Count > 200) _restoredEvents.RemoveAt(0);
            }
        }

        private void OnDeviceDeparted(string deviceId)
        {
            string key = GetStorageKey(deviceId);
            if (string.IsNullOrEmpty(key)) return;

            bool wasWatched;
            lock (_lock)
            {
                wasWatched = _watched.ContainsKey(key);
            }
            Unwatch(key);
            if (!wasWatched) return;

            lock (_lock)
            {
                _deviceEvents.Add(new DeviceEvent { Kind = "removed", Key = key });
                Trim();
            }
        }

        private void OnVolumeChanged(string key, float scalar, bool muted, Guid context)
        {
            // 自己写的忽略掉：否则「恢复音量」会被当成用户操作再记一遍。
            if (context == SelfEventContext) return;

            lock (_lock)
            {
                _volumeEvents.Add(new VolumeEvent { Key = key, Volume = ToPercent(scalar), Muted = muted });
                Trim();
            }
        }

        private void Trim()
        {
            DateTime cutoff = DateTime.UtcNow - EventRetention;
            _deviceEvents.RemoveAll(delegate (DeviceEvent e) { return e.AtUtc < cutoff; });
            _volumeEvents.RemoveAll(delegate (VolumeEvent e) { return e.AtUtc < cutoff; });
            while (_deviceEvents.Count > MaxQueuedEvents) _deviceEvents.RemoveAt(0);
            while (_volumeEvents.Count > MaxQueuedEvents) _volumeEvents.RemoveAt(0);
        }

        public void Dispose()
        {
            try { _enumerator.UnregisterEndpointNotificationCallback(_notificationClient); } catch { }

            List<string> keys;
            lock (_lock)
            {
                keys = new List<string>(_watched.Keys);
            }
            foreach (string key in keys) Unwatch(key);

            Release(_enumerator);
        }

        // ------------------------------------------------------------ COM 回调实现

        [ComVisible(true)]
        [ClassInterface(ClassInterfaceType.None)]
        public sealed class VolumeChangeSink : IAudioEndpointVolumeCallback
        {
            private readonly AudioEndpointService _owner;
            private readonly string _key;

            internal VolumeChangeSink(AudioEndpointService owner, string key)
            {
                _owner = owner;
                _key = key;
            }

            public void OnNotify(IntPtr pNotify)
            {
                try
                {
                    AudioVolumeNotificationData data =
                        (AudioVolumeNotificationData)Marshal.PtrToStructure(pNotify, typeof(AudioVolumeNotificationData));
                    _owner.OnVolumeChanged(_key, data.fMasterVolume, data.bMuted != 0, data.guidEventContext);
                }
                catch (Exception ex)
                {
                    Program.Log("OnNotify 解析失败: " + ex.Message);
                }
            }
        }

        [ComVisible(true)]
        [ClassInterface(ClassInterfaceType.None)]
        public sealed class NotificationClient : IMMNotificationClient
        {
            private readonly AudioEndpointService _owner;

            internal NotificationClient(AudioEndpointService owner)
            {
                _owner = owner;
            }

            public void OnDeviceAdded(string pwstrDeviceId)
            {
                try { _owner.OnDeviceArrived(pwstrDeviceId); } catch (Exception ex) { Program.Log("OnDeviceAdded 失败: " + ex.Message); }
            }

            public void OnDeviceRemoved(string pwstrDeviceId)
            {
                try { _owner.OnDeviceDeparted(pwstrDeviceId); } catch (Exception ex) { Program.Log("OnDeviceRemoved 失败: " + ex.Message); }
            }

            public void OnDeviceStateChanged(string pwstrDeviceId, DeviceState dwNewState)
            {
                try
                {
                    switch (dwNewState)
                    {
                        case DeviceState.ACTIVE:
                            _owner.OnDeviceArrived(pwstrDeviceId);
                            break;
                        case DeviceState.DISABLED:
                        case DeviceState.NOTPRESENT:
                        case DeviceState.UNPLUGGED:
                            _owner.OnDeviceDeparted(pwstrDeviceId);
                            break;
                    }
                }
                catch (Exception ex) { Program.Log("OnDeviceStateChanged 失败: " + ex.Message); }
            }

            public void OnDefaultDeviceChanged(EDataFlow flow, ERole role, string pwstrDefaultDeviceId)
            {
                // 本插件按端点记账，与「谁是默认设备」无关，所以不处理。
            }

            public void OnPropertyValueChanged(string pwstrDeviceId, PROPERTYKEY key)
            {
                // 只需要端点增删与音量变化两种事件。
            }
        }
    }
}
