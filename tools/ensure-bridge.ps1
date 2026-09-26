# ensure-bridge.ps1 —— 把桥接带回正轨（2026-09-24，第 2 版）
#
# 为什么需要它：在 DSH-Web 窗口按 r 只重启 DSH。DSH 一换代，launch token 就变了，而桥接
# 手里还是旧令牌（全链路 401）；实测更糟 —— 那次重启连桥接进程带它的守护窗口一起没了，
# 于是桥接控制台端口直接 DOWN，而"用 API 重启桥接"这条路在桥接死时根本走不通（fetch failed）。
#
# 第 2 版两处改动（主人："r 和 b 可以同步在一起吗 —— 我按完 r 之后窗口最小化了，没有提示要我去按 b"）：
#   1) **默认等新令牌**：DSH 起来到写出 token 有几秒空窗，太早读会读到旧值或读不到，
#      所以先重试直到令牌同步成功（最多 -WaitSeconds 秒）。这样它可以被 r 之后立刻调用而不扑空。
#   2) **不创建窗口**（第 3 版，2026-09-24 P1④）：默认按"后台进程"拉起（桌面只留 DSH-Web）；
#      起法/为什么不再用"Hidden + 重定向"、失败怎么回退，都写在下面第 2 段与 tools\windowless.ps1 文件头。
#   顺带把当时的窗口清单记一笔（state\_tmp\ensure-bridge-windows.log），排障时能对上号。
#
# 退出码：0 = 本来就是好的或已恢复；4 = 拉起来了但没监听 / 令牌始终没同步上（看 state\bridge.log）
[CmdletBinding()]
param(
    [switch]$Quiet,
    [int]$WaitSeconds = 25,
    # 回退开关（与 tools\start-all.ps1 -Visible 同一语义）：用**可见窗口**方式拉起桥接。
    [switch]$Visible
)
$ErrorActionPreference = 'Stop'

# ── 端口唯一来源（P2⑦ 参数单一来源）────────────────────────────────────────
# 默认值表只有一处（qq-bridge\src\config-lib.js 的 DEFAULT_PORTS），生效值由仓库根的
# agent.config.json 决定 —— 问 Node 要（见 tools\env-config.ps1 文件头）。本脚本不抄字面量。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
$BridgePort = $Ports.bridgeConsole
$Root      = Split-Path -Parent $PSScriptRoot
$BridgeDir = Join-Path $Root 'qq-bridge'
$BridgeBat = Join-Path $BridgeDir 'start.bat'
$TmpDir    = Join-Path $BridgeDir 'state\_tmp'

function Say([string]$m) { if (-not $Quiet) { Write-Host $m } }
function Test-Port([int]$Port) {
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port)
        return $true
    } catch { return $false } finally { if ($c) { $c.Close() } }
}

# ── 0) 诊断：把"此刻有窗口的进程"记一笔（r 之后紧接着跑，正好可能抓到那个白窗口）────────
try {
    if (-not (Test-Path $TmpDir)) { New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null }
    $who = 'auto'
    if (-not $Quiet) { $who = 'manual' }
    # 用 tools\list-windows.ps1（EnumWindows）：Get-Process 的 MainWindowHandle **看不到**
    # 桥接那个 cmd 的 PseudoConsoleWindow（159x27、贴在左下角的空白小框就是它，2026-09-24 已实证）。
    $lw = Join-Path $PSScriptRoot 'list-windows.ps1'
    if (Test-Path $lw) {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $lw -Label ('ensure-bridge 开始时（' + $who + '）') -AppendTo (Join-Path $TmpDir 'ensure-bridge-windows.log') | Out-Null
    }
} catch { }

# ── 1) 同步 DSH 令牌：重试到成功（DSH 刚起来时 token 还没写进日志）────────────────────
Say '  桥接体检：先同步 DSH 令牌…'
Push-Location $Root
$synced = $false
$lastOut = ''
try {
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while (-not $synced) {
        $lastOut = (& node 'tools\ops.mjs' token --write 2>&1 | Out-String)
        if ($lastOut -match '已写回|已是最新') { $synced = $true; break }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 2
    }
} catch { Say ('    [警告] 写令牌时出错：' + $_.Exception.Message) }
finally { Pop-Location }
if ($synced) {
    if (-not $Quiet) { ($lastOut -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) | ForEach-Object { '    ' + $_.Trim() } }
} else {
    Say '    [警告] 还没读到 DSH 的新令牌（DSH 可能还没起来）—— 先看桥接本身'
}

# ── 2) 桥接没在跑就拉起来（**不创建窗口**；守护仍是 start.bat，认进程那套照旧）──────────
if (Test-Port $BridgePort) { Say ('  桥接 ' + $BridgePort + ' 已在监听 —— 不用动（令牌已同步，重启后生效）'); exit 0 }

Say ('  桥接 ' + $BridgePort + ' 不通 —— 拉起来（默认不创建窗口）…')
if (-not (Test-Path $BridgeBat)) { Say "  [错误] 找不到 $BridgeBat"; exit 4 }
# ★ 2026-09-24 的历史教训（那一次"无窗口化把桥接弄死"，别照着旧注释再踩一遍）：
#   `Start-Process -WindowStyle Hidden` **配** `-RedirectStandardOutput` 会死 —— 因为后者是**管道**，
#   读端是本脚本；本脚本一退出读端就没了，桥接往 stdout 一写就是断管（EPIPE）⇒ 当场死，
#   而守护看着还在跑。**不是"隐藏窗口"本身的错**（那台机器的控制台宿主是 Windows Terminal，
#   当时归因错了）。
#   现在的做法（实测过，见 tools\windowless.ps1 文件头）：
#     · 起法：Start-Process -WindowStyle Hidden（窗口对象一个都不建，桌面/任务栏零出现）
#     · 输出：交给 cmd `> 文件 2>&1`（真文件句柄，本脚本退出后照样有效，还留一份崩溃现场）
#     · 起的是**同一个 start.bat** ⇒ "桥接死了 5 秒后有人拉回来"这条自愈能力原地保留
#   无窗口那条在超时内没通就**自动回退**到有窗口形态（绝不留半死不活的状态）。
. (Join-Path $PSScriptRoot 'windowless.ps1')
$brOut = Join-Path $TmpDir 'bridge-console.out.log'
$brErr = Join-Path $TmpDir 'bridge-console.err.log'
$brCommand = 'title qq-bridge & start.bat'
$brProc = $null
if (-not $Visible) {
    $brProc = Start-WindowlessProcess -FilePath 'cmd.exe' -WorkingDirectory $BridgeDir `
        -Arguments (New-CmdRedirectLine -Command $brCommand -StdOutLog $brOut -StdErrLog $brErr)
    if ($brProc) { Say ('  已按"不创建窗口"的方式拉起（后台进程 ' + $brProc.Id + '）') }
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 1
        if (Test-Port $BridgePort) { Say ('  桥接已恢复（等了 ' + $i + ' 秒；无窗口运行，守护仍在）'); exit 0 }
    }
    # ★ 自动回退：先收掉自己刚起的那一棵（只按手里的 pid），再换回可见窗口重来一次
    Stop-WindowlessProcess -Process $brProc | Out-Null
    Write-WindowlessFallback -What 'qq-bridge（20 秒内端口没通）'
}
Start-Process -FilePath 'cmd.exe' -WorkingDirectory $BridgeDir -ArgumentList '/k', $brCommand
Start-Sleep -Seconds 2
# 起来之后把它的窗口最小化（找标题含 qq-bridge 的窗口），免得在桌面上留一个空白小框
try {
    if (-not ('WinMinX' -as [type])) {
        Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinMinX {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static int MinimizeTitled(string needle) {
    int n = 0;
    EnumWindows((h, l) => {
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      if (t.ToString().ToLower().Contains(needle)) { ShowWindow(h, 6); n++; }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
    }
    $n = [WinMinX]::MinimizeTitled('qq-bridge')
    # （藏窗口已撤：主人要求只最小化、不隐藏）
    if ($n -gt 0) { Say ('  已把 qq-bridge 窗口最小化（' + $n + ' 个）') }
} catch { }
foreach ($i in 1..20) {
    Start-Sleep -Seconds 1
    if (Test-Port $BridgePort) { Say ('  桥接已恢复（等了 ' + $i + ' 秒；窗口形态，守护仍在）'); exit 0 }
}
Say '  [错误] 20 秒内还没监听 —— 看 qq-bridge\state\bridge.log'
exit 4
