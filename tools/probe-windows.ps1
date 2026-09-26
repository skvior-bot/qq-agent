# ASCII only. List every visible top-level window whose owner is a console-ish process.
$ErrorActionPreference = 'Stop'

Add-Type -Namespace LW -Name W -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@

$rows = New-Object System.Collections.ArrayList
$cb = [LW.W+EnumProc]{
    param($h, $l)
    if (-not [LW.W]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [LW.W]::GetWindowTextW($h, $sb, 512) | Out-Null
    $title = $sb.ToString()
    $wpid = 0
    [LW.W]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    $proc = Get-Process -Id ([int]$wpid) -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { '?' }
    if ($name -in @('cmd', 'node', 'conhost', 'WindowsTerminal', 'OpenConsole', 'powershell', 'pwsh', 'ApplicationFrameHost')) {
        [void]$rows.Add([pscustomobject]@{ Owner = $name; Pid = [int]$wpid; Title = $title; Hwnd = $h })
    }
    return $true
}
[LW.W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

foreach ($r in ($rows | Sort-Object Owner, Title)) {
    Write-Host ("{0,-17} pid={1,-7} hwnd={2,-9} title='{3}'" -f $r.Owner, $r.Pid, $r.Hwnd, $r.Title)
}
Write-Host ("total: {0}" -f $rows.Count)
