# ============================================================================
#  一键启动：DSH Web + SnowLuma + qq-bridge
#
#  由 一键启动.cmd 调用，分两段执行：
#    第 1 段：在独立窗口启动 DSH，输出落进 ~/.dsh/guard/logs/，并等出启动令牌
#    第 2 段：写入桥接配置后，启动 SnowLuma 与 qq-bridge
#
#  为什么要分两段：只有 DSH 会占住前台（它是个常驻服务），所以先把它丢到
#  自己的窗口里，等令牌抓到再启动另外两个。
#
#  注意：本文件必须存成「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会按
#  ANSI 解析，中文全变乱码（实测踩过）。
#
#  参数（可透传：一键启动.cmd -NoRestart）：
#    -NoRestart  什么都不清、什么都不重启：只补起缺失的服务（在跑的一律不动）
#    -NoClean    跳过"清场"，但仍按老规则重启 DSH（= 留住 QQ 那套：SnowLuma + 桥接）
#    -Visible    回到"有窗口"的老形态（P1④ 的回退开关）：SnowLuma 与 qq-bridge 各开一个可见窗口。
#                默认**不创建窗口**（后台进程，桌面只留 DSH-Web）；无窗口那条超时没起来会**自动**
#                回退到这条路上来并打一句人话（实测结论与"为什么不用 CreateNoWindow"见 tools\windowless.ps1）
#    -KeepWindow 强制让 DSH-Web **留在桌面上**（别名 -NoMinimize）。默认是**按引导判据走**
#                （§10.1-5：引导做完 → 收尾连它一起缩进任务栏；没做完 → 留桌面当引导载体，
#                 判定与落盘在 tools\onboard.ps1）—— 这个开关就是那条判据的手动退路。
#  不带参数时（2026-09-23 主人第二次调整）：**先清场、再启动** —— 先把正在跑的
#  DSH / SnowLuma / 桥接 / 面板一起收掉（调 tools\stop-all.ps1），再干干净净起三件套。
#  本脚本可能被别的脚本用 Start-Process 调起，所以全程不做交互式等待。
# ============================================================================

param(
    [switch]$NoRestart,
    # 清场：默认**先调 tools\stop-all.ps1 把正在跑的全部收掉**
    # （主人 2026-09-23："打开一键启动的时候 自动清除全部程序"）。
    #   -NoClean    跳过清场，只按老规则重启 DSH（QQ 那套留着不动）
    [switch]$NoClean,
    # 浏览器页面：★★ 2026-09-25 00:2x **主人当面定的语义 = 逐页判定**（原话：
    #   「程序启动之后可以先打开浏览器，如果有进程就不用打开了；如果是检查标签页面是否已经有三个网站，
    #     **没有的话就弹出、有的话就不弹，每个都检测一下**」）
    # ⇒ 默认：三页（DSH :3080 / SnowLuma :5099 / 桥接 :3100）各检测一次，缺哪张开哪张；
    #   检测走 panels.ps1 的**唯一一份判据** Get-PanelVerdicts（三态：实测开着 / 实测不在 / 判不准）：
    #     · 实测开着：netstat -ano 里**浏览器**（msedge/chrome）在 :3080/:5099 上的 ESTABLISHED 长连接
    #       （DSH 页还会连 :3101 控制面）、控制台页的心跳 panel-presence.json、可见窗口标题兜底；
    #     · 实测不在：一个浏览器进程都没跑（标签页不可能存在），或桥接一直在跑而心跳全无；
    #     · 判不准 ⇒ **宁可不开**（绝不重复开 —— 主人最烦"每重启一次多一份"，2026-09-25 的原话
    #       "检测不准宁可不开"）。旧标签的令牌失效由下面那句人话告诉他按 F5，不替他再开一张。
    # ⇒ 那处会**绕过去重**的 `-ForcePage snowluma` 已经删掉（它就是"多出两个页面"的直接来源）。
    #   · 一个都不开：`-NoOpen`（旧名 -NoPanels 仍然认）   · 明确要开：`-Open`（= 默认语义）
    #   · 某页必须重开：`tools\panels.ps1 open -ForcePage <dsh|console|snowluma>`
    [switch]$Open,
    #   -AllPages   旧开关（"三个都开"），保留只为兼容旧命令行
    [switch]$AllPages,
    #   -NoOpen     一个都不开（旧名 -NoPanels 仍然认）
    [Alias('NoPanels')][switch]$NoOpen,
    # 2026-09-24 新增：跳过"自动登录 SnowLuma"（默认会做，见下方登录段）
    [switch]$NoSnowlumaLogin,
    # 2026-09-24 新增（主人反馈："主动按 e 退出，网站不会被退出"）：
    # 默认把三个页面开进**他正在用的**浏览器窗口当标签页 —— 那样脚本手上没句柄，"关闭全部"收不掉它们
    # （浏览器不允许脚本 attach 到已运行的实例去关单个标签；panels.ps1 第 427 行有说明）。
    # 想要"能被一起收掉"，加这个开关 = 另开我们自己的一个窗口装这三个页面。
    [Alias('NewWindow')][switch]$OwnWindow,
    # 2026-09-24 补（主人："又断开了 你是动了启动器吗"）：这个脚本原来**没有 DryRun 开关**，
    # PowerShell 会把不认识的参数当多余参数忽略掉 ⇒ 我拿 -DryRun 当干跑用，实际是**完整启动一遍**
    # （先清场：停 DSH + 桥接 + 关面板）⇒ 会话被自己掐断、桥接反复死。现在它是真的：只打印，不动作。
    [switch]$DryRun,
    # 2026-09-24（P1④ 那批）：默认把 SnowLuma 与 qq-bridge 起成**不创建窗口**的后台进程
    # （桌面只留 DSH-Web 一个可见窗口，见 docs\qq-agent-产品设计.md §3.2）。
    # 这个开关 = **回退开关**：回到"有窗口"的老形态（SnowLuma / qq-bridge 各一个可见窗口，收尾一起最小化）。
    # 无窗口那条路起不来时，脚本也会**自动**回退到这条路上来（并打一句人话说明）。
    [switch]$Visible,
    # 2026-09-24（第五批，§10.1-5「窗口可见性也是引导的一部分」）：**强制让 DSH-Web 留在桌面上**。
    # 默认行为是**按判据走**：引导做完了 → 收尾把它也一起缩进任务栏；没做完 → 留桌面当引导载体。
    # 这个开关 = 那条判据的手动退路（判据出问题时用；也方便"我就想看着它"的人）。
    # 别名叫 -NoMinimize（两种叫法都认）。
    [Alias('NoMinimize')][switch]$KeepWindow
)

    # 2026-09-24 补：主人反馈"又断开了 你是动了启动器吗" —— 根因是我拿 -DryRun 当干跑用，
    # 而这个脚本**从来没有 DryRun 开关**，PowerShell 把不认识的参数当多余参数忽略掉 ⇒
    # 于是"干跑"其实是**完整启动一遍**（先清场：停 DSH + 桥接 + 关面板）⇒ 会话被自己掐断、桥接反复死。
    # 现在它是真的：只打印会做什么，一个动作都不做。

# ── 引导判据（§10.1-5）：「引导做完没有」= 窗口收尾缩不缩的唯一判据 ─────────────
# 判定与落盘**都在 tools\onboard.ps1**（它自己再问 control.ps1 status -Json + 核实"她真的回过话"的
# 真实信号）；本启动器只消费它的结论，**不自己拼第二套**。
# ⚠ 为什么这个函数定义在 param 之后、脚本最前面：下面的 -DryRun 分支要用它，而 PowerShell 是
#    **从上往下执行**的（函数不提升）—— 放到下面就会 "not recognized"。
# 抓法沿用 tools\dsh-prompt.ps1 的样板（子进程 -File + stdout 被重定向时 PS 5.1 会按 OEM 码页写中文
# ⇒ 必须让子进程显式钉成 UTF-8 输出、这边按 UTF-8 读，否则结论里的中文全是乱码）。
function Get-OnboardDecision {
    # -ReadOnly：给子进程加 -DryRun（只判不落盘）—— 干跑分支必须用这个
    param([switch]$ReadOnly)
    $ob = Join-Path $PSScriptRoot 'onboard.ps1'
    if (-not (Test-Path $ob)) { return $null }
    try {
        $extra = if ($ReadOnly) { ' -DryRun' } else { '' }
        $cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & ' + "'" + $ob + "'" + ' -Json' + $extra
        $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $enc
        $psi.WorkingDirectory = (Split-Path $PSScriptRoot -Parent)
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $psi.StandardOutputEncoding = $utf8
        $psi.StandardErrorEncoding = $utf8
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit()
        if (-not $out.Trim()) { return $null }
        $a = $out.IndexOf('{'); $b = $out.LastIndexOf('}')
        if ($a -lt 0 -or $b -le $a) { return $null }
        return ($out.Substring($a, $b - $a + 1) | ConvertFrom-Json)
    } catch { return $null }
}

# ── 「我是被谁调起来的」（★ 2026-09-25 协调线硬要求）────────────────────────────
# 为什么要有它：今晚那场"DSH 反复换代"卡住的就这一格 —— **启动器从来不记调用者**：
#   `state\_tmp\launcher-windows.log` 只证明"哪几秒跑过"、`.launcher-state.json` 只说明窗口，
#   是谁触发的（哪条会话 / 哪次双击 / 哪次 HTTP）**查不出来**。
# 这一行落 `qq-bridge\state\_tmp\launcher-boot.jsonl`：时间 / pid / 开关组合 / **父进程链的命令行**。
# 取不到就如实留空（CIM 在受限环境会拒绝访问）—— 绝不猜、绝不编。
function Get-BootCallerChain {
    $chain = New-Object System.Collections.ArrayList
    try {
        $me = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction Stop
        $cur = [int]$me.ParentProcessId
        $depth = 0
        while ($cur -gt 0 -and $depth -lt 5) {
            $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cur) -ErrorAction Stop
            if (-not $p) { break }
            $line = [string]$p.CommandLine
            if ($line.Length -gt 300) { $line = $line.Substring(0, 300) + '…' }
            [void]$chain.Add(('{0}({1}) {2}' -f $p.Name, $p.ProcessId, $line))
            $cur = [int]$p.ParentProcessId
            $depth++
        }
    } catch { }
    return @($chain)
}
# 这一轮的"启动标签"：起齐后的收尾（唤醒各线 / 撤闸标记）用它做去重键，一行日志也用它对齐。
$BootStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# ★ 调用方标签（2026-09-25 晚加）：受认可的调用方（控制面 / 兜底 cmd / 窗口守窗器）显式带
#   `DSH_LAUNCHER_CALLER=owner-dblclick | control-http:<会话> | cli:<用户> | window-repair`；
#   读不到就记 `unattributed`（**绝不猜** —— 父进程链照旧保留，两条证据并存）。
#   ⚠ 读完**必须从环境里删掉**：本脚本起的孩子（DSH-Web 窗口那个 cmd、DSH 本身）会继承它 ——
#     不删的话，那些孩子以后自己再拉一次启动器时会带着**上一轮的标签**，等于给账本喂假证据。
$LauncherCaller = 'unattributed'
try { if ($env:DSH_LAUNCHER_CALLER) { $LauncherCaller = [string]$env:DSH_LAUNCHER_CALLER } } catch { }
try { Remove-Item Env:\DSH_LAUNCHER_CALLER -ErrorAction SilentlyContinue } catch { }
try {
    $bootDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'qq-bridge\state\_tmp'
    if (-not (Test-Path -LiteralPath $bootDir)) { New-Item -ItemType Directory -Path $bootDir -Force | Out-Null }
    $bootRec = [ordered]@{
        at         = [System.DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz')
        pid        = $PID
        stamp      = $BootStamp
        invocation = [string]$MyInvocation.Line
        switches   = [ordered]@{ noRestart = [bool]$NoRestart; noClean = [bool]$NoClean; dryRun = [bool]$DryRun; noOpen = [bool]$NoOpen; visible = [bool]$Visible }
        launcherCaller = $LauncherCaller
        caller     = @(Get-BootCallerChain)
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText((Join-Path $bootDir 'launcher-boot.jsonl'), ((ConvertTo-Json $bootRec -Compress -Depth 6) + "`r`n"), $utf8NoBom)
} catch { Write-Host "  [提示] 启动调用者记录没写上（不影响启动）：$($_.Exception.Message)" }

if ($DryRun) {
    Write-Host '[DryRun] 只打印，不动作。真正会做的事：'
    # ★ 2026-09-25 00:5x：干跑文案**必须反映 -NoRestart / -NoClean 的真实效果** ——
    #   干跑是"这一步安不安全"的判断依据（有人拿它当"我只看看"用），写成"先清场"而真路径其实跳过，
    #   就是本项目最忌的"说了但没做"。真路径见下面第 0 段那三个分支。
    if ($NoRestart) { Write-Host '  1) 清场：**跳过**（-NoRestart：在跑的一律不动，只补缺的服务）' }
    elseif ($NoClean) { Write-Host '  1) 清场：**跳过**（-NoClean：只重启 DSH，SnowLuma 与桥接留着）' }
    else { Write-Host '  1) 先清场：调 tools\stop-all.ps1 停掉在跑的 DSH / SnowLuma / 桥接 / 面板窗口' }
    if ($NoRestart) { Write-Host '  2) 缺什么补什么：DSH 已在跑就不动它；SnowLuma / qq-bridge 没起的才起成后台进程（不创建窗口）' }
    else { Write-Host '  2) 起 DSH Web（窗口 DSH-Web）；SnowLuma 与 qq-bridge 起成后台进程（不创建窗口）' }
    if ($Visible) { Write-Host '     （-Visible：上面这两个改成**开窗口**的老形态，收尾会一起最小化）' }
    Write-Host '  3) 同步令牌；收尾按**引导判据**决定 DSH-Web 缩不缩（判定在 tools\onboard.ps1）：'
    Write-Host '       引导做完（且五灯全绿）→ 一起最小化到任务栏；没做完 → 留桌面当引导载体'
    Write-Host '       ★「留桌面」不只是"不缩"：DSH-Web 在 Windows Terminal 里，而 WT 会**复用同一个窗口**'
    Write-Host '         （已经缩着的 WT 窗口里开新标签，新窗口生下来就是缩着的）⇒ 收尾会主动确认它'
    Write-Host '         在桌面上：本来是缩着的就放回去，本来就在桌面上就不动它 —— 两句都如实打印。'
    if ($KeepWindow) { Write-Host '     （-KeepWindow：这次强制留桌面，不看判据）' }
    # 顺手把**此刻**的判据结论打出来 —— **只读**（子进程带 -DryRun，一个字节都不写），
    # 这样"干跑"就能看出这次启动窗口会缩还是留，不用真启动一遍去试。
    Write-Host '     此刻的判据结论（只读，不写任何文件）：'
    $o = Get-OnboardDecision -ReadOnly
    if ($o) {
        $word = if ($o.decision -eq 'minimize') { '最小化' } else { '留桌面' }
        if ($KeepWindow) { $word = $word + '（但这次 -KeepWindow 强制留桌面）' }
        Write-Host ('       → 窗口决定：{0} ｜ 引导{1} ｜ 依据：{2}' -f $word, $(if ($o.done) { '已完成' } else { '未完成' }), $o.decisionWhy)
    } else {
        Write-Host '       → （读不到 tools\onboard.ps1 的结论 —— 那就按"留桌面"处理，窗口不会乱缩）'
    }
    Write-Host '  4) 浏览器页面：**逐页判定**（三页各查一次：已经开着的不开、缺的那张才开；说不清就不开）'
    Write-Host '     一个都不开用 -NoOpen；某页要强制重开用 tools\panels.ps1 open -ForcePage <页>'
    Write-Host '  5) 起齐后的收尾（★ 2026-09-25 加）：撤 restart-stack 的闸标记 + **唤醒各条开发线** + 给主人 QQ 一条'
    Write-Host '     干跑一个都不做；-NoRestart（只补缺）也不做（那不是一次停机恢复）'
    Write-Host '  想看各步骤细节：不加 -DryRun 直接跑；想跳过清场：-NoClean；要老的有窗口形态：-Visible'
    exit 0
}

$ErrorActionPreference = 'Continue'

# ── 端口唯一来源（P2⑦ 参数单一来源）────────────────────────────────────────
# 默认值表只有一处（qq-bridge\src\config-lib.js 的 DEFAULT_PORTS），生效值由仓库根的
# agent.config.json 决定 —— 这里问 Node 要（为什么这么绕，tools\env-config.ps1 文件头写了）。
# 本脚本**一个端口字面量都不抄**：改端口只改那一处，整条启动链跟着走（换台机器同理）。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts

$Root = Split-Path -Parent $PSScriptRoot   # 2026-09-24：从脚本位置推导（原来写死 D:\hobby\DSH，换目录/交付给别人就整链失效）
$SnowLumaDir  = Join-Path $Root 'SnowLuma'
$SnowLumaExe  = Join-Path $SnowLumaDir 'node.exe'
$BridgeDir    = Join-Path $Root 'qq-bridge'
$BridgeBat    = Join-Path $BridgeDir 'start.bat'
$BridgeConfig = Join-Path $BridgeDir 'config.json'
$LogsDir      = Join-Path $env:USERPROFILE '.dsh\guard\logs'

# 端口**全部从环境层派生**（唯一来源见文件上方那个 dot-source）：变量名保持不变，下面全程用变量。
# 控制面的 $ControlPort 原来定义在下面「控制面」那一段，一起挪上来 —— 六个端口一眼看全。
$DshPort         = $Ports.dshWeb
$SnowLumaPort    = $Ports.snowlumaWs
$SnowLumaWebPort = $Ports.snowlumaWeb
$OneBotPort      = $Ports.onebotHttp
$BridgePort      = $Ports.bridgeConsole
$ControlPort     = $Ports.bridgeControl

function Test-Port([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(1000, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# 等端口就绪。★ 2026-09-24 深夜（主人："程序正在等待运行的时候加个…吗 用来提醒用户程序正在运行
#   而不是让他们以为开掉了"）：这是启动器里**最长的等待**（SnowLuma 那条最多 90 秒），
#   原来全程一声不吭 ⇒ 看着像卡死/已经开完了。
#   ★ 2026-09-25 00:1x **改实现**：真正干活的搬到 `tools\progress.ps1` 的 `Wait-PortWithProgress`
#   （一个函数管"等 + 逐秒打点 + 收口"），这里只剩一层壳。为什么搬：主人 00:04 那次跑完说
#   "加载时候的...没有出现" —— 根因就是 `Wait-Port $DshPort 45` 那一处**没传 -What**，
#   而"没标签 = 一个字符都不打"，它偏偏是最长的那段"加载"等待。
#   ⇒ 现在**每一处等待都必须给标签**（见下面各调用点）；给不出标签的只剩"顺手看一眼"的短轮询。
#   ⚠ 用 Write-Host -NoNewline（cmd 里逐秒可见），**不用** Tee-Object / 不换 log-run.ps1 的写法
#     （那是断令牌链的红线）。被重定向到文件时是同一行上一串点 —— 以 cmd 可见为准。
function Wait-Port([int]$Port, [int]$TimeoutSec, [string]$What = '') {
    return (Wait-PortWithProgress -Port $Port -TimeoutSec $TimeoutSec -What $What)
}

# 找出占用某端口的进程 PID；没有则返回 0。
# 用 netstat 而不是 Get-NetTCPConnection：后者在部分 Windows 上要管理员权限。
function Get-PortOwnerPid([int]$Port) {
    foreach ($line in (netstat -ano)) {
        if ($line -match (':{0}\s+\S+\s+LISTENING\s+(\d+)\s*$' -f $Port)) {
            return [int]$Matches[1]
        }
    }
    return 0
}

# 结束占用某端口的旧实例，并等端口真正释放（不释放的话新实例绑不上）。
# 返回 $true 表示端口已空、可以启动新实例。
function Stop-PortOwner([int]$Port) {
    $owner = Get-PortOwnerPid $Port
    if (-not $owner) { return $true }
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    $startedAt = ''
    if ($proc) {
        try { $startedAt = $proc.StartTime.ToString('HH:mm:ss') } catch { $startedAt = '' }
    }
    if ($proc) {
        Write-Host ("      结束旧实例 PID {0}（{1}，启动于 {2}）…" -f $owner, $proc.ProcessName, $startedAt)
    } else {
        Write-Host ("      结束旧实例 PID {0}…" -f $owner)
    }
    try {
        Stop-Process -Id $owner -Force -ErrorAction Stop
        Write-Host '      已结束。'
    } catch {
        Write-Host ("      [警告] 结束失败：{0}" -f $_.Exception.Message)
    }
    for ($i = 0; $i -lt 40; $i++) {
        if (-not (Test-Port $Port)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (-not (Test-Port $Port))
}

# 等 DSH 打印出带令牌的地址，并从日志里抠出令牌
function Wait-LaunchToken([datetime]$Since, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $files = @(Get-ChildItem -Path $LogsDir -Filter 'server-*.out.log' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $Since })
        foreach ($f in ($files | Sort-Object LastWriteTime -Descending)) {
            try {
                $text = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction Stop
            } catch { continue }
            if ($text -match '[?&]token=([A-Za-z0-9_\-]{20,})') { return $Matches[1] }
        }
        Start-Sleep -Milliseconds 900
    }
    return ''
}

# 令牌的**不可逆指纹**（sha256 前 8 位十六进制）：够对账（"换的是哪一个、和上次是不是同一个"），
# 但**拼不出令牌本身**。★ 为什么要有它：启动日志里原来印的是真令牌的前 8 位明文
# （`已写入新令牌：4iMaR0FY…`）—— 截断了也还是密钥的一段，截图/粘日志就等于漏一截。
function Get-TokenFingerprint([string]$Token) {
    if (-not $Token) { return '(空)' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Token))
        $hex = (-join ($hash | ForEach-Object { $_.ToString('x2') }))
        return $hex.Substring(0, 8)
    } finally { $sha.Dispose() }
}

function Set-BridgeToken([string]$Token) {
    try {
        $json = Get-Content -LiteralPath $BridgeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Host "  [警告] 读不了 config.json：$($_.Exception.Message)"
        return $false
    }
    $old = [string]$json.dsh.authToken
    if ($old -eq $Token) {
        Write-Host '  令牌已是最新，无需改写'
        return $true
    }
    $json.dsh.authToken = $Token
    # 保持 2 空格缩进的原有格式；桥接每次启动都读这个文件
    # ⚠ 2026-09-24 修的 bug：PS 5.1 的 `Set-Content -Encoding UTF8` **会写 BOM（EF BB BF）**，
    # 而严格读取者（JSON.parse、scripts\test-{v2-wait,forward,stickers}.mjs）见到 BOM 直接抛
    # "Unexpected token ''"。桥接自己读的时候会剥 BOM（state-lib 的 readJsonSafe），
    # 所以这毛病一直被掩盖 —— 直到今晚全量重启（DSH 换代 ⇒ 令牌变了 ⇒ 走到这里）把它写进 config.json，
    # 同时跑的 npm test 立刻红了 3 个套件。改用 .NET 写：UTF8Encoding($false) = 明确不带 BOM。
    $text = ($json | ConvertTo-Json -Depth 20) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($BridgeConfig, $text, (New-Object System.Text.UTF8Encoding($false)))
    Add-Content -LiteralPath $BridgeConfig -Value "`n" -NoNewline -Encoding UTF8
    # ★ 2026-09-24 深夜（问题 4）：这一行原来印的是**真令牌的前 8 位**
    #   （`已写入新令牌：4iMaR0FY…`）—— 截断了也还是密钥本身的一段，截图/粘日志就等于漏一截。
    #   现在改印 **sha256 指纹前 8 位**：同样能对账（"这次换的是哪一个、和上次是不是同一个"），
    #   但**不可逆**、拼不出令牌。顺带把长度留住（43 这种）——长度不泄密，但排障时很有用。
    Write-Host ("  已写入新令牌：指纹 {0}（长度 {1}；旧指纹 {2}，长度 {3}）" -f `
            (Get-TokenFingerprint $Token), $Token.Length, (Get-TokenFingerprint $old), $old.Length)
    return $true
}

# DSH 窗口现在是最小化的，启动失败时把日志尾部打到本窗口，省得去找那个窗口
function Show-LogTail([string]$Path, [int]$Lines) {
    if (-not (Test-Path $Path)) { Write-Host '      （日志文件尚未生成）'; return }
    try {
        Get-Content -LiteralPath $Path -Tail $Lines -Encoding UTF8 -ErrorAction Stop |
            ForEach-Object { Write-Host ('      | ' + $_) }
    } catch {
        Write-Host ('      （读日志失败：' + $_.Exception.Message + '）')
    }
}

Write-Host ''
Write-Host '############################################################'
Write-Host '#  一键启动：DSH + SnowLuma + qq-bridge'
Write-Host '############################################################'
Write-Host ''

# ── 收尾助手：认窗口 / 最小化（实现与"为什么不能启动时就最小化"见
#    tools\minimize-windows.ps1；这里点源它）
. (Join-Path $Root 'tools\minimize-windows.ps1')

# ── 无窗口启动小库（P1④，2026-09-24）：Start-WindowlessProcess / New-CmdRedirectLine /
#    Stop-WindowlessProcess / Write-WindowlessFallback —— **启动器与 ensure-bridge 共用这一份**
#    （"救桥接"不能自己长出一套起法）。为什么是"Hidden + cmd 级文件重定向"而不是 CreateNoWindow，
#    以及那次"无窗口化把桥接弄死"到底死在哪，全写在那个文件头（实测记录）。
. (Join-Path $Root 'tools\windowless.ps1')
# ★ 控制面的**唯一一份起法**（2026-09-26）：起法原来只长在本文件下面那段内联形状里，搬进
#   tools\control-plane.ps1 之后与 dsh-prompt 的补缺**共用同一份**（QQ 不在本机时只补控制面 ⇒
#   不会把 SnowLuma / 桥接起出来抢号）。
. (Join-Path $Root 'tools\control-plane.ps1')

# ── 等待进度小库（2026-09-25）：Wait-PortWithProgress / Test-PortState —— **启动器与关闭器共用**
#    （"每一处等待都要有活进度"这条只有一份实现，见文件头：主人 00:04 说"加载时候的...没有出现"）。
. (Join-Path $Root 'tools\progress.ps1')

# 无窗口化的运行态：想不想要（-Visible 就不要）+ 每个组件**实际**用上了没有
# （自动回退之后要如实记录，收尾与 .launcher-state.json 都按它说话）。
$script:WantWindowless    = -not $Visible
$script:WindowlessBridge  = $false
$script:WindowlessSnowLuma = $false
# 端口超时（没通就回退到可见窗口）：★ 2026-09-24 深夜重定，两条都按**实测**改过 ——
#   · 桥接 20 → **60 秒**：主人那次实测，无窗口那条其实起来了，只是 start.bat 撞上"过期锁文件"
#     重试了一轮，3100 到第 57 秒才监听（见 state\_tmp\bridge-console.err.log）⇒ 20 秒必然误判。
#   · SnowLuma 45 秒**判据换成 5099（WebUI）**：进程一起来就有（实测 <1 秒）；原来拿 3001 当判据，
#     而 3001 要等 QQ 客户端登录/hook 接上（实测 17 秒~几分钟）⇒ 45 秒必然误判。
#     改判据之后 45 秒只是"进程没起来"的兜底，正常路径根本用不到它。
# ⚠ 判据只许用"**进程自己起来了**"的端口；"外部依赖就绪"（QQ 登录）在下面单独等（90 秒那处）。
$WindowlessTimeoutBridge   = 60
$WindowlessTimeoutSnowLuma = 45
if ($Visible) { Write-Host '（-Visible：按老形态开窗口起 SnowLuma 与 qq-bridge）' }

# ── 第 0 段：清场（默认）────────────────────────────────────────────────────
# 2026-09-23 主人："打开一键启动的时候 自动清除全部程序" —— 所以启动的第一步是
# 把正在跑的 DSH / 桥接（连面板）收掉，再干干净净起来 —— **SnowLuma 不动**：它是 QQ 网关，
# WebUI 的会话令牌只存在它内存里，重启就得重新登录（主人 2026-09-23 反馈过）。复用 tools\stop-all.ps1（它按端口占用者 /
# 命令行签名 / 启动器记的窗口句柄三路认人，**绝不碰主人自己的窗口**，并且会跳过
# 自己与自己的祖先进程 —— 本启动器和这个窗口正是它的祖先，不会被它关掉）。
# 这样"上次没收干净 / 桥接守护自己爬起来 / 端口被旧实例占着"就都不用管了。
#   · -NoRestart：连清场一起跳过（只想补起缺的服务）
#   · -NoClean  ：跳过清场，但照旧重启 DSH（= 留住 QQ 那套）
# 必须用**子进程**跑：stop-all.ps1 用 exit 收尾，在进程内直接 & 调用会把本启动器一起退掉。
# ── 清场**之前**先拍一张"现在哪几页实测开着"的快照（tools\panels.ps1 snapshot）──────────────
# 为什么：清场会把 DSH 与桥接杀掉，而"这页还开着吗"是**实测**认的（netstat 的浏览器长连接 / 控制台心跳
# / 桥接进程启动时间，见 panels.ps1 的 Get-PanelVerdicts）—— 等服务重启完再问，那些旧标签的 socket
# 早断了、心跳也停在死前那一刻，于是把他明明还挂着的标签页又开了一遍
# （主人 2026-09-23 与 2026-09-25 两次反馈，第二次的原话就是"网站页面多开了三个"）。
# ★ 2026-09-25 深夜修正：这张快照原来**只在"全清场"那条路拍**（在下面 else 里面）⇒
#   走 `-NoClean`（只重启 DSH）或 `-NoRestart` 时没有快照，而 `-NoClean` 恰恰会把 DSH 重启掉 ⇒
#   那张还开着的 DSH 标签在清场后测不出连接 ⇒ 被判成"缺页" ⇒ 又开一张。
#   现在**三条路都拍**：快照本身"只记录、不开页、不关任何东西"，拍了只会更保守（判不准宁可不开）。
#   三页都在 $SnapshotPages 里（含 DSH 页）—— DSH 换启动令牌后旧标签要按 F5，但那由下面那句人话告诉他，
#   不是"再开一张"的理由。
$panelsScript = Join-Path $Root 'tools\panels.ps1'
if (-not $DryRun -and (Test-Path $panelsScript)) {
    try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $panelsScript snapshot -Quiet } catch {}
}
if ($NoRestart) {
    Write-Host '[0/3] 清场：跳过（-NoRestart：在跑的一律不动）'
} elseif ($NoClean) {
    Write-Host '[0/3] 清场：跳过（-NoClean：只重启 DSH，SnowLuma 与桥接留着）'
} else {
    $stopAllScript = Join-Path $Root 'tools\stop-all.ps1'
    if (Test-Path $stopAllScript) {
        Write-Host '[0/3] 清场：收掉正在跑的 DSH / 桥接（这步要十几秒）'
        # -KeepSnowLuma：QQ 网关不动 —— 它的 WebUI 会话令牌只在内存里，重启就得重新登录
        # （主人 2026-09-23："这个网站不关掉重开就要输入令牌"）；顺带也少一次 QQ 重连。
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopAllScript -KeepSnowLuma
        if ($LASTEXITCODE -ne 0) {
            Write-Host '      [提示] 清场没完全干净（多半是端口没立刻释放）—— 照常往下启动，占着的端口下面会自动处理。'
        }
        Write-Host '      清场结束，开始启动（SnowLuma 若已在跑就原地留着）。'
    } else {
        Write-Host '      [提示] 找不到 tools\stop-all.ps1，跳过清场直接启动。'
    }
}

# ── 已知启动窗口：**盖章**（"刚发起启动"的时间戳）────────────────────────────────
# 位置很讲究：必须盖在**清场之后、即将开始起**的这一刻 —— 清场本身要十几秒，而桥接在清场里就已经没了，
# 盖在它前面等于把 45 秒宽限期吃掉一半（届时桥接还没起完，假警告照旧会闪）。
# 为什么要盖：主人平时的主力路径就是双击 一键启动.cmd → 这个脚本；不盖的话，接下来桥接起来之前的那几秒
# 会被 DSH-Web 窗口 / 页面面板报成"⚠ 桥接断了 → 按 r"（2026-09-24 22:19 实拍的那一屏正是这条路径）。
# ★ 形状 / 判定 / 那个 45 秒**都不在这里**：走 tools\starting-window.mjs 的 CLI（只有那一处算宽限期）。
# ⚠ -NoRestart（"在跑的一律不动、只补缺的服务"）**不盖**：那一轮桥接没被碰，要是它此刻断着，那是
#   **真故障**，不该被这 45 秒盖住。⚠ -DryRun 也不盖（上面那个分支已经 exit 了，这里是双保险）。
# ⚠ 盖不上绝不许影响启动：它只是个给提示用的时间戳。
if (-not $DryRun -and -not $NoRestart) {
    try {
        $stampScript = Join-Path $PSScriptRoot 'starting-window.mjs'
        if (Test-Path $stampScript) {
            $stampNode = (Get-Command 'node.exe' -ErrorAction SilentlyContinue).Source
            if (-not $stampNode) { $stampNode = 'node' }
            & $stampNode $stampScript mark up '--by=start-all.ps1' | Out-Null
        }
    } catch {
        Write-Host "      [提示] 启动窗口时间戳没盖上（不影响启动）：$($_.Exception.Message)"
    }
}
Write-Host ''
# 启动前给所有控制台窗口拍个快照：跑完比一次，新出现的那些就是我们的
# （标题会被程序改回 cmd 默认值，所以只认句柄）。
$windowsBefore = @(Get-ConsoleWindows)
# ── 第 1 段：DSH ────────────────────────────────────────────────────────────
# DSH Web 端口已在监听时默认「重启」，不再静默跳过：装/删插件、换令牌都只有重启 DSH 才生效，
# 旧版直接跳过正是「装了插件却怎么都不生效」的坑。要保留当前实例就用 -NoRestart。
# 注意：本脚本会被别的脚本用 Start-Process 调起（见 恢复归档会话-自动.ps1），
# 所以这一段绝不能有 Read-Host —— 非交互环境下它会一直挂着等输入。
Write-Host '[1/3] DSH Web'
$startDsh = $true
$dshStartedAt = $null
if (Test-Port $DshPort) {
    if ($NoRestart) {
        $startDsh = $false
        Write-Host ('      ' + $DshPort + ' 已在监听 —— -NoRestart：跳过启动（本次改动不会生效）。')
    } else {
        Write-Host ('      ' + $DshPort + ' 已在监听 —— 重启 DSH（要保留当前实例请改用 -NoRestart）。')
        if (Stop-PortOwner $DshPort) {
            Write-Host ('      ' + $DshPort + ' 已释放，开始启动新实例。')
        } else {
            $startDsh = $false
            Write-Host ('      [警告] ' + $DshPort + ' 仍被占用 —— 请手动关掉标题为 DSH-Web 的窗口后重试。')
        }
    }
}

if ($startDsh) {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $LogsDir "server-$stamp.out.log"
    Write-Host "      启动（窗口最小化到任务栏，标题 DSH-Web）；输出写入：$log"
    # 先起 DSH，再等令牌：桥接正是从这类日志里自动发现令牌的。
    # 用 log-run.ps1（cmd 原生管道 + Out-File -Encoding utf8）——
    # PS 5.1 的 Tee-Object 默认写 UTF-16LE，桥接按 UTF-8 读只会拿到 \u0000
    # 交错的乱码，永远匹配不到令牌（实测踩过这个坑）。
    # 给 log-run 那段加 -WindowStyle Hidden 是为了少占屏幕：不加 Hidden 时，
    # 管道里那个 powershell.exe 会额外弹一个空白的 PowerShell 窗口。
    # 出错内容仍会落进上面的日志，启动失败时本启动器会把日志尾部打出来。
    $pipe = "powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Root\tools\log-run.ps1`" `"$log`""
    # 窗口里跑的是 tools\dsh-window.cmd（DSH 停了以后：输 exit = 关闭全部、回车 = 只重起 DSH）。
    # ★ 为什么不再直接 `dsh web`：`dsh` 是 npm 壳（.cmd），壳内部会跑 `title %COMSPEC%`
    #   —— 这正是以前"窗口标题变成 C:\Windows\system32\cmd.exe、按标题认不出窗口"的根因；
    #   而且壳是嵌套批处理，Ctrl+C 会先问一层 "Terminate batch job (Y/N)?"。
    #   所以改成直接用 node 跑包里的 lib\bin.js（路径找不到时退回壳）。
    # doskey 是兜底：万一包装脚本被 Ctrl+C(Y) 干掉、窗口回到裸 cmd 提示符，
    #   在那儿输 exit 或 e 也照样执行"关闭全部"（e 是 exit 的简写 —— 主人 2026-09-23：
    #   "我想要手动输入exit简称e来退出"；正常路径里 tools\dsh-prompt.ps1 那个中文提示也认 e）。
    $dshNode = ''
    $dshBin  = ''
    $shim = (Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue).Source
    $nodeExe = (Get-Command 'node.exe' -ErrorAction SilentlyContinue).Source
    if ($shim -and $nodeExe) {
        $cand = Join-Path (Split-Path $shim) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (Test-Path $cand) { $dshNode = $nodeExe; $dshBin = $cand }
    }
    $windowCmd  = Join-Path $Root 'tools\dsh-window.cmd'
    $stopAllPs1 = Join-Path $Root 'tools\stop-all.ps1'
    if ((Test-Path $windowCmd) -and (Test-Path $stopAllPs1)) {
        $stopAllMacro = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$stopAllPs1`""
        $doskey = "doskey exit=$stopAllMacro & doskey e=$stopAllMacro"
        $cmdLine = '/k', "title DSH-Web & chcp 65001 >nul & $doskey & call `"$windowCmd`" `"$dshNode`" `"$dshBin`" `"$log`""
    } else {
        # 兜底：tools\dsh-window.cmd 不在（或停止脚本被删）→ 退回原来的写法
        $cmdLine = '/k', "title DSH-Web & chcp 65001 >nul & dsh web --no-open 2>&1 | $pipe"
    }
    # 记下启动时刻：下面抓令牌时只认这次的新日志（见 $since 那段注释）。
    $dshStartedAt = Get-Date
    # 窗口照最开始那样**正常打开**（不做最小化：2026-09-23 主人"不用最小化了，改成最开始的"）。
    Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine
    if (Wait-Port $DshPort 45 ('DSH Web（:{0}，等一下它会自己起完）' -f $DshPort)) {
        Write-Host ('      ' + $DshPort + ' 已就绪')
    } else {
        Write-Host ('      [警告] 45 秒内没等到 ' + $DshPort + ' —— 下面是启动日志的最后几行：')
        Show-LogTail -Path $log -Lines 12
    }
}

# 抓最新令牌（可能是刚启动的，也可能是之前启动器留下的日志）。
# 本次刚启动/重启过 DSH 时只认这次的新日志 —— 否则会先命中上一代实例的旧日志、
# 抓到已失效的令牌，桥接就一路 401（现在重启成了常规路径，这个坑必须堵）。
$since = if ($dshStartedAt) { $dshStartedAt.AddSeconds(-2) } else { (Get-Date).AddHours(-48) }
$token = Wait-LaunchToken -Since $since -TimeoutSec 30
if ($token) {
    Write-Host '      已从 guard 日志抓到启动令牌 ✅'
    # 无论桥接是否已在运行，都先把令牌写进配置 —— 上一版只在「要启动桥接」时才写，
    # 结果桥接已在跑时配置里一直留着失效的旧令牌（实测踩过）。
    Write-Host '      写入桥接配置：'
    Set-BridgeToken -Token $token | Out-Null
} else {
    Write-Host '      [提示] 没抓到令牌：桥接会在自身启动时自行从 guard 日志发现'
}
Write-Host ''

# ── 第 2 段：SnowLuma + 桥接 ───────────────────────────────────────────────
# 2026-09-24（P0 收口）：记着"这一轮 SnowLuma 是不是**新起的**" —— 它的 WebUI 令牌表只存在
# 内存里，一停就全失效 ⇒ 新起的那一轮必须让 panels.ps1 用 -ForcePage snowluma 重载自动登录页
# （否则主人看到的就是"组合里那个 SnowLuma 还是没登录"）。已在跑的那一轮不强制，免得白开重复标签。
$SnowLumaStarted = $false
Write-Host '[2/3] SnowLuma（QQ 网关）'
if (Test-Port $SnowLumaPort) {
    Write-Host ('      ' + $SnowLumaPort + ' 已在监听 —— SnowLuma 已在运行，跳过启动。')
    # 已在运行的实例吃不到下面那两个环境变量（它们是给新进程的），所以用运行时接口
    # 把窗口级别对齐一次：否则手动重启过 SnowLuma 之后，窗口又会开始刷 WARN。
    # 失败不影响启动（没存过 WebUI 密码、或 SnowLuma 恰好没起来都只是跳过）。
    $logLevelScript = Join-Path $Root 'tools\snowluma-log-level.ps1'
    if (Test-Path $logLevelScript) {
        try {
            & $logLevelScript error -Quiet | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Host '      已对齐窗口日志级别 = error（WARN 不进窗口；日志文件仍 debug）' }
            else { Write-Host '      [提示] 窗口日志级别没对齐（可用 tools\snowluma-log-level.ps1 手动设）' }
        } catch { Write-Host '      [提示] 窗口日志级别没对齐（异常已忽略）' }
    }
} elseif (Test-Path $SnowLumaExe) {
    # 窗口噪音治理（2026-09-23）：SnowLuma 把「群/私聊撤回」「read ECONNRESET」
    # 这类事件按 WARN 写出去，每次桥接重启/撤回都会刷屏。logger 有两条独立级别：
    #   SNOWLUMA_LOG_LEVEL       → 控制台窗口 + WebUI 环形缓冲（默认 info）
    #   SNOWLUMA_LOG_FILE_LEVEL  → 日志文件（默认 debug，**不动**，排查靠它）
    # 这里把窗口压到 error（只留真错误），要看细节随时用
    #   tools\snowluma-log-level.ps1            # 查当前
    #   tools\snowluma-log-level.ps1 info       # 临时放开（运行时生效，不用重启）
    # 子进程继承 PowerShell 的环境变量，所以在这个进程里设一次即可。
    $env:SNOWLUMA_LOG_LEVEL = 'error'
    $env:SNOWLUMA_LOG_FILE_LEVEL = 'debug'
    Write-Host '      日志级别：窗口=error（不刷 WARN），文件=debug（完整保留）'
    # 日志它自己写文件（SnowLuma\logs），看日志在 DSH-Web 窗口按 l。
    #
    # ── 2026-09-24 第四版（P1④"不创建窗口"）：这一段的形态由 $WantWindowless 决定 ──────
    #   · 默认（无窗口）：`cmd /c "…node.exe .\index.mjs > 日志 2> 日志"`，窗口**根本不创建**
    #     （实测：EnumWindows 连隐藏窗口都查不到它，桌面/任务栏零出现）。
    #   · -Visible    ：`cmd /k "title SnowLuma & …"`，回到"有一个可见窗口"的老形态
    #     （收尾会最小化它；排障时能直接看它刷什么）。
    #   · 无窗口那条**在超时内端口没通**就自动回退到可见窗口重来一次（不许静默失败）。
    #   注意：cmd /k 那条老路与 Windows Terminal 的窗口管理会打架（WT 只暴露当前标签页的标题），
    #   所以"收尾一起最小化"对它可能失效 —— 但这只是**回退形态**，看得见窗口本身就是它存在的意义。
    $slLogDir = Join-Path $Root 'SnowLuma\logs'
    if (-not (Test-Path $slLogDir)) { New-Item -ItemType Directory -Path $slLogDir -Force | Out-Null }
    $slOut = Join-Path $slLogDir 'console.out.log'
    $slErr = Join-Path $slLogDir 'console.err.log'
    # 两种形态共用同一条内层命令（只有外面那层 cmd 的开关与重定向不同）
    $slCommand = 'title SnowLuma & cd /d "' + $SnowLumaDir + '" & "' + $SnowLumaExe + '" .\index.mjs'
    $slProc = $null
    if ($WantWindowless) {
        # ★★ 2026-09-24 深夜：无窗口那条的**就绪判据从 3001 改成 5099（WebUI）**。
        #   踩过的坑（主人这次报"SnowLuma 窗口没藏住、还多出标签页"的真正起点）：
        #   3001 是 OneBot 的 WS，**要等 QQ 客户端登录/hook 接上才绑**（当天实测 17 秒~几分钟），
        #   而 5099 是 SnowLuma 自己的管理页、进程一起来就有（实测 <1 秒）。
        #   拿 3001 当判据 ⇒ 45 秒超时 ⇒ 白白杀掉一个**完全成功的无窗口实例**、再开一个**可见窗口**
        #   （可见控制台在这台机器上就是 Windows Terminal 的一个窗口 ⇒ 主人看到的那多出来的窗口）。
        #   ⇒ 判据一律用"**进程自己起来了**"的端口；"外部依赖就绪"（QQ 登录）另外等（见下面的 90 秒那处）。
        $slWebOwnerBefore = Get-PortOwnerPid $SnowLumaWebPort
        $slProc = Start-WindowlessProcess -FilePath 'cmd.exe' -WorkingDirectory $SnowLumaDir `
            -Arguments (New-CmdRedirectLine -Command $slCommand -StdOutLog $slOut -StdErrLog $slErr)
        if ($slProc) { Write-Host ('      已拉起（后台进程 {0}，CREATE_NO_WINDOW：不会出现它的窗口）' -f $slProc.Id) }
        else { Write-Host '      无窗口方式没能拉起来。' }
        $slReady = $false
        if ($slProc) {
            if (Wait-Port $SnowLumaWebPort $WindowlessTimeoutSnowLuma 'SnowLuma 管理页（进程起来的信号）') {
                $slWebOwnerNow = Get-PortOwnerPid $SnowLumaWebPort
                if ($slWebOwnerNow -ne 0 -and $slWebOwnerNow -ne $slWebOwnerBefore) { $slReady = $true }
                else { Write-Host '      [提示] 管理页有人在听，但占用者不是这次拉起的进程（老实例？）—— 不当成"起来了"' }
            }
        }
        if ($slReady) {
            $script:WindowlessSnowLuma = $true
            Write-Host '      ✓ SnowLuma 已在**无窗口**方式下起来（桌面不会多它一个窗口）'
        } else {
            # 超时/失败要分两种，**不许一锅端**：
            #   · 进程已经没了 ⇒ 真失败 ⇒ 收干净 + 回退可见窗口（人得看得见它为什么死）
            #   · 进程还活着，只是端口慢 ⇒ **不杀、不换窗口**：换窗口解决不了"QQ 还没登录"，
            #     只会白白在桌面上多一个 WT 窗口（主人报的就是这个）。让它继续跑，后面那条
            #     "等 QQ 网关就绪（最多 90 秒）"会接着等，日志也一直写着。
            if ($slProc -and (Get-Process -Id $slProc.Id -ErrorAction SilentlyContinue)) {
                $script:WindowlessSnowLuma = $true
                Write-Host ('      [慢] 后台进程 {0} 还活着，只是管理页没在 {1} 秒内就绪 —— **保留它继续等**（不换窗口）。' -f $slProc.Id, $WindowlessTimeoutSnowLuma)
                Write-Host ('           要看它刷什么：{0}' -f $slErr)
            } else {
                # ★ 自动回退：先把自己刚起的那一棵收干净（只按手里的 pid，绝不做全屏扫荡），再走可见窗口
                Stop-WindowlessProcess -Process $slProc | Out-Null
                Write-WindowlessFallback -What ("SnowLuma（{0} 秒内进程就没了）" -f $WindowlessTimeoutSnowLuma)
            }
        }
    }
    if (-not $script:WindowlessSnowLuma) {
        Start-Process -FilePath 'cmd.exe' -WorkingDirectory $SnowLumaDir -ArgumentList '/k', $slCommand
        Write-Host '      已启动（**有窗口**：标题 SnowLuma，收尾会最小化；日志按 l）'
    }
    $SnowLumaStarted = $true
} else {
    Write-Host "      [错误] 找不到 $SnowLumaExe"
}
Write-Host ''

Write-Host '[3/3] qq-bridge（DSH 桥接）'
if (Test-Port $BridgePort) {
    Write-Host ('      ' + $BridgePort + ' 已在监听 —— 桥接已在运行。')
    # ★ 只在**本轮真的(重)起过 DSH** 时才让桥接重来：DSH 一换实例就换 launch token，桥接手里
    #   那份立刻失效（全链路 401），所以必须让它带着新令牌重连。
    #   反过来，-NoRestart（"在跑的一律不动，只补缺的服务"）时 DSH 没动、令牌没变 ⇒ 不该掐桥接：
    #   这条路现在也被 control.ps1 的 `restart snowluma` 用（只重启 QQ 网关），
    #   顺手把桥接弹一下属于纯粹的副作用（QQ 侧白断几秒），与那个开关的承诺也不一致。
    if ($token -and $startDsh) {
        # 桥接只在启动时读 config.json，所以此刻它手里可能还是旧令牌；调它的重启接口
        # 让它带着新令牌重来（若由 start.bat 守护，5 秒后自动拉起）。
        $restarted = $false
        try {
            $tokenFile = Join-Path $BridgeDir 'state\console-token'
            if (Test-Path $tokenFile) {
                $ct = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
                Invoke-RestMethod -Method Post -TimeoutSec 8 `
                    -Uri ("http://127.0.0.1:$BridgePort/api/restart?token=" + [uri]::EscapeDataString($ct)) `
                    -ContentType 'application/json' -Body '{}' | Out-Null
                $restarted = $true
            }
        } catch {
            $restarted = $false
        }
        if ($restarted) {
            Write-Host '      已触发桥接重启，让它用新令牌重连（守护 5 秒后拉起）'
            # ★ 2026-09-24 深夜（问题 3）：原来是死等 `Start-Sleep -Seconds 8`（8 秒里屏幕一动不动，
            #   主人原话"提醒用户程序正在运行 而不是让他们以为开掉了"）。现在改成**盯端口换人**：
            #   先记下重启前 3100 的占用者 pid，然后每 400ms 看一眼 —— 端口掉了、或者占用者换成了
            #   新的 pid ⇒ 这次重启就真的完成了（实测守护 5~6 秒拉起，**比死等 8 秒快**，而且途中
            #   每 2 秒打一个点、让人看得见它在动）。最多等 40 秒，超时如实说"还在拉起中"。
            $brOldPid = Get-PortOwnerPid $BridgePort
            $brDeadline = (Get-Date).AddSeconds(40)
            Write-Host '      · 等它自己爬起来（守护 5 秒后重拉；好了就立刻继续）' -NoNewline
            $brTicks = 0
            $brBackUp = $false
            while ((Get-Date) -lt $brDeadline) {
                Start-Sleep -Milliseconds 400
                $brTicks++
                if ($brTicks % 5 -eq 0) { Write-Host '.' -NoNewline }
                $brNowPid = Get-PortOwnerPid $BridgePort
                if ($brNowPid -ne 0 -and $brNowPid -ne $brOldPid) { $brBackUp = $true; break }
            }
            if ($brBackUp) { Write-Host ' 起来了（端口占用者已换成新进程）' }
            else { Write-Host ' 40 秒内没看到它重新监听 —— 看 state\bridge.log 或按 b' }
        } else {
            Write-Host '      [提示] 没触发重启：桥接会在 401 后自行从 guard 日志发现新令牌'
        }
    } elseif ($token) {
        Write-Host '      DSH 本轮没动（-NoRestart）⇒ 令牌没变，不打扰桥接。'
    }
} elseif (-not (Test-Path $BridgeBat)) {
    Write-Host "      [错误] 找不到 $BridgeBat"
} else {
    # ── 桥接：★ 守护必须跟着一起搬过去（P1④ 硬约束）───────────────────────────────
    # 起的东西**还是那个 `start.bat`**（唯一一份守护实现：node 退出 → 5 秒后重拉），
    # 只是外层 cmd 换成了"不创建窗口"的形态 —— 所以"桥接死了有人拉回来"这条自愈能力原地保留。
    # 历史事故（2026-09-24）：那一次连桥接进程带它的守护窗口一起没了 ⇒ 没有任何东西把它拉回来
    # ⇒ QQ 侧断线。所以这一段的评价标准不是"有没有窗口"，是"守护还在不在"。
    # `title qq-bridge &` 留着：命令行签名（stop-all 的 CIM 那一路）与可见形态的标题都认它。
    $brTmp = Join-Path $BridgeDir 'state\_tmp'
    if (-not (Test-Path $brTmp)) { New-Item -ItemType Directory -Path $brTmp -Force | Out-Null }
    $brOut = Join-Path $brTmp 'bridge-console.out.log'
    $brErr = Join-Path $brTmp 'bridge-console.err.log'
    $brCommand = 'title qq-bridge & start.bat'
    $brProc = $null
    if ($WantWindowless) {
        # ★ 2026-09-24 深夜：超时 20 秒 → 60 秒。主人的那次实测里，无窗口那条**其实成功了**：
        #   23:24:41 起 cmd（隐藏控制台、标题 qq-bridge、守护在跑），桥接进程 23:25:38 才监听 3100
        #   —— 因为 start.bat 第一次进去撞上"过期锁文件"重试了一轮（见 state\_tmp\bridge-console.err.log），
        #   57 秒 > 原来的 20 秒 ⇒ 被误判成"没起来"⇒ 打印回退、又开了一个可见窗口。
        #   60 秒 = 实测 57 秒 + 余量；判据仍是 3100（桥接自己的端口 = "进程起来了"的信号，不依赖外部）。
        $brProc = Start-WindowlessProcess -FilePath 'cmd.exe' -WorkingDirectory $BridgeDir `
            -Arguments (New-CmdRedirectLine -Command $brCommand -StdOutLog $brOut -StdErrLog $brErr)
        if ($brProc) { Write-Host ('      已拉起（后台进程 {0}，CREATE_NO_WINDOW：不会出现它的窗口；守护仍是 start.bat）' -f $brProc.Id) }
        else { Write-Host '      无窗口方式没能拉起来。' }
        $brReady = $false
        if ($brProc) { $brReady = Wait-Port $BridgePort $WindowlessTimeoutBridge '桥接控制台（进程起来的信号）' }
        if ($brReady) {
            $script:WindowlessBridge = $true
            Write-Host '      ✓ qq-bridge 已在**无窗口**方式下起来（守护 start.bat 照旧在它里面跑）'
        } else {
            # 与 SnowLuma 同一套判据：进程还在 ⇒ 别杀、别换窗口（换窗口只会白多一个 WT 窗口），
            # 让它继续跑；真没了才回退可见窗口（那才叫人看得见它为什么死）。
            if ($brProc -and (Get-Process -Id $brProc.Id -ErrorAction SilentlyContinue)) {
                $script:WindowlessBridge = $true
                Write-Host ('      [慢] 后台进程 {0} 还活着，只是 {1} 没在 {2} 秒内就绪 —— **保留它继续等**（不换窗口）。' -f $brProc.Id, $BridgePort, $WindowlessTimeoutBridge)
                Write-Host ('           要看它刷什么：{0}' -f $brErr)
            } else {
                # ★ 自动回退：先收掉自己刚起的那一棵（只按手里的 pid），再走可见窗口
                Stop-WindowlessProcess -Process $brProc | Out-Null
                Write-WindowlessFallback -What ("qq-bridge（{0} 秒内进程就没了）" -f $WindowlessTimeoutBridge)
            }
        }
    }
    if (-not $script:WindowlessBridge) {
        Start-Process -FilePath 'cmd.exe' -WorkingDirectory $BridgeDir -ArgumentList '/k', $brCommand
        Write-Host '      已启动（**有窗口**：标题 qq-bridge，自带守护；收尾会最小化）'
    }
}
Write-Host ''

# 等 QQ 网关起来，然后自检
if (-not $token) {
    $token = Wait-LaunchToken -Since $since -TimeoutSec 10
    if ($token) {
        Write-Host '      补抓到令牌，写入桥接配置并让它自行重启后生效'
        Set-BridgeToken -Token $token | Out-Null
    }
}

# 2026-09-24（主人："开机刚启动的时候 SnowLuma 登陆不上 需要先注入登陆才行"）：
# 全量启动这条路以前**从不**登录 SnowLuma —— 而它的 WebUI 会话只在内存里，每次重启都要重新注入。
# 不注入时 OneBot 的 WS 迟迟不 accept，桥接就空转重连（实测 02:38:08 → 02:39:38 才连上，
# 主人截图里那串 "WebSocket closed before opening" 就是它）。
# 放在桥接启动**之后**做，是为了不给开机增加等待（桥接自己有重连）。
if (-not $NoSnowlumaLogin) {
    $loginScript = Join-Path $Root 'tools\snowluma-login.ps1'
    if (Test-Path $loginScript) {
        if (Wait-Port $SnowLumaWebPort 45 'SnowLuma 管理页') {
            Write-Host '登录 SnowLuma（注入 WebUI 会话）...'
            try {
                # ★ 2026-09-24（P0 收口）：这里**只换令牌 / 校验会话**，不开页面 —— 页面统一由
                # panels.ps1 开（它是唯一的"开页面者"，见 docs\qq-agent-产品设计.md §3.3）。
                # 历史坑：早先"这里加 -NoOpen 之后管理页开始要密码"，当时归因错了 —— 根因不是 -NoOpen，
                # 而是那会儿**没有任何人**再加载 snowluma-autologin.html（旧 panels 会跳过 SnowLuma）。
                # 现在开页是显式的：收尾时调 panels.ps1 open -Pages dsh,console,snowluma
                # -ForcePage snowluma（SnowLuma 刚被重启 ⇒ 旧标签里的令牌已失效）。
                # -Quiet 只是不把那串带令牌的 URL 打到屏幕上。
                & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $loginScript -NoOpen -Quiet | Out-Null
                if ($LASTEXITCODE -eq 0) { Write-Host '      令牌已更新（页面由 panels.ps1 统一开，不再问 SnowLuma 密码）' }
                # 精确注入（2026-09-24）：只给**她的号**注入。
                # 为什么不用 SnowLuma 的 hookAutoLoad：它会注入所有枚举到的 QQ.exe，Windows 上无过滤，
                # 结果把主人自己的号也 hook 进来、那个 OneBot 还因 HTTP/WS 端口被占报 EADDRINUSE
                # （主人原话："我的另一个不用注入的QQ也给我登陆上了"）⇒ 已弃用，改成按 UIN 认人。
                $injectScript = Join-Path $Root 'tools\snowluma-inject.ps1'
                # 给 SnowLuma 一点时间把 WebUI 会话与 OneBot 侧准备好（原来这里是为了等登录页的
                # WS 连上；2026-09-24 起页面由 panels.ps1 在收尾时开，这 3 秒只剩"让它稳定下来"的作用）。
                Start-Sleep -Seconds 3
                if (Test-Path $injectScript) {
                    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $injectScript | Out-Host
                    if ($LASTEXITCODE -eq 3) { Write-Host '      [提示] 她的 QQ 还没启动 —— 起来后跑 tools\snowluma-inject.ps1 补注入' }
                }
                else { Write-Host "      [提示] 登录脚本返回 $LASTEXITCODE（可跑 一键启动.cmd login 看细节）" }
            } catch {
                Write-Host "  [提示] 登录脚本出错：$($_.Exception.Message)（可跑 一键启动.cmd login 重试）"
            }
        } else {
            Write-Host "  [提示] 管理页（端口 $SnowLumaWebPort）45 秒内没就绪，跳过自动登录（可跑 一键启动.cmd login）"
        }
    }
}

Write-Host '等 QQ 网关就绪（最多 90 秒）...'
# ★ 这是启动器里**最长**的一次等待（要等 QQ 客户端登录/hook 接上），原来全程一声不吭 ——
#   主人这次的诉求就是它："程序正在等待运行的时候加个…用来提醒用户程序正在运行"。
# ★ 端口一律走变量（`$Ports = Get-AgentPorts`，见本文件 `:144`）—— **连提示文案里也不许写死数字**：
#   棘轮检查（self-check 5.13）为文案里的一个字面量报过失败，这正是它该做的（2026-09-24 实测抓到一次）。
#   顺带修一个笔误：这里等的是 **SnowLuma WS** 口，不是 OneBot 口。
$ready = Wait-Port $SnowLumaPort 90 ('QQ 网关（SnowLuma :{0}，要等 QQ 客户端登录）' -f $SnowLumaPort)
if (-not $ready) { Write-Host ('  [警告] 90 秒内 SnowLuma :{0} 未就绪，看 SnowLuma 窗口的日志' -f $SnowLumaPort) }

Write-Host ''
Write-Host '====================== 自检 ======================'
foreach ($item in @(
        @{ name = 'DSH      '; port = $DshPort },
        @{ name = 'SnowLuma '; port = $SnowLumaPort },
        @{ name = 'OneBot-HTTP'; port = $OneBotPort },
        @{ name = '桥接控制台'; port = $BridgePort })) {
    $ok = Test-Port $item.port
    $mark = if ($ok) { 'OK  ' } else { 'DOWN' }
    Write-Host ("  {0} : {1}  (127.0.0.1:{2})" -f $item.name, $mark, $item.port)
}

if (Test-Port $OneBotPort) {
    try {
        $cfg = Get-Content -LiteralPath $BridgeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
        $t = [string]$cfg.snowluma.accessToken
        $uri = "http://127.0.0.1:$OneBotPort/get_login_info?access_token=$t"
        $res = Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body '{}' -TimeoutSec 10
        if ($res.status -eq 'ok') {
            Write-Host ("  QQ 账号   : 在线  {0} ({1})" -f $res.data.nickname, $res.data.user_id)
        } else {
            Write-Host "  QQ 账号   : 未就绪 $($res | ConvertTo-Json -Compress)"
        }
    } catch {
        Write-Host "  QQ 账号   : 查询失败（$($_.Exception.Message)）"
    }
}

Write-Host '=================================================='
Write-Host ''
Write-Host '常用地址：'
Write-Host ('  桥接控制台  http://127.0.0.1:' + $BridgePort + '  （切模式/看日志/改白名单）')
Write-Host ('  SnowLuma    http://127.0.0.1:' + $SnowLumaWebPort + '  （QQ 登录/OneBot 配置）')
Write-Host ('  DSH         http://127.0.0.1:' + $DshPort)
Write-Host ''
Write-Host '窗口约定：DSH-Web 收尾会**按引导判据**决定留桌面还是缩进任务栏（引导没走完就留桌面；'
Write-Host '          缩进去了也不用记着它 —— 五灯不绿时它会自己跳回来）。桥接由 start.bat 守护。'

# ── 控制面（P1⑤ 页面总控面板的载波）：独立小服务 tools\control-server.mjs ──────────────
# ★ 为什么必须是**独立进程**：页面面板上那个「重起 DSH」如果走 DSH 自己的 HTTP 服务，
#   就是一个**会杀掉自己所在服务器的请求** —— 只有独立进程才能活着看它重启完、
#   才能在 DSH 不在的时候照样回答"现在什么状态"。
# ★ 它只做搬运：每个请求翻译成一次 tools\control.ps1 调用（唯一动作源），自己不判定任何状态。
# ★ 它和三件套**没有任何父子/守护关系**：起不来或中途死了，只是页面面板变灰，QQ 链路照跑。
#   （所以那一份起法内部一律不 throw，把结果当返回值交出去 —— 绝不因为它让整个启动失败。）
# ★ 2026-09-26：**起法只有一份** —— 原来这段内联形状搬进了 tools\control-plane.ps1，三个入口共用。
#   为什么非抽不可：QQ 搬走之后，dsh-prompt 的"补缺"（走 -NoRestart）会把 SnowLuma 与桥接一起起
#   出来 ⇒ 抢号 ⇒ 它只能整段跳过补缺 ⇒ 按 r 之后 :3101 死了**没人管**（主人报的"总控的灯不见了"）。
#   这一段 = **全量启动**时的调用点；补缺那条路调的是**同一个函数**（谁都不许再写第二份实现）。
# （$ControlPort 在文件上方和其他端口一起派生了，这里直接用。）
Write-Host ''
Write-Host '[控制面] 页面总控面板的服务（tools\control-server.mjs，独立进程）'
[void](Start-ControlPlane -Port $ControlPort -WaitSec 15)

# ── 收尾：三件套都起来了，一起把控制台窗口最小化 ────────────────────────────
# （主人 2026-09-23："最好 cmd 的最小化，还是这个形式，可以全部启动完一起最小化"）
# 放在这里而不是启动时最小化：正常创建才有正确的任务栏图标（WT 形式），
# 而且"全部起完再一起收"不会看到窗口一个个蹦出来又被压下去。
# 认窗口两路并用：① 比启动前的快照多出来的控制台窗口（**标题会被程序改回 cmd 默认值，
# 只有句柄靠得住**）② 标题匹配的（兜"本来就在跑的"）。句柄连同标题记进
# .launcher-state.json，给 stop-all.ps1 精确关闭用。
Write-Host ''
Write-Host '收尾：最小化控制台窗口'
# 标题模式来自 tools\minimize-windows.ps1 的 $script:DshWindowTitlePatterns（**只有那一份定义**：
# dsh-prompt.ps1 判断"窗口是不是缩着的"也按同一份标题找它）。
$titlePatterns = @($script:DshWindowTitlePatterns) + @('SnowLuma*', 'qq-bridge*', '*start.bat*')
$newWins = @(Get-NewConsoleWindows -Before $windowsBefore)
$titledWins = @(Get-TitledConsoleWindows -Patterns $titlePatterns)
$targets = @($newWins)
foreach ($w in $titledWins) { if (-not ($targets | Where-Object { $_.Hwnd -eq $w.Hwnd })) { $targets += $w } }

    # 2026-09-24 主人："这个控制窗口不要隐藏了 —— 如果第一次启动就会出问题，最好设计得人性化一点"。
    # ★ 2026-09-24 第五批（§10.1-5「窗口可见性也是引导的一部分」，主人原话："这个窗口默认是最小化的…
    #   第一次启动的时候可以不用吧，用来给用户提示"）：判据只有一个 —— **引导做完没有**：
    #     · 没做完 → DSH-Web 留桌面（它此刻就是引导载体：三步走 + 扫码 + 那一行"下一动作"）；
    #     · 做完了 → 收尾**一起缩进任务栏**，桌面彻底干净（出问题它会自己跳出来，见 dsh-prompt.ps1）。
    #   判定与落盘全在 tools\onboard.ps1（它再问 control.ps1 status + 核实"她真的回过话"的真实信号），
    #   本处**只消费结论**，不自己拼第二套。判据读不到 / 五灯不绿 / 显式 -KeepWindow ⇒ 一律留桌面
    #   （**宁可多留一个窗口，也不能把报错藏进任务栏**）。
    #   qq-bridge / SnowLuma 这类后台控制台照旧总是最小化。（$targets 仍然完整记进 .launcher-state.json，
    #   这样"一键关闭"照样能精确关掉全部。）
    $onboard = Get-OnboardDecision
    $minimizeDshWeb = $false
    $whyKeep = ''
    if ($KeepWindow) {
        $whyKeep = '-KeepWindow：强制留桌面（手动退路）'
    } elseif (-not $onboard) {
        $whyKeep = '读不到引导判据（tools\onboard.ps1）—— 按"留桌面"处理'
    } elseif ($onboard.decision -ne 'minimize') {
        $whyKeep = [string]$onboard.decisionWhy
    } else {
        $minimizeDshWeb = $true
    }
    $dshWins = @($targets | Where-Object { $_.Title -match 'DSH-Web|dsh web' })
    $minimizeThese = @($targets | Where-Object { $_.Title -match 'qq-bridge|start\.bat|SnowLuma' })
    if ($minimizeDshWeb) {
        foreach ($w in $dshWins) { if (-not ($minimizeThese | Where-Object { $_.Hwnd -eq $w.Hwnd })) { $minimizeThese += $w } }
    }
$minimized = Minimize-WindowHandles -Handles (@($minimizeThese | ForEach-Object { $_.Hwnd }))
# 到底缩下去没有（**如实说**：Set-WindowMinimized 可能没成，别报"缩好了"）
$dshOk = $false
foreach ($t in $minimized) { foreach ($w in $dshWins) { if ([Int64]$t.Hwnd -eq [Int64]$w.Hwnd) { $dshOk = $true } } }
if ($minimized.Count -gt 0) {
    foreach ($t in $minimized) {
        $label = if ($t.Title) { $t.Title } else { '（标题被程序改成了默认值）' }
        Write-Host ("      已最小化：{0}" -f $label)
    }
    Write-Host '      （要看日志：任务栏点开对应窗口，或直接看日志文件）'
    if ($dshOk) {
        Write-Host '      DSH-Web 也一起缩进任务栏了 —— 引导已经走完，桌面就该干净；'
        Write-Host '      出事（五灯不绿）它会自己跳回前台，平时要看它就点任务栏那个窗口：输 e 关全部、r 重起、s 登录 QQ'
    } else {
        # 别再说死"它留在桌面上"：这次收尾**没有**碰它，"在不在桌面上"由下面那段主动确认后再说
        Write-Host '      DSH-Web 不在这次要缩的名单里 —— 它该留在桌面上当总开关（下面会确认它真在）'
    }
} else {
    if ($script:WindowlessBridge -or $script:WindowlessSnowLuma) {
        # P1④ 之后这是**正常状态**，不是"没找到窗口"：那两个组件根本没有窗口。
        Write-Host '      （无窗口模式：qq-bridge / SnowLuma 没有窗口可最小化）'
    } else {
        Write-Host '      [提示] 没有可最小化的窗口（可能三件套本来就在跑）'
    }
    if ($minimizeDshWeb -and $dshWins.Count -eq 0) {
        Write-Host '      [提示] 判据说"可以缩"，但没认出 DSH-Web 那个窗口（标题被改过？）—— 它还在桌面上，没动它。'
    }
}
# 引导做完了、这次却把窗口留在了桌面上：如实说清**为什么**（留桌面永远是有理由的，不是忘了缩）
if (-not $dshOk -and $minimizeDshWeb -and $dshWins.Count -gt 0 -and $minimized.Count -gt 0) {
    Write-Host '      [提示] 判据说"可以缩"，但 DSH-Web 没缩下去（系统不让？）—— 它还在桌面上。'
} elseif (-not $minimizeDshWeb) {
    if ($whyKeep) { Write-Host ('      窗口留桌面：{0}' -f $whyKeep) }
    # ★ 2026-09-24（主人双击 一键启动.cmd 后 DSH-Web 自己缩进了任务栏，而判据当时算的正是"留桌面"）：
    #   **"不缩窗口"不等于"窗口在桌面上"。** DSH-Web 跑在 **Windows Terminal** 里，而 WT **复用同一个窗口**
    #   （同一个 pid 上能看到多个 HWND/标题）—— **在一个已经缩着的 WT 窗口里开新标签，那个新窗口生下来
    #   就是缩着的**。所以"留桌面"这条路**必须主动确认并把它放回桌面**；什么都不做 = 把引导载体
    #   （三步走 + 扫码 + 那一行"下一动作" + 那句一次性告知）藏进任务栏，正是 §10.1-5 要避免的事。
    #   还原走 tools\minimize-windows.ps1 的 Restore-WindowHandles（与"最小化"同一份窗口库，不另写一套）。
    #   ⚠ 三种情况三句话，**如实说**：本来缩着的 / 本来就在桌面上（没碰它）/ 试了没成（系统不让）；
    #     没成功时**不许**印"已放回桌面"。
    if ($dshWins.Count -eq 0) {
        Write-Host '      [提示] 没认出 DSH-Web 那个窗口（标题被改过？）—— 没法确认它缩着没有，去任务栏看一眼。'
    } else {
        $kept = @(Restore-WindowHandles -Handles @($dshWins | ForEach-Object { $_.Hwnd }))
        foreach ($k in $kept) {
            if (-not $k.Exists) {
                Write-Host '      [提示] DSH-Web 那个窗口已经不在了（刚被关掉？）—— 这次没动它。'
            } elseif (-not $k.WasIconic) {
                Write-Host '      DSH-Web 本来就在桌面上（没动它）。'
            } elseif ($k.Ok) {
                Write-Host '      DSH-Web 本来是缩着的（Windows Terminal 复用了那个缩着的窗口）—— 已经把它放回桌面了。'
            } else {
                Write-Host '      [提示] DSH-Web 本来是缩着的，试着放回桌面没成（系统不让）—— 请点一下任务栏那个窗口。'
            }
        }
    }
}

# 记下这次的窗口句柄 + 三个端口占用者，给"一键关闭"用（句柄比标题可靠）
# ★ 无窗口模式（P1④）下 windows 里**只剩 DSH-Web**（另两个组件没有窗口）——
#   这不是记录缺了，而是"收它们"改由 pids（端口占用者）+ stop-all 的 CIM 命令行签名负责，
#   那两条路对"有没有窗口"完全无感（见 tools\stop-all.ps1 文件头）。mode 字段把这件事写清楚。
try {
    $statePath = Join-Path $Root '.launcher-state.json'
    $winRecords = @()
    foreach ($w in $targets) {
        $winRecords += [pscustomobject]@{ hwnd = [Int64]$w.Hwnd; title = [string]$w.Title; owner = [string]$w.Owner }
    }
    $portRecords = @{}
    foreach ($pr in @(@{ p = $DshPort; k = 'dsh' }, @{ p = $BridgePort; k = 'bridge' }, @{ p = $SnowLumaPort; k = 'snowluma' })) {
        $portRecords[$pr.k] = (Get-PortOwnerPid $pr.p)
    }
    if ($script:WindowlessBridge -and $script:WindowlessSnowLuma) { $mode = 'no-window' }
    elseif ($script:WindowlessBridge -or $script:WindowlessSnowLuma) { $mode = 'mixed' }
    elseif ($WantWindowless) { $mode = 'visible（无窗口那条没起来，已自动回退）' }
    else { $mode = 'visible（-Visible）' }
    $state = [pscustomobject]@{
        at = (Get-Date).ToString('s'); mode = $mode
        windowless = [pscustomobject]@{ bridge = [bool]$script:WindowlessBridge; snowluma = [bool]$script:WindowlessSnowLuma }
        windows = $winRecords; pids = $portRecords
    }
    ($state | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-Host ("      已记录窗口句柄：{0} 个，模式 {1}（.launcher-state.json）" -f $winRecords.Count, $mode)
} catch {
    Write-Host ("      [提示] 记窗口句柄失败（不影响启动）：{0}" -f $_.Exception.Message)
}

# ── 自动打开网页 ───────────────────────────────────────────────────────────
# 控制台带鉴权（config.consoleToken 为空时桥接会生成随机令牌存进
# state/console-token），不带 ?token= 直接开控制台只会弹「请输入控制台访问令牌」。
# 控制台前端会把 ?token= 记进 localStorage（见 public/console.html），
# 所以带上令牌开一次，以后不带参数也能直接进。
function Open-WebPage([string]$Url, [string]$Label) {
    try {
        Start-Process $Url | Out-Null
        Write-Host "  已打开$Label"
    } catch {
        Write-Host "  [提示] 打不开$Label，请手动访问：$Url"
    }
}

$consoleUrl = "http://127.0.0.1:$BridgePort"
$consoleToken = ''
try {
    $tokenPath = Join-Path $BridgeDir 'state\console-token'
    if (Test-Path $tokenPath) { $consoleToken = (Get-Content -LiteralPath $tokenPath -Raw -ErrorAction Stop).Trim() }
} catch {
    Write-Host "  [提示] 读不到 state\console-token：$($_.Exception.Message)"
}
if (-not $consoleToken) {
    # 兼容把令牌手写在 config.json 里的情况
    try {
        $cfgNow = Get-Content -LiteralPath $BridgeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
        $consoleToken = ([string]$cfgNow.consoleToken).Trim()
    } catch {}
}

Write-Host ''
# ★ 2026-09-24 深夜：这句只在**真的要自动开页**时才说"已写进面板" —— 默认不开页的时候
#   它是在说谎（项目最忌"说的和做的不一致"）。-NoOpen 时令牌照样打出来，方便手动粘。
if ($consoleToken -and (-not $NoOpen)) {
    Write-Host '控制台令牌（已写进这次自动打开的面板页，不用手输）：'
    Write-Host "  $consoleToken"
} elseif ($consoleToken) {
    Write-Host '控制台令牌（这轮不自动开页；手动打开控制台时把它贴进页面，或直接用它带上 ?token=）：'
    Write-Host "  $consoleToken"
}

# ── 浏览器页面：★★ 2026-09-25 00:2x 改成**逐页判定**（主人当面原话）：
#   「程序启动之后可以先打开浏览器，如果有进程就不用打开了；如果是检查标签页面是否已经有三个网站，
#     **没有的话就弹出、有的话就不弹，每个都检测一下**」
#   ⇒ 语义 = 三页（DSH :3080 / SnowLuma :5099 / 桥接 :3100）**各检测一次**，缺哪张开哪张、已有就不开；
#     判据（**唯一一份**在 panels.ps1 的 Get-PanelVerdicts，全是实测信号，没有猜也没有记账）：
#       · 控制台 = 心跳 panel-presence.json（窗口 180 秒 —— 实测心跳周期 ≈60 秒、偶尔 120 秒，
#         原来正好取 60 秒 ⇒ 有一半时间把活着的控制台判成"没开"⇒ 重复开，这是本次缺陷的一条根因）；
#         ⚠ :3100 上**没有**浏览器长连接（实测只有 TIME_WAIT），所以它只能看心跳。
#       · dsh / snowluma = 浏览器（netstat -ano 最后一列 PID 的进程名是 msedge/chrome）在对应端口上的
#         ESTABLISHED（dsh 还认 :3101 控制面 —— DSH 页里的控制面板插件每 5 秒拉一次）；
#       · 三页各自独立的"实测不在"：一个浏览器进程都没跑，或（控制台）桥接一直在跑而心跳全无；
#       · 判不准 = 第三种状态 ⇒ **宁可不开**（panels.ps1 打 `[不开] … 判不准` + 把带令牌的地址打出来）。
#     盲区如实写在 panels.ps1 那段注释里：令牌失效/被挂起的旧标签，socket 层看不见 ⇒ 靠清场前的快照兜
#     （所以快照现在三条启动路都会拍，见上面 [0/3] 那段）。
#   ⇒ **删掉那处 `-ForcePage snowluma`**：它绕过去重、无条件再开一张，是"多出两个页面"的直接来源。
#     旧 SnowLuma 标签令牌失效怎么办：**如实提示**（下面那句），不再默默多开一张。
#   · 一个都不开：`-NoOpen`（旧名 -NoPanels 仍然认）   · 明确要开：`-Open`（= 默认语义）
#   · 某页必须重开：`tools\panels.ps1 open -ForcePage <dsh|console|snowluma>`
$doOpen = -not $NoOpen
if ($doOpen) {
    if (-not (Wait-Port $SnowLumaWebPort 30 ('SnowLuma 管理页（开页前确认 :{0}）' -f $SnowLumaWebPort))) {
        Write-Host "  [提示] SnowLuma 管理页还没就绪（http://127.0.0.1:$SnowLumaWebPort），panels.ps1 会自己跳过它。"
    }
    $panelsScript = Join-Path $Root 'tools\panels.ps1'
    if (Test-Path $panelsScript) {
        # 必须用**子进程**跑：panels.ps1 里用 exit 0 收尾，在进程内直接 & 调用会把本启动器一起退掉。
        try {
            # ★ 显式说这次开哪几页（`all` = 三页都要，逐页各自判"已经开着吗"）；
            #   页列表只有 panels.ps1 那一份来源（$PageKeys / $DefaultPages），这里不抄名单。
            # ★ 2026-09-25 修回（主人 14:2x 报的回归：「没刷新页面 + SnowLuma 令牌没更新」）：
            #   **本轮新起了 SnowLuma ⇒ 这一页必须重开** —— 它的令牌表只在 SnowLuma 进程的内存里，
            #   旧标签手里那份已失效，而 **F5 救不回来**（localStorage 里还是旧的）⇒ 只有一次**新导航**
            #   把 snowluma-autologin.html?token=… 送进浏览器，才能把新令牌写进去
            #   （设计口径：docs\启动与踩坑.md 的「三个页面」那节；「会新开一个」是设计如此，不是 bug）。
            #   ⚠ 这里**只在本轮新起了 SnowLuma 时**才传 —— 72cfd22 曾把它连注释一起删掉（注释还写成
            #   「无条件再开一张」）⇒ 去重把**死标签**当成「已开着」⇒ 既不刷新、也不写新令牌。
            #   其他页照旧去重（「挂着就别再开一份」这条收益不变）。
            $panelArgs = @('open', '-Pages', 'all')
            if ($SnowLumaStarted) { $panelArgs += @('-ForcePage', 'snowluma') }
            if ($OwnWindow) { $panelArgs += '-OwnWindow' }
            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $panelsScript @panelArgs
            # 旧标签的令牌可能已经失效（DSH 换启动令牌 / SnowLuma 重启过）—— **如实说**，不替主人再开一张。
            if ($SnowLumaStarted -or $startDsh) {
                Write-Host '  [提示] 若某张旧标签提示"要令牌 / 连不上"：那是它手里还是上一轮的令牌 ——'
                Write-Host '         DSH 页按 F5 就行；SnowLuma 那页 F5 没用（令牌在它自己的内存里）——'
                Write-Host '         本轮若已重开一张新的就用那张，旧的那张 Ctrl+W 关掉即可。'
            }
        } catch {
            Write-Host "  [提示] 面板脚本出错：$($_.Exception.Message)（可手动跑 tools\panels.ps1 open）"
        }
    } else {
        Write-Host '  [提示] 找不到 tools\panels.ps1，退回旧方式打开页面。'
        Open-WebPage "http://127.0.0.1:$DshPort" 'DSH 页面'
        if (Test-Port $BridgePort) { Open-WebPage "$consoleUrl/?token=$([uri]::EscapeDataString($consoleToken))" '桥接控制台' }
        Open-WebPage "http://127.0.0.1:$SnowLumaWebPort" 'SnowLuma 管理页'
    }
} else {
    Write-Host '  （-NoOpen：这次一个页面都不开；地址见上面的横幅，需要时按 DSH-Web 窗口里的 w）'
}
Write-Host ''
try {
    $dumpPath = Join-Path $Root 'qq-bridge\state\_tmp\launcher-windows.log'
    $lw = Join-Path $PSScriptRoot 'list-windows.ps1'
    if (Test-Path $lw) {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $lw -Label '启动器收尾时' -AppendTo $dumpPath | Out-Null
    }
} catch { }

try {
    $hb = Join-Path $PSScriptRoot 'hide-bridge-console.ps1'
    # 2026-09-24 主人："这个隐藏的后台 PowerShell 进程没用，我打开别的东西他会给我关掉" ⇒ 守窗器已撤。
} catch { }
Write-Host ''
Write-Host '第一次用（或换了浏览器）：浏览器打开下面三个地址，建议存成标签组 ——'
Write-Host ('   DSH Web          http://127.0.0.1:' + $DshPort)
Write-Host ('   桥接控制台        http://127.0.0.1:' + $BridgePort)
Write-Host ('   SnowLuma 管理页   http://127.0.0.1:' + $SnowLumaWebPort)
Write-Host '   （不想手打：在 DSH-Web 窗口里按 w 会一次性开好；SnowLuma 问密钥就按 s）'
Write-Host '面板：**逐页判定**（已开着的不重复开、缺的才开；说不清就不开）—— 一个都不开加 -NoOpen'
Write-Host '      独立窗口（关全部时能一起收）：-OwnWindow     某页强制重开：panels.ps1 open -ForcePage dsh'

# ── 起齐之后的收尾（★ 2026-09-25 主人点名两件）───────────────────────────────────
#   ① 撤掉 restart-stack 的并发闸标记（"这一次重启跑完了" ⇒ 入口立刻重新可用）
#   ② **一次性唤醒各条开发线** + 给主人 QQ 私聊一条"已经全起来了"
#      （主人原话：「停机之后要我给你们发消息你们才会动起来，不然就会全部停摆」+「以后 QQ 提示我」）
# ★ 只在"这一轮真起齐了"那一支做：-NoRestart（补缺）跳过 —— 那是补一个缺的服务、不是一次停机恢复，
#   在那一支也叫一遍 = 在同一份脚本的另一支重复投（协调线点名要求过的）。
# ★ 失败一律不重试、只记一行：这三件都是**旁路**通知，绝不能把启动本身带崩。
if ($DryRun) {
    Write-Host '  [DryRun] 起齐后的收尾（撤闸标记 / 唤醒各线 / QQ 提示）一个都不做。'
} elseif ($NoRestart) {
    Write-Host '  （-NoRestart：只补缺的服务 ⇒ 不唤醒各线、不发 QQ 提示）'
} else {
    Write-Host ''
    Write-Host '起齐后的收尾（撤闸标记 / 唤醒各线 / 给主人 QQ 一条）'
    $threeUp = (Test-Port $DshPort) -and (Test-Port $BridgePort) -and (Test-Port $ControlPort)
    if (-not $threeUp) {
        Write-Host ('  [跳过] 三件套没全通（DSH {0} / 桥接 {1} / 控制面 {2}）⇒ 不叫各线（起齐了才叫）。' -f $DshPort, $BridgePort, $ControlPort)
    } else {
        # ① 撤闸标记：路径仍在动作目录那一处定义（走目录的 --clear-busy，**不在这里抄路径**）
        try {
            $clearOut = & node (Join-Path $PSScriptRoot 'control-actions.mjs') '--clear-busy' 'restart-stack' 2>&1 | Out-String
            Write-Host ('  ' + $clearOut.Trim())
        } catch { Write-Host "  [提示] 撤闸标记失败（不影响启动）：$($_.Exception.Message)" }
        # ② 唤醒各线（目标从 docs\HANDOFF.md 台账现取；去重 state\_tmp\.woke-<stamp>）
        try {
            & node (Join-Path $PSScriptRoot 'wake-lines.mjs') '--stamp' $BootStamp '--reason' '三件套起齐（全量重启收尾）'
        } catch { Write-Host "  [提示] 唤醒各线出错（不影响启动）：$($_.Exception.Message)" }
        # ③ 给主人 QQ 一条 —— 红线 3：正文里**不许出现路径 / 配置 / 令牌**，所以这句话写死、不拼任何变量
        try {
            & node (Join-Path $PSScriptRoot 'qq-notify.mjs') '【自动提示】已经全起来了：DSH、QQ 桥接、控制面都通了，我又在线了。' '--tag' 'boot-up'
        } catch { Write-Host "  [提示] QQ 提示发不出去（不影响启动）：$($_.Exception.Message)" }
    }
}
