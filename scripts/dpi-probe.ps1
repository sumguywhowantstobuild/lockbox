$ErrorActionPreference = 'Stop'
$out = Join-Path $env:RUNNER_TEMP 'dpi-probe'
New-Item -ItemType Directory -Force $out | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Dpi {
  [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPath, out uint numMode);
  [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint flags, ref uint numPath, IntPtr paths, ref uint numMode, IntPtr modes, IntPtr topo);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(IntPtr packet);
  [DllImport("user32.dll")] public static extern int DisplayConfigSetDeviceInfo(IntPtr packet);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr mon, int type, out uint x, out uint y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);

  // First active path: adapter LUID and source id.
  public static void Source(out uint low, out int high, out uint id) {
    uint np, nm; int r = GetDisplayConfigBufferSizes(2, out np, out nm); if (r != 0) throw new Exception("sizes " + r);
    IntPtr p = Marshal.AllocHGlobal((int)np * 72), m = Marshal.AllocHGlobal((int)nm * 64);
    try {
      r = QueryDisplayConfig(2, ref np, p, ref nm, m, IntPtr.Zero); if (r != 0) throw new Exception("query " + r);
      low = (uint)Marshal.ReadInt32(p, 0); high = Marshal.ReadInt32(p, 4); id = (uint)Marshal.ReadInt32(p, 8);
    } finally { Marshal.FreeHGlobal(p); Marshal.FreeHGlobal(m); }
  }
  static IntPtr Header(int type, int size, uint low, int high, uint id) {
    IntPtr b = Marshal.AllocHGlobal(size);
    for (int i = 0; i < size; i++) Marshal.WriteByte(b, i, 0);
    Marshal.WriteInt32(b, 0, type); Marshal.WriteInt32(b, 4, size);
    Marshal.WriteInt32(b, 8, (int)low); Marshal.WriteInt32(b, 12, high); Marshal.WriteInt32(b, 16, (int)id);
    return b;
  }
  // Returns min, cur, max relative steps (undocumented type -3).
  public static int[] Get() {
    uint low, id; int high; Source(out low, out high, out id);
    IntPtr b = Header(-3, 32, low, high, id);
    try { int r = DisplayConfigGetDeviceInfo(b); if (r != 0) throw new Exception("get " + r);
      return new int[] { Marshal.ReadInt32(b, 20), Marshal.ReadInt32(b, 24), Marshal.ReadInt32(b, 28) }; }
    finally { Marshal.FreeHGlobal(b); }
  }
  // Sets a relative step (undocumented type -4).
  public static int Set(int rel) {
    uint low, id; int high; Source(out low, out high, out id);
    IntPtr b = Header(-4, 24, low, high, id);
    try { Marshal.WriteInt32(b, 20, rel); return DisplayConfigSetDeviceInfo(b); }
    finally { Marshal.FreeHGlobal(b); }
  }
  public static uint MonitorDpi() {
    POINT pt; pt.x = 0; pt.y = 0; IntPtr mon = MonitorFromPoint(pt, 1); uint x, y; GetDpiForMonitor(mon, 0, out x, out y); return x;
  }
}
'@

[void][Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Shot([string]$name) {
  $w = [Dpi]::GetSystemMetrics(0); $h = [Dpi]::GetSystemMetrics(1)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

"session: $([System.Diagnostics.Process]::GetCurrentProcess().SessionId) interactive: $([Environment]::UserInteractive)"
"screen: $([Dpi]::GetSystemMetrics(0)) x $([Dpi]::GetSystemMetrics(1)); system dpi $([Dpi]::GetDpiForSystem()); monitor dpi $([Dpi]::MonitorDpi())"

# Modes the adapter offers.
$dm = New-Object Dpi+DEVMODE; $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)
$modes = @(); $i = 0
while ([Dpi]::EnumDisplaySettings($null, $i, [ref]$dm)) { $modes += "$($dm.dmPelsWidth)x$($dm.dmPelsHeight)"; $i++ }
"modes: " + (($modes | Select-Object -Unique) -join ', ')

"sizeof DEVMODE: $([System.Runtime.InteropServices.Marshal]::SizeOf($dm)); current ok: $([Dpi]::EnumDisplaySettings($null, -1, [ref]$dm)) $($dm.dmPelsWidth)x$($dm.dmPelsHeight); err $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
"Set-DisplayResolution available: $([bool](Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue))"
Get-CimInstance Win32_VideoController | ForEach-Object { "adapter: $($_.Name) $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution) max-refresh $($_.MaxRefreshRate)" }
foreach ($wh in @(@(2560, 1600), @(2560, 1440), @(1920, 1200), @(1920, 1080), @(1600, 1200), @(1280, 1024))) {
  if (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue) {
    try { Set-DisplayResolution -Width $wh[0] -Height $wh[1] -Force -ErrorAction Stop; "Set-DisplayResolution $($wh -join 'x'): ok" } catch { "Set-DisplayResolution $($wh -join 'x'): $($_.Exception.Message)" }
  }
  $d = New-Object Dpi+DEVMODE; $d.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($d)
  [void][Dpi]::EnumDisplaySettings($null, -1, [ref]$d)
  $d.dmPelsWidth = $wh[0]; $d.dmPelsHeight = $wh[1]; $d.dmFields = 0x180000
  "ChangeDisplaySettings $($wh -join 'x'): $([Dpi]::ChangeDisplaySettings([ref]$d, 0)); screen now $([Dpi]::GetSystemMetrics(0)) x $([Dpi]::GetSystemMetrics(1))"
  if ([Dpi]::GetSystemMetrics(0) -ge 1600) { break }
}
"screen now: $([Dpi]::GetSystemMetrics(0)) x $([Dpi]::GetSystemMetrics(1))"

$steps = 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500
try { $g = [Dpi]::Get() } catch { "get failed: $_"; exit 0 }
"rel min/cur/max: $($g -join ' / ')"
$rec = [math]::Abs($g[0])
"recommended: $($steps[$rec])%  current: $($steps[$rec + $g[1]])%  max: $($steps[$rec + $g[2]])%"

foreach ($want in 100, 125, 150, 200) {
  $idx = [array]::IndexOf($steps, $want)
  $r = [Dpi]::Set($idx - $rec)
  Start-Sleep -Seconds 2
  $p = Start-Process -FilePath "$env:SystemRoot\System32\notepad.exe" -PassThru
  Start-Sleep -Seconds 3
  "set $want% -> result $r; monitor dpi $([Dpi]::MonitorDpi()); rel now $(([Dpi]::Get())[1])"
  Shot "scale-$want"
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
