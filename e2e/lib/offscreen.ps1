# Moves every visible top-level window of one process off the screen, without activating it, so that an end-to-end run
# does not get in the way of whoever is at the PC. Waits up to -TimeoutSeconds for a window to appear. Prints one
# "moved" line per window (its old position, never its title). Exit 0 when at least one window was moved, 2 when none appeared.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [int]$TimeoutSeconds = 20
)
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OffScreen {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static List<IntPtr> Windows(uint pid) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$moved = 0
while ($moved -eq 0 -and (Get-Date) -lt $deadline) {
  foreach ($h in [OffScreen]::Windows([uint32]$ProcessId)) {
    $r = New-Object OffScreen+RECT
    [void][OffScreen]::GetWindowRect($h, [ref]$r)
    # SWP_NOSIZE 0x1 | SWP_NOZORDER 0x4 | SWP_NOACTIVATE 0x10
    if ([OffScreen]::SetWindowPos($h, [IntPtr]::Zero, -4000, -4000, 0, 0, 0x15)) {
      "moved from $($r.Left),$($r.Top)"
      $moved++
    }
  }
  if ($moved -eq 0) { Start-Sleep -Milliseconds 100 }
}
if ($moved -eq 0) { "no window of process $ProcessId appeared"; exit 2 }
