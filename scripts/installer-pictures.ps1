#requires -Version 5.1
# Throwaway (Plan 5, Task 9e Step 5): pictures of the installer's states, taken on a GitHub-hosted Windows runner at 100, 125,
# 150 and 175 %, plus a live scale change, high contrast and larger text. It installs and uninstalls Petalock for the runner's
# user, so it refuses to run anywhere else. Never part of the repo's history.
param([Parameter(Mandatory = $true)][string]$InstallerDir, [string]$Only = '')

$ErrorActionPreference = 'Stop'
if (-not ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_TEMP)) {
  Write-Output 'installer-pictures: runs only on a GitHub-hosted runner; nothing was done'
  exit 3
}

$Out = Join-Path $env:RUNNER_TEMP 'pictures'
[void][System.IO.Directory]::CreateDirectory($Out)
$LogPath = Join-Path $Out 'capture.log'
$IndexPath = Join-Path $Out 'pictures.tsv'
[System.IO.File]::WriteAllText($LogPath, '')
[System.IO.File]::WriteAllText($IndexPath, "file`tstate`tscale`tmonitor_dpi`twindow_dpi`tawareness`tsetup_system_dpi`twindow_rect`tclient`tnote`r`n")

function Write-Log([string]$Text) {
  $line = (Get-Date).ToString('HH:mm:ss.fff') + ' ' + $Text
  Write-Host $line
  [System.IO.File]::AppendAllText($LogPath, $line + "`r`n")
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Cap {
  // --- display scale (from the DPI probe, run 46025780552) ---
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPath, out uint numMode);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPath, IntPtr paths, ref uint numMode, IntPtr modes, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr packet);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(IntPtr packet);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint x, out uint y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l; public int t; public int r; public int b; }

  static void Source(out uint low, out int high, out uint id) {
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
  public static int[] Get() {
    uint low, id; int high; Source(out low, out high, out id);
    IntPtr b = Header(-3, 32, low, high, id);
    try { int r = DisplayConfigGetDeviceInfo(b); if (r != 0) throw new Exception("get " + r);
      return new int[] { Marshal.ReadInt32(b, 20), Marshal.ReadInt32(b, 24), Marshal.ReadInt32(b, 28) }; }
    finally { Marshal.FreeHGlobal(b); }
  }
  public static int Set(int rel) {
    uint low, id; int high; Source(out low, out high, out id);
    IntPtr b = Header(-4, 24, low, high, id);
    try { Marshal.WriteInt32(b, 20, rel); return DisplayConfigSetDeviceInfo(b); }
    finally { Marshal.FreeHGlobal(b); }
  }
  public static uint MonitorDpi() {
    POINT pt; pt.x = 0; pt.y = 0; IntPtr mon = MonitorFromPoint(pt, 1); uint x, y; GetDpiForMonitor(mon, 0, out x, out y); return x;
  }

  // --- one window: where it is, its scale, bringing it to the front ---
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern uint GetSystemDpiForProcess(IntPtr hProcess);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  public static int[] Rect(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); return new int[] { r.l, r.t, r.r, r.b }; }
  public static int[] Client(IntPtr h) { RECT r; GetClientRect(h, out r); return new int[] { r.r - r.l, r.b - r.t }; }
  public static int Awareness(IntPtr h) { return GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(h)); }
  public static long ProcessSystemDpi(IntPtr hp) { try { return GetSystemDpiForProcess(hp); } catch { return -1; } }
  public static uint WindowMonitorDpi(IntPtr h) { IntPtr m = MonitorFromWindow(h, 2); uint x, y; GetDpiForMonitor(m, 0, out x, out y); return x; }
  public static void Front(IntPtr h) {
    SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x43);
    SetWindowPos(h, (IntPtr)(-2), 0, 0, 0, 0, 0x43);
    SetForegroundWindow(h);
  }

  // --- the dialogs, driven by messages (copied from scripts/installer-smoke.ps1) ---
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr d, int id);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  public static List<IntPtr> Tops() { var r = new List<IntPtr>(); EnumWindows((h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static List<IntPtr> Kids(IntPtr p) { var r = new List<IntPtr>(); EnumChildWindows(p, (h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Caption(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Text(IntPtr h) { var s = new StringBuilder(4096); SendMessage(h, 0x000D, (IntPtr)4096, s); return s.ToString(); }
  public static int Id(IntPtr h) { return GetDlgCtrlID(h); }
  public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
  public static bool Enabled(IntPtr h) { return IsWindowEnabled(h); }
  public static void Click(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
  public static int Press(IntPtr dlg, IntPtr button) {
    int id = GetDlgCtrlID(button);
    if (!PostMessage(dlg, 0x0111, (IntPtr)id, button)) return Marshal.GetLastWin32Error();
    return 0;
  }
  public static IntPtr Item(IntPtr d, int id) { return GetDlgItem(d, id); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static void SetCheck(IntPtr h, bool on) { SendMessage(h, 0x00F1, (IntPtr)(on ? 1 : 0), IntPtr.Zero); }
  public static int GetCheck(IntPtr h) { return (int)SendMessage(h, 0x00F0, IntPtr.Zero, IntPtr.Zero); }

  // --- high contrast, text size, system colours ---
  [StructLayout(LayoutKind.Sequential)] public struct HIGHCONTRAST { public int cbSize; public int dwFlags; public IntPtr lpszDefaultScheme; }
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)] static extern bool SpiHc(uint a, uint b, ref HIGHCONTRAST hc, uint f);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)] static extern bool SpiPtr(uint a, uint b, IntPtr p, uint f);
  public static int SetHighContrast(bool on, string scheme) {
    var hc = new HIGHCONTRAST(); hc.cbSize = Marshal.SizeOf(typeof(HIGHCONTRAST)); hc.dwFlags = on ? 1 : 0;
    IntPtr s = IntPtr.Zero; if (on && scheme != null) s = Marshal.StringToHGlobalUni(scheme);
    hc.lpszDefaultScheme = s;
    bool ok = SpiHc(0x43, (uint)hc.cbSize, ref hc, 3);
    int err = ok ? 0 : Marshal.GetLastWin32Error();
    if (s != IntPtr.Zero) Marshal.FreeHGlobal(s);
    return ok ? 0 : (err == 0 ? -1 : err);
  }
  public static int HighContrastFlags() {
    var hc = new HIGHCONTRAST(); hc.cbSize = Marshal.SizeOf(typeof(HIGHCONTRAST));
    if (!SpiHc(0x42, (uint)hc.cbSize, ref hc, 0)) return -1; return hc.dwFlags;
  }
  // NONCLIENTMETRICSW (504 bytes): iMenuHeight at 220, lfMessageFont.lfHeight at 408.
  public static int[] Metrics() {
    IntPtr b = Marshal.AllocHGlobal(504);
    try { for (int i = 0; i < 504; i++) Marshal.WriteByte(b, i, 0); Marshal.WriteInt32(b, 0, 504);
      if (!SpiPtr(0x29, 504, b, 0)) return new int[] { -1, -1 };
      return new int[] { Marshal.ReadInt32(b, 408), Marshal.ReadInt32(b, 220) }; }
    finally { Marshal.FreeHGlobal(b); }
  }
  [DllImport("user32.dll")] public static extern uint GetSysColor(int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r);
  public static void Broadcast(int wparam, string area) { IntPtr r; SendMessageTimeout((IntPtr)0xFFFF, 0x1A, (IntPtr)wparam, area, 2, 5000, out r); }
}
'@

# Per-monitor aware (V2) before any window exists, so rectangles and the screen copy are in real pixels.
$aware = [Cap]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$Id = 'io.github.sumguywhowantstobuild.petalock'
$LocalApp = [Environment]::GetFolderPath('LocalApplicationData')
$RoamApp = [Environment]::GetFolderPath('ApplicationData')
$State = Join-Path $LocalApp 'Petalock'
$IdLocal = Join-Path $LocalApp $Id
$IdRoam = Join-Path $RoamApp $Id
$DefaultDir = Join-Path $LocalApp 'Programs\Petalock'
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartPrograms = [Environment]::GetFolderPath('Programs')
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalock'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$Steps = 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500
$script:SmallDrive = $null
$script:Vhd = Join-Path $env:RUNNER_TEMP 'MU-small.vhdx'
$script:RealVersion = $null

$exes = @(Get-ChildItem -LiteralPath $InstallerDir -Filter '*.exe' -File)
if ($exes.Count -ne 1) { Write-Log "expected one installer in $InstallerDir, found $($exes.Count)"; exit 2 }
$Installer = $exes[0].FullName

# --- small helpers ---------------------------------------------------------------------------------------------------------

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') } finally { $stream.Dispose(); $sha.Dispose() }
}

function Get-Dialogs([int[]]$Pids) {
  $found = @()
  if ($null -eq $Pids -or $Pids.Count -eq 0) { return $found }
  foreach ($h in [Cap]::Tops()) {
    if (-not [Cap]::Visible($h)) { continue }
    if ([Cap]::Cls($h) -ne '#32770') { continue }
    if ($Pids -notcontains [int][Cap]::Pid($h)) { continue }
    $caption = [Cap]::Caption($h)
    $kids = @()
    foreach ($k in [Cap]::Kids($h)) {
      $kids += [pscustomobject]@{ Handle = $k; Class = [Cap]::Cls($k); Text = ([Cap]::Text($k) -replace '&', ''); Id = [Cap]::Id($k); Enabled = [Cap]::Enabled($k); Visible = [Cap]::Visible($k) }
    }
    $found += [pscustomobject]@{ Handle = $h; Caption = $caption; Kids = $kids }
  }
  return $found
}

function Get-DialogText($Dialog) {
  return (($Dialog.Kids | Where-Object { $_.Class -eq 'Static' -and $_.Visible -and $_.Text }) | ForEach-Object { $_.Text }) -join "`n"
}

# Every visible control of a dialog, for the log: class, id, words, enabled.
function Get-DialogDump($Dialog) {
  return (($Dialog.Kids | Where-Object { $_.Visible -and $_.Class -ne '#32770' }) | ForEach-Object { "[$($_.Class) $($_.Id) '$($_.Text)'$(if (-not $_.Enabled) { ' off' })]" }) -join ' '
}

function Get-UninstallerCopies {
  $found = @()
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $p.Path } catch { }
    if ($path -and $path -like '*\~nsu*.tmp\*') { $found += $p }
  }
  return $found
}

function Save-Screen([string]$Name) {
  try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $path = Join-Path $Out ('screen-' + ($Name -replace '[^A-Za-z0-9_-]', '_') + '.png')
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Log "  (whole screen saved: $([System.IO.Path]::GetFileName($path)))"
  } catch { Write-Log "  (no screen picture: $($_.Exception.Message))" }
}

# The window's rectangle with a 16 px margin, copied from the screen (what a person sees, scaling included), as <Name>.png.
function Save-Window($Handle, [string]$Name, [string]$StateName, [string]$Scale, [string]$Note = '', $Process = $null, [switch]$Fast) {
  if (-not $Fast) { [Cap]::Front($Handle); Start-Sleep -Milliseconds 700 }
  $r = [Cap]::Rect($Handle)
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $m = 16
  $l = [Math]::Max($vs.Left, $r[0] - $m); $t = [Math]::Max($vs.Top, $r[1] - $m)
  $rr = [Math]::Min($vs.Right, $r[2] + $m); $bb = [Math]::Min($vs.Bottom, $r[3] + $m)
  $w = $rr - $l; $h = $bb - $t
  if ($w -le 0 -or $h -le 0) { Write-Log "  $Name : the window has no rectangle on the screen ($($r -join ','))"; return }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save((Join-Path $Out "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $mon = [Cap]::WindowMonitorDpi($Handle); $wd = [Cap]::GetDpiForWindow($Handle); $aw = [Cap]::Awareness($Handle); $cl = [Cap]::Client($Handle)
  $sd = -1
  if ($Process) { try { $sd = [Cap]::ProcessSystemDpi($Process.Handle) } catch { } }
  $rect = "$($r -join ',') ($($r[2] - $r[0]) x $($r[3] - $r[1]))"
  Write-Log "  picture $Name.png: monitor dpi $mon, window dpi $wd, awareness $aw (1 system, 2 per-monitor), Setup's system dpi $sd, window $rect, client $($cl -join ' x ') $Note"
  [System.IO.File]::AppendAllText($IndexPath, "$Name.png`t$StateName`t$Scale`t$mon`t$wd`t$aw`t$sd`t$rect`t$($cl -join 'x')`t$Note`r`n")
}

function Start-Setup([string[]]$ArgList = @()) {
  if ($ArgList.Count -gt 0) { $p = Start-Process -FilePath $Installer -ArgumentList $ArgList -PassThru }
  else { $p = Start-Process -FilePath $Installer -PassThru }
  $null = $p.Handle
  Write-Log "  Setup started (pid $($p.Id)) $($ArgList -join ' ')"
  return $p
}

function Wait-Page($Process, [string]$Like, [int]$Seconds = 60) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($d in @(Get-Dialogs @([int]$Process.Id))) { if ((Get-DialogText $d) -like $Like) { return $d } }
    if ($Process.HasExited) { throw "Setup ended (exit $($Process.ExitCode)) before a page like '$Like'" }
    Start-Sleep -Milliseconds 250
  }
  throw "no page like '$Like' within $Seconds s"
}

function Get-Dialog($Process, $Handle) {
  return @(Get-Dialogs @([int]$Process.Id) | Where-Object { $_.Handle -eq $Handle })[0]
}

function Click-Kid($Dialog, [string]$Text) {
  $kid = @($Dialog.Kids | Where-Object { $_.Visible -and $_.Text -eq $Text })[0]
  if (-not $kid) { throw "no visible control '$Text' on the page; it shows: $(Get-DialogDump $Dialog)" }
  [Cap]::Click($kid.Handle)
  Start-Sleep -Milliseconds 1200
}

function Press-Button($Dialog, [int]$Id) {
  $b = [Cap]::Item($Dialog.Handle, $Id)
  $e = [Cap]::Press($Dialog.Handle, $b)
  Write-Log "  pressed button $Id ('$([Cap]::Text($b) -replace '&', '')'), post result $e"
}

function Stop-Setup($Process, $Dialog = $null) {
  if ($Process.HasExited) { Write-Log "  Setup had ended (exit $($Process.ExitCode))"; return }
  if (-not $Dialog) { $Dialog = @(Get-Dialogs @([int]$Process.Id))[0] }
  if ($Dialog) { Press-Button $Dialog 2 }
  if (-not $Process.WaitForExit(15000)) { Write-Log '  Setup did not end after Cancel: killed'; try { $Process.Kill() } catch { } ; [void]$Process.WaitForExit(10000) }
  Write-Log "  Setup ended, exit $($Process.ExitCode)"
}

function Stop-Petalock {
  foreach ($p in @(Get-Process -Name 'petalock' -ErrorAction SilentlyContinue)) { try { $p.Kill(); [void]$p.WaitForExit(15000) } catch { } }
}

function Stop-AllSetup {
  Stop-Petalock
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $p.Path } catch { }
    if ($path -and ($path -eq $Installer -or $path -like '*\~nsu*.tmp\*' -or $path.StartsWith($DefaultDir + '\', [System.StringComparison]::OrdinalIgnoreCase))) {
      try { $p.Kill(); [void]$p.WaitForExit(15000) } catch { }
    }
  }
}

function Reset-World {
  Stop-AllSetup
  foreach ($path in @($DefaultDir, $State, $IdLocal, $IdRoam, (Join-Path $Desktop 'Petalock.lnk'), (Join-Path $StartPrograms 'Petalock.lnk'))) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -LiteralPath $RunKey -Name 'Petalock' -ErrorAction SilentlyContinue
  Write-Log '  world reset (no Petalock, no entry, no state)'
}

function Test-Installed { return ([System.IO.File]::Exists((Join-Path $DefaultDir 'petalock.exe')) -and [System.IO.File]::Exists((Join-Path $DefaultDir 'uninstall.exe'))) }

function Install-Quietly {
  $p = Start-Setup @('/S')
  if (-not $p.WaitForExit(240000)) { try { $p.Kill() } catch { }; throw 'the silent install did not end' }
  Write-Log "  silent install exit $($p.ExitCode)"
  if (-not (Test-Installed)) { throw 'the silent install left no program' }
  Start-Sleep -Seconds 2
}

function Set-DisplayVersion($Value) {
  if ($null -eq $Value) { Remove-ItemProperty -LiteralPath $UninstallKey -Name 'DisplayVersion' -ErrorAction SilentlyContinue; Write-Log '  DisplayVersion removed' }
  else { Set-ItemProperty -LiteralPath $UninstallKey -Name 'DisplayVersion' -Value $Value; Write-Log "  DisplayVersion = $Value" }
}

function Set-Scale([int]$Want) {
  $g = [Cap]::Get()
  $rec = [Math]::Abs($g[0])
  $idx = [array]::IndexOf($Steps, $Want)
  $r = [Cap]::Set($idx - $rec)
  Start-Sleep -Seconds 3
  $now = [Cap]::Get()
  $mon = [Cap]::MonitorDpi()
  $expect = [int]($Want * 96 / 100)
  Write-Log "SCALE $Want %: set result $r; monitor dpi $mon (expected $expect); rel $($now[1]) (min $($now[0]) max $($now[2])); screen $([Cap]::GetSystemMetrics(0)) x $([Cap]::GetSystemMetrics(1)); message font / menu height $([Cap]::Metrics() -join ' / ')"
  if ($mon -ne $expect) { Write-Log "  WARNING: the monitor is at $mon dpi, not $expect" }
}

function Invoke-Step([string]$StepName, [scriptblock]$Body) {
  Write-Log "STEP $StepName"
  try { & $Body; Write-Log "  ok: $StepName" }
  catch {
    Write-Log "  FAIL: $StepName : $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
    Save-Screen "fail-$StepName"
    Stop-AllSetup
  }
}

function Start-PetalockHidden {
  $p = Start-Process -FilePath (Join-Path $DefaultDir 'petalock.exe') -ArgumentList '--hidden' -PassThru
  $name = "Local\$Id.instance"
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { throw "petalock.exe exited early ($($p.ExitCode))" }
    $m = $null
    try { if ([System.Threading.Mutex]::TryOpenExisting($name, [ref]$m)) { $m.Dispose(); Start-Sleep -Seconds 5; Write-Log "  Petalock running (pid $($p.Id))"; return $p } } catch { }
    Start-Sleep -Milliseconds 250
  }
  throw 'petalock.exe never took its instance lock'
}

# --- the states ------------------------------------------------------------------------------------------------------------

# 1 and 2: the first page of a new install, then Options open.
function Save-FirstAndOptions([string]$Prefix, [string]$Scale) {
  $p = Start-Setup
  try {
    $d = Wait-Page $p '*What Setup will do*'
    Start-Sleep -Milliseconds 1500
    $d = Get-Dialog $p $d.Handle
    Write-Log "  page: $(Get-DialogDump $d)"
    Save-Window $d.Handle "${Prefix}01-first-$Scale" "${Prefix}1 first page" $Scale '' $p
    Click-Kid $d 'Options'
    $d = Get-Dialog $p $d.Handle
    Write-Log "  page: $(Get-DialogDump $d)"
    Save-Window $d.Handle "${Prefix}02-options-$Scale" "${Prefix}2 Options open" $Scale '' $p
  } finally { Stop-Setup $p }
}

# 3: a folder that can't be written (under C:\Windows), as the page first shows it and after Install is pressed.
function Save-BadFolder([string]$Prefix, [string]$Scale) {
  $p = Start-Setup @('/D=C:\Windows\MU-cap\Petalock')
  try {
    $d = Wait-Page $p '*What Setup will do*'
    Start-Sleep -Milliseconds 1500
    $d = Get-Dialog $p $d.Handle
    Write-Log "  page: $(Get-DialogDump $d)"
    Save-Window $d.Handle "${Prefix}03-badfolder-first-$Scale" "${Prefix}3 folder that can't be written, first look" $Scale '' $p
    Press-Button $d 1
    Start-Sleep -Milliseconds 3000
    $d = Get-Dialog $p $d.Handle
    Write-Log "  page: $(Get-DialogDump $d)"
    Save-Window $d.Handle "${Prefix}03-badfolder-$Scale" "${Prefix}3 folder that can't be written, after Install" $Scale '' $p
  } finally { Stop-Setup $p }
}

# 4 and 5: a new install through the window: every distinct progress frame (polled every 250 ms), then the receipt; "Open
# Petalock" unticked before Finish. -AtReceipt runs with the receipt's handle before the box is unticked.
function Save-InstallAndReceipt([string]$Prefix, [string]$Scale, [scriptblock]$AtReceipt = $null, [string]$EndName = '05-receipt', [string]$FrameName = '04') {
  $p = Start-Setup
  try {
    $d = Wait-Page $p '*What Setup will do*'
    Start-Sleep -Milliseconds 1500
    [Cap]::Front($d.Handle)
    Start-Sleep -Milliseconds 300
    Press-Button $d 1
    $seen = @{}
    $k = 0
    $receipt = $null
    $deadline = (Get-Date).AddSeconds(240)
    while (-not $receipt -and -not $p.HasExited -and (Get-Date) -lt $deadline) {
      foreach ($x in @(Get-Dialogs @([int]$p.Id))) {
        $text = Get-DialogText $x
        if ($text -like '*What Setup did*' -or $text -like '*Where Setup stopped*') { $receipt = $x; break }
        if ($text -like '*What Setup is doing*') {
          $sig = $text -replace '\s+', ' '
          if (-not $seen.ContainsKey($sig)) {
            $seen[$sig] = 1
            $k++
            $onProgress = -not [Cap]::Visible([Cap]::Item($x.Handle, 1))
            $kind = if ($onProgress) { 'progress' } else { 'checking' }
            $status = [Cap]::Text([Cap]::Item($x.Handle, 1950))
            if (-not $status) { foreach ($kid in [Cap]::Kids($x.Handle)) { if ([Cap]::Id($kid) -eq 1950) { $status = [Cap]::Text($kid) } } }
            Save-Window $x.Handle "${Prefix}${FrameName}-$kind-$Scale-$k" "${Prefix}${FrameName} $kind frame $k" $Scale "status: $status | words: $sig" $p -Fast
          }
        }
      }
      if (-not $receipt) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $receipt) { throw "no receipt page (Setup ended: $($p.HasExited))" }
    Start-Sleep -Milliseconds 1500
    $receipt = Get-Dialog $p $receipt.Handle
    Write-Log "  page: $(Get-DialogDump $receipt)"
    Save-Window $receipt.Handle "${Prefix}${EndName}-$Scale" "${Prefix}$EndName last page" $Scale '' $p
    if ($AtReceipt) { & $AtReceipt $receipt.Handle $p }
    $receipt = Get-Dialog $p $receipt.Handle
    $open = @($receipt.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Text -like 'Open Petalock*' })[0]
    if ($open) { [Cap]::SetCheck($open.Handle, $false); Start-Sleep -Milliseconds 300; Write-Log "  Open Petalock ticked now: $([Cap]::GetCheck($open.Handle))" }
    else { Write-Log '  no Open Petalock box on the last page' }
    Press-Button $receipt 1
    if (-not $p.WaitForExit(60000)) { throw 'Setup did not end after Finish' }
    Write-Log "  Setup ended after Finish, exit $($p.ExitCode)"
    Start-Sleep -Seconds 2
    if (Get-Process -Name 'petalock' -ErrorAction SilentlyContinue) { Write-Log '  NOTE: Petalock is running after Finish (the box was unticked): stopped'; Stop-Petalock }
  } finally { if (-not $p.HasExited) { Stop-Setup $p } }
}

# 6 to 9: the first page with Petalock installed (same, older, newer, unknown version); -Other also opens "Other choices".
function Save-Maintenance([string]$Name, [string]$StateName, [string]$Scale, [switch]$Other) {
  $p = Start-Setup
  try {
    $d = Wait-Page $p '*What Setup will do*'
    Start-Sleep -Milliseconds 1500
    $d = Get-Dialog $p $d.Handle
    Write-Log "  page: $(Get-DialogDump $d)"
    Save-Window $d.Handle "$Name-$Scale" $StateName $Scale '' $p
    if ($Other) {
      Click-Kid $d 'Other choices'
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "$Name-other-$Scale" "$StateName, Other choices open" $Scale '' $p
    }
  } finally { Stop-Setup $p }
}

# 10: Petalock running: the first page, then after the main button is pressed. Setup never ends Petalock; this script does.
function Save-Running([string]$Scale) {
  $pet = Start-PetalockHidden
  try {
    $p = Start-Setup
    try {
      $d = Wait-Page $p '*What Setup will do*'
      Start-Sleep -Milliseconds 1500
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "10-running-first-$Scale" '10 Petalock running, first look' $Scale '' $p
      Press-Button $d 1
      Start-Sleep -Milliseconds 4000
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "10-running-$Scale" '10 Petalock running, after the main button' $Scale '' $p
    } finally { Stop-Setup $p }
  } finally { Stop-Petalock; Start-Sleep -Seconds 2 }
}

# 11: the uninstaller's confirm page and its finish page (the box left unticked).
function Save-Uninstall([string]$Scale) {
  $p0 = Start-Process -FilePath (Join-Path $DefaultDir 'uninstall.exe') -PassThru
  [void]$p0.WaitForExit(15000)
  $confirm = $null
  $deadline = (Get-Date).AddSeconds(60)
  while (-not $confirm -and (Get-Date) -lt $deadline) {
    $copies = @(Get-UninstallerCopies)
    foreach ($d in @(Get-Dialogs @($copies | ForEach-Object { [int]$_.Id }))) {
      $b = [Cap]::Item($d.Handle, 1)
      if ($b -ne [IntPtr]::Zero -and [Cap]::Visible($b) -and ([Cap]::Text($b) -replace '&', '') -eq 'Uninstall') { $confirm = $d; $copy = @($copies | Where-Object { $_.Id -eq [Cap]::Pid($d.Handle) })[0] }
    }
    if (-not $confirm) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $confirm) { throw 'the uninstaller never showed its confirm page' }
  Start-Sleep -Milliseconds 1500
  Write-Log "  page: $(Get-DialogDump $confirm)"
  Save-Window $confirm.Handle "11-uninstall-confirm-$Scale" '11 uninstaller confirm page' $Scale '' $copy
  Press-Button $confirm 1
  $finish = $null
  $deadline = (Get-Date).AddSeconds(120)
  while (-not $finish -and (Get-Date) -lt $deadline) {
    foreach ($d in @(Get-Dialogs @(Get-UninstallerCopies | ForEach-Object { [int]$_.Id }))) {
      if ((Get-DialogText $d) -like '*was uninstalled*') { $finish = $d }
    }
    if (-not $finish) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $finish) { throw 'the uninstaller never showed its finish page' }
  Start-Sleep -Milliseconds 1500
  $finish = @(Get-Dialogs @(Get-UninstallerCopies | ForEach-Object { [int]$_.Id }) | Where-Object { $_.Handle -eq $finish.Handle })[0]
  Write-Log "  page: $(Get-DialogDump $finish)"
  Save-Window $finish.Handle "11-uninstall-finish-$Scale" '11 uninstaller finish page' $Scale '' $copy
  Press-Button $finish 1
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-UninstallerCopies) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  Write-Log "  uninstaller gone: $(-not (Get-UninstallerCopies)); program left: $(Test-Installed)"
}

# 12: low space, a new install into a tiny virtual disk.
function Save-LowSpace([string]$Scale) {
  if (-not $script:SmallDrive) { Write-Log '  no small drive: skipped'; return }
  $p = Start-Setup @("/D=$($script:SmallDrive)\Petalock")
  try {
    $d = Wait-Page $p '*What Setup will do*'
    Start-Sleep -Milliseconds 1500
    $d = Get-Dialog $p $d.Handle
    Write-Log "  page: $(Get-DialogDump $d)"
    Save-Window $d.Handle "12-lowspace-first-$Scale" '12 low space, first look' $Scale '' $p
    Press-Button $d 1
    Start-Sleep -Milliseconds 3000
    $d = Get-Dialog $p $d.Handle
    Write-Log "  page: $(Get-DialogDump $d)"
    Save-Window $d.Handle "12-lowspace-$Scale" '12 low space, after Install' $Scale '' $p
  } finally { Stop-Setup $p }
}

function Invoke-Diskpart([string[]]$Lines, [string]$What) {
  $file = Join-Path $env:RUNNER_TEMP "diskpart-$What.txt"
  [System.IO.File]::WriteAllText($file, ($Lines -join "`r`n") + "`r`n")
  $ErrorActionPreference = 'Continue'
  $outText = & "$env:SystemRoot\System32\diskpart.exe" /s $file | Out-String
  Write-Log "  diskpart $What exit $LASTEXITCODE`: $(($outText -split "`r?`n" | Where-Object { $_ -match 'success|error|fail|Virtual|percent|assigned' }) -join ' | ')"
  return $LASTEXITCODE
}

function New-SmallDrive {
  $used = @([System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 1).ToUpper() })
  $letter = @('Q', 'R', 'S', 'T', 'U', 'V', 'W') | Where-Object { $used -notcontains $_ } | Select-Object -First 1
  if (-not $letter) { throw 'no free drive letter' }
  if (Test-Path -LiteralPath $script:Vhd) { Remove-Item -LiteralPath $script:Vhd -Force }
  $code = Invoke-Diskpart @("create vdisk file=`"$($script:Vhd)`" maximum=5 type=fixed", "select vdisk file=`"$($script:Vhd)`"", 'attach vdisk',
    'convert mbr', 'create partition primary', 'format fs=fat quick label=MUSMALL', "assign letter=$letter") 'create'
  $drive = [System.IO.DriveInfo]::new("${letter}:\")
  if (-not $drive.IsReady) { throw "the small drive ${letter}: is not ready (diskpart exit $code)" }
  $script:SmallDrive = "${letter}:"
  Write-Log "  small drive ${letter}: $($drive.DriveFormat), $([int]($drive.AvailableFreeSpace / 1MB)) MB free of $([int]($drive.TotalSize / 1MB)) MB"
}

function Remove-SmallDrive {
  if (-not (Test-Path -LiteralPath $script:Vhd)) { return }
  [void](Invoke-Diskpart @("select vdisk file=`"$($script:Vhd)`"", 'detach vdisk') 'detach')
}

# 13: the added-file refusal (an older version installed, a file Setup did not install in its folder, "Remove ... before installing"
# ticked under Other choices, then the main button).
function Save-AddedRefusal([string]$Scale) {
  $added = Join-Path $DefaultDir 'MU-added.txt'
  [System.IO.File]::WriteAllText($added, 'MU-added')
  try {
    Set-DisplayVersion '0.0.9'
    $p = Start-Setup
    try {
      $d = Wait-Page $p '*What Setup will do*'
      Start-Sleep -Milliseconds 1500
      Click-Kid $d 'Other choices'
      $d = Get-Dialog $p $d.Handle
      $box = @($d.Kids | Where-Object { $_.Class -eq 'Button' -and $_.Visible -and $_.Text -like 'Remove*before installing*' })[0]
      if (-not $box) { throw "no remove-first box: $(Get-DialogDump $d)" }
      [Cap]::Click($box.Handle)
      Start-Sleep -Milliseconds 1200
      $d = Get-Dialog $p $d.Handle
      Write-Log "  box ticked: $([Cap]::GetCheck($box.Handle)); page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "13-removefirst-ticked-$Scale" '13 update, Remove first ticked (plan rows)' $Scale '' $p
      Press-Button $d 1
      $d = Wait-Page $p '*be removed first*' 30
      Start-Sleep -Milliseconds 1500
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "13-added-refusal-$Scale" '13 added-file refusal' $Scale '' $p
    } finally { Stop-Setup $p }
  } finally {
    Remove-Item -LiteralPath $added -Force -ErrorAction SilentlyContinue
    Set-DisplayVersion $script:RealVersion
  }
}

# The registry refusal (copied from the smoke script): this account is denied one right on a key, always taken back in a finally.
function Get-RegDenyRule([string]$Right) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  return (New-Object System.Security.AccessControl.RegistryAccessRule($sid, [System.Security.AccessControl.RegistryRights]$Right,
    [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Deny))
}
function Set-RegDeny([string]$Path, [string]$Right, [bool]$On) {
  $sub = $Path -replace '^HKCU:\\', ''
  $rights = [System.Security.AccessControl.RegistryRights]::ChangePermissions -bor [System.Security.AccessControl.RegistryRights]::ReadKey
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $rights)
  if ($null -eq $key) { throw "the registry key $Path cannot be opened" }
  try {
    $acl = $key.GetAccessControl()
    if ($On) { $acl.AddAccessRule((Get-RegDenyRule $Right)) } else { [void]$acl.RemoveAccessRule((Get-RegDenyRule $Right)) }
    $key.SetAccessControl($acl)
  } finally { $key.Close() }
  Write-Log "  registry: $Right on $sub $(if ($On) { 'denied' } else { 'given back' })"
}

# 14: Windows refuses the Installed apps entry: a fresh install (its files are taken out again) and an install over the existing
# one (same version, nothing removed). The failure page is captured, then Close.
function Save-RegistryRefusal([string]$Scale) {
  $parent = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  Reset-World
  [void][Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall').Close()
  Set-RegDeny $parent 'CreateSubKey' $true
  try { Save-InstallAndReceipt '' $Scale $null '14-regfail-fresh' '14-fresh' } finally { Set-RegDeny $parent 'CreateSubKey' $false }
  Write-Log "  after the refused fresh attempt: program left $(Test-Installed); entry $([bool](Test-Path -LiteralPath $UninstallKey))"
  Reset-World
  Install-Quietly
  Set-RegDeny $UninstallKey 'SetValue' $true
  try { Save-InstallAndReceipt '' $Scale $null '14-regfail-over' '14-over' } finally { Set-RegDeny $UninstallKey 'SetValue' $false }
  Write-Log "  after the refused install over: program left $(Test-Installed); entry version $((Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue).DisplayVersion)"
  Reset-World
}

# A folder this account may not add to (the runner's account is an elevated administrator, so C:\Windows is writable for it):
# files and folders denied to its own SID, inherited.
$LockedRoot = 'C:\MU-locked'
function Set-FolderDeny([string]$Path, [bool]$On) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $rights = [System.Security.AccessControl.FileSystemRights]'CreateFiles, CreateDirectories'
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Deny)
  $info = New-Object System.IO.DirectoryInfo $Path
  $acl = $info.GetAccessControl()
  if ($On) { $acl.AddAccessRule($rule) } else { [void]$acl.RemoveAccessRule($rule) }
  $info.SetAccessControl($acl)
  $probe = Join-Path $Path 'MU-probe.txt'
  $writable = $true
  try { [System.IO.File]::WriteAllText($probe, 'x'); Remove-Item -LiteralPath $probe -Force } catch { $writable = $false }
  Write-Log "  folder $Path : add files/folders $(if ($On) { 'denied' } else { 'given back' }); writable now: $writable"
}

# 3 (fixed): a new install into a folder this account can't add to, as first shown and after the main button.
function Save-LockedFolder([string]$Prefix, [string]$Scale) {
  [void][System.IO.Directory]::CreateDirectory($LockedRoot)
  Set-FolderDeny $LockedRoot $true
  try {
    $p = Start-Setup @("/D=$LockedRoot\Petalock")
    try {
      $d = Wait-Page $p '*What Setup will do*'
      Start-Sleep -Milliseconds 1500
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "${Prefix}03-locked-first-$Scale" "${Prefix}3 folder that can't be written (denied), first look" $Scale '' $p
      Press-Button $d 1
      Start-Sleep -Milliseconds 3000
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "${Prefix}03-locked-$Scale" "${Prefix}3 folder that can't be written (denied), after the main button" $Scale '' $p
    } finally { Stop-Setup $p }
  } finally { Set-FolderDeny $LockedRoot $false }
  Write-Log "  installed after the refusal: $([System.IO.File]::Exists("$LockedRoot\Petalock\petalock.exe"))"
}

# 3b: an update whose folder this account can't add to (an older version recorded, the program folder denied).
function Save-LockedUpdate([string]$Scale) {
  Reset-World
  Install-Quietly
  $script:RealVersion = [string](Get-ItemProperty -LiteralPath $UninstallKey -Name 'DisplayVersion').DisplayVersion
  Set-DisplayVersion '0.0.9'
  Set-FolderDeny $DefaultDir $true
  try {
    $p = Start-Setup
    try {
      $d = Wait-Page $p '*What Setup will do*'
      Start-Sleep -Milliseconds 1500
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "03b-update-locked-first-$Scale" "3b update, folder can't be written, first look" $Scale '' $p
      Press-Button $d 1
      Start-Sleep -Milliseconds 3000
      $d = Get-Dialog $p $d.Handle
      Write-Log "  page: $(Get-DialogDump $d)"
      Save-Window $d.Handle "03b-update-locked-$Scale" "3b update, folder can't be written, after the main button" $Scale '' $p
    } finally { Stop-Setup $p }
  } finally { Set-FolderDeny $DefaultDir $false; Set-DisplayVersion $script:RealVersion }
  Reset-World
}

# All the states at one scale, each from a known world.
function Invoke-Scale([string]$Scale) {
  Reset-World
  Invoke-Step "1-2 first page and Options at $Scale" { Save-FirstAndOptions '' $Scale }
  Invoke-Step "3 folder that can't be written at $Scale" { Save-BadFolder '' $Scale }
  Invoke-Step "12 low space at $Scale" { Save-LowSpace $Scale }
  Reset-World
  Invoke-Step "4-5 progress and receipt at $Scale" { Save-InstallAndReceipt '' $Scale }
  Invoke-Step "installed for 6-11 at $Scale" {
    if (-not (Test-Installed)) { Write-Log '  not installed after the window: silent install'; Reset-World; Install-Quietly }
    $script:RealVersion = [string](Get-ItemProperty -LiteralPath $UninstallKey -Name 'DisplayVersion').DisplayVersion
    Write-Log "  installed version $($script:RealVersion)"
  }
  Invoke-Step "6 same version at $Scale" { Save-Maintenance '06-reinstall' '6 same version installed' $Scale }
  Invoke-Step "7 older installed at $Scale" { try { Set-DisplayVersion '0.0.9'; Save-Maintenance '07-update' '7 older installed (0.0.9)' $Scale } finally { Set-DisplayVersion $script:RealVersion } }
  Invoke-Step "8 newer installed at $Scale" { try { Set-DisplayVersion '9.9.9'; Save-Maintenance '08-newer' '8 newer installed (9.9.9)' $Scale -Other } finally { Set-DisplayVersion $script:RealVersion } }
  Invoke-Step "9 unknown version at $Scale" { try { Set-DisplayVersion $null; Save-Maintenance '09-unknown' '9 unknown version' $Scale } finally { Set-DisplayVersion $script:RealVersion } }
  Invoke-Step "13 added-file refusal at $Scale" { Save-AddedRefusal $Scale }
  Invoke-Step "10 Petalock running at $Scale" { Save-Running $Scale }
  Invoke-Step "11 uninstaller at $Scale" { if (-not (Test-Installed)) { Install-Quietly }; Save-Uninstall $Scale }
  Reset-World
  Invoke-Step "14 registry refusal at $Scale" { Save-RegistryRefusal $Scale }
  Reset-World
}

# --- run -------------------------------------------------------------------------------------------------------------------

$started = Get-Date
Write-Log "installer-pictures: $([System.IO.Path]::GetFileName($Installer)), SHA-256 $(Get-Sha256 $Installer), version $([System.Diagnostics.FileVersionInfo]::GetVersionInfo($Installer).ProductVersion)"
Write-Log "session $([System.Diagnostics.Process]::GetCurrentProcess().SessionId), interactive $([Environment]::UserInteractive), per-monitor aware set: $aware, 64-bit: $([Environment]::Is64BitProcess)"
Write-Log "screen $([Cap]::GetSystemMetrics(0)) x $([Cap]::GetSystemMetrics(1)); system dpi $([Cap]::GetDpiForSystem()); monitor dpi $([Cap]::MonitorDpi()); high contrast flags $([Cap]::HighContrastFlags()); message font / menu height $([Cap]::Metrics() -join ' / ')"
try { Set-DisplayResolution -Width 1920 -Height 1080 -Force -ErrorAction Stop; Start-Sleep -Seconds 3; Write-Log "Set-DisplayResolution 1920 x 1080: ok; screen now $([Cap]::GetSystemMetrics(0)) x $([Cap]::GetSystemMetrics(1))" }
catch { Write-Log "Set-DisplayResolution 1920 x 1080: $($_.Exception.Message)" }
try { $g = [Cap]::Get(); Write-Log "scale steps rel min/cur/max: $($g -join ' / ')" } catch { Write-Log "scale steps unreadable: $($_.Exception.Message)" }

if ($Only -eq 'folder') {
  # Second run: only the folder that can't be written (new install and update), at each scale and under high contrast.
  foreach ($scale in @(100, 125, 150, 175)) {
    Invoke-Step "set scale $scale" { Set-Scale $scale }
    Reset-World
    Invoke-Step "3 folder that can't be written at $scale" { Save-LockedFolder '' "$scale" }
    Invoke-Step "3b update folder that can't be written at $scale" { Save-LockedUpdate "$scale" }
  }
  Invoke-Step 'set scale 100' { Set-Scale 100 }
  Invoke-Step 'high contrast, folder that can''t be written' {
    $r = [Cap]::SetHighContrast($true, 'High Contrast Black')
    $deadline = (Get-Date).AddSeconds(30)
    while ((([Cap]::HighContrastFlags() -band 1) -ne 1) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 8
    Write-Log "  high contrast on: result $r; flags $([Cap]::HighContrastFlags()); window colour $('{0:X6}' -f [Cap]::GetSysColor(5))"
    try {
      Reset-World
      Invoke-Step 'hc 3' { Save-LockedFolder 'hc-' '100' }
      Invoke-Step 'hc 3b' { Save-LockedUpdate 'hc-100' }
    } finally {
      [void][Cap]::SetHighContrast($false, $null)
      $deadline = (Get-Date).AddSeconds(30)
      while ((([Cap]::HighContrastFlags() -band 1) -ne 0) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
      Write-Log "  high contrast off: flags $([Cap]::HighContrastFlags())"
    }
  }
  Invoke-Step 'clean up' { Reset-World; Remove-Item -LiteralPath $LockedRoot -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Log ("installer-pictures (folder run): done in {0:N0} s; {1} pictures" -f ((Get-Date) - $started).TotalSeconds, @(Get-ChildItem -LiteralPath $Out -Filter '*.png').Count)
  exit 0
}

Invoke-Step 'small drive for state 12' { New-SmallDrive }

foreach ($scale in @(100, 125, 150, 175)) {
  Invoke-Step "set scale $scale" { Set-Scale $scale }
  Invoke-Scale "$scale"
}

# --- extra checks at 100 % ---
Invoke-Step 'set scale 100 for the extra checks' { Set-Scale 100 }

# Live scale change: the first page open at 100 %, switched to 150 % (WM_DPICHANGED), and back.
Invoke-Step 'live scale change on the first page' {
  Reset-World
  $p = Start-Setup
  try {
    $d = Wait-Page $p '*What Setup will do*'
    Start-Sleep -Milliseconds 1500
    Save-Window $d.Handle 'live-01-first-100-before' 'live: first page at 100 before the switch' '100' '' $p
    Set-Scale 150
    Start-Sleep -Seconds 2
    Save-Window $d.Handle 'live-01-first-100to150' 'live: first page opened at 100, now 150' '100>150' '' $p
    Set-Scale 100
    Start-Sleep -Seconds 2
    Save-Window $d.Handle 'live-01-first-150to100' 'live: back at 100' '150>100' '' $p
  } finally { Stop-Setup $p; Set-Scale 100 }
}
Invoke-Step 'live scale change on the receipt' {
  Reset-World
  Save-InstallAndReceipt 'live-' '100' {
    param($h, $proc)
    Set-Scale 150
    Start-Sleep -Seconds 2
    Save-Window $h 'live-05-receipt-100to150' 'live: receipt opened at 100, now 150' '100>150' '' $proc
    Set-Scale 100
    Start-Sleep -Seconds 2
  }
  Reset-World
}

# High contrast: on live, states 1, 2, 3 and 5 (4 comes on the way), then off.
Invoke-Step 'high contrast' {
  $before = "window $('{0:X6}' -f [Cap]::GetSysColor(5)) text $('{0:X6}' -f [Cap]::GetSysColor(8))"
  $r = [Cap]::SetHighContrast($true, 'High Contrast Black')
  $deadline = (Get-Date).AddSeconds(30)
  while ((([Cap]::HighContrastFlags() -band 1) -ne 1) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  Write-Log "  SPI_SETHIGHCONTRAST on: result $r; flags now $([Cap]::HighContrastFlags()); system colours before: $before"
  if (([Cap]::HighContrastFlags() -band 1) -ne 1) {
    $themes = Join-Path $env:SystemRoot 'Resources\Ease of Access Themes'
    Write-Log "  the call did not take; themes there: $((Get-ChildItem -LiteralPath $themes -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ', ')"
    $theme = @(Get-ChildItem -LiteralPath $themes -Filter '*.theme' -ErrorAction SilentlyContinue | Sort-Object { $_.Name -ne 'aquatic.theme' })[0]
    if ($theme) { Start-Process -FilePath $theme.FullName; $deadline = (Get-Date).AddSeconds(60); while ((([Cap]::HighContrastFlags() -band 1) -ne 1) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 } }
    Get-Process -Name 'SystemSettings' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch { } }
    Write-Log "  theme $($theme.Name): flags now $([Cap]::HighContrastFlags())"
  }
  Start-Sleep -Seconds 8
  Write-Log "  system colours now: window $('{0:X6}' -f [Cap]::GetSysColor(5)) text $('{0:X6}' -f [Cap]::GetSysColor(8)) highlight $('{0:X6}' -f [Cap]::GetSysColor(13)) hotlight $('{0:X6}' -f [Cap]::GetSysColor(26)) btnface $('{0:X6}' -f [Cap]::GetSysColor(15))"
  if (([Cap]::HighContrastFlags() -band 1) -ne 1) { throw 'high contrast could not be turned on' }
  try {
    Reset-World
    Invoke-Step 'hc 1-2' { Save-FirstAndOptions 'hc-' '100' }
    Invoke-Step 'hc 3' { Save-BadFolder 'hc-' '100' }
    Invoke-Step 'hc 4-5' { Save-InstallAndReceipt 'hc-' '100' }
    Reset-World
  } finally {
    $r = [Cap]::SetHighContrast($false, $null)
    $deadline = (Get-Date).AddSeconds(30)
    while ((([Cap]::HighContrastFlags() -band 1) -ne 0) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 5
    Write-Log "  high contrast off: result $r; flags now $([Cap]::HighContrastFlags())"
  }
}

# Larger text: TextScaleFactor 150 and a broadcast; whether the system's fonts grew is measured, then 1 and 2.
Invoke-Step 'larger text 150' {
  $before = [Cap]::Metrics()
  $menuBefore = [Cap]::GetSystemMetrics(15)
  $key = 'HKCU:\Software\Microsoft\Accessibility'
  if (-not (Test-Path -LiteralPath $key)) { [void](New-Item -Path $key -Force) }
  try {
    New-ItemProperty -LiteralPath $key -Name 'TextScaleFactor' -PropertyType DWord -Value 150 -Force | Out-Null
    [Cap]::Broadcast(0x2A, 'WindowMetrics')
    [Cap]::Broadcast(0, 'Accessibility')
    Start-Sleep -Seconds 4
    $after = [Cap]::Metrics()
    $menuAfter = [Cap]::GetSystemMetrics(15)
    $took = ($after[0] -ne $before[0]) -or ($menuAfter -ne $menuBefore)
    Write-Log "  TextScaleFactor 150: message font height $($before[0]) -> $($after[0]); menu height (NCM) $($before[1]) -> $($after[1]); SM_CYMENU $menuBefore -> $menuAfter; took effect without sign-out: $took"
    Reset-World
    Save-FirstAndOptions 'text150-' '100'
  } finally {
    Remove-ItemProperty -LiteralPath $key -Name 'TextScaleFactor' -ErrorAction SilentlyContinue
    [Cap]::Broadcast(0x2A, 'WindowMetrics')
    [Cap]::Broadcast(0, 'Accessibility')
    Write-Log "  TextScaleFactor removed; message font height now $([Cap]::Metrics()[0])"
  }
}

Invoke-Step 'clean up' { Reset-World; Remove-SmallDrive }
Write-Log ("installer-pictures: done in {0:N0} s; {1} pictures" -f ((Get-Date) - $started).TotalSeconds, @(Get-ChildItem -LiteralPath $Out -Filter '*.png').Count)
exit 0
