using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

// Volumen de una app en el mezclador de Windows (Core Audio), buscada por nombre de proceso.
public static class AppVolume {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr control);
    int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl2 session);
  }

  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName(IntPtr name, IntPtr ctx);
    int GetIconPath(out IntPtr path);
    int SetIconPath(IntPtr path, IntPtr ctx);
    int GetGroupingParam(out Guid param);
    int SetGroupingParam(IntPtr param, IntPtr ctx);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out uint pid);
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid ctx);
    int GetMasterVolume(out float level);
  }

  static ISimpleAudioVolume Find(string process) {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 1 /* eMultimedia */, out device) != 0) return null;
    var iid = typeof(IAudioSessionManager2).GUID;
    object o;
    if (device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) return null;
    IAudioSessionEnumerator sessions;
    if (((IAudioSessionManager2)o).GetSessionEnumerator(out sessions) != 0) return null;
    int count; sessions.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IAudioSessionControl2 ctl; sessions.GetSession(i, out ctl);
      uint pid; ctl.GetProcessId(out pid);
      try {
        if (pid != 0 && string.Equals(Process.GetProcessById((int)pid).ProcessName, process, StringComparison.OrdinalIgnoreCase))
          return (ISimpleAudioVolume)ctl;
      } catch { }
    }
    return null;
  }

  // 0–100, o -1 si la app no tiene sesión de audio.
  public static int Get(string process) {
    var v = Find(process);
    if (v == null) return -1;
    float level; v.GetMasterVolume(out level);
    return (int)Math.Round(level * 100);
  }

  public static bool Set(string process, int percent) {
    var v = Find(process);
    if (v == null) return false;
    var ctx = Guid.Empty;
    return v.SetMasterVolume(Math.Max(0, Math.Min(100, percent)) / 100f, ref ctx) == 0;
  }
}
