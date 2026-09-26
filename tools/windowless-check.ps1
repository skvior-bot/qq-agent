# =============================================================================
#  windowless-check.ps1 —— 「真的没有窗口吗」的可重复检查（2026-09-24 深夜新增）
#
#  为什么要有它：主人 2026-09-24 报"SnowLuma 的窗口没被藏住，还多出三个标签页"，
#  而启动器同一行还写着"不创建窗口" —— **说的和做的不一致**是这个项目最忌讳的。
#  光靠"看代码觉得对"不算数：`Start-Process -WindowStyle Hidden` 看着也对，
#  实测它创建的是一个**隐藏的 conhost 窗口对象**（`ConsoleWindowClass`，EnumWindows 查得到）；
#  而 `CREATE_NO_WINDOW` 才是"连窗口对象都没有"。这条检查就是把这件事钉成可复跑的命令。
#
#  一条命令复跑（**不需要**跑启动器、不碰任何在跑的服务）：
#      powershell -NoProfile -ExecutionPolicy Bypass -File tools\windowless-check.ps1
#    · 退出码 0 = 全过；1 = 有失败（可挂 CI / 手工回归）
#    · `-Census`  只打印窗口普查（只读，一个进程都不起）
#    · `-Keep`    检查完**不杀**睡觉进程（排障用；平时别加，会留垃圾）
#
#  三条检查（**没有一条是恒真的** —— 每一条都能真的红）：
#    [1] 检测器灵敏度（反例）：用**老起法**（`Start-Process -WindowStyle Hidden`）起一个睡觉进程，
#        本地枚举器必须看到它带来的**新增窗口对象**（隐藏的也算）。看不到 ⇒ 说明是"枚举器瞎了"，
#        那么 [2] 的"0 新增"就毫无意义 ⇒ 直接判失败（防"把检查改成永不报警"）。
#    [2] 真无窗口（正例）：用 `tools\windowless.ps1` 的 `Start-WindowlessProcess` 起同一个睡觉进程，
#        必须**新增 0 个窗口对象**（可见的、隐藏的都不许有），且它的 `MainWindowHandle` = 0。
#        顺手验证"无窗口没把功能弄坏"：cmd 级重定向出的日志文件里有正确的中文（chcp 65001 生效）。
#    [3] 不攥调用者的管道 + 调用者退出后子进程照活：让一个**子 PowerShell** 用它起睡觉进程，
#        外层用管道读它的输出 —— 必须**很快返回**（若子进程继承了调用者的 stdout 管道，
#        外层要等到睡觉进程结束才拿到 EOF，就是 `control.ps1 up | Out-Host` 卡死那个坑）；
#        并且外层返回后睡觉进程**仍然活着**（桥接守护必须这样）。
#
#  ★ 收尾规矩：只按**自己手里的 pid** 杀（`Stop-Process -Id`），绝不按名字扫荡 ——
#    "按名字扫"正是守窗器被否掉的那条路，也真会误伤主人正在用的东西。
#  ★ 本文件必须 UTF-8 **带 BOM**（PS 5.1 否则按 ANSI 解码，中文注释直接炸）。
# =============================================================================
[CmdletBinding()]
param(
    [switch]$Census,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$SleepLine = '/c "ping -n 21 127.0.0.1 >nul"'   # ~20 秒的睡觉进程（不看 stdin，无窗口下也照跑）

# ── 本地窗口枚举器（EnumWindows + IsWindowVisible + 类名/标题/owner）──────────────
# 为什么不用 `Get-Process | Where MainWindowHandle -ne 0`：它**看不到**隐藏窗口、也看不到
# 由 WT/conhost 托管的窗口（owner 不是那个进程）。要断言"连隐藏窗口都没有"，只能自己枚举。
if (-not ('WlcWin' -as [type])) {
    Add-Type -Namespace Wlc -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
}

# 控制台系进程名：窗口 owner 落在这里面才算"我们这类东西弄出来的窗口"。
# （不框定范围的话，桌面图标/商店/输入法随时冒出来的窗口会让检查假红 —— 实测踩过。）
$script:ConsoleishOwners = @('cmd', 'node', 'conhost', 'WindowsTerminal', 'OpenConsole', 'powershell', 'pwsh')

function Get-WindowCensus {
    $rows = New-Object System.Collections.ArrayList
    $cb = [Wlc.Win+EnumProc] {
        param($h, $l)
        $t = New-Object System.Text.StringBuilder 512
        [Wlc.Win]::GetWindowTextW($h, $t, 512) | Out-Null
        $c = New-Object System.Text.StringBuilder 512
        [Wlc.Win]::GetClassNameW($h, $c, 512) | Out-Null
        $wpid = 0
        [Wlc.Win]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
        $owner = '?'
        try { $owner = (Get-Process -Id ([int]$wpid) -ErrorAction Stop).ProcessName } catch { }
        [void]$rows.Add([pscustomobject]@{
                Hwnd = [int64]$h; Visible = [bool][Wlc.Win]::IsWindowVisible($h)
                Class = $c.ToString(); Owner = $owner; Pid = [int]$wpid; Title = $t.ToString()
            })
        return $true
    }
    [Wlc.Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    return $rows
}

# 新旧两次普查的差集，只留"控制台系 owner 弄出来的新窗口"（外带别人的窗口只做提示，不算我们的账）
function Compare-WindowCensus {
    param($Before, $After, [int[]]$IgnorePids = @())
    $new = @($After | Where-Object {
            $h = $_.Hwnd
            (-not ($Before | Where-Object { $_.Hwnd -eq $h })) -and ($IgnorePids -notcontains $_.Pid)
        })
    return @($new | Where-Object { $script:ConsoleishOwners -contains $_.Owner })
}

function Format-WindowList($Windows) {
    foreach ($w in $Windows) {
        Write-Host ('        + visible={0,-5} {1,-28} owner={2}({3}) title="{4}"' -f $w.Visible, $w.Class, $w.Owner, $w.Pid, $w.Title)
    }
}

# 共享读一个还被别人按写方式开着的日志文件（排障时最常撞的一堵墙：File in use）
function Read-SharedText([string]$Path) {
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sr = New-Object System.IO.StreamReader($fs, (New-Object System.Text.UTF8Encoding($false)))
        return $sr.ReadToEnd()
    } finally { $fs.Dispose() }
}

function Get-SleeperPids {
    if ($script:Pids.Count -eq 0) { return @() }
    return @(Get-Process -Id @($script:Pids) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

function Stop-Sleepers {
    foreach ($procId in @($script:Pids)) {
        if ($procId -le 0) { continue }
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p) { continue }
        try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { Write-Host ("      [警告] 收不掉 pid {0}：{1}" -f $procId, $_.Exception.Message) }
    }
    # 复查：真没了没有（不许留垃圾进程）
    Start-Sleep -Milliseconds 600
    $left = @(Get-SleeperPids)
    if ($left.Count -gt 0) { Write-Host ('      [警告] 还活着：{0}' -f ($left -join ',')) }
    return ($left.Count -eq 0)
}

$script:Pids = New-Object System.Collections.ArrayList
$failures = New-Object System.Collections.ArrayList
function Fail([string]$msg) { [void]$failures.Add($msg); Write-Host ('  ✗ ' + $msg) }
function Pass([string]$msg) { Write-Host ('  ✓ ' + $msg) }

Write-Host ''
Write-Host '== 窗口普查（此刻，可见 + 隐藏）=='
$base = Get-WindowCensus
$consoleish = @($base | Where-Object { $script:ConsoleishOwners -contains $_.Owner })
foreach ($w in ($consoleish | Sort-Object Owner, Class)) {
    Write-Host ('  {0,-6} {1,-30} owner={2}({3}) title="{4}"' -f $(if ($w.Visible) { '可见' } else { '隐藏' }), $w.Class, $w.Owner, $w.Pid, $w.Title)
}
Write-Host ('  合计：顶层窗口 {0} 个，其中控制台系 owner 的 {1} 个' -f $base.Count, $consoleish.Count)

if ($Census) {
    Write-Host ''
    Write-Host '（-Census：只普查，一个进程都没起）'
    exit 0
}

# ── [1] 检测器灵敏度：老起法必须被抓到 ─────────────────────────────────────────
Write-Host ''
Write-Host '[1] 检测器灵敏度（反例）：老起法 Start-Process -WindowStyle Hidden 应当留下窗口对象'
$legacyProc = $null
try {
    $legacyProc = Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -ArgumentList $SleepLine -PassThru
} catch {
    Fail ('老起法都没能起来，检查无法进行：' + $_.Exception.Message)
}
if ($legacyProc) {
    [void]$script:Pids.Add([int]$legacyProc.Id)
    Start-Sleep -Seconds 3
    $legacyWindows = Compare-WindowCensus -Before $base -After (Get-WindowCensus) -IgnorePids @($PID)
    if ($legacyWindows.Count -gt 0) {
        Pass ('老起法留下了 {0} 个窗口对象 —— 本地枚举器确实看得见新窗口（所以下面那个"0 新增"是有意义的）' -f $legacyWindows.Count)
        Format-WindowList $legacyWindows
        Write-Host ('        （这一档的性质：{0}）' -f $(if (@($legacyWindows | Where-Object { $_.Visible }).Count -gt 0) { '**可见**窗口 —— 老起法在这台机器上挡不住默认终端（WT）' } else { '隐藏窗口 —— 看不见，但窗口对象确实存在' }))
    } else {
        Fail '老起法没有留下任何窗口对象 ⇒ 要么系统行为变了、要么枚举器瞎了 —— 此时"0 新增"不能当成通过，请人工复核本脚本'
    }
    if (-not $Keep) { Stop-Sleepers | Out-Null }
}

# ── [2] 真无窗口：Start-WindowlessProcess ────────────────────────────────────
Write-Host ''
Write-Host '[2] 真无窗口：tools\windowless.ps1 的 Start-WindowlessProcess'
. (Join-Path $PSScriptRoot 'windowless.ps1')
$before = Get-WindowCensus
$outLog = Join-Path $env:TEMP ('wlc-out-{0}.log' -f $PID)
$errLog = Join-Path $env:TEMP ('wlc-err-{0}.log' -f $PID)
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue
# 刻意用**和启动器同一条**形式：New-CmdRedirectLine（chcp 65001 + cmd 级重定向）。
# 睡觉进程用 cmd（活得比断言窗口的那 3 秒长），收尾只按 pid 杀。
# ⚠ `New-CmdRedirectLine` 末尾那个 `>` **只作用于 `&` 链里的最后一条命令**
#   （cmd 的重定向是"贴着哪条命令就归哪条"）—— 所以断言要盯"最后那条命令"的输出，
#   不是 `title` / `echo` 这种前面的内建命令（第一版就是这么误报的）。
$sleeperCmd = 'title WLCProbe & ping -n 13 127.0.0.1 >nul'
$wlProc = Start-WindowlessProcess -FilePath 'cmd.exe' -WorkingDirectory $env:SystemRoot `
    -Arguments (New-CmdRedirectLine -Command $sleeperCmd -StdOutLog $outLog -StdErrLog $errLog)
if (-not $wlProc) {
    Fail 'Start-WindowlessProcess 返回空 —— 无窗口这条路没起来（调用方会回退到可见窗口！）'
} else {
    [void]$script:Pids.Add([int]$wlProc.Id)
    Start-Sleep -Seconds 3
    $wlWindows = Compare-WindowCensus -Before $before -After (Get-WindowCensus) -IgnorePids @($PID)
    if ($wlWindows.Count -eq 0) {
        Pass '新增窗口对象 0 个（连隐藏的都没有）'
    } else {
        Fail ('新增了 {0} 个窗口对象 —— "不创建窗口"这句话就是假的：' -f $wlWindows.Count)
        Format-WindowList $wlWindows
    }
    $p2 = Get-Process -Id $wlProc.Id -ErrorAction SilentlyContinue
    if (-not $p2) {
        Fail '睡觉进程已经不在了 —— 无窗口方式把进程也弄死了'
    } elseif ([int64]$p2.MainWindowHandle -ne 0) {
        Fail ('睡觉进程有可见主窗口（MainWindowHandle={0}）' -f $p2.MainWindowHandle)
    } else {
        Pass '睡觉进程 MainWindowHandle = 0 且仍活着'
    }
    if (-not $Keep) { Stop-Sleepers | Out-Null }
    Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue
}

# [2b] 顺手证明"无窗口"没把功能弄坏：无窗口控制台里 chcp/重定向/UTF-8 中文照常。
# 这一档的进程**自己会退出**（node 打完一行就走）⇒ 不留垃圾、也不需要收尾。
Write-Host ''
Write-Host '[2b] 无窗口控制台没坏：cmd 级重定向 + UTF-8 中文'
$out2 = Join-Path $env:TEMP ('wlc-utf8-{0}.log' -f $PID)
Remove-Item $out2 -ErrorAction SilentlyContinue
$emitCmd = 'title WLCUtf8 & node -e "console.log(''中文探针-OK'')"'
$emitProc = Start-WindowlessProcess -FilePath 'cmd.exe' -WorkingDirectory $env:SystemRoot `
    -Arguments (New-CmdRedirectLine -Command $emitCmd -StdOutLog $out2)
if (-not $emitProc) {
    Fail 'UTF-8 探针没起来（Start-WindowlessProcess 返回空）'
} else {
    [void]$script:Pids.Add([int]$emitProc.Id)
    try { $emitProc.WaitForExit(15000) | Out-Null } catch { }
    Start-Sleep -Milliseconds 400
    if (Test-Path $out2) {
        $text = Read-SharedText $out2
        if ($text -match '中文探针-OK') { Pass 'chcp 65001 + cmd 级重定向在无窗口控制台里照常工作（日志是正确 UTF-8）' }
        else { Fail ('重定向日志里没有预期中文（拿到：{0}）—— 无窗口控制台可能不可用' -f $text.Trim()) }
    } else {
        Fail ('重定向日志没生成（{0}）—— cmd 的文件重定向在无窗口下失效了' -f $out2)
    }
    Remove-Item $out2 -ErrorAction SilentlyContinue
}

# ── [3] 不攥调用者的管道 + 调用者退出后子进程照活 ─────────────────────────────
Write-Host ''
Write-Host '[3] 调用者管道不被攥住 + 子进程比调用者活得久'
# 子 PowerShell 起睡觉进程（~12 秒），把 pid 打到 stdout；外层用**管道**读它。
# 若子进程继承了调用者的 stdout 管道，外层要等到睡觉进程结束才拿到 EOF ⇒ 就是那个"卡死"的坑。
$lifeLine = 'ping -n 13 127.0.0.1 >nul'
$inner = @(
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8'
    '. "' + (Join-Path $PSScriptRoot 'windowless.ps1') + '"'
    '$p = Start-WindowlessProcess -FilePath ''cmd.exe'' -Arguments ''/c "' + $lifeLine + '"'''
    'if ($p) { Write-Output (''SLEEPER='' + $p.Id) } else { Write-Output ''SLEEPER=0'' }'
) -join "`n"
$enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$piped = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc 2>&1 | Out-String
$sw.Stop()
$secs = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
$innerPid = 0
if ($piped -match 'SLEEPER=(\d+)') { $innerPid = [int]$Matches[1] }
if ($innerPid -gt 0) { [void]$script:Pids.Add($innerPid) }
if ($innerPid -le 0) {
    Fail ('子 PowerShell 没能起出睡觉进程（拿到：{0}）' -f $piped.Trim())
} else {
    if ($sw.Elapsed.TotalSeconds -lt 6) {
        Pass ('外层管道 {0} 秒就返回了（睡觉进程要活 {1} 秒 ⇒ 没被攥住）' -f $secs, 12)
    } else {
        Fail ('外层管道等了 {0} 秒 —— 子进程攥住了调用者的 stdout 管道（就是 control.ps1 up | Out-Host 卡死那个坑）' -f $secs)
    }
    if (Get-Process -Id $innerPid -ErrorAction SilentlyContinue) {
        Pass ('调用者（子 PowerShell）已退出，睡觉进程 {0} 仍然活着 —— 桥接守护要的就是这个性质' -f $innerPid)
    } else {
        Fail '调用者退出后睡觉进程也死了 —— 落不了地（守护/后台服务活不下来）'
    }
    if (-not $Keep) { Stop-Sleepers | Out-Null }
}

# ── 结论 ────────────────────────────────────────────────────────────────────
Write-Host ''
if ($Keep) { Write-Host ('（-Keep：留下睡觉进程 pid = {0}，记得自己收）' -f (@($script:Pids) -join ',')) }
if ($failures.Count -eq 0) {
    Write-Host '结论：全过 —— 无窗口那条路真的是无窗口（连隐藏窗口对象都没有），且没攥住调用者的管道。'
    exit 0
}
Write-Host ('结论：{0} 条失败' -f $failures.Count)
foreach ($f in $failures) { Write-Host ('  ✗ ' + $f) }
exit 1
