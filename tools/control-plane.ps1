<#
  控制面（:3101，页面总控面板的 HTTP 载波 = tools\control-server.mjs）的**唯一一份起法**。  # port-literal-ok: 注释里提到面板端口，不是配置来源（端口一律走 env-config.ps1 的 Get-AgentPorts）

  为什么抽出来（2026-09-26 主人报「总控的灯不见了，我刷新了没用」的收口）：
    · 起法原来**只**长在 tools\start-all.ps1 里（一段内联的 `cmd /d … node tools\control-server.mjs`）；
    · QQ 搬到服务器（qq-bridge\qq-moved-to-server）之后，凡走"补缺"那条路（`start-all -NoRestart`）
      都会把 **SnowLuma 与桥接一起起出来 ⇒ 抢号**，于是 dsh-prompt 的补缺被**整段跳过**
      ⇒ 按一次 `r` 之后 :3101 死了**没人管**（页面面板一直「读不到状态」）；  # port-literal-ok: 同上，叙述用
    · 于是把那个形状抽成这一份，三个入口共用：start-all（全量启动）、dsh-prompt（补缺）、
      **谁都不许再写第二份实现**（"补缺"那条口径写在 dsh-prompt.ps1 的注释里）。

  ★ 与三件套**没有任何父子/守护关系**：起不来或中途死了，只是页面面板变灰 ⇒ 本文件一律**不 throw**，
    把结果当返回值交出去（`@{ ok; act; why; port; pid; secs }`，act = none | started | failed）。
  ★ **没有守护循环**：只"当场确保一次"⇒ `stop-all` 关掉之后**绝不会自己回来**（关得干净）。
  ★ 幂等：已经在监听就**什么都不做**（不会起第二个）。

  当脚本跑（验收/排查用，只动 :3101 一个进程）：  # port-literal-ok: 同上，叙述用
    powershell -File tools\control-plane.ps1 -CpEnsure [-CpQuiet] [-CpWaitSec 15]
      退出码 0 = 在听；1 = 没起来（如实报，绝不粉饰）。
  当库用（dot-source）：调 `Start-ControlPlane [-Port <int>] [-WaitSec <int>] [-Quiet]`。
    ⚠ 参数名带 `Cp` 前缀：dot-source 会把 param 里的名字带进调用方作用域，前缀避免撞名。
#>
param(
    [switch]$CpEnsure,
    [switch]$CpQuiet,
    [int]$CpWaitSec = 15
)

# 仓库根 / 端口 / 那两个无窗口起进程的助手：都按需解析（**不假设调用方已经点源过谁**）——
# 这一份要在三个入口里都能用：start-all（点过 windowless.ps1）、dsh-prompt（没点过）、以及本文件当脚本跑。
$script:CpRoot = Split-Path $PSScriptRoot -Parent

function Get-CpPort {
    if (-not (Get-Command Get-AgentPorts -ErrorAction SilentlyContinue)) {
        . (Join-Path $PSScriptRoot 'env-config.ps1')
    }
    return (Get-AgentPorts).bridgeControl
}

# 廉价探活：一个 TCP 连接试一下（不拉子进程）。与 dsh-prompt 的 Test-PortQuick 同形状、但**各留一份**：
# 那个是窗口看守的触发器（250ms），这个是"控制面在不在"的判据，语义不同、别互相绑死。
function Test-ControlPlaneAlive {
    param([int]$Port = 0, [int]$TimeoutMs = 300)
    if ($Port -le 0) { $Port = Get-CpPort }
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs)
        $conn = ($ok -and $c.Connected)
        $c.Close()
        return [bool]$conn
    } catch { return $false }
}

# ★ 唯一一份起法。返回 @{ ok; act; why; port; pid; secs }
function Start-ControlPlane {
    param([int]$Port = 0, [int]$WaitSec = 15, [switch]$Quiet)
    $say = { param([string]$m) if (-not $Quiet) { Write-Host $m } }
    if ($Port -le 0) { $Port = Get-CpPort }
    if (Test-ControlPlaneAlive -Port $Port) {
        & $say ('      {0} 已在监听 —— 控制面已在运行。' -f $Port)
        return @{ ok = $true; act = 'none'; port = $Port; pid = 0; secs = 0; why = '已在监听 ⇒ 不重复起' }
    }
    try {
        if (-not (Get-Command Start-WindowlessProcess -ErrorAction SilentlyContinue)) {
            . (Join-Path $PSScriptRoot 'windowless.ps1')
        }
        # node 的选择与 start-all 同一条判据：优先 SnowLuma 自带的那只，找不到才用 PATH 里的 node。
        $snowlumaNode = Join-Path (Join-Path $script:CpRoot 'SnowLuma') 'node.exe'
        $ctlNode = if (Test-Path $snowlumaNode) { $snowlumaNode } else { 'node' }
        $ctlLog = Join-Path $script:CpRoot 'qq-bridge\state\_tmp\control-server.log'
        $ctlCommand = 'cd /d "' + $script:CpRoot + '" & "' + $ctlNode + '" tools\control-server.mjs'
        & $say ('      等 :{0} 起来（最多 {1} 秒）…' -f $Port, $WaitSec)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $ctlProc = Start-WindowlessProcess -FilePath 'cmd.exe' -WorkingDirectory $script:CpRoot `
            -Arguments (New-CmdRedirectLine -Command $ctlCommand -StdOutLog $ctlLog)
        $ok = $false
        for ($i = 0; $i -lt $WaitSec; $i++) {
            Start-Sleep -Milliseconds 1000
            if (Test-ControlPlaneAlive -Port $Port) { $ok = $true; break }
        }
        $sw.Stop()
        $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        if ($ok) {
            & $say ('      已启动（后台进程 {0}，CREATE_NO_WINDOW：不会出现它的窗口；日志 {1}）' -f $ctlProc.Id, $ctlLog)
            return @{ ok = $true; act = 'started'; port = $Port; pid = $ctlProc.Id; secs = $secs; why = '刚起起来' }
        }
        & $say '      [提示] 控制面没起来 —— 只是页面面板暂时没数据，三件套不受影响。'
        return @{ ok = $false; act = 'failed'; port = $Port; pid = 0; secs = $secs; why = ('等了 {0} 秒 :{1} 还是没在听' -f $WaitSec, $Port) }
    } catch {
        & $say ('      [提示] 控制面没起来（{0}）—— 三件套不受影响。' -f $_.Exception.Message)
        return @{ ok = $false; act = 'failed'; port = $Port; pid = 0; secs = 0; why = $_.Exception.Message }
    }
}

if ($CpEnsure) {
    Write-Host ''
    Write-Host '  ── 控制面（页面总控面板的载波）· 确保一次 ─────────────────'
    Write-Host ('  · 唯一起法：本文件（tools\control-plane.ps1）；只动这一个进程，DSH / QQ / 桥接一律不碰')
    $r = Start-ControlPlane -WaitSec $CpWaitSec -Quiet:$CpQuiet
    Write-Host ('  · 结果：{0}（act={1}；{2} 秒；pid={3}）' -f `
        $(if ($r.ok) { '✓ 在听' } else { '✗ 不在听' }), $r.act, $r.secs, $(if ($r.pid) { $r.pid } else { '-' }))
    if ($r.why) { Write-Host ('  · 说明：' + $r.why) }
    Write-Host ''
    exit $(if ($r.ok) { 0 } else { 1 })
}
