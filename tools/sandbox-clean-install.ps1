# 干净机器点火测试台（Windows 沙盒）—— 2026-09-24
#
# 干什么：把 tools\pack-new.mjs 打出的**交付包**放进一台**全新的 Windows**（Windows 沙盒 = 一次性 VM）里，
#         跑一次"首次安装入口"，把全过程转录回宿主机，然后让沙盒**自己关机**。
#         它只回答一个问题：**在一台什么都没有的机器上，安装入口会不会清楚地说"缺 node"**
#         （而不是甩一堆看不懂的报错）。完整安装不在本轮目标内 —— 沙盒里不联网装 node。
#
# 为什么可信：Windows 沙盒是一台全新 Windows（无 node / 无 git / 无 DSH / 无 %USERPROFILE%\.dsh），
#             所以这是本机唯一能拿到的"真正干净的机器"。
#
# ── 安全（三条，别改）───────────────────────────────────────────────────────
#   1. **只映射"打包产物所在的临时目录"**（可写，好把转录写回来）；**绝不映射仓库本身**——
#      否则沙盒里的安装脚本可能反过来改宿主机仓库。脚本里 Assert-StageSafe 会挡住这种误用。
#   2. **安装器只在沙盒里跑**：沙盒有自己的 ~，碰不到宿主机 %USERPROFILE%\.dsh。
#   3. 沙盒窗口会出现在屏幕上 ⇒ **一次只开一个**（开之前先查有没有在跑的沙盒），
#      跑完 / 超时 / 脚本自己抛异常，三条路都走 finally 里的 shutdown，不留 VM 挂在屏幕上。
#
# ── 用法 ────────────────────────────────────────────────────────────────────
#   powershell -ExecutionPolicy Bypass -File tools\sandbox-clean-install.ps1 -DryRun
#       # 只看计划：查前置 + 打印"会打包到哪、映射什么、跑什么"，不打包、不写文件、不开沙盒
#   powershell -ExecutionPolicy Bypass -File tools\sandbox-clean-install.ps1
#       # 全流程：打包 → 生成 harness/.wsb → 开沙盒 → 等它自己关 → 打印四项判据 + 转录
#   powershell -ExecutionPolicy Bypass -File tools\sandbox-clean-install.ps1 -Prepare
#       # 只打包 + 生成 harness/.wsb（不开沙盒）；给人手动双击 .wsb 用
#   powershell -ExecutionPolicy Bypass -File tools\sandbox-clean-install.ps1 -Stage <目录> -NoPack -Report
#       # 重新打印上一次的转录与四项判据（不开沙盒）
#   可选：-TimeoutSec 360（沙盒里安装入口的墙钟上限，秒）｜-NoPack（复用 -Stage 里已有的 pack）
#         ｜-OutRoot <目录>（换临时根，默认 %TEMP%\dsh-sandbox-test）｜-MemMB N（默认 0 = 用沙盒自带的 4096 MB）
#         ｜-Yes（跳过"开沙盒会让这台机器短暂掉线"那次确认）｜-NoCleanup（收尾不清理自己拉起的沙盒进程）
#         ｜-IgnorePreflight（前置自检误报时才用；那会真的去开沙盒）
#
# 退出码：0 = 四项判据全过；2 = 用法/前置不满足（**含"沙盒还没准备好"**）；3 = 打包或安全自检失败；
#         4 = 沙盒没跑完/没自己关（或还没跑过）。
#
# ── 已知坑 ──────────────────────────────────────────────────────────────────
#   ① 沙盒里**没有 node**（这正是要观察的第一件事，别在沙盒里联网装它）；
#   ② Start-Transcript 写的是 UTF-16LE，宿主机用 Convert-Transcript 转成 UTF-8 再读；
#   ③ 入口脚本的中文依赖 .ps1 的 UTF-8 BOM —— 没 BOM 会变乱码，harness 里有一节专门逐文件查它；
#   ④ 沙盒来自宿主机同一份 Windows，所以它证明的是"全新机器 + 无 node"，**不是**"另一台电脑"；
#   ⑤ **2026-09-24 本机实测（Windows 11 25H2 / build 26200）**：这台机器上沙盒**没跑起来**。
#      两次点火看到的提示依次是 `0x803fb008`「更新失败。继续使用经典 Windows 沙盒。」与
#      `0x80070005`「无法初始化。拒绝访问。」；VM 未进入登录（无 00-alive.flag、无 WDAGUtilityAccount 档案）。
#      **原因未查明** —— 别编归因，要真数据就再点一次火。
#      ⚠ **本脚本第一版犯过的错（务必别再犯）**：拿"记忆里的文件名" `WindowsSandboxServer.exe` 当判据，
#      见它不在就推出"服务端组件没装载 / 沙盒已迁 Microsoft Store"—— 两条**都被实测推翻**：
#        · 这个文件在本机**本来就不该存在**：System32 里带 'andbox' 的只有 WindowsSandbox.exe 与
#          WindowsSandboxClient.exe 两个客户端组件，组件本体在 WinSxS
#          （`amd64_microsoft-windows-c..-disposableclientvm_…10.0.26100.9278_none_…`）；
#        · 2026-09-24 实测：Microsoft Store 里**搜不到**「Windows Sandbox」⇒ Store 那条路作废。
#      ⇒ **判据只能来自本机实测的文件 / 注册表 / 服务状态**（见 Test-SandboxReady 的四条）。
#      ⇒ 另两条踩过的判据坑：注册表 `ProductName` 在 Windows 11 上**一直谎报 "Windows 10"**（判版本看 CurrentBuild）；
#        `RebootPending`/`RebootRequired` 对"启用可选功能"**不灵敏**（没置位 ≠ 不用重启，看 CBS CurrentState/InstallPending）。
#      ⇒ 判"到底行不行"的**唯一**权威办法是开一次（一次就够，别反复重试：每试一次屏幕上弹一次）。

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Prepare,
    [switch]$Report,
    [switch]$NoPack,
    [string]$Stage = '',
    [string]$OutRoot = '',
    [int]$TimeoutSec = 360,
    [int]$MemMB = 0,
    [switch]$NoNetwork,
    [switch]$IgnorePreflight,
    [switch]$Yes,
    [switch]$NoCleanup
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$SandboxExe = Join-Path $env:SystemRoot 'System32\WindowsSandbox.exe'
$PackNew = Join-Path $PSScriptRoot 'pack-new.mjs'
$Template = Join-Path $PSScriptRoot 'sandbox-clean-install.wsb.template'
$SandboxFolder = 'C:\dsh-sandbox'
$EntryRel = 'tools\setup-all.ps1'

function Step([string]$t) { Write-Host ''; Write-Host "── $t " -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Bad([string]$t) { Write-Host "  [!!]   $t" -ForegroundColor Red }
function Info([string]$t) { Write-Host "         $t" }

function Get-TempRoot() {
    if ($OutRoot) { return $OutRoot }
    return (Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-sandbox-test')
}

function Get-RunningSandbox() {
    @(Get-Process -Name 'WindowsSandbox', 'WindowsSandboxClient', 'WindowsSandboxRemoteSession', 'WindowsSandboxServer' -ErrorAction SilentlyContinue)
}

# 「我现在是不是跑在一个被文件沙箱限制的 shell 里？」——**实测判据**（不是猜、也不是恒真）：
#   往"工作区 / 临时目录之外"的三个正常用户可写目录（Documents、Desktop、ProgramData）各写一个探针文件：
#     · 有一个能写 ⇒ 不受限 ⇒ 放行；
#     · 三个全被拒 ⇒ 受限（典型：DSH 的文件沙箱 workspace-write）⇒ **起不了 Windows 沙盒**。
# 为什么这条能推出"起不了沙盒"（2026-09-25 实测结论）：Windows 沙盒启动时要往自己的工作目录/临时文件写，
# 被文件沙箱挡住 ⇒ 客户端起来又立刻退出，主人在屏幕上看到的就是 `0x80070005 拒绝访问`。
# 反证（证明判据不是"永远拒绝"）：同一个进程里往 `$env:TEMP` 与仓库内 `state\_tmp` 写探针**都成功**。
function Test-RestrictedShell() {
    $targets = @(
        (Join-Path $env:USERPROFILE 'Documents'),
        (Join-Path $env:USERPROFILE 'Desktop'),
        $env:ProgramData
    )
    $allowed = @(); $denied = @()
    foreach ($d in $targets) {
        if (-not $d -or -not (Test-Path $d)) { continue }
        $f = Join-Path $d ('.dsh-sandbox-probe-' + ([guid]::NewGuid().ToString('N').Substring(0, 8)) + '.tmp')
        try {
            Set-Content -LiteralPath $f -Value 'probe' -Encoding Ascii -ErrorAction Stop
            Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
            $allowed += $d
        } catch { $denied += $d }
    }
    return @{ Restricted = ($allowed.Count -eq 0 -and $denied.Count -gt 0); Allowed = $allowed; Denied = $denied }
}

# 安全闸：stage 必须在临时根之下、且**不能**在仓库里（防"把仓库映射进沙盒"）
function Assert-StageSafe([string]$stageDir) {
    $full = [System.IO.Path]::GetFullPath($stageDir)
    $tempRoot = [System.IO.Path]::GetFullPath((Get-TempRoot))
    if (-not $full.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝：stage（$full）不在临时根（$tempRoot）之下 —— 只会映射打包产物的临时目录"
    }
    $repo = [System.IO.Path]::GetFullPath($Root)
    if ($full.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝：stage（$full）在仓库里（$repo）—— 绝不许把仓库映射进沙盒"
    }
    return $full
}

# ── 前置自检：这台机器**现在**能不能起沙盒（打印人话结论；不通过就不开沙盒）──────────
# 判据只允许来自**本机实测**的文件 / 注册表 / 服务状态，就这四条：
#   · System32 里在不在 WindowsSandbox.exe 与 WindowsSandboxClient.exe；
#   · vmcompute / HvHost 是不是 Running；
#   · 有没有残留的沙盒进程（不许叠加弹窗）；
#   · `CurrentBuild`（**不是** `ProductName` —— 它在 Win11 上谎报 "Windows 10"）。
# 这四条都过 ⇒ **放行去真跑**：起不起得来只能靠点火拿真相，不靠猜。
# ⚠ 血泪教训（2026-09-24）：本脚本第一版拿"记忆里的文件名" `WindowsSandboxServer.exe` 当判据，
#   见它不在就推出"组件没装载 / 沙盒已迁 Microsoft Store"—— 两条都**不成立**：
#   那个文件在本机**本来就不该存在**（System32 里带 'andbox' 的只有上面那两个客户端组件，
#   组件本体在 WinSxS 里），而 Store 里**搜不到**「Windows Sandbox」（2026-09-24 实测）。
#   ⇒ 别拿记忆当判据：编得出一个"缺失"，就能推出一整条错误结论。文件名必须先在本机 ls 过。
# 旁证（**不参与判定、不带结论**）：`RebootPending`/`RebootRequired` 对"启用可选功能"不灵敏。
function Test-SandboxReady() {
    $hard = @()
    Step '前置自检：这台机器现在能不能起沙盒'

    # 版本：**只看 CurrentBuild**（注册表 ProductName 在 Windows 11 上一直谎报 "Windows 10"，用它判版本必错）
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    $build = 0
    if ($cv -and $cv.CurrentBuild) { $build = [int]$cv.CurrentBuild }
    $ubr = ''; $disp = ''; $fakeName = ''
    if ($cv) { $ubr = '' + $cv.UBR; $disp = '' + $cv.DisplayVersion; $fakeName = '' + $cv.ProductName }
    Info ("系统：build " + $build + "." + $ubr + " ｜ DisplayVersion " + $disp + " ｜ ProductName 键写着 '" + $fakeName + "' —— **Win11 上它谎报 Windows 10，判版本只能看 CurrentBuild**")

    # 最关键的一条：我是不是跑在受限 shell 里（受限 ⇒ 起沙盒必失败 0x80070005）
    $rs = Test-RestrictedShell
    if ($rs.Restricted) {
        Bad ("这个 shell 是**受限**的（往工作区/临时目录之外写全被拒：" + ($rs.Denied -join '、') + "）")
        Info '        ⇒ **从这里启动 Windows 沙盒必然失败**（客户端起来又立刻退出，屏幕上弹 0x80070005 拒绝访问）：'
        Info '          沙盒启动要往自己的工作目录写，被 DSH 的文件沙箱挡住了。'
        Info '        ⇒ 正确做法：**由主人在桌面上双击 tools\sandbox-check.cmd**。'
    } else {
        Ok ("shell 不受限（探针写成功：" + ($rs.Allowed -join '、') + "）")
    }

    foreach ($n in 'WindowsSandbox.exe', 'WindowsSandboxClient.exe') {
        $p = Join-Path $env:SystemRoot "System32\$n"
        if (Test-Path $p) { Ok "客户端组件在：$p" }
        else { Bad "缺 $p —— 功能没启用（管理员：dism /online /enable-feature /featurename:Containers-DisposableClientVM /all，然后重启）"; $hard += $n }
    }
    foreach ($s in @(Get-Service vmcompute, HvHost -ErrorAction SilentlyContinue)) {
        if ($s.Status -eq 'Running') { Ok ("服务 " + $s.Name + " = Running") }
        else { Bad ("服务 " + $s.Name + " = " + $s.Status + " —— 起不来沙盒（管理员：sc.exe start " + $s.Name + "）"); $hard += $s.Name }
    }
    $running = Get-RunningSandbox
    if ($running.Count -eq 0) { Ok '当前没有在跑的沙盒（本脚本一次只开一个）' }
    else { Bad ("已经有 " + $running.Count + " 个沙盒在跑 —— 先关掉再开（不许叠加弹窗）"); $hard += 'running-sandbox' }

    # **中性事实陈述**（不是判据、不推任何结论）：System32 里带 'andbox' 的到底是哪几个文件。
    # 第一版就是在这儿拿"服务端二进制不在"推 Store 的 —— 别再犯（见文件头血泪教训）。
    $sandboxSys = @(Get-ChildItem (Join-Path $env:SystemRoot 'System32') -Filter '*andbox*' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    $sysTxt = '（一个都没有）'
    if ($sandboxSys.Count -gt 0) { $sysTxt = $sandboxSys -join ', ' }
    Info ("事实陈述（不是判据、不推结论）：System32 里带 'andbox' 的文件 = " + $sysTxt + " —— 本机正常形态就是这两个客户端组件")

    # 重启标记：只当旁证（对"启用可选功能"不灵敏）
    $pending = @()
    foreach ($k in @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootInProgress',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\PackagesPending',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')) {
        if (Test-Path $k) { $pending += (Split-Path $k -Leaf) }
    }
    $sess = 0
    $sp = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\SessionsPending'
    if (Test-Path $sp) { $sess = @(Get-ChildItem $sp -ErrorAction SilentlyContinue).Count }
    $rebootTxt = '（无）'
    if ($pending.Count -gt 0) { $rebootTxt = $pending -join '/' }
    Info ("旁证：重启标记 " + $rebootTxt + " ｜ CBS SessionsPending=" + $sess + "（对'启用可选功能'不灵敏，别当结论）")
    return @{ Ready = ($hard.Count -eq 0); Hard = $hard; Build = $build; Restricted = $rs.Restricted }
}

function Show-RestrictedShellBlock() {
    Step '结论：这个 shell 起不了沙盒 —— 本轮不点火（不弹窗口、不重试）'
    Bad '原因（2026-09-25 实测）：DSH 的文件沙箱（workspace-write）不许往工作区 / 临时目录之外写，'
    Bad '      而 Windows 沙盒启动时必须往自己的工作目录写 ⇒ 客户端起来又立刻退出，主人屏幕上弹的'
    Bad '      就是 `Windows 沙盒无法初始化。Error 0x80070005. 拒绝访问.`（**从这儿跑必然失败**）。'
    Info ''
    Info '要跑这个测试台，请**由主人在桌面上双击**：'
    Info '   tools\sandbox-check.cmd'
    Info '（那是普通桌面会话，没有文件沙箱限制；沙盒跑完会自己关机，结果写回映射目录。）'
    Info '⚠ 别在 DSH 会话 / 子代理里反复试 —— 每试一次都在主人屏幕上弹一次警告。'
    Info '自检本身误报时才用 -IgnorePreflight 跳过。'
}

function Show-SandboxNotReady([string[]]$hard) {
    Step '结论：这台机器现在开不了沙盒 —— 本轮不点火（不弹窗口、不重试）'
    Bad ("没过的硬判据：" + ($hard -join ', '))
    Info ''
    Info '该做什么（每一条都能在本机核实）：'
    Info '  1) 缺 WindowsSandbox.exe / WindowsSandboxClient.exe ⇒ 功能没启用。管理员跑：'
    Info '       dism /online /enable-feature /featurename:Containers-DisposableClientVM /all   然后重启一次'
    Info '  2) 服务没 Running ⇒ 管理员：sc.exe start vmcompute ；sc.exe start HvHost'
    Info '  3) 有残留沙盒进程 ⇒ 先关掉（任务管理器结束 WindowsSandbox / WindowsSandboxClient）'
    Info '  4) **Hyper-V 没启用** ⇒ 沙盒起不来（它建在 Hyper-V 上）：'
    Info '       dism /online /enable-feature /featurename:Microsoft-Hyper-V-All /all   然后重启一次'
    Info '       （2026-09-25 实测：Hyper-V 启用后，主人双击 .cmd 就真的跑出了干净桌面 ✓）'
    Info '  这几条都过了脚本就放行 —— **起不起得来只能靠点火看，不靠猜**。'
    Info ''
    Info '启动时看到的提示，一句话翻译（都是本机实测看到过的）：'
    Info '   · 0x80070005「无法初始化。拒绝访问。」→ **两种原因，本机都实测到了**：'
    Info '       (a) **Hyper-V 功能没启用**（Windows 沙盒建在它上面）—— 启用后可用（2026-09-25 实测 ✓）；'
    Info '       (b) **从"被文件沙箱限制的 shell"里启动**（DSH 会话 / 子代理，workspace-write）⇒ 必然拒绝访问 ——'
    Info '           沙盒要往自己的工作目录写，被挡住；**这种只能由主人在桌面上双击 tools\sandbox-check.cmd**。'
    Info '   · 0x803fb008「更新失败。继续使用经典 Windows 沙盒。」 → 它试图更新沙盒组件但失败了；'
    Info '       **原因未查明**（与 Microsoft Store 无关 —— 实测商店里搜不到「Windows Sandbox」这个应用）'
    Info '   · 0x80370102 / 0x8037010x → CPU 虚拟化没开（BIOS 开 VT-x/AMD-V；本机若是 VM 要开嵌套虚拟化）'
    Info '   · 缺 WindowsSandbox.exe → 功能根本没启用（见上面第 1 条）'
    Info ''
    Info '⚠ 教训：判据只能来自**本机实测**的文件 / 注册表 / 服务状态。别拿记忆里的文件名当判据 ——'
    Info '   编得出一个"缺失"，就能推出一整条错误结论（本脚本第一版就这么错过一次）。'
    Info '自检本身误报时才用 -IgnorePreflight 跳过（那会真的去开沙盒）。'
}

# ── 沙盒内点火脚本（写进 stage\harness\，由 .wsb 的 LogonCommand 调起）──────────
$RunnerText = @'
param([int]$TimeoutSec = 360)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Harness = $PSScriptRoot
$Stage   = Split-Path -Parent $Harness
$Pack    = Join-Path $Stage 'pack'
$Entry   = Join-Path $Pack 'tools\setup-all.ps1'
$Alive   = Join-Path $Harness '00-alive.flag'
$Flag    = Join-Path $Harness '99-done.flag'
$ResultF = Join-Path $Harness '99-result.json'
$OutF    = Join-Path $Harness '10-entry.stdout.txt'
$ErrF    = Join-Path $Harness '10-entry.stderr.txt'
$LogF    = Join-Path $Harness 'transcript.log'
$Shutdown = Join-Path $env:SystemRoot 'System32\shutdown.exe'

function Say([string]$t) { Write-Host $t }
function Head([string]$t) { Write-Host ''; Write-Host ('#' * 72); Write-Host ("# " + $t); Write-Host ('#' * 72) }

# 沙盒里拿到的原始字节可能是 UTF-8、也可能是 shell 自己的 OEM 代码页；UTF-8 解出替换字符就退回 GBK
function Get-TextSmart([string]$p) {
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    $b = [System.IO.File]::ReadAllBytes($p)
    if ($b.Length -eq 0) { return '' }
    $t = (New-Object System.Text.UTF8Encoding($false)).GetString($b)
    if ($t.IndexOf([char]0xFFFD) -ge 0) {
        try { $t = [System.Text.Encoding]::GetEncoding(936).GetString($b) } catch { }
    }
    return $t
}
function Show-File([string]$p, [string]$title) {
    Head $title
    $t = Get-TextSmart $p
    if ($null -eq $t) { Say ("（没有这个文件：" + $p + "）"); return }
    Say ("（原样：" + (Split-Path -Leaf $p) + "，" + (Get-Item -LiteralPath $p).Length + " 字节）")
    foreach ($ln in ($t -split "`r?`n")) { Say ("  | " + $ln) }
}
function Get-PackFiles([string]$root) {
    @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue)
}

$R = [ordered]@{
    startedAt    = (Get-Date).ToString('s')
    sandboxUser  = "$env:USERNAME@$env:COMPUTERNAME"
    stage        = $Stage
    entry        = $Entry
    entryInvoked = $false
    entryExitCode = $null
    entryTimedOut = $false
    entrySeconds = $null
}

try {
    Start-Transcript -Path $LogF -Force | Out-Null
    Set-Content -LiteralPath $Alive -Value ("alive " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " " + $env:COMPUTERNAME) -Encoding UTF8

    Head '① 沙盒起来了 ＆ 映射目录可读'
    Say ("沙盒用户：" + $env:USERNAME + "@" + $env:COMPUTERNAME)
    Say ("脚本位置：" + $MyInvocation.MyCommand.Path)
    $osCap = '?'
    try { $osCap = (Get-CimInstance Win32_OperatingSystem).Caption + " build " + (Get-CimInstance Win32_OperatingSystem).BuildNumber } catch { }
    Say ("系统：" + $osCap)
    Say ("PowerShell：" + $PSVersionTable.PSVersion + " / ExecutionPolicy=" + (Get-ExecutionPolicy) + " / Culture=" + (Get-Culture).Name)
    Say ("映射目录 " + $Stage + " 可读=" + (Test-Path $Stage) + " ｜ pack 可读=" + (Test-Path $Pack))
    Say ("pack 里的文件数：" + (Get-PackFiles $Pack).Count)
    Say ("宿主机 %USERPROFILE% 那套东西在这儿当然没有：C:\Users\" + $env:USERNAME + "\.dsh 存在=" + (Test-Path (Join-Path $env:USERPROFILE '.dsh')))

    Head '② 交付包里的 .ps1 有没有保住 UTF-8 BOM（PS 5.1 没 BOM 就把中文读成乱码）'
    $noBom = 0; $psCount = 0
    foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $Pack 'tools') -Filter *.ps1 -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        $psCount++
        $b = [System.IO.File]::ReadAllBytes($f.FullName)
        $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
        Say ("  " + $f.Name.PadRight(36) + " BOM=" + $hasBom)
        if (-not $hasBom) { $noBom++ }
    }
    Say ("  ⇒ tools\ 下 .ps1 共 " + $psCount + " 个，无 BOM 的 " + $noBom + " 个")
    $R.psCount = $psCount
    $R.psNoBom = $noBom

    Head '③ 这台机器上「有什么 / 没有什么」'
    foreach ($c in @('node', 'npm', 'npx', 'git', 'dsh', 'dsh.cmd', 'winget', 'tar', 'curl')) {
        $g = Get-Command $c -ErrorAction SilentlyContinue
        if ($g) { Say ("  [有] " + $c.PadRight(10) + " " + $g.Source) } else { Say ("  [无] " + $c.PadRight(10) + " （PATH 里找不到）") }
    }
    $R.nodePresent = [bool](Get-Command node -ErrorAction SilentlyContinue)

    # 探针一律用 cmd 重定向落到文件 —— 拿到的是**操作系统原话的原始字节**，不经过控制台解码
    & cmd.exe /c "node -v > `"$Harness\05-probe-node.txt`" 2>&1"
    Show-File (Join-Path $Harness '05-probe-node.txt') '③b 直接敲 node -v：操作系统原话'

    Head '④ 跑首次安装入口（交付包里的 tools\setup-all.ps1）'
    Say ("入口：" + $Entry + " ｜存在=" + (Test-Path $Entry))
    Say ("沙盒里由 " + (Join-Path $Harness 'invoke-entry.ps1') + " 包一层，把 stdout 固定成 UTF-8")
    $before = Get-PackFiles $Pack
    $beforeMap = @{}
    foreach ($f in $before) { $beforeMap[$f.FullName] = $true }

    Set-Location $Pack
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $timedOut = $false
    $exitCode = $null
    $codeF = Join-Path $Harness '10-entry.exitcode.txt'
    if (Test-Path $Entry) {
        $R.entryInvoked = $true
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $Harness 'invoke-entry.ps1'),
            '-Entry', $Entry, '-ExitCodeFile', $codeF
        ) -NoNewWindow -PassThru -RedirectStandardOutput $OutF -RedirectStandardError $ErrF
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            $timedOut = $true
            try { $p.Kill() } catch { }
            Start-Sleep -Seconds 2
        }
        # 退出码优先读**包装脚本自己写下的那个文件**：实测 Start-Process -PassThru 的 $p.ExitCode
        # 在重定向 stdout 时会拿到 $null（2026-09-25 主人那次真跑就是 null），文件更靠谱。
        if (Test-Path $codeF) {
            $raw = (Get-Content -LiteralPath $codeF -Encoding UTF8 -Raw)
            if ($null -ne $raw) { $raw = $raw.Trim() }
            if ($raw -match '^-?\d+$') { $exitCode = [int]$raw } else { $exitCode = $raw }
        }
        if ($null -eq $exitCode) { try { $exitCode = $p.ExitCode } catch { } }
    } else { Say '入口不存在 —— 交付包不完整' }
    $sw.Stop()

    $R.entryTimedOut = $timedOut
    $R.entryExitCode = $exitCode
    $R.entrySeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Say ("耗秒=" + $R.entrySeconds + " ｜ 超时=" + $timedOut + " ｜ 退出码=" + $exitCode + "（setup-all.ps1：0 成功 / 2 环境不满足 / 3 某步失败）")
    Show-File $OutF '④a 入口 stdout（原样）'
    Show-File $ErrF '④b 入口 stderr（原样）'

    Head '⑤ 失败之前它有没有动过包里的文件'
    $after = Get-PackFiles $Pack
    $new = @($after | Where-Object { -not $beforeMap.ContainsKey($_.FullName) })
    Say ("跑之前 " + $before.Count + " 个文件 → 跑之后 " + $after.Count + " 个，新增 " + $new.Count + " 个")
    foreach ($f in @($new | Select-Object -First 30)) { Say ("  + " + $f.FullName.Substring($Pack.Length + 1)) }
    Say ("qq-bridge\config.json 存在=" + (Test-Path (Join-Path $Pack 'qq-bridge\config.json')) + " ｜ qq-bridge\node_modules 存在=" + (Test-Path (Join-Path $Pack 'qq-bridge\node_modules')))
    $R.packFilesBefore = $before.Count
    $R.packFilesAfter = $after.Count

    Head '⑥ 换一条路：照包内 部署说明.txt 第一条敲 node tools\setup-new.mjs'
    & cmd.exe /c "cd /d `"$Pack`" && node tools\setup-new.mjs > `"$Harness\06-probe-setup-new.txt`" 2>&1"
    Show-File (Join-Path $Harness '06-probe-setup-new.txt') '⑥ 操作系统原话'

    Head '⑦ 点火数据（机器可读，同时写 99-result.json）'
    $R.finishedAt = (Get-Date).ToString('s')
    $json = ($R | ConvertTo-Json)
    Say $json
    Set-Content -LiteralPath $ResultF -Value $json -Encoding UTF8
    Set-Content -LiteralPath $Flag -Value ("done " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
    Say ''
    Say '点火脚本跑完了 —— 5 秒后沙盒自己关机。'
} catch {
    Write-Host ''
    Write-Host ("!! 点火脚本自己抛异常：" + $_.Exception.Message)
    Write-Host $_.ScriptStackTrace
} finally {
    # 三条路（正常/异常/超时）都要走到这儿：停转录 → 留标记 → 关沙盒，不留 VM 挂在屏幕上
    try { Stop-Transcript | Out-Null } catch { }
    try {
        if (-not (Test-Path $Flag)) {
            Set-Content -LiteralPath $Flag -Value ("done-with-errors " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
        }
    } catch { }
    Start-Sleep -Seconds 3
    & $Shutdown /s /t 5 /f
}
'@

$InvokerText = @'
# 把交付包里的入口包一层，只做两件事：
#   1) 让它的 stdout/stderr 固定成 UTF-8（宿主机拿到的中文不会因代码页不同而乱码）；
#   2) 把退出码**写进一个文件** —— 实测 Start-Process -PassThru 在重定向 stdout 时 $p.ExitCode 会是 $null
#      （2026-09-25 真跑时 entryExitCode 就是 null），写文件才是可靠的。
# 改交付入口本身是禁止的，所以只能在外面包一层。
param(
    [Parameter(Mandatory = $true)][string]$Entry,
    [string]$ExitCodeFile = ''
)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
& $Entry
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
if ($ExitCodeFile) {
    try { [System.IO.File]::WriteAllText($ExitCodeFile, "$code", (New-Object System.Text.UTF8Encoding($false))) } catch { }
}
exit $code
'@

function Write-Utf8Bom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

function New-HarnessFiles([string]$stageDir, [int]$timeout) {
    $harness = Join-Path $stageDir 'harness'
    New-Item -ItemType Directory -Force -Path $harness | Out-Null
    Write-Utf8Bom (Join-Path $harness 'run-in-sandbox.ps1') $RunnerText
    Write-Utf8Bom (Join-Path $harness 'invoke-entry.ps1') $InvokerText

    $net = if ($NoNetwork) { 'Disable' } else { 'Enable' }
    $logon = 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File ' + $SandboxFolder + '\harness\run-in-sandbox.ps1 -TimeoutSec ' + $timeout
    # 沙盒默认就是 4096 MB；只在显式覆盖时才写这个元素，而且必须放**最后**（.wsb 的 schema 是序列）
    $mem = ''
    if ($MemMB -gt 0) { $mem = "`r`n  <MemoryInMB>$MemMB</MemoryInMB>" }
    if (Test-Path $Template) {
        $xml = [System.IO.File]::ReadAllText($Template, [System.Text.Encoding]::UTF8)
        $xml = $xml.Replace('{{HOST_FOLDER}}', $stageDir).Replace('{{SANDBOX_FOLDER}}', $SandboxFolder)
        $xml = $xml.Replace('{{NETWORKING}}', $net).Replace('{{LOGON_COMMAND}}', $logon).Replace('{{MEMORY}}', $mem)
    } else {
        $xml = @"
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$stageDir</HostFolder>
      <SandboxFolder>$SandboxFolder</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>$net</Networking>
  <LogonCommand>
    <Command>$logon</Command>
  </LogonCommand>$mem
</Configuration>
"@
    }
    # 生成的 .wsb 里去掉注释：注释只是给读模板的人看的，写出去只会多一层"万一解析器挑食"的风险
    $xml = [System.Text.RegularExpressions.Regex]::Replace($xml, '<!--.*?-->', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $wsb = Join-Path $stageDir 'sandbox.wsb'
    [System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))
    return @{ Harness = $harness; Wsb = $wsb }
}

# Start-Transcript 写的是 UTF-16LE；转一份 UTF-8 出来给人和别的工具读（显式编码，不做裸往返）。
# 落点优先"转录旁边"；写不进去（例如从 DSH 会话里 -Report 一个别人跑的 stage，文件沙箱不许写那儿）
# 就退到本会话临时目录 —— 只影响副本放哪儿，不影响读数；实在都写不了返回 $null（调用方按 Unicode 读原件）。
function Convert-Transcript([string]$src) {
    if (-not (Test-Path -LiteralPath $src)) { return $null }
    $txt = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::Unicode)
    $enc = New-Object System.Text.UTF8Encoding($true)
    $leaf = ((Split-Path -Leaf $src) -replace '\.log$', '') + '.utf8.txt'
    foreach ($dst in @(($src -replace '\.log$', '.utf8.txt'), (Join-Path ([System.IO.Path]::GetTempPath()) $leaf))) {
        try { [System.IO.File]::WriteAllText($dst, $txt, $enc); return $dst } catch { }
    }
    return $null
}

function Show-RunReport([string]$stageDir) {
    $harness = Join-Path $stageDir 'harness'
    Step ("上一次的点火结果：$stageDir")
    $running = Get-RunningSandbox
    $alive = Join-Path $harness '00-alive.flag'
    $done = Join-Path $harness '99-done.flag'
    $log = Join-Path $harness 'transcript.log'
    $res = Join-Path $harness '99-result.json'
    $outF = Join-Path $harness '10-entry.stdout.txt'

    if (-not ((Test-Path $alive) -or (Test-Path $log) -or (Test-Path $done) -or (Test-Path $res))) {
        Step '结论：这四项**还没验证过**（本测试台在这台机器上还没成功跑过一次）'
        Info '① 沙盒起得来 + 读得到映射目录 —— 未验证'
        Info '② 安装入口可调用 —— 未验证'
        Info '③ transcript 回传 —— 未验证'
        Info '④ 沙盒自己关机 —— 未验证'
        $noteEarly = Join-Path $harness '98-host-note.txt'
        if (Test-Path $noteEarly) {
            Info ''
            Info '上一轮失败时脚本留下的现场记录（98-host-note.txt）—— 这条就是"已知阻塞"的证据：'
            Get-Content -LiteralPath $noteEarly -Encoding UTF8 | ForEach-Object { Write-Host ("  " + $_) }
        }
        Info '要真数据就跑：powershell -ExecutionPolicy Bypass -File tools\sandbox-clean-install.ps1'
        return $false
    }

    $c1 = (Test-Path $alive) -and (Test-Path $log)
    $c2 = (Test-Path $outF) -and (Test-Path $res)
    $c3 = (Test-Path $log) -and ((Get-Item $log).Length -gt 0)
    # ④ 判的是"**沙盒（guest）自己关掉了**"：99-done.flag 是 guest 在 shutdown 之前写的最后一样东西。
    #    ⚠ 别把"启动器进程还在"算成没关 —— 2026-09-25 实测：guest 早关了（没窗口、没 VM），
    #    但 WindowsSandbox.exe 那个启动器进程可能一直不退。残留单独报（并由收尾 6b 清掉）。
    $c4 = (Test-Path $done)
    $pass = 0
    foreach ($pair in @(@($c1, '① 沙盒起来了 + 映射目录可写（转录回得来）'), @($c2, '② 安装入口被调用过（有 stdout / 有结果 JSON）'), @($c3, '③ 转录成功回传（transcript.log 非空）'), @($c4, '④ 沙盒（guest）自己关掉了（99-done.flag = shutdown 前写的最后一样东西）'))) {
        if ($pair[0]) { Ok $pair[1]; $pass++ } else { Bad $pair[1] }
    }
    if ($running.Count -eq 0) { Info '沙盒进程残留：0 个（干净）' }
    else {
        Info ("沙盒进程残留：" + $running.Count + " 个 —— " + (($running | ForEach-Object { $_.Name + '#' + $_.Id }) -join ', '))
        Info '  说明：这些多半是**启动器残留**（不是 VM）；收尾那一步会清掉自己拉起的那些。'
    }
    $noteF = Join-Path $harness '98-host-note.txt'
    if (Test-Path $noteF) {
        Step '上一轮没跑起来时脚本留下的现场记录（98-host-note.txt）'
        Get-Content -LiteralPath $noteF -Encoding UTF8 | ForEach-Object { Write-Host ("  " + $_) }
    }
    if (Test-Path $res) { Info ('结果 JSON：' + (Get-Content -LiteralPath $res -Encoding UTF8 -Raw).Trim().Replace("`r`n", ' ')) }

    $u8 = Convert-Transcript $log
    if ($u8) {
        Step "转录（UTF-8 副本：$u8）"
        Get-Content -LiteralPath $u8 -Encoding UTF8 | ForEach-Object { Write-Host ("  " + $_) }
    } elseif (Test-Path $log) {
        # 副本写不出来（例如从受限 shell 里读别人的 stage）—— 直接按 UTF-16LE 读原件，别假装没有
        Step "转录（原件 $log，UTF-16LE，副本写不出来就直读）"
        Get-Content -LiteralPath $log -Encoding Unicode | ForEach-Object { Write-Host ("  " + $_) }
    } else { Bad '没有 transcript.log —— 沙盒可能根本没起来' }
    return ($pass -eq 4)
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '========================================================='
Write-Host ' DSH 干净机器点火测试台（Windows 沙盒）'
Write-Host " 仓库根：$Root"
Write-Host '========================================================='

$existing = Get-RunningSandbox

if ($DryRun) {
    Step 'DRY-RUN：只打印计划（不打包、不写文件、不开沙盒）'
    $ready = Test-SandboxReady
    if (Test-Path $PackNew) { Ok "打包器：tools\pack-new.mjs" } else { Bad '缺 tools\pack-new.mjs' }
    if (Test-Path $Template) { Ok "配置模板：tools\sandbox-clean-install.wsb.template" } else { Bad '缺 .wsb 模板（脚本会退回内置默认）' }
    Info '四项判据（① 沙盒起得来+读得到映射目录 ② 安装入口可调用 ③ transcript 回传 ④ 沙盒自己关机）'
    Info '  现在都还是**未验证** —— DRY-RUN 不开沙盒，跑了才有真数据。'

    Step '会做什么（按顺序）'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $planStage = if ($Stage) { $Stage } else { Join-Path (Get-TempRoot) $stamp }
    Info "1) node tools\pack-new.mjs --dry-run          （先看清包含/排除什么，只读）"
    Info "2) node tools\pack-new.mjs --out <stage>\pack （真打包；退出码 3 = 安全自检命中 ⇒ 立刻停）"
    Info "3) 生成 <stage>\harness\{run-in-sandbox.ps1,invoke-entry.ps1} 与 <stage>\sandbox.wsb"
    Info "4) $SandboxExe <stage>\sandbox.wsb   （沙盒窗口会出现在屏幕上，一次一个）"
    Info "5) 等 <stage>\harness\99-done.flag（沙盒自己关机的标记），最多等 $TimeoutSec 秒 + 开机与关机余量"
    Info "6) 打印四项判据 + 转录（转录 UTF-16LE → 转一份 UTF-8 副本再读）"

    Step '关键参数（要变就改这里）'
    Info "stage（= 唯一被映射进沙盒的目录）：$planStage"
    Info "  沙盒里挂到：$SandboxFolder（可写；**绝不映射仓库 $Root**）"
    Info "  沙盒里跑的入口：$SandboxFolder\pack\$EntryRel"
    Info "  入口墙钟上限：$TimeoutSec 秒（超时也留转录，然后关机）"
    Info ("  沙盒内存：" + $(if ($MemMB -gt 0) { "$MemMB MB" } else { '沙盒默认（4096 MB）' }) + " ｜ 网络：" + $(if ($NoNetwork) { 'Disable' } else { 'Enable' }))
    Info '  沙盒里**不装 node**（本轮只点火，不做完整安装）'
    Info ''
    Info '⚠ 开沙盒会**影响到这台电脑**：虚拟网卡 + 几 GB 内存 ⇒ DSH 会话 / 桥接 / SnowLuma 的连接会被重置，'
    Info '  那几分钟机器人（QQ 侧）是断的（2026-09-25 主人实测）。脚本开跑前会先要一次确认（或 -Yes 跳过）。'
    if (-not $ready.Ready) {
        Show-SandboxNotReady $ready.Hard
        Step 'DRY-RUN 结束：什么都没做（前置自检**没过** ⇒ 去掉 -DryRun 也不会开沙盒，退出码 2）。'
        exit 2
    }
    if ($ready.Restricted) {
        Show-RestrictedShellBlock
        Step 'DRY-RUN 结束：什么都没做（"shell 不受限"这条没过 ⇒ 去掉 -DryRun 也不会开沙盒，退出码 2）。'
        exit 2
    }
    Step 'DRY-RUN 结束：什么都没做（前置自检通过 ⇒ 去掉 -DryRun 就会真开沙盒）。'
    exit 0
}

if ($Report) {
    if (-not $Stage) { Bad '-Report 要配 -Stage <目录>'; exit 2 }
    if (-not (Test-Path (Join-Path $Stage 'harness'))) { Bad "那个目录里没有 harness\：$Stage"; exit 2 }
    if (Show-RunReport $Stage) { exit 0 } else { exit 4 }
}

# 1) 前置自检：不通过就**不开沙盒**（人话结论 + 非 0 退出），免得反复在屏幕上弹窗口
$ready = Test-SandboxReady
if (-not $ready.Ready) {
    if (-not $IgnorePreflight) { Show-SandboxNotReady $ready.Hard; exit 2 }
    Bad '前置自检没过，但给了 -IgnorePreflight —— 照开（出问题别怪脚本）'
}
# 受限 shell（DSH 会话 / 子代理）里启动沙盒**必然** 0x80070005 ⇒ 直接拒绝，别在主人屏幕上白弹一次
if ($ready.Restricted -and -not $IgnorePreflight) {
    if ($Prepare) {
        Info '（-Prepare 只生成 .wsb、不启动沙盒，所以放行；真要跑请让主人在桌面上双击 tools\sandbox-check.cmd）'
    } else {
        Show-RestrictedShellBlock
        exit 2
    }
}

# 2) stage
if ($Stage) {
    $stageDir = Assert-StageSafe $Stage
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Ok "复用 stage：$stageDir"
} else {
    $stageDir = Assert-StageSafe (Join-Path (Get-TempRoot) (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Ok "新建 stage：$stageDir"
}

# 3) 打包
$packDir = Join-Path $stageDir 'pack'
if ($NoPack) {
    if (-not (Test-Path (Join-Path $packDir 'tools\setup-all.ps1'))) { Bad "-NoPack 但 $packDir 里没有交付包"; exit 2 }
    Ok "复用已有交付包：$packDir（$((Get-ChildItem -LiteralPath $packDir -Recurse -File).Count) 个文件）"
} else {
    Step '打包（tools\pack-new.mjs）'
    if (Test-Path $packDir) { Remove-Item -LiteralPath $packDir -Recurse -Force }
    & node $PackNew --out $packDir
    $packExit = $LASTEXITCODE
    if ($packExit -eq 3) { Bad '打包器的安全自检命中了（产物已删）—— 这本身就是必须记录的一条告警'; exit 3 }
    if ($packExit -ne 0) { Bad "打包失败，退出码 $packExit"; exit 3 }
    Ok "交付包：$packDir（$((Get-ChildItem -LiteralPath $packDir -Recurse -File).Count) 个文件）"
}

# 4) harness + .wsb
Step '生成沙盒配置与点火脚本'
$h = New-HarnessFiles $stageDir $TimeoutSec
Ok "点火脚本：$($h.Harness)\run-in-sandbox.ps1"
Ok "沙盒配置：$($h.Wsb)"
Info "被映射进沙盒的**只有**：$stageDir"

if ($Prepare) {
    Info ''
    Info '（-Prepare：到此为止，没开沙盒）。手动跑：双击上面那个 .wsb，或用：'
    Info "  $SandboxExe `"$($h.Wsb)`""
    Info "回来收结果： powershell -ExecutionPolicy Bypass -File tools\sandbox-clean-install.ps1 -Stage `"$stageDir`" -Report"
    exit 0
}

# 5) 开沙盒（只开这一个）—— 开之前必须让跑的人知道：**它会把这台电脑的网络/服务打断**
Step '开沙盒（窗口会出现在屏幕上；它跑完会自己关机）'
Info ''
Info '⚠⚠ 开沙盒之前必须知道：**它会影响到这台电脑上的其它东西**（2026-09-25 主人实测）：'
Info '   · 沙盒会建一块虚拟网卡、吃掉几 GB 内存 ⇒ **DSH 的会话连接、桥接与 SnowLuma 的连接会被重置**；'
Info '     （当时 DSH-Web 窗口直接报了「DSH 已停止」，还弹过"有连接，别终止了"的警告）'
Info '   · 也就是说：**那几分钟里机器人（QQ 侧）是断的**，别指望它回话。'
Info '   · 沙盒跑完会自己关机 ⇒ 之后网络与服务会恢复。**别在需要它的时候跑这一趟。**'
Info ''
if (-not $Yes) {
    $ans = $null
    try { $ans = Read-Host '同意现在开沙盒（机器人会短暂掉线）就输 y 回车，其它任何输入 = 取消' }
    catch {
        Bad '拿不到交互输入（这里没有控制台）⇒ 要跑请加 -Yes 明确同意，或让主人在桌面上双击 tools\sandbox-check.cmd'
        exit 2
    }
    if ($ans -notmatch '^(y|Y|yes|YES|Yes|是)$') { Bad '已取消 —— 没有开沙盒'; exit 0 }
}
Start-Process -FilePath $SandboxExe -ArgumentList @($h.Wsb) | Out-Null
Ok '已拉起 WindowsSandbox.exe'
# 记下"开跑前就已经在跑的沙盒进程"——收尾时**只清我们自己拉起来的那些**，绝不动别人的
$prePids = @($existing | ForEach-Object { $_.Id })

# 6) 等它自己关：等 99-done.flag（沙盒跑完写的）。
#    客户端进程没了、又没留下任何标记 ⇒ **VM 根本没起来**，不必干等到超时（2026-09-24 本机就是这样）。
$flag = Join-Path $h.Harness '99-done.flag'
$budget = 180 + $TimeoutSec + 120
$waited = 0
$goneChecks = 0
$seen = $false
while ($waited -lt $budget -and -not (Test-Path $flag)) {
    Start-Sleep -Seconds 5
    $waited += 5
    $n = (Get-RunningSandbox).Count
    if ($n -gt 0) { $seen = $true; $goneChecks = 0 }
    elseif ($seen -or $waited -ge 60) { $goneChecks++ }
    if ($goneChecks -ge 12) { break }   # 连续 60 秒一个沙盒进程都没有
    if ($waited % 30 -eq 0) { Info ("…已等 " + $waited + " 秒（沙盒进程 " + $n + " 个）") }
}
$vmNeverBooted = (-not (Test-Path $flag)) -and ($goneChecks -ge 12)
if (Test-Path $flag) { Ok "沙盒跑完了（99-done.flag 出现，等了 $waited 秒）" }
elseif ($vmNeverBooted) { Bad '沙盒客户端进程已退出、又没留下 00-alive.flag ⇒ **VM 根本没起来**（没走到登录/映射那一步）' }
else { Bad "等了 $waited 秒还没等到 99-done.flag —— 沙盒可能卡住了" }
if (-not (Test-Path $flag)) {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    $bld = 0; if ($cv -and $cv.CurrentBuild) { $bld = [int]$cv.CurrentBuild }
    $note = @(
        '上一轮（' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '）开了沙盒，但**没跑起来**。',
        '  现象：WindowsSandbox 客户端进程退出了，映射目录里没有 00-alive.flag ⇒ VM 没走到登录/挂载那一步。',
        '  本机 build ' + $bld + '。实测提示：0x80070005「Windows 沙盒无法初始化。Error 0x80070005。拒绝访问。」',
        '    （2026-09-24；**dism disable+enable 重装组件、并再重启一次之后，症状一模一样**）。',
        '  **原因未查明** —— 不给推测性归因（旧版脚本的 "已迁 Store" 归因已被实测推翻：商店里搜不到该应用）。',
        '  已排除：第三方杀软 / 内存完整性（DeviceGuard·HVCI 键不存在）/ vmcompute·HvHost 未运行 / 组件库缺包（WinSxS 里 disposableclientvm 在）。',
        '  仍未排除的一种可能：那两次 dism 都带 /norestart ⇒ 也许还差一次重启（**未验证的可能**，不是结论）。',
        '  下一步（都不必现在做）：再重启一次后重试；或改用 Hyper-V 虚拟机（需要 Windows ISO）。',
        '  ⚠ 这不是交付的阻塞项：主链路已在 WSL（真 systemd、全新 home）上验过 ⇒ Windows 侧干净机器验证只是加分项。'
    ) -join "`r`n"
    try { Set-Content -LiteralPath (Join-Path $h.Harness '98-host-note.txt') -Value $note -Encoding UTF8 } catch { }
}
$waited = 0
while ($waited -lt 120 -and (Get-RunningSandbox).Count -gt 0) { Start-Sleep -Seconds 5; $waited += 5 }
Info ("等沙盒进程退出用了 " + $waited + " 秒")

# 6b) 收尾清场：**只清这次自己拉起来的**沙盒进程（硬要求：别留沙盒挂在主人屏幕上）。
#     实测（2026-09-25 主人那次）：guest 已经关了（没有 vmwp、没有窗口），但 WindowsSandbox.exe 启动器
#     可能一直不退。开跑前已经确认过"没有别的沙盒在跑"，所以这里出现的、且 PID 不在 $prePids 里的，都是我们的。
if (-not $NoCleanup) {
    $mine = @((Get-RunningSandbox) | Where-Object { $prePids -notcontains $_.Id })
    if ($mine.Count -gt 0) {
        Info ("发现 " + $mine.Count + " 个这次自己拉起的沙盒进程还没退（" + (($mine | ForEach-Object { $_.Name + '#' + $_.Id }) -join ', ') + "）—— 再等 30 秒")
        $grace = 0
        while ($grace -lt 30 -and @((Get-RunningSandbox) | Where-Object { $prePids -notcontains $_.Id }).Count -gt 0) { Start-Sleep -Seconds 5; $grace += 5 }
        $mine = @((Get-RunningSandbox) | Where-Object { $prePids -notcontains $_.Id })
        if ($mine.Count -gt 0) {
            Bad ("它们没自己退 ⇒ 收掉（这是我们自己拉起来的，且开跑前确认过机器上没有别的沙盒）：" + (($mine | ForEach-Object { $_.Name + '#' + $_.Id }) -join ', '))
            foreach ($pr in $mine) { try { Stop-Process -Id $pr.Id -Force -ErrorAction Stop; Ok ("已结束 " + $pr.Name + "#" + $pr.Id) } catch { Bad ("结束失败：" + $pr.Name + "#" + $pr.Id + " —— " + $_.Exception.Message) } }
        } else { Ok '它们自己退干净了' }
    } else { Ok '没有残留的沙盒进程' }
}

# 7) 报告
if (Show-RunReport $stageDir) { exit 0 } else { exit 4 }
