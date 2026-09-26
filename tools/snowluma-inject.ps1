# 只给**指定 UIN** 的 QQ 进程做注入（2026-09-24）。
#
# 为什么要自己写而不用 SnowLuma 自带的 hookAutoLoad（config\runtime.json）：
# 那个开关会注入**所有**枚举到的 QQ.exe —— Windows 上没有任何过滤（源码 index.mjs 里
# shouldAutoLoadPid 只对 linux 生效）。主人机器上同时开着两个 QQ，于是 2026-09-24 开机时
# 他自己的号（<主人昵称> <主人QQ>）也被 hook 进来，它的 OneBot 还因为 OneBot/控制台端口被占
# 而报 EADDRINUSE 应用失败。⇒ 改成按 UIN 精确挑：先 probe-login 问出这个进程是哪个号，
# 是目标号才 load；不是就跳过。幂等：已经 injected 的不重复 load。
#
# ★ 身份从环境层来（2026-09-24 个人信息脱敏）：目标号可以写进 agent.config.json 的 botQQ
#   （写了就锁死，见下），主人号同样从环境层/config.json 的 ownerQQ 读 —— **本文件里一个
#   真号都不许出现**（原来注释里就写着主人的号与机器人号，交付/公开时会一起漏出去）。
#
# 用法：
#   powershell -File tools\snowluma-inject.ps1              # 目标号：先看 agent.config.json 的 botQQ，没有才自动推
#   powershell -File tools\snowluma-inject.ps1 -Uin <机器人QQ>
#   powershell -File tools\snowluma-inject.ps1 -DryRun      # 只看会注入谁
# 退出码：0 = 成功（已注入或本来就 injected）；3 = 没找到目标号的进程（她还没启动）；4/5 = 拿不到令牌/列进程失败
param(
    [string]$Uin = '',
    [switch]$DryRun,
    [int]$WaitOnlineSec = 60
)
$ErrorActionPreference = 'Continue'
# 端口从唯一来源派生（agent.config.json → tools\env-config.ps1 问 Node 要）；这里不写数字。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
$Base = "http://127.0.0.1:$($Ports.snowlumaWeb)"

# 目标 UIN：① -Uin 参数（最高）→ ② 环境层 agent.config.json 的 botQQ（填了就锁死，推荐）
#          → ③ 从 SnowLuma 的 OneBot 配置文件名里推（onebot_<UIN>.json，排除 ownerQQ）
if (-not $Uin) {
    $Uin = Get-AgentBotQQ          # ② 环境层；空串 = 没填，往下走推断
    if ($Uin) { Write-Host '  [注入] 目标 UIN 取自环境层 agent.config.json 的 botQQ' }
}
if (-not $Uin) {
    # 目标 = SnowLuma 的 onebot_*.json 里**不是主人自己号**的那个。
    # 2026-09-24 干跑逮到的坑：SnowLuma 给主人自己的号也建了一份 onebot_<ownerQQ>.json，
    # 早先"取第一个"正好取到主人号 ⇒ 差点去注入他本人（正是他报的那个 bug）。所以排除 ownerQQ。
    # 主人号也**不写死**：环境层 → config.json（与 config-lib.js 同一条优先级链）。
    $ownerQq = Get-AgentOwnerQQ
    if (-not $ownerQq) {
        try {
            $bc = Get-Content (Join-Path $PSScriptRoot '..\qq-bridge\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($bc.ownerQQ) { $ownerQq = [string]$bc.ownerQQ }
        } catch { }
    }
    $cands = @(Get-ChildItem (Join-Path $PSScriptRoot '..\SnowLuma\config') -Filter 'onebot_*.json' -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.Name -match 'onebot_(\d+)\.json') { $Matches[1] } } |
        Where-Object { $_ -ne $ownerQq })
    if ($cands.Count -eq 1) { $Uin = $cands[0] }
    elseif ($cands.Count -gt 1) { $Uin = $cands[0]; Write-Host ("  [注入] 有多个候选 UIN（{0}），先按 {1} 走；要指定请传 -Uin，或在 agent.config.json 填 botQQ 锁死" -f ($cands -join ', '), $Uin) }
}
if (-not $Uin) { Write-Host '  [注入] 推不出目标 UIN，也没有 -Uin 参数（可在 agent.config.json 填 botQQ 锁死）'; exit 4 }

# 令牌：复用现成的登录脚本（-NoOpen 会打印带令牌的 URL）。令牌只在内存里用，不落盘、不打印。
$loginOut = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'snowluma-login.ps1') -NoOpen -Quiet 2>&1
$urlLine = ($loginOut | Where-Object { $_ -match 'token=' } | Select-Object -First 1)
if (-not $urlLine) { Write-Host '  [注入] 拿不到令牌（SnowLuma 没起来？密码不对？）'; exit 4 }
$tok = ([regex]::Match($urlLine, 'token=([^&\s]+)').Groups[1].Value)
$hdr = @{ Authorization = "Bearer $tok" }

function Get-Procs {
    $r = Invoke-RestMethod -Uri "$Base/api/processes" -Headers $hdr -TimeoutSec 15
    if ($r.list) { return @($r.list) }
    return @($r)
}

try { $procs = Get-Procs } catch { Write-Host "  [注入] 列进程失败：$($_.Exception.Message)"; exit 5 }

$hit = $false
foreach ($p in $procs) {
    $ppid = $p.pid
    $info = $null
    try { $info = (Invoke-RestMethod -Uri "$Base/api/processes/$ppid/probe-login" -Headers $hdr -TimeoutSec 30).info } catch { }
    $u = if ($info) { [string]$info.uin } else { '' }
    $nick = if ($info) { [string]$info.nickName } else { '' }
    if ($u -ne $Uin) {
        Write-Host ("  [注入] 跳过 pid={0}（是 {1} {2}，不是目标号）" -f $ppid, $u, $nick)
        continue
    }
    if ($p.injected) { Write-Host ("  [注入] pid={0}（{1}）已经注入过了" -f $ppid, $nick); $hit = $true; continue }
    if ($DryRun) { Write-Host ("  [注入][DryRun] 会给 pid={0}（{1} UIN={2}）注入" -f $ppid, $nick, $u); $hit = $true; continue }
    try {
        Invoke-RestMethod -Uri "$Base/api/processes/$ppid/load" -Method Post -Headers $hdr -TimeoutSec 60 | Out-Null
        Write-Host ("  [注入] 已注入 pid={0}（{1} UIN={2}）" -f $ppid, $nick, $u)
        $hit = $true
    } catch {
        Write-Host ("  [注入] 注入 pid={0} 失败：{1}" -f $ppid, $_.Exception.Message)
    }
}

if (-not $hit) { Write-Host "  [注入] 没找到目标号 $Uin 的 QQ.exe（她还没启动）—— 桥接会等她上来"; exit 3 }
if ($DryRun) { exit 0 }

# 等她 online（OneBot 的 3001 要等登录成功才 listen）
foreach ($i in 1..[Math]::Max(1, [int]($WaitOnlineSec / 2))) {
    Start-Sleep -Seconds 2
    try { $now = Get-Procs } catch { continue }
    $mine = @($now) | Where-Object { [string]$_.uin -eq $Uin -and $_.status -eq 'online' }
    if ($mine) { Write-Host "  [注入] 目标号已 online（OneBot $($Ports.snowlumaWs) 应该起来了）"; exit 0 }
}
Write-Host '  [注入] 已注入，但没在等待窗口内看到 online（可能还在登录）—— 桥接会自己重连'
exit 0
