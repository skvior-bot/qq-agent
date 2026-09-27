<#
  只开 DSH —— QQ 搬到服务器之后，本机只需要 DSH Web 时用这个。

  用法（工作区根目录下跑；脚本按 $PSScriptRoot 定位自己，所以从别处跑也行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\dsh-only.ps1
  ★ 根目录原来那个双击入口「只开DSH.cmd」调的就是本脚本，**2026-09-27 按主人要求撤除**
    （原话「那个只启动dsh可以不要了 bug太多了 我以后就自己用cmd启动了」）⇒ 现在只剩命令行这一条路。
  ★ 撤除时一并修了一处漏判：原来"DSH 刚起来"那一支开页时没带 -Direct（见文件末尾），
    仍会被 panels.ps1 判成"页面已经有了"⇒ 什么都不开。现在两支同口径。
  ★★ 同日第二刀（**更要紧**）：`-Direct` 那一支原来**直接开裸地址** —— 而 DSH Web **拒绝裸地址**
    （浏览器只显示 `dsh web authentication required. reopen the URL printed by dsh web`）
    ⇒ 主人报的「页面打不开」有一半是这个（2026-09-27 截图实证）。
    现在 `Open-DshPage` **必须带令牌**才开页；令牌从**那只 DSH 自己打印在启动日志里的地址**取，
    口径与打码方式见下面的 `Get-DshUrlWithToken`。

  为什么单独一个入口：一键启动.cmd 会把 SnowLuma 与 qq-bridge 一起起出来，而同一个 QQ 号
  只能一处在线 ⇒ 本机起了会**抢号**（主人 2026-09-26 的处境：QQ 岗已经在服务器上）。

  这个入口 = 「一键启动里"起 DSH 窗口"那一段」+ 「把'QQ 那套不在本机'告诉窗口」：
    · 起窗口那一套（守窗器 / 自动修 / r 重起 DSH / e 关闭）—— 与一键启动**同一条路**；
    · 给窗口挂 DSH_WINDOW_NO_SERVICES=1 ⇒ 窗口**不补缺**（补缺那条会把 SnowLuma 与桥接起出来 ✗）、
      不报「⚠ QQ 未登录」、也不因为"桥接那几盏灯不绿"而报警（只认 DSH 那盏灯）；
    · 起来后只开 DSH 那一页（-NoOpen 可关掉）。
  不动的：**绝不**调 start-all.ps1 / stop-all.ps1（那是三件套的入口）。

  干跑（什么都不起，只印会干什么）：powershell -File tools\dsh-only.ps1 -DryRun [-Port 3999]
    （-Port 只在干跑/排查时用：假装 DSH 的端口是这个 ⇒ 能看"真的会起哪条命令"，默认取生效端口）
#>
param(
    [switch]$DryRun,
    [switch]$NoOpen,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
$DshPort = $Ports.dshWeb
if ($Port -gt 0) { $DshPort = $Port }

function Test-PortOpen([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(300)
        if ($ok -and $c.Connected) { $c.Close(); return $true }
        $c.Close(); return $false
    } catch { return $false }
}
# ── 取"带令牌的 DSH 地址" ───────────────────────────────────────────────────
#   ★ 为什么必须带令牌（2026-09-27 截图实证）：DSH Web **拒绝裸地址** —— 浏览器只显示
#     `dsh web authentication required. reopen the URL printed by dsh web.`
#     ★ 判据口径与 `panels.ps1:1023-1028` 那条**是同一条**："抓到一个 http 串"不算数，
#       **必须里面真有 `token=`** —— 否则就是"静默开出一张没带令牌的登录页，谁都不知道"。
#   来源优先级（越靠前越权威）：
#     ① 本次启动的那份日志（= DSH 自己打印的 `dsh web: http://127.0.0.1:<port>/?token=…`）
#     ② 最近一份启动日志（DSH 已在跑时，说不出"本次"是哪份）
#     ③ `qq-bridge\config.json` 的 `dsh.authToken`（**口径同 panels.ps1 的 Get-DshToken**）
#        ⚠ 这条路只在 `start-all` 同步过之后才准；"只开 DSH"模式**故意不跑 start-all**
#          ⇒ 它常常是**上一代**的令牌（自检里那句「令牌不同步（预期）」指的就是它）⇒ 只当退路。
function Get-LatestDshLog {
    $dir = Join-Path $env:USERPROFILE '.dsh\guard\logs'
    if (-not (Test-Path $dir)) { return '' }
    $f = Get-ChildItem (Join-Path $dir 'server-*.out.log') -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) { return $f.FullName }
    return ''
}
function Get-DshUrlFromLog {
    param([string]$LogPath)
    foreach ($p in @($LogPath, (Get-LatestDshLog))) {
        if (-not $p -or -not (Test-Path $p)) { continue }
        try {
            $m = [regex]::Match((Get-Content -LiteralPath $p -Raw -ErrorAction Stop),
                                'https?://127\.0\.0\.1:\d+/[^\s"'']*[?&]token=[^\s"'']+')
            if ($m.Success) { return $m.Value }
        } catch { }
    }
    return ''
}
function Get-DshUrlFromConfig {
    try {
        $cfgPath = Join-Path $Root 'qq-bridge\config.json'
        if (Test-Path $cfgPath) {
            $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $t = ([string]$cfg.dsh.authToken).Trim()
            if ($t) { return ('http://127.0.0.1:' + $DshPort + '/?token=' + [uri]::EscapeDataString($t)) }
        }
    } catch { }
    return ''
}

function Open-DshPage {
    param([switch]$Direct, [switch]$Wait)
    #   -Direct（2026-09-27 微批 9）：**不经过 panels.ps1 的去重 / 状态判定**，直接把地址交给系统开。
    #   为什么要这一支：panels.ps1 会按自己的页面状态判断"要不要开"，判成"已经有了"时**什么都不开、也不报**
    #   ⇒ 主人启动后窗口一闪、页面没出来（他报的「不会开网站」就是这个形状）。
    #   主动跑这个入口＝意图明确 ⇒ 这一支必须真的把页面打开（多一个标签页，比"看不到页面"好得多）。
    #   -Wait：**"DSH 刚起完"那一支**才传（见下）；"已在跑"那一支不传 —— 那时不该再等。
    if (-not $Direct) {
        $panels = Join-Path $PSScriptRoot 'panels.ps1'
        if (Test-Path $panels) {
            try {
                Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
                    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $panels, 'open', '-DshOnly') | Out-Null
                return
            } catch { }
        }
    }
    # ★★ 2026-09-27 修：这一支原来**直接开裸地址** ⇒ DSH 回一张 authentication required 页
    #    （主人报的「页面打不开」就是这个）—— 现在**必须带令牌**才开。
    #    `$log` 是本次启动的日志（"DSH 已在跑"那一支还没定义它 ⇒ 传 $null，函数自己去找最新那份）。
    $u = Get-DshUrlFromLog -LogPath $log
    $src = '启动日志'
    if (-not $u -and $Wait) {
        # ★★★ 2026-09-27 第三刀（主人第二次截图实证）：**"端口在听" ≠ "DSH 把那行带令牌的地址写进日志了"**
        #   —— 两者之间有窗口期。原来这里抓不到就**立刻**退到 `config.json`，而那一刻它常常还是**上一代**的
        #   令牌（守窗器同步要慢一拍）⇒ 照样开出一张 authentication required 页
        #   （实测：开出去那个页面的令牌指纹与"日志里的""config 里的"**两份都不同**，正是这个窗口期）。
        #   ⇒ 现在**先等**：最多 20 秒、1 秒一探，等 DSH 自己把那行地址打出来。
        for ($i = 1; $i -le 20; $i++) {
            Start-Sleep -Seconds 1
            $u = Get-DshUrlFromLog -LogPath $log
            if ($u) { break }
        }
    }
    if (-not $u) {
        $u = Get-DshUrlFromConfig
        if ($u) { $src = 'config.json（★ 可能已过期）' }
    }
    if ($u) {
        # 令牌是凭据（红线 3）：打印时打码，与 panels.ps1 同口径。
        Write-Host ('  → 打开（带令牌 · 来源：' + $src + '）：' + ($u -replace '([?&])token=[^&]*', '$1token=***'))
        try { Start-Process $u | Out-Null; return } catch { }
    }
    Write-Host '  ⚠ 没拿到带令牌的地址 ⇒ 本次只能开**裸地址**，DSH 会回一张 authentication required 页。'
    Write-Host '     （启动日志里没有 DSH 打印的那行 URL，config.json 里也没有可用令牌）'
    Write-Host '     多半是因为**当前这只 DSH 不是本脚本起的** —— 手敲 dsh web 不写启动日志，'
    Write-Host '     所以既拿不到它的令牌（工具会 401），也开不出能用的页面。'
    Write-Host '     修法：关掉它，再用本脚本起一次。'
    try { Start-Process ('http://127.0.0.1:' + $DshPort) | Out-Null }
    catch { Write-Host ('  ⚠ 页面没打开（' + $_.Exception.Message + '）—— 请手动打开 http://127.0.0.1:' + $DshPort) }
}

Write-Host ''
Write-Host '  只开 DSH Web（QQ 那套不动：SnowLuma 与 qq-bridge 一律不起）'
Write-Host '  ────────────────────────────────────────────────────────'
Write-Host ('  · 窗口：DSH-Web —— 键位照旧：r = 重起 DSH，e = 关闭')
Write-Host ('  · 页面：http://127.0.0.1:' + $DshPort)
Write-Host '  · 本机不登 QQ（QQ 在服务器上跑；它掉线会推你手机，Server酱）'
Write-Host '  · 要三件套齐全（QQ 在本机）请用 一键启动.cmd —— 别用这个'
Write-Host ''

if (Test-PortOpen $DshPort) {
    Write-Host ('  DSH 已经在跑（:' + $DshPort + ' 在听）—— 不重复起（起第二个会抢端口）。')
    # ★ 这一支的判据（2026-09-27 微批 9，主人亲报「只启动dsh还是有问题 不会开网站」后定）：
    #   · 双击 / 正常调用 ⇒ **真的把页面打开**（`-Direct`：不走 panels.ps1 的去重判定）。
    #     理由：**主人主动双击＝意图明确**，此时开浏览器正是他要的；红线 6 管的是"**未经请求**地抢焦点"，不是这个。
    #   · `-DryRun` ⇒ 一个窗口都不开（干跑只印）。
    #   · `-NoOpen` ⇒ 只印，不开（保住这个开关的原意）。
    #   历史（小镜 2026-09-26 量到的既有口子，已修）：这条快路径原来排在 -DryRun 检查之前 ⇒ DSH 已在听时
    #   干跑也会走到开页那一行，真开一个浏览器窗口。
    if ($DryRun) {
        Write-Host '  [干跑] 到此为止：不会开页、也不会起第二个 DSH。'
        exit 0
    }
    if ($NoOpen) {
        Write-Host '  -NoOpen：只打印，不开页面。'
        exit 0
    }
    Write-Host '  正在打开页面…'
    Open-DshPage -Direct
    exit 0
}

# node + dsh 的 bin.js：与一键启动同一套判据（优先 node + 包里的 lib\bin.js，找不到才退回 dsh 壳）
$dshNode = ''
$dshBin  = ''
$shim = (Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue).Source
$nodeExe = (Get-Command 'node.exe' -ErrorAction SilentlyContinue).Source
if ($shim -and $nodeExe) {
    $cand = Join-Path (Split-Path $shim) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $cand) { $dshNode = $nodeExe; $dshBin = $cand }
}
$windowCmd  = Join-Path $PSScriptRoot 'dsh-window.cmd'
$stopAllPs1 = Join-Path $PSScriptRoot 'stop-all.ps1'

$logsDir = Join-Path $env:USERPROFILE '.dsh\guard\logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
$log = Join-Path $logsDir ('server-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.out.log')

if ((Test-Path $windowCmd) -and (Test-Path $stopAllPs1) -and $dshNode) {
    $stopAllMacro = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$stopAllPs1`""
    $doskey = "doskey exit=$stopAllMacro & doskey e=$stopAllMacro"
    $cmdLine = '/k', "title DSH-Web & chcp 65001 >nul & $doskey & call `"$windowCmd`" `"$dshNode`" `"$dshBin`" `"$log`""
} else {
    Write-Host '  ⚠ 起不来：找不到 node.exe / dsh 的 lib\bin.js，或 tools\dsh-window.cmd / stop-all.ps1 不在。'
    Write-Host '     （判据与一键启动完全一样 —— 先把那个修好，再来用这个入口。）'
    exit 1
}

if ($DryRun) {
    Write-Host '  [干跑] 会执行这一条（**真跑时会先把 DSH_WINDOW_NO_SERVICES=1 挂上**）：'
    Write-Host ('         cmd.exe ' + $cmdLine[0] + ' "' + $cmdLine[1] + '"')
    Write-Host ('         日志：' + $log)
    Write-Host '  [干跑] 不会调 start-all.ps1 / stop-all.ps1；不会碰 SnowLuma 与 qq-bridge。'
    exit 0
}

# ★ 关键：给窗口那一套挂上"QQ 那套不在本机"（子进程继承环境变量）
$env:DSH_WINDOW_NO_SERVICES = '1'
Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine

$ok = $false
# 2026-09-26 主人亲报（协调线实测定位）：等待上限原来只有 45 秒，而 DSH 冷启动实测已到 58 秒
# ⇒ 等不到就静默跳过开页，主人以为失败、改用 cmd 手动起 ⇒ 那只不写 guard 日志 ⇒ 日志里没有它的
#   token ⇒ sessions.mjs / notify-session.mjs / 控制面**全部 401**（投递通道整条断掉）。
# ⇒ 上限抬到 180 秒，并在等待期间每 5 秒说一句话（原来是一片安静，体感就是"卡住了"）。
$waitSec = 180
for ($i = 1; $i -le $waitSec; $i++) {
    Start-Sleep -Seconds 1
    if (Test-PortOpen $DshPort) { $ok = $true; break }
    if ($i % 5 -eq 0) { Write-Host ('  … 还在等 DSH 起来（已 ' + $i + ' 秒 / 最多 ' + $waitSec + ' 秒）') }
}
if ($ok) {
    Write-Host ('  ✓ DSH 起来了（:' + $DshPort + ' 在听，等了约 ' + $i + ' 秒）')
    # ★ 2026-09-27（撤除 `只开DSH.cmd` 时一并修）：这一支原来**不带 `-Direct`** ⇒ 刚起来这次仍走
    #   `panels.ps1` 的去重判定，判成"页面已经有了"就**什么都不开、也不报** —— 正是主人报的
    #   「页面不打开」。微批 9 只修了上面"已在跑"那一支（见前面的 `Open-DshPage -Direct`），这条漏了。
    #   主动跑本脚本＝意图明确 ⇒ 与那一支同口径：直接开。
    if (-not $NoOpen) { Open-DshPage -Direct -Wait }
} else {
    Write-Host ('  ⚠ ' + $waitSec + ' 秒内没等到 :' + $DshPort + ' —— 它**可能还在起**：')
    Write-Host ('     先等十几秒，再打开 http://127.0.0.1:' + $DshPort + '（或到 DSH-Web 窗口里输 r 重起）')
    Write-Host '     日志（里面 dsh web 那行的 URL 带 token，可直接点）：'
    Write-Host ('     ' + $log)
    Write-Host '     ⚠ 别改用 cmd 手动起 DSH：那样不会写这份日志，日志里就没有它的 token，'
    Write-Host '       后面所有工具（sessions.mjs / notify-session.mjs / 控制面）都会 401。'
    # 2026-09-26（小镜指出的条件）：这里原来 exit 0 ⇒ 上面那段救命文案会被调用方的 pause 吞掉。
    # ★ 2026-09-27：入口 `只开DSH.cmd` 撤除后，"pause 那一层"没有了 ⇒ 这段文案在终端里**只出现一次**、
    #   往上滚就没了，所以更要紧（尤其「别改用 cmd 手动起」那两句：手动起不写这份日志 ⇒ 全套工具 401）。
    #   退出码保持非 0：失败就该是失败，控制面板 / 计划任务这类调用方能判。
    exit 1
}
