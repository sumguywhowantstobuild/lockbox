# Measures installer words with Windows' own text drawing, for scripts/installer-render.test.mjs (Plan 5, Task 9h).
#
#   powershell -NoProfile -File scripts/installer-measure-text.ps1 -In keys.json -Out table.json
#
# keys.json is a list of { "text", "weight", "em", "width" }: the words, the font weight (400 or 600, as the installer's
# fonts have), the font's size in pixels at 100 % (12, 15, 19 or 20) and the room the words have in design pixels at 100 %
# (0 for a single line with no limit). For each of the five scales (96, 120, 144, 168 and 192 dpi, which are 100, 125, 150,
# 175 and 200 %) the font is made as the installer makes it (Segoe UI, a negative height of em x dpi / 96 pixels, once) and
# the words are measured with GetTextExtentPoint32 (their one-line width) and DrawText with DT_CALCRECT | DT_WORDBREAK
# (their height in a box of that width, as a label draws them). The result keeps each key and adds "w" and "h" (five numbers
# each, one per scale) and "pitch" (the height of one line).
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class InstallerText {
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFontW(int h, int w, int e, int o, int weight, uint i, uint u, uint s, uint cs, uint op, uint cp, uint q, uint pf, string face);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr w);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr w, IntPtr dc);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int DrawTextW(IntPtr dc, string s, int n, ref RECT r, uint f);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern bool GetTextExtentPoint32W(IntPtr dc, string s, int n, out SIZE sz);
  public static int[] Measure(string text, int lfHeight, int weight, int boxWidth) {
    IntPtr dc = GetDC(IntPtr.Zero);
    IntPtr font = CreateFontW(lfHeight, 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 0, 0, "Segoe UI");
    IntPtr old = SelectObject(dc, font);
    SIZE one; GetTextExtentPoint32W(dc, text, text.Length, out one);
    SIZE line; GetTextExtentPoint32W(dc, "Ag", 2, out line);
    int height = line.cy;
    if (boxWidth > 0) {
      RECT r = new RECT(); r.l = 0; r.t = 0; r.r = boxWidth; r.b = 0;
      // DT_CALCRECT 0x400 | DT_WORDBREAK 0x10 | DT_NOPREFIX 0x800 | DT_EXPANDTABS 0x40
      DrawTextW(dc, text, -1, ref r, 0x400 | 0x10 | 0x800 | 0x40);
      height = r.b - r.t;
    }
    SelectObject(dc, old); DeleteObject(font); ReleaseDC(IntPtr.Zero, dc);
    return new int[] { one.cx, height, line.cy };
  }
}
"@
$keys = Get-Content -LiteralPath $In -Raw -Encoding UTF8 | ConvertFrom-Json
$result = @()
foreach ($key in @($keys)) {
  $w = @(); $h = @(); $pitch = @()
  foreach ($dpi in 96, 120, 144, 168, 192) {
    $em = [int][math]::Floor($key.em * $dpi / 96)
    $room = [int][math]::Floor($key.width * $dpi / 96)
    $m = [InstallerText]::Measure([string]$key.text, -$em, [int]$key.weight, $room)
    $w += $m[0]; $h += $m[1]; $pitch += $m[2]
  }
  $result += [pscustomobject]@{ text = [string]$key.text; weight = [int]$key.weight; em = [int]$key.em; width = [int]$key.width; w = $w; h = $h; pitch = $pitch }
}
$json = ConvertTo-Json -InputObject @($result) -Depth 4
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "measured $(@($result).Count) entries"
