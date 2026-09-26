<#
console-screen-dump.ps1 -- read ANOTHER console window's screen buffer, code page and
doubling pattern. Read-only: it attaches to the target console, reads characters, and
never writes to it.

Why this exists: the DSH-Web window (tools\dsh-prompt.ps1 prints Chinese) sometimes
renders every CJK character twice ("ZhengZheng 正正 ..."). The question that decides the
fix is whether the BUFFER holds two chars per CJK char (the writer duplicated them, so
the fix is in our script) or one char (conhost/font rendering, so the fix is the window's
font/code page). Reading the buffer answers it; eyeballing the window does not.
(First seen 2026-09-23, probes were parked in state\_tmp and got cleaned up -> now a
permanent tool. See docs\规则与踩坑日志.md.)

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\console-screen-dump.ps1 -TargetPid 23064
  ... -Out D:\hobby\DSH\qq-bridge\state\_tmp\console-dump.txt     # write UTF-8 instead of stdout

Find the pid of the window that prints the banner (cmd.exe host + the guard script):
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe' or Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'dsh-window|dsh-prompt' } | ft ProcessId,Name

Pure ASCII on purpose (PS 5.1 reads BOM-less UTF-8 as GBK), and it still carries a UTF-8 BOM
because tools\self-check.mjs (5.10) requires one on every tools\*.ps1. If an editor strips the
BOM, put it back with:
  [IO.File]::WriteAllBytes($p, [byte[]](0xEF,0xBB,0xBF) + [IO.File]::ReadAllBytes($p))
#>
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class ConDump
{
    [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct CSBI
    {
        public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes;
        public SMALL_RECT srWindow; public COORD dwMaximumWindowSize;
    }
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr templ);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ReadConsoleOutputCharacter(IntPtr h, StringBuilder buf, uint len, COORD coord, out uint read);
    [DllImport("kernel32.dll")] public static extern uint GetConsoleOutputCP();
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();

    // Is a run of the same char twice in a row? (the doubling signature)
    static int CountDoubled(string s)
    {
        int n = 0;
        for (int i = 1; i < s.Length; i++) if (s[i] == s[i - 1] && s[i] != ' ') n++;
        return n;
    }
    static string Codes(string s, int max)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < s.Length && i < max; i++) sb.Append(((int)s[i]).ToString("X4")).Append(' ');
        return sb.ToString().Trim();
    }

    public static string Dump(uint pid)
    {
        var sb = new StringBuilder();
        FreeConsole();
        if (!AttachConsole(pid))
        {
            sb.AppendLine("AttachConsole FAILED, win32err=" + Marshal.GetLastWin32Error());
            return sb.ToString();
        }
        sb.AppendLine("attached to pid " + pid);
        sb.AppendLine("GetConsoleWindow(now mine) = 0x" + GetConsoleWindow().ToInt64().ToString("X"));
        sb.AppendLine("GetConsoleOutputCP = " + GetConsoleOutputCP());
        sb.AppendLine("Console.OutputEncoding = " + Console.OutputEncoding.WebName);
        sb.AppendLine("Console.InputEncoding  = " + Console.InputEncoding.WebName);

        IntPtr h = CreateFileW("CONOUT$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
        if (h == new IntPtr(-1))
        {
            sb.AppendLine("CreateFile(CONOUT$) FAILED, win32err=" + Marshal.GetLastWin32Error());
            return sb.ToString();
        }
        CSBI info;
        if (!GetConsoleScreenBufferInfo(h, out info))
        {
            sb.AppendLine("GetConsoleScreenBufferInfo FAILED, win32err=" + Marshal.GetLastWin32Error());
            return sb.ToString();
        }
        sb.AppendLine("buffer = " + info.dwSize.X + " x " + info.dwSize.Y
            + "   window rows " + info.srWindow.Top + ".." + info.srWindow.Bottom
            + "   cursor " + info.dwCursorPosition.X + "," + info.dwCursorPosition.Y);
        sb.AppendLine();

        int width = info.dwSize.X;
        for (int row = info.srWindow.Top; row <= info.srWindow.Bottom; row++)
        {
            var line = new StringBuilder(width);
            uint got;
            var c = new COORD(); c.X = 0; c.Y = (short)row;
            if (!ReadConsoleOutputCharacter(h, line, (uint)width, c, out got)) { sb.AppendLine("row " + row + ": read failed"); continue; }
            string s = line.ToString().TrimEnd();
            if (s.Length == 0) continue;
            int dbl = CountDoubled(s);
            sb.AppendLine("row " + row.ToString("00") + "  len=" + s.Length + "  doubled=" + dbl + "  [" + s + "]");
            sb.AppendLine("        codes: " + Codes(s, 48));
        }
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp

$text = [ConDump]::Dump([uint32]$TargetPid)
if ($Out) {
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("[console-screen-dump] wrote " + $Out + " (" + $text.Length + " chars)")
} else {
    Write-Output $text
}
