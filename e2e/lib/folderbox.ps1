# Answers a native Windows file or folder box that WebDriver cannot reach, by window messages only: finds the visible
# dialog (#32770) of one process whose title contains -Title, moves it off the screen without activating it, puts
# -Folder in its name box (control 1152 in a folder picker, 1148 or 1001 in a file box), reads the text back, and
# presses the default button (control 1) only if the box holds exactly what was typed. Waits up to -TimeoutSeconds for
# the box to appear.
# Exit 0 pressed; 2 no such box appeared; 3 the box has no name box; 4 the box did not hold the text; 5 no default button.
# Prints no path.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Folder,
  [int]$TimeoutSeconds = 20
)
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FolderBox {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Read(IntPtr h) { var s = new StringBuilder(4096); SendMessage(h, 0x000D, (IntPtr)4096, s); return s.ToString(); }
  public static List<IntPtr> Tops() { var r = new List<IntPtr>(); EnumWindows((h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static List<IntPtr> Kids(IntPtr p) { var r = new List<IntPtr>(); EnumChildWindows(p, (h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static uint Owner(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
}
"@
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$box = $null
while ($null -eq $box -and (Get-Date) -lt $deadline) {
  $box = [FolderBox]::Tops() | Where-Object {
    [FolderBox]::IsWindowVisible($_) -and [FolderBox]::Owner($_) -eq [uint32]$ProcessId -and
    [FolderBox]::Cls($_) -eq "#32770" -and [FolderBox]::Title($_).Contains($Title)
  } | Select-Object -First 1
  if ($null -eq $box) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $box) { "no box titled like the one asked for appeared"; exit 2 }
# SWP_NOSIZE 0x1 | SWP_NOZORDER 0x4 | SWP_NOACTIVATE 0x10
[void][FolderBox]::SetWindowPos($box, [IntPtr]::Zero, -4000, -4000, 0, 0, 0x15)
$edit = [FolderBox]::Kids($box) | Where-Object { [FolderBox]::Cls($_) -eq "Edit" -and ([FolderBox]::GetDlgCtrlID($_) -in @(1152, 1148, 1001)) } | Select-Object -First 1
if ($null -eq $edit) { "the box has no name box"; exit 3 }
[void][FolderBox]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $Folder)
if ([FolderBox]::Read($edit) -ne $Folder) { "the name box did not hold the text; pressed nothing"; exit 4 }
$button = [FolderBox]::Kids($box) | Where-Object { [FolderBox]::Cls($_) -eq "Button" -and [FolderBox]::GetDlgCtrlID($_) -eq 1 } | Select-Object -First 1
if ($null -eq $button) { "the box has no default button"; exit 5 }
# BM_CLICK on the button itself, as a real press does, so the box runs its own checks on the typed name.
[void][FolderBox]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
"pressed"
