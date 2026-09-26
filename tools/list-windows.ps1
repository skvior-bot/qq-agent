# list-windows.ps1 —— 列出"屏幕上所有可见窗口"（2026-09-24）
#
# 为什么不用 Get-Process 的 MainWindowHandle：它**看不到**某些控制台/终端辅助窗口
# （实测漏掉了 cmd 的 PseudoConsoleWindow —— 那个 159x27、贴在左下角的白色空框就是这个），
# 于是前几次排查都白做了。这里用 EnumWindows + IsWindowVisible + GetWindowRect，一个不漏。
#
# 用法：powershell -File tools\list-windows.ps1 [-Label "说明"] [-AppendTo <日志文件>]
[CmdletBinding()]
param(
    [string]$Label = '',
    [string]$AppendTo = ''
)
$ErrorActionPreference = 'Stop'
if (-not ('WinEnumX' -as [type])) {
    Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnumX {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Dump() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var c = new StringBuilder(512); GetClassNameW(h, c, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      if ((r.R - r.L) <= 0 || (r.B - r.T) <= 0) return true;
      res.Add(pid + "|" + c.ToString() + "|" + t.ToString() + "|" + (r.R-r.L) + "x" + (r.B-r.T) + " at " + r.L + "," + r.T);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
}
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add(("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Label))
foreach ($row in [WinEnumX]::Dump()) {
    $p = $row -split '\|'
    $name = '?'
    try { $name = (Get-Process -Id ([int]$p[0]) -ErrorAction Stop).ProcessName } catch { }
    $lines.Add(('  {0,-16} pid={1,-7} {2,-24} {3,-18} "{4}"' -f $name, $p[0], $p[1], $p[3], $p[2]))
}
if ($AppendTo) { $lines | Out-File -FilePath $AppendTo -Encoding UTF8 -Append } else { $lines | ForEach-Object { Write-Host $_ } }