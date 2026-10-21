// ============================================================================
//  PokeVolume —— 测试专用：用**随机** guidEventContext 改某个音频端点的音量，
//  用来模拟「用户自己拖音量条」。随机的 event context 是关键：VolumeHelper 会
//  忽略掉带自己那个固定 context 的写操作，所以只有随机 context 才能触发它的
//  IAudioEndpointVolumeCallback 路径。
//
//  这个工具**不随插件发布**，只存在于 .workbuddy/tmp 下。
//
//  用法: PokeVolume.exe --id "<完整端点 id>" --volume <0-100>
//                      | --default --volume <0-100>
// ============================================================================

using System;
using System.Runtime.InteropServices;

namespace PokeVolume
{
    internal enum EDataFlow { eRender = 0 }
    internal enum ERole { eMultimedia = 1 }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        void Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams,
                      [MarshalAs(UnmanagedType.Interface)] out object ppInterface);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        IntPtr EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask);
        [return: MarshalAs(UnmanagedType.Interface)]
        IMMDevice GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role);
        [return: MarshalAs(UnmanagedType.Interface)]
        IMMDevice GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId);
        void RegisterEndpointNotificationCallback(IntPtr pClient);
        void UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        void RegisterControlChangeNotify(IntPtr pNotify);
        void UnregisterControlChangeNotify(IntPtr pNotify);
        uint GetChannelCount();
        void SetMasterVolumeLevel(float fLevelDB, ref Guid ctx);
        void SetMasterVolumeLevelScalar(float fLevel, ref Guid ctx);
        void GetMasterVolumeLevel(out float pfLevelDB);
        void GetMasterVolumeLevelScalar(out float pfLevel);
        void SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid ctx);
        void SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid ctx);
        void GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        float GetChannelVolumeLevelScalar(uint nChannel);
        void SetMute(int bMute, ref Guid ctx);
        int GetMute();
        void GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
        void VolumeStepUp(ref Guid ctx);
        void VolumeStepDown(ref Guid ctx);
        void QueryHardwareSupport(out uint pdwHardwareSupportMask);
        void GetVolumeRange(out float pnMin, out float pnMax, out float pnInc);
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator { }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            string id = null;
            bool useDefault = false;
            int volume = -1;

            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--id": if (i + 1 < args.Length) id = args[++i]; break;
                    case "--default": useDefault = true; break;
                    case "--volume": if (i + 1 < args.Length) int.TryParse(args[++i], out volume); break;
                }
            }

            if (volume < 0 || volume > 100)
            {
                Console.WriteLine("ERROR: --volume must be 0..100");
                return 2;
            }
            if (!useDefault && string.IsNullOrEmpty(id))
            {
                Console.WriteLine("ERROR: need --id <endpointId> or --default");
                return 2;
            }

            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                IMMDevice device = useDefault
                    ? enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia)
                    : enumerator.GetDevice(id);
                if (device == null) { Console.WriteLine("ERROR: device not found"); return 3; }

                Guid iid = typeof(IAudioEndpointVolume).GUID;
                object raw;
                device.Activate(ref iid, 0x1, IntPtr.Zero, out raw);
                var volumeApi = (IAudioEndpointVolume)raw;

                float before;
                volumeApi.GetMasterVolumeLevelScalar(out before);

                // 随机 event context = 模拟外部（用户）写入
                Guid randomContext = Guid.NewGuid();
                volumeApi.SetMasterVolumeLevelScalar(volume / 100f, ref randomContext);

                float after;
                volumeApi.GetMasterVolumeLevelScalar(out after);

                Console.WriteLine("poked: " + Math.Round(before * 100) + "% -> " + Math.Round(after * 100) + "% (ctx " + randomContext + ")");
                return 0;
            }
            catch (Exception ex)
            {
                Console.WriteLine("ERROR: " + ex.Message);
                return 4;
            }
        }
    }
}
