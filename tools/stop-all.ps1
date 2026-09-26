# ============================================================================
#  一键关闭：DSH Web + SnowLuma + qq-bridge（顺带关掉面板浏览器窗口）
#
#  为什么需要它：三件套各有各的窗口（DSH-Web / SnowLuma 外层+子窗口 / qq-bridge），
#  一个个点 X 太慢；而且桥接窗口里是 start.bat 的守护循环，光杀 node 它 5 秒后自己
#  又爬起来 —— 必须先收守护窗口本身。
#
#  用法：
#    powershell -File tools\stop-all.ps1              关掉全部
#    powershell -File tools\stop-all.ps1 -DryRun      只列出"会关谁"，绝不动手
#    powershell -File tools\stop-all.ps1 -KeepPanels  留着面板浏览器窗口
#    powershell -File tools\stop-all.ps1 -OnlySnowLuma  **只停 SnowLuma**（QQ 网关；DSH 与桥接不动）
#    powershell -File tools\stop-all.ps1 -OnlyControl   **只停控制面**（tools\control-server.mjs；三件套不动）
#  或者在 DSH 窗口里输 exit（tools\dsh-window.cmd 会调本脚本）。
#
#  认人（只关自己人，宁少勿错）：
#    ① 端口占用者：DSH / 桥接（含控制台）/ SnowLuma 三件套（端口从 tools\env-config.ps1 派生，不再写死）
#    ② 命令行签名（Get-CimInstance，拿不到就跳过）：`title DSH-Web`、`start.bat`、
#       `start "SnowLuma"`、`dsh guard` —— 这些**外层包装窗口**不占端口、只占屏幕
#    ③ 窗口标题：`DSH-Web*` / `*dsh web*` / `*start.bat*` / `SnowLuma*` 的控制台窗口发
#       WM_CLOSE（等于人点 X：连带结束那个窗口里的进程）
#    ④ 自保：本脚本自己的进程与它的祖先一律跳过（否则从某个窗口里跑就会把自己打断）
#    ⑤ 事后体检：把"没认出来的控制台窗口"列出来（可能是他自己的窗口，绝不乱关）
#    ★ 2026-09-24（P1④ 无窗口化）之后，桥接与 SnowLuma **不再创建窗口** ⇒ 认它们**只靠 ①端口 + ②命令行签名**
#      （③那条路对它们自然落空，不是故障；`.launcher-state.json` 里也只剩 DSH-Web 一个句柄）。
#      端口→进程那条对"有没有窗口"完全无感：桥接 = 占控制台端口的 node，守护 = 命令行里带 `start.bat` 的 cmd。
#
#  注意：本文件必须存成「UTF-8 带 BOM」（PS 5.1 否则按 ANSI 解码，中文全乱）。
# ============================================================================

param(
    [switch]$DryRun,
    [switch]$KeepPanels,
    # 别动 SnowLuma：它是 QQ 网关，WebUI 的会话令牌只存在它**内存**里（一重启就得重新登录，
    # 主人 2026-09-23："这个网站不关掉重开就要输入令牌"）。启动器的"打开时先清场"默认带这个开关。
    [switch]$KeepSnowLuma,
    # 反过来：**只停 SnowLuma**，DSH 与 qq-bridge 一律不动（2026-09-24 加，P1④ 那批）。
    # 存在的理由：control.ps1 的 `restart snowluma` 需要一个"只停它"的执行体，
    # 而自己再写一套"只杀 SnowLuma"的认进程逻辑就是**第二份实现**（设计文档 §3.1 明令消灭的东西）。
    # 这里只是把下面那三张识别表**过滤成只留 SnowLuma**：自保、端口→进程、事后体检全部复用。
    # ⚠ 语义后果：SnowLuma 的 WebUI 令牌只在内存 ⇒ 停它 = 管理页那个标签要重新登录（输出里会提醒）。
    [switch]$OnlySnowLuma,
    # 再一个"只停一件"：**只停控制面**（tools\control-server.mjs 那个独立进程，:3101），
    # 三件套（DSH / 桥接 / SnowLuma）一律不动（2026-09-24 加，主人实测发现的缺口）。
    # 存在的理由与 -OnlySnowLuma 同一个：control.ps1 的 `restart control` 要一个"只停它"的执行体，
    # 而"按端口认人 + 自保 + 事后体检"这三件事这里已经有一份了，另写就是第二份实现。
    # 它同样只是把下面那三张识别表过滤成只留控制面那一行（端口表里那条 `control-server 控制面`）。
    # ⚠ 语义后果：控制面是页面总控面板的载波 ⇒ 停它 = 面板灰掉（十几秒），QQ 链路不受影响（输出里会提醒）。
    [switch]$OnlyControl,
    # ★ 2026-09-26（P1，小舵拍板）：再一个"只停一件" —— **只停 DSH**（DSH Web 那个 node ＋ 它的窗口），
    #   桥接 / SnowLuma / 控制面一律不动。存在的理由与 -OnlySnowLuma / -OnlyControl 同一个：面板那个
    #   "重起 DSH"要一个"只停它"的执行体，而"按端口认人 ＋ 自保 ＋ 事后体检"这里已经有一份了，另写就是第二份。
    #   它同样只是把三张识别表过滤成只留 DSH 那一行 ＋ DSH-Web 那个窗口。
    # ⚠ 为什么连窗口一起关：DSH 的窗口（dsh-prompt 守窗器）会在 DSH 死后**自动把它拉回来** ⇒ 只杀进程、
    #   留着窗口，那次"重起"就变成"窗口自己拉一代"（账本记成 auto、还可能撞上频率告警）⇒ 关掉窗口，
    #   由调用方按**同一个入口**（tools\dsh-only.ps1）重起一代，行为与"主人双击只开DSH"一致。
    [switch]$OnlyDsh
)

$ErrorActionPreference = 'Continue'

# ── 端口唯一来源（P2⑦ 参数单一来源）────────────────────────────────────────
# 默认值表只有一处（qq-bridge\src\config-lib.js 的 DEFAULT_PORTS），生效值由仓库根的
# agent.config.json 决定 —— 问 Node 要（为什么这么绕，tools\env-config.ps1 文件头写了）。
# 下面那张"杀谁"的端口表**全部由这里派生**：改端口只改那一处，清场跟着走。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
# ── 等待进度小库（2026-09-25）：清场这几段"要十几秒"的等待必须有活进度 ——
#    主人原话："程序正在等待运行的时候加个…用来提醒用户程序正在运行，而不是让他们以为开掉了"。
#    实现只有一份（tools\progress.ps1），与启动器共用。
. (Join-Path $PSScriptRoot 'progress.ps1')
$DshPort          = $Ports.dshWeb
$BridgePort       = $Ports.bridgeConsole
$ControlPort      = $Ports.bridgeControl
$SnowLumaWsPort   = $Ports.snowlumaWs
$SnowLumaHttpPort = $Ports.onebotHttp
$SnowLumaWebPort  = $Ports.snowlumaWeb

$Root = Split-Path -Parent $PSScriptRoot   # 2026-09-24：从脚本位置推导（原来写死 D:\hobby\DSH，换目录/交付给别人就整链失效）
$BridgeDir = Join-Path $Root 'qq-bridge'

# 端口 → 说明（顺序=优先级：先守护/包装，后服务）；端口全部来自上面的环境层派生
$PortTargets = @(
    @{ Port = $DshPort; Label = 'DSH Web' },
    @{ Port = $BridgePort; Label = 'qq-bridge 控制台' },
    # 2026-09-24：控制面 = 页面总控面板的载波（tools\control-server.mjs）。
    # 它**不是**三件套之一（不涉及 QQ 链路），"关闭全部"时顺手收掉它只是因为
    # 主人按 e 的语义是"全停"；它自己挂了也不影响三件套。
    @{ Port = $ControlPort; Label = 'control-server 控制面' },
    @{ Port = $SnowLumaWsPort; Label = 'SnowLuma WS' },
    @{ Port = $SnowLumaHttpPort; Label = 'SnowLuma OneBot' },
    @{ Port = $SnowLumaWebPort; Label = 'SnowLuma 管理页' }
)

# 命令行签名 → 这是干什么的（这些进程**不占端口**，光看端口会漏掉，窗口就一直留着）
$CmdLineSignatures = @(
    @{ Like = '*title DSH-Web*';    Label = 'DSH-Web 窗口（cmd /k）' },
    @{ Like = '*title qq-bridge*';  Label = 'qq-bridge 守护窗口（cmd /k）' },
    @{ Like = '*start.bat*';        Label = 'qq-bridge 守护窗口（旧形态，start.bat）' },
    @{ Like = '*title SnowLuma*';   Label = 'SnowLuma 窗口（cmd /k）' },
    @{ Like = '*start "SnowLuma"*'; Label = 'SnowLuma 旧外层窗口（已不再产生，留作兜底）' },
    @{ Like = '*dsh*guard*';        Label = 'DSH 守护进程（若在用）' }
)

# 窗口标题 → 说明（`title X & …` 的实际标题末尾带一个空格，所以一律用通配符）
# 2026-09-23 起启动器给三个窗口都写了 title：DSH-Web / SnowLuma / qq-bridge
# （SnowLuma 不再用 `start` 开子窗口，所以没有那个标题是 cmd 默认值的多余空窗口了）。
$TitlePatterns = @(
    @{ Like = 'DSH-Web*';    Label = 'DSH-Web 窗口' },
    @{ Like = '*dsh web*';   Label = 'DSH-Web 窗口（cmd 把命令续在标题后面）' },
    @{ Like = 'qq-bridge*';  Label = 'qq-bridge 守护窗口' },
    @{ Like = '*start.bat*'; Label = 'qq-bridge 守护窗口（旧标题形态）' },
    @{ Like = 'SnowLuma*';   Label = 'SnowLuma 窗口' }
)

# -KeepSnowLuma：把 SnowLuma 相关的目标（端口 / 命令行签名 / 窗口标题）整体摘掉。
# 启动器的清场默认带上它 —— 只清 DSH 与桥接（连面板），QQ 网关和它 WebUI 的登录态原地不动。
if ($KeepSnowLuma) {
    $PortTargets       = @($PortTargets       | Where-Object { $_.Label -notlike 'SnowLuma*' })
    $CmdLineSignatures = @($CmdLineSignatures | Where-Object { $_.Label -notlike 'SnowLuma*' })
    $TitlePatterns     = @($TitlePatterns     | Where-Object { $_.Label -notlike 'SnowLuma*' })
}

# -OnlySnowLuma：正好相反 —— **只留 SnowLuma**（三个端口 / 两条命令行签名 / 窗口标题）。
# 它是 control.ps1 `restart snowluma` 的执行体：一行新的识别逻辑都没有，只是把三张表过滤一遍，
# 所以"端口→进程、自保、体检"三件事与"关全部"用的是**同一份实现**（这正是 §3.1 要的）。
if ($OnlySnowLuma -and $KeepSnowLuma) {
    Write-Host '  [用法错误] -OnlySnowLuma（只停它）与 -KeepSnowLuma（别停它）语义相反，不能一起用。'
    exit 2
}
if ($OnlyControl -and $OnlySnowLuma) {
    Write-Host '  [用法错误] -OnlyControl（只停控制面）与 -OnlySnowLuma（只停 QQ 网关）是两个互斥的"只停一件"，不能一起用。'
    exit 2
}
if ($OnlyControl -and $KeepSnowLuma) {
    Write-Host '  [用法错误] -OnlyControl 只停控制面，-KeepSnowLuma 是"别停 SnowLuma" —— 后者对前者没有意义（多半是参数拼错了）。'
    exit 2
}
if ($OnlyDsh -and ($OnlySnowLuma -or $OnlyControl)) {
    Write-Host '  [用法错误] -OnlyDsh / -OnlySnowLuma / -OnlyControl 是三个互斥的"只停一件"，不能一起用。'
    exit 2
}
if ($OnlySnowLuma) {
    $PortTargets       = @($PortTargets       | Where-Object { $_.Label -like 'SnowLuma*' })
    $CmdLineSignatures = @($CmdLineSignatures | Where-Object { $_.Label -like 'SnowLuma*' })
    $TitlePatterns     = @($TitlePatterns     | Where-Object { $_.Label -like 'SnowLuma*' })
}
# -OnlyControl：同上，只留端口表里那条 `control-server 控制面`（它不占窗口，所以两张窗口表都清空）。
if ($OnlyControl) {
    $PortTargets       = @($PortTargets       | Where-Object { $_.Label -like 'control-server*' })
    $CmdLineSignatures = @()
    $TitlePatterns     = @()
}
# -OnlyDsh：只留端口表里那条 `DSH Web`，以及**只留 DSH-Web 那个窗口**（2026-09-26）。
if ($OnlyDsh) {
    $PortTargets       = @($PortTargets       | Where-Object { $_.Label -eq 'DSH Web' })
    $CmdLineSignatures = @($CmdLineSignatures | Where-Object { $_.Label -like 'DSH*' })
    $TitlePatterns     = @($TitlePatterns     | Where-Object { $_.Label -like 'DSH*' })
}

# 体检时算"控制台类窗口"的进程名
$ConsoleOwnerNames = @('cmd', 'node', 'conhost', 'WindowsTerminal', 'OpenConsole', 'powershell', 'pwsh')

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

# 占用某端口的 PID；没有则 0。用 netstat 而不是 Get-NetTCPConnection（后者可能要管理员）。
function Get-PortOwnerPid([int]$Port) {
    foreach ($line in (netstat -ano)) {
        if ($line -match (':{0}\s+\S+\s+LISTENING\s+(\d+)\s*$' -f $Port)) {
            return [int]$Matches[1]
        }
    }
    return 0
}

if (-not ('StopAll.Win' -as [type])) {
    Add-Type -Namespace StopAll -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, uint msg, System.IntPtr wp, System.IntPtr lp);
'@
}

# 所有可见顶层窗口（带拥有者进程名，体检时用来区分"自己的"和"他的"）
function Get-VisibleWindows {
    $script:__stopAllWins = New-Object System.Collections.ArrayList
    $cb = [StopAll.Win+EnumProc]{
        param($h, $l)
        if (-not [StopAll.Win]::IsWindowVisible($h)) { return $true }
        $sb = New-Object System.Text.StringBuilder 512
        [StopAll.Win]::GetWindowTextW($h, $sb, 512) | Out-Null
        $wpid = 0
        [StopAll.Win]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
        $proc = Get-Process -Id ([int]$wpid) -ErrorAction SilentlyContinue
        [void]$script:__stopAllWins.Add([pscustomobject]@{
            Hwnd  = $h
            Title = $sb.ToString()
            Pid   = [int]$wpid
            Owner = $(if ($proc) { $proc.ProcessName } else { '?' })
        })
        return $true
    }
    [StopAll.Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    return $script:__stopAllWins
}

Write-Host '=================================================='
if ($DryRun) { Write-Host ' 关闭全部（-DryRun：只看不做）' } else { Write-Host ' 关闭全部：DSH Web + SnowLuma + qq-bridge' }
if ($OnlySnowLuma) { Write-Host ' 模式：-OnlySnowLuma —— 只停 QQ 网关，DSH 与 qq-bridge 一律不动' }
Write-Host '=================================================='

# ── 自保：自己的进程与所有祖先 ──────────────────────────────────────────────
$selfPids = New-Object System.Collections.ArrayList
[void]$selfPids.Add($PID)
$cimOk = $false
$cimProcs = @()
try {
    $cimProcs = Get-CimInstance Win32_Process -ErrorAction Stop
    $cimOk = $true
} catch {
    Write-Host '  [提示] 读不到进程命令行（CIM 不可用）—— 改用"端口 + 窗口标题"两种办法认人。'
}
if ($cimOk) {
    $cursor = $PID
    for ($i = 0; $i -lt 8; $i++) {
        $me = $cimProcs | Where-Object { $_.ProcessId -eq $cursor } | Select-Object -First 1
        if (-not $me -or -not $me.ParentProcessId) { break }
        $cursor = [int]$me.ParentProcessId
        if ($cursor -le 0 -or $selfPids -contains $cursor) { break }
        [void]$selfPids.Add($cursor)
    }
}

# ── 收集目标进程 ────────────────────────────────────────────────────────────
$targets = New-Object System.Collections.ArrayList   # @{ Pid; Name; Why }
function Add-Target([int]$ProcessId, [string]$Why) {
    if ($ProcessId -le 0) { return }
    foreach ($t in $targets) { if ($t.Pid -eq $ProcessId) { return } }
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return }
    [void]$targets.Add([pscustomobject]@{ Pid = $ProcessId; Name = $proc.ProcessName; Why = $Why })
}

# ① 端口占用者
foreach ($pt in $PortTargets) {
    $owner = Get-PortOwnerPid $pt.Port
    if ($owner -gt 0) { Add-Target $owner ("{0}（占着 {1}）" -f $pt.Label, $pt.Port) }
}

# ② 命令行签名（外层包装窗口 / 守护）
if ($cimOk) {
    foreach ($sig in $CmdLineSignatures) {
        foreach ($p in ($cimProcs | Where-Object { $_.CommandLine -and $_.CommandLine -like $sig.Like })) {
            Add-Target ([int]$p.ProcessId) $sig.Label
        }
    }
}

# ── 收集目标窗口 ────────────────────────────────────────────────────────────
# 两路并用：① 标题匹配 ② **启动器记录的窗口句柄**（.launcher-state.json）。
# 为什么必须有 ②：`dsh web` 跑起来后那个窗口的标题会变回 cmd 的默认值
# `C:\Windows\system32\cmd.exe`（SnowLuma 旧形态的外层窗口也是）→ 按标题根本认不出来，
# 于是"关完还剩一个空窗口"。句柄是启动器在收尾时拍下来的，比标题可靠得多。
$allWins = Get-VisibleWindows
$winHits = New-Object System.Collections.ArrayList
foreach ($w in $allWins) {
    if (-not $w.Title) { continue }
    foreach ($tp in $TitlePatterns) {
        if ($w.Title -like $tp.Like) {
            [void]$winHits.Add([pscustomobject]@{ Hwnd = $w.Hwnd; Title = $w.Title; Label = $tp.Label })
            break
        }
    }
}

$statePath = Join-Path $Root '.launcher-state.json'
if (Test-Path $statePath) {
    try {
        $st = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $added = 0
        foreach ($rec in @($st.windows)) {
            $h = [IntPtr]([Int64]$rec.hwnd)
            $live = $allWins | Where-Object { $_.Hwnd -eq $h } | Select-Object -First 1
            if (-not $live) { continue }
            $already = $false
            foreach ($x in $winHits) { if ($x.Hwnd -eq $h) { $already = $true; break } }
            if ($already) { continue }
            # 句柄会被系统回收复用：只有"还是控制台类进程的窗口"且"标题没变成别人的"才认
            $okOwner = $ConsoleOwnerNames -contains $live.Owner
            $okTitle = ($live.Title -eq [string]$rec.title) -or ($live.Title -like '*cmd.exe*') -or (-not $live.Title)
            # ★ -OnlySnowLuma（2026-09-24 实测补的漏）：这份记录是**上一轮启动**拍的，里面有
            #   DSH-Web、qq-bridge 那些**不属于本次动作**的窗口；不过滤的话"只停 QQ 网关"会顺手
            #   把 qq-bridge 窗口也 WM_CLOSE 掉（干跑实测：真发生）。这里只认**标题明显是 SnowLuma**
            #   的记录 —— 认不出来的一律跳过（宁少勿错；无窗口形态本来就不靠窗口认人，靠端口）。
            if ($OnlySnowLuma -and ($live.Title -notlike '*SnowLuma*')) { continue }
            # -KeepSnowLuma 时更要小心：记录里**认不出来的**（空标题）那个也可能正是 SnowLuma 的窗口
            # —— QQ 网关绝不能误关（关了 WebUI 要重新登录、QQ 还要重连），所以这两种一律跳过。
            # 代价：万一 DSH 窗口的标题也是空的，这次它不会被关，多留一个窗口（无害，主人点掉即可）。
            if ($KeepSnowLuma -and ((-not $live.Title) -or ($live.Title -like '*SnowLuma*'))) { continue }
            if ($okOwner -and $okTitle) {
                [void]$winHits.Add([pscustomobject]@{ Hwnd = $h; Title = $live.Title; Label = '启动器记录的窗口（标题可能被程序改过）' })
                $added++
            }
        }
        Write-Host ("  启动器记录：读入 {0} 条，补上 {1} 个标题认不出来的窗口" -f @($st.windows).Count, $added)
    } catch {
        Write-Host ("  [提示] 读 .launcher-state.json 失败（跳过，只用标题认窗口）：{0}" -f $_.Exception.Message)
    }
} else {
    Write-Host '  [提示] 没有 .launcher-state.json（这次实例不是启动器起的）—— 只用标题认窗口。'
}

# ── 自保过滤 ────────────────────────────────────────────────────────────────
foreach ($keep in $selfPids) {
    for ($i = $targets.Count - 1; $i -ge 0; $i--) {
        if ($targets[$i].Pid -eq $keep) {
            Write-Host ("  跳过 {0}（pid {1}）：它是本脚本自己或它的父进程" -f $targets[$i].Name, $targets[$i].Pid)
            $targets.RemoveAt($i)
        }
    }
}

# 窗口也要自保（2026-09-23 加，因为"启动前先清场"成了常规路径）：
# .launcher-state.json 里记的句柄是**上一轮**的，句柄会被系统回收复用 —— 万一某个旧句柄
# 现在落到"启动器自己这个窗口"上（它正是本脚本的父进程的窗口），按记录关掉它就等于
# 启动到一半把自己掐死。所以凡是属于自己/祖先进程的窗口，一律跳过。
$selfHwnds = @()
foreach ($w in $allWins) { if ($selfPids -contains $w.Pid) { $selfHwnds += $w.Hwnd } }
for ($i = $winHits.Count - 1; $i -ge 0; $i--) {
    if ($selfHwnds -contains $winHits[$i].Hwnd) {
        Write-Host ("  跳过窗口 [{0}] {1}：它属于本脚本自己或它的父进程" -f $winHits[$i].Label, $winHits[$i].Title)
        $winHits.RemoveAt($i)
    }
}

# 再来一道（2026-09-23 探针实测后补的）：**Windows Terminal 托管的控制台窗口不属于 cmd 进程**
# （owner = `WindowsTerminal.exe`，见 docs\启动与踩坑.md），所以上面按 pid 的窗口自保对它无效 ——
# 实测：一个标题为 DSH-Web、由 cmd 祖先拉起的窗口照样被列进"要关的窗口"。但那种窗口的
# **标题就是本进程所在控制台的标题**（WT 把控制台标题显示在窗口/标签上），所以再按标题认一次自己。
# 这一条专治"启动前先清场"路上的致命误判：启动器自己那个窗口被当成本轮的 DSH-Web 关掉
# = 启动到一半，什么都没起来。
$ownTitle = ''
try { $ownTitle = [string]$Host.UI.RawUI.WindowTitle } catch { $ownTitle = '' }
if (-not $ownTitle) { try { $ownTitle = [string][Console]::Title } catch { $ownTitle = '' } }
$ownTitle = ([string]$ownTitle).Trim()
if ($ownTitle.Length -ge 6) {
    for ($i = $winHits.Count - 1; $i -ge 0; $i--) {
        $t = ([string]$winHits[$i].Title).Trim()
        if ($t -and ($t -eq $ownTitle -or $t.StartsWith($ownTitle))) {
            Write-Host ("  跳过窗口 [{0}] {1}：它就是本脚本自己所在的控制台窗口" -f $winHits[$i].Label, $t)
            $winHits.RemoveAt($i)
        }
    }
}

Write-Host ''
Write-Host ('要关的进程 {0} 个：' -f $targets.Count)
foreach ($t in ($targets | Sort-Object { if ($_.Name -eq 'cmd') { 0 } else { 1 } })) {
    Write-Host ("  - {0} (pid {1})：{2}" -f $t.Name, $t.Pid, $t.Why)
}
if ($targets.Count -eq 0) { Write-Host '  （没有正在跑的进程）' }
Write-Host ('要关的窗口 {0} 个：' -f $winHits.Count)
foreach ($w in $winHits) { Write-Host ("  - [{0}] {1}" -f $w.Label, $w.Title) }
if ($winHits.Count -eq 0) { Write-Host '  （没认出窗口 —— 可能本来就没开控制台窗口，见最后体检）' }

if ($DryRun) {
    Write-Host ''
    Write-Host '（-DryRun：到此为止，什么都没动。真关就去掉 -DryRun。）'
    exit 0
}

# ── 停机前给主人 QQ 一条（★ 2026-09-25 主人：「以后 QQ 提示我」）────────────────────
# 为什么放在"动手"之前、且走 OneBot HTTP 直连（tools\qq-notify.mjs）：清场会把桥接一起关掉，
#   走桥接等于把通知交给一个正在关门的进程；而 SnowLuma 在本脚本里默认**留着不动**
#   （启动器的清场带 -KeepSnowLuma），所以它此刻还站着。
# 只在**整机停机**那一支发：-DryRun 不发（干跑不许有副作用）、-OnlySnowLuma / -OnlyControl 不发
#   （那是"只重起一件"，不是停机）。失败不重试、只记一行，绝不影响停机本身。
if (-not $DryRun -and -not $OnlySnowLuma -and -not $OnlyControl -and -not $OnlyDsh) {
    try {
        Write-Host '[QQ] 停机前给主人一条提示（发不出去也不影响停机；同一轮重复停机由 --dedupe 压成一条）'
        # ★ 2026-09-25 加去重：主人那晚为了救系统连着双击启动器，每次清场都发一条 ⇒ 他收到 4 条一样的。
        #   去重键与窗口由 qq-notify.mjs 落 `state\_tmp\.notify-stop-notice`（只在真发成功时落）。
        & node (Join-Path $PSScriptRoot 'qq-notify.mjs') '【自动提示】现在要停机了（整套停一下，可能一两分钟）。这段时间里你发的话我可能收不到 —— 起来后我会再跟你说一声。' '--tag' 'shutdown' '--dedupe' 'stop-notice' '--window-min' '10' 2>&1 | Out-String | ForEach-Object { Write-Host ('  ' + $_.Trim()) }
    } catch { Write-Host "  [提示] QQ 提示发不出去（不影响停机）：$($_.Exception.Message)" }
}

# ── 动手 ────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '[1/5] 关窗口（等于逐个点 X，会连带结束窗口里的进程）'
foreach ($w in $winHits) {
    [void][StopAll.Win]::SendMessage($w.Hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
    Write-Host ("  已请求关闭：{0}" -f $w.Title)
}
if ($winHits.Count -gt 0) {
    # ★ 2026-09-24 深夜、2026-09-25 微调（主人："程序正在等待运行的时候加个…用来提醒用户程序正在运行"）：
    #   原来是死等 `Start-Sleep -Seconds 2`。现在改成**盯进程**：窗口收到 WM_CLOSE 之后里面的
    #   进程通常几百毫秒就退了 ⇒ 退干净就立刻往下走（实测比死等 2 秒快），最多等 3 秒；
    #   还没退的交给下一步强收，并且**如实说**"还有 N 个没退"（不装成功）。
    #   点号节奏 = **每 1 秒一个**（250ms × 4）：密到能看出在动，又不至于刷屏。
    Write-Host '  等它们真的退出（退干净就立刻继续，最多 3 秒）' -NoNewline
    $winDeadline = (Get-Date).AddSeconds(4)
    $winTicks = 0
    while ((Get-Date) -lt $winDeadline) {
        $still = @($targets | Where-Object { Get-Process -Id $_.Pid -ErrorAction SilentlyContinue })
        if ($still.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
        $winTicks++
        if ($winTicks % 4 -eq 0) { Write-Host '.' -NoNewline }
    }
    $still = @($targets | Where-Object { Get-Process -Id $_.Pid -ErrorAction SilentlyContinue })
    if ($still.Count -eq 0) { Write-Host ' 窗口和进程都退干净了' }
    else { Write-Host (' 还有 {0} 个没退，下一步强收' -f $still.Count) }
}

Write-Host '[2/5] 结束剩余进程（含子进程）'
foreach ($t in ($targets | Sort-Object { if ($_.Name -eq 'cmd') { 0 } else { 1 } })) {
    if (-not (Get-Process -Id $t.Pid -ErrorAction SilentlyContinue)) {
        Write-Host ("  已随窗口一起退出：{0} (pid {1})" -f $t.Name, $t.Pid)
        continue
    }
    & taskkill.exe /PID $t.Pid /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Process -Id $t.Pid -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $t.Pid -ErrorAction SilentlyContinue) {
        Write-Host ("  [警告] 没能结束 {0} (pid {1})，可能需要管理员权限" -f $t.Name, $t.Pid)
    } else {
        Write-Host ("  已结束：{0} (pid {1})" -f $t.Name, $t.Pid)
    }
}

Write-Host '[3/5] 等端口释放'
# ★ 2026-09-24 深夜 + 2026-09-25：这一段原来是**全程静默**的（每个端口最多等 10 秒，三四个端口
#   就是几十秒屏幕一动不动 —— 主人那句"以为开掉了"说的就是这类段落）。
#   现在每个在听的端口都走 `Wait-PortWithProgress -Want Closed`：**等 + 逐秒打点 + 收口**一份实现
#   （tools\progress.ps1）；本来就没在听的就直接说一句，不浪费一个字。
$left = @()
foreach ($pt in $PortTargets) {
    if (-not (Test-Port $pt.Port)) { Write-Host ("  {0} :{1} 本来就没在听" -f $pt.Label, $pt.Port); continue }
    $freed = Wait-PortWithProgress -Port $pt.Port -TimeoutSec 10 -Want Closed -What ("{0} :{1} 释放" -f $pt.Label, $pt.Port)
    if (-not $freed) {
        $owner = Get-PortOwnerPid $pt.Port
        Write-Host ("  [警告] {0} :{1} 还在监听（pid {2}）" -f $pt.Label, $pt.Port, $owner)
        $left += $pt.Port
    }
}

Write-Host '[4/5] 关浏览器面板窗口'
if ($KeepPanels) {
    Write-Host '  -KeepPanels：留着面板窗口不动。'
} elseif ($OnlySnowLuma) {
    # 只停 QQ 网关时别去动浏览器：DSH / 控制台那两页与这次动作无关
    # （SnowLuma 页会在重起后由 panels.ps1 -ForcePage snowluma 重载，把新令牌写进浏览器）。
    Write-Host '  -OnlySnowLuma：面板窗口不动（DSH / 控制台两页与这次动作无关）。'
} elseif ($OnlyControl) {
    # 只停控制面时更不能动浏览器：面板页面本身就要靠控制面才有数据，关掉它反而更糟
    # （页面会在控制面回来之后自己恢复轮询）。
    Write-Host '  -OnlyControl：面板窗口不动（页面会在控制面起来后自己恢复）。'
} else {
    $panelsScript = Join-Path $Root 'tools\panels.ps1'
    if (Test-Path $panelsScript) {
        # 子进程跑：panels.ps1 用 exit 收尾，进程内直调会把本脚本一起退掉。
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $panelsScript close
    } else {
        Write-Host '  [提示] 找不到 tools\panels.ps1，面板窗口请手动关。'
    }
}

Write-Host '[5/5] 体检：还有哪些控制台窗口没关'
$rest = @()
foreach ($w in (Get-VisibleWindows)) {
    if (-not $w.Title) { continue }
    if ($ConsoleOwnerNames -notcontains $w.Owner) { continue }
    $already = $false
    foreach ($h in $winHits) { if ($h.Hwnd -eq $w.Hwnd) { $already = $true; break } }
    if ($already) { continue }
    $rest += $w
}
if ($rest.Count -eq 0) {
    Write-Host '  干净：没有剩下的控制台窗口 ✅'
} else {
    Write-Host '  这些窗口我没动（多半是你自己开的，或者是没认出来的）：'
    foreach ($w in $rest) { Write-Host ("    - [{0}] {1}" -f $w.Owner, $w.Title) }
    Write-Host '  如果其中某个其实是我们的（关完还留着），把标题发我，我加进识别规则。'
}

# ── 记录用一次就作废 ────────────────────────────────────────────────────────
# .launcher-state.json 里是**这一轮**实例的窗口句柄，关掉之后全失效；留着只会在下一轮被
# 系统回收、复用到别的窗口上。2026-09-23 起"启动前先清场"成了常规路径（start-all.ps1 的
# 第一件事就是调本脚本），这份记录必须消费掉：否则某天某个旧句柄落到**启动器自己那个
# 窗口**上，清场就会把启动器掐死（启动到一半，什么都没起来）。下一轮启动会重新记。
# ★ 例外：-OnlySnowLuma / -OnlyControl 时**不能删** —— DSH 那半还活着，它窗口的句柄仍然有效，
#   删了就等于让"关闭全部"丢掉 DSH-Web 的句柄（下次只靠标题认窗口，历史坑）。
if ($OnlySnowLuma -or $OnlyControl) {
    if (Test-Path $statePath) { Write-Host '保留 .launcher-state.json（DSH 还在跑，它窗口的句柄仍然有效）' }
} elseif (Test-Path $statePath) {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Write-Host '已作废 .launcher-state.json（下一轮启动会重新记录）'
}

Write-Host ''
if ($OnlyDsh) {
    if ($left.Count -eq 0) {
        Write-Host 'DSH 已停 ✅（qq-bridge / SnowLuma / 控制面全程没动）'
        Write-Host '   重起它：tools\dsh-only.ps1（面板那条"重起 DSH"就是 停它 → 再拉 dsh-only 一次）'
        exit 0
    } else {
        Write-Host ("DSH 还有端口没释放：{0} —— 重跑一次本脚本，或用管理员权限跑。" -f ($left -join ', '))
        exit 1
    }
}
if ($OnlyControl) {
    if ($left.Count -eq 0) {
        Write-Host '控制面已停 ✅（DSH / qq-bridge / SnowLuma 全程没动）'
        Write-Host '⚠ 页面总控面板这十几秒没有数据（载波就是它）—— 它回来后页面会自己恢复轮询。'
        Write-Host '   重起它：control.ps1 restart control（= 本脚本 -OnlyControl + start-all.ps1 -NoRestart -NoOpen）'
        exit 0
    } else {
        Write-Host ("控制面还有端口没释放：{0} —— 重跑一次本脚本，或用管理员权限跑。" -f ($left -join ', '))
        exit 1
    }
}
if ($OnlySnowLuma) {
    if ($left.Count -eq 0) {
        Write-Host 'SnowLuma 已停 ✅（DSH 与 qq-bridge 全程没动）'
        Write-Host '⚠ 它的 WebUI 登录令牌**只在内存里** —— 重起之后管理页那个标签会失效，要重新登录：'
        Write-Host '   DSH-Web 窗口按 s（或跑 control.ps1 login qq）；重起本身：control.ps1 restart snowluma'
        exit 0
    } else {
        Write-Host ("SnowLuma 还有端口没释放：{0} —— 重跑一次本脚本，或用管理员权限跑。" -f ($left -join ', '))
        exit 1
    }
}
if ($left.Count -eq 0) {
    Write-Host '全部已关闭 ✅（重新启动：双击旁边的启动器 .cmd）'
    exit 0
} else {
    Write-Host ("还有端口没释放：{0} —— 重跑一次本脚本，或用管理员权限跑。" -f ($left -join ', '))
    exit 1
}
