# =============================================================================
#  progress-check.ps1 —— 「等待时真的有活进度吗」的可复跑检查（2026-09-25 新增）
#
#  为什么要有它：主人 2026-09-25 00:04 跑完完整启动器后说「加载时候的...没有出现」。
#  实测根因：`start-all.ps1` 里 `Wait-Port $DshPort 45` 那一处**没传 -What**，
#  而当时的实现是"没标签 = 一个字符都不打" ⇒ 最长的那段"加载"等待全程静默。
#  光"看一眼代码觉得有"不算数 —— 这条检查把"等的时候到底有没有输出"钉成断言。
#
#  一条命令复跑（不碰任何服务、只等一个没人听的端口）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File tools\progress-check.ps1
#  退出码 0 = 全过；1 = 有失败。
#
#  [1] 行为：`Wait-PortWithProgress` 等一个**没人听**的端口 4 秒 ⇒ 捕获到的输出里必须有
#      ① 开场那句"· 等…（最多 N 秒）" ② **≥3 个点号**（逐秒打的）③ 收口"超时（4 秒…）"。
#      同时断言**真的等了**（耗时 ≥3.5 秒）—— 否则"有点号"可能只是最后补的一行。
#  [2] 反例（灵敏度）：同一个函数**不给 -What** 等 2 秒 ⇒ 输出必须**为空**。
#      这一条证明"有点号"是被测代码真的在打，不是检查脚本自己的噪音；
#      如果哪天有人把进度删了，[1] 会红；如果哪天有人把 [1] 写成恒真，[2] 这半边也兜不住 —— 所以它是必需的对照。
#  [3] 静态：`start-all.ps1` 里**每一处** `Wait-Port` 调用都必须带标签（第三个参数）——
#      这正是这次事故的根因形态。★ 检查器自己也过一次反例：喂它一段"没标签"的假源码，它必须报出来。
#  [4] 静态：关闭器的"等端口释放"必须走 `Wait-PortWithProgress`（不再各写一个静默 while）。
#  ⚠ 本文件必须 UTF-8 **带 BOM**。
# =============================================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$failures = New-Object System.Collections.ArrayList
function Fail([string]$m) { [void]$failures.Add($m); Write-Host ('  ✗ ' + $m) }
function Pass([string]$m) { Write-Host ('  ✓ ' + $m) }

. (Join-Path $PSScriptRoot 'progress.ps1')

# 挑一个**没人听**的端口：先让系统给一个随机空闲端口，然后立刻放掉它
$probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$probe.Start(); $deadPort = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port; $probe.Stop()
Start-Sleep -Milliseconds 300

Write-Host ''
Write-Host ('[1] 等待期间真的有输出吗（对着没人听的 :{0} 等 4 秒）' -f $deadPort)
# ★ 为什么用**子进程 + 真管道**量，而不是在自己进程里 `*>&1 | Out-String`：
#   实测过 —— `Write-Host -NoNewline` 走信息流(6)，在**同一个进程**里重定向会把连续的
#   -NoNewline 写合并/覆盖（第一版量出来的输出里只剩 1 个点、连 "RESULT" 都被啃掉两个字母）✗
#   那量的是"宿主怎么渲染"，不是"重定向时到底写出去了什么"。子进程 + 管道才是真的重定向现场。
function Invoke-ChildWait([string]$Body) {
    $child = @('. "' + (Join-Path $PSScriptRoot 'progress.ps1') + '"') + ($Body -split "`n")
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes(($child -join "`n")))
    return (& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc 2>&1 | Out-String)
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$txt = Invoke-ChildWait @"
`$r = Wait-PortWithProgress -Port $deadPort -TimeoutSec 8 -What '检查用的死端口'
Write-Output ("RESULT=" + `$r)
"@
$sw.Stop()
Write-Host ('    捕获到的输出：<<{0}>>' -f ($txt.Trim() -replace "`r?`n", ' | '))
Write-Host ('    耗时 {0:N1} 秒' -f $sw.Elapsed.TotalSeconds)
$marks = ([regex]::Matches($txt, '还在等检查用的死端口（已 \d+ 秒')).Count
$hasHead = ($txt -match '· 等检查用的死端口（最多 8 秒')
$hasEnd = ($txt -match '超时（8 秒')
# ★ 降级路的硬要求：**不许出现 `\r`**、也不许漏出动画帧 —— 那在文件里就是一串乱码
$hasCr = ($txt -match "`r(?!`n)")
$hasFrame = ($txt -match '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]')
if ($sw.Elapsed.TotalSeconds -lt 7.5) { Fail ('没真的等（只花了 {0:N1} 秒）—— 那"有进度行"说明不了问题' -f $sw.Elapsed.TotalSeconds) }
elseif (-not $hasHead) { Fail '输出里没有开场那句"· 等…（最多 N 秒…）"' }
elseif ($marks -lt 1) { Fail ('一行活进度都没有（重定向时每 5 秒一行，8 秒至少 1 行）') }
elseif (-not $hasEnd) { Fail '输出里没有收口那句"超时（N 秒…）"' }
elseif ($hasCr) { Fail '重定向的输出里有"裸回车"（CR 后面没跟 LF）—— 掉进日志就是一串乱码' }
elseif ($hasFrame) { Fail '重定向的输出里漏出了动画帧（应当只在 TTY 上出现）' }
else { Pass ('等待 {0:N1} 秒：降级成 {1} 行进度，开场/收口都在，且没吐 \r 与动画帧（重定向可读）' -f $sw.Elapsed.TotalSeconds, $marks) }
if ($txt -match 'RESULT=True') { Fail '等一个没人听的端口却报成功' }
elseif ($txt -match 'RESULT=False') { Pass '超时如实返回 False（没有假装成功）' }
else { Fail '没拿到返回值（子进程没跑完？）' }

Write-Host ''
Write-Host ''
Write-Host '[1b] TTY 那一行的排版（非交互环境看不到动画，所以直接量格式化函数）'
$l0 = Format-WaitLine -Label 'DSH Web' -Elapsed 0 -TimeoutSec 45 -FrameIndex 0
$l12 = Format-WaitLine -Label 'DSH Web' -Elapsed 12 -TimeoutSec 45 -FrameIndex 3
Write-Host ('    0s : <<{0}>>' -f $l0)
Write-Host ('    12s: <<{0}>>' -f $l12)
if ($l0 -notmatch '^      [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 等DSH Web（最多 45 秒） \[░{10}\] 0s/45s$') { Fail '0 秒那一行不像"帧 + 空进度条 + 0s/45s"' }
elseif ($l12 -notmatch '\[▓{2}░{8}\] 12s/45s$') { Fail '12/45 秒那一行进度条不对（应当 2 格实心）' }
else { Pass '动画行排版正确：帧 + 进度条随秒数增长 + Ns/45s（一眼看出在动、还剩多久）' }

Write-Host '[2] 反例：不给 -What 就必须一个字符都不打（证明 [1] 的点号来自被测代码）'
$quiet = Invoke-ChildWait @"
`$r = Wait-PortWithProgress -Port $deadPort -TimeoutSec 2
Write-Output ("RESULT=" + `$r)
"@
$quietTxt = ($quiet -replace "`r?`n", ' ').Trim()
if ($quietTxt -eq 'RESULT=False') { Pass '静默模式真的静默（只回返回值）—— 所以 [1] 那串点确实是被测代码打的' }
else { Fail ('不给 -What 却有输出：<<{0}>>' -f $quietTxt) }

Write-Host ''
Write-Host '[3] 静态：start-all.ps1 里每一处 Wait-Port 都要带标签（这次事故的根因形态）'
function Get-UnlabeledWaitCalls([string]$Source) {
    $bad = @()
    foreach ($line in ($Source -split "`n")) {
        if ($line -notmatch 'Wait-Port\s+\$') { continue }
        if ($line -match '^\s*#') { continue }                      # 注释不算
        if ($line -match 'function\s+Wait-Port') { continue }        # 定义不算
        # 形如 `Wait-Port $Port 45 '标签'` **或** `Wait-Port $Port 45 ('…' -f $x)` 都算带标签：
        # 数字后面紧跟一个引号或一个左括号 ⇒ 有标签；紧跟 `)` 或行尾 ⇒ 没标签（静默）。
        if ($line -notmatch "Wait-Port\s+\\?\`$\w+\s+\S+\s+[`"'(]") { $bad += $line.Trim() }
    }
    return $bad
}
$saSrc = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'start-all.ps1'), (New-Object System.Text.UTF8Encoding($false)))
$unlabeled = @(Get-UnlabeledWaitCalls $saSrc)
if ($unlabeled.Count -eq 0) { Pass 'start-all.ps1 里每一处 Wait-Port 都带了标签' }
else { foreach ($l in $unlabeled) { Fail ('这一处等待没有标签（= 静默）：' + $l) } }
# ★ 检查器自己的反例：喂它一段假源码，必须能报出来
$synthetic = "function Wait-Port([int]`$Port) { }`nif (Wait-Port `$DshPort 45) { }`nif (Wait-Port `$P 20 '标签') { }"
$synBad = @(Get-UnlabeledWaitCalls $synthetic)
if ($synBad.Count -eq 1) { Pass '检查器本身灵敏：假源码里那一处没标签的被抓到了（另一处带标签的没误报）' }
else { Fail ('检查器不灵敏：假源码应当抓到 1 处，实际 {0} 处' -f $synBad.Count) }

Write-Host ''
Write-Host '[4] 静态：关闭器的"等端口释放"走同一份实现'
$stopSrc = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'stop-all.ps1'), (New-Object System.Text.UTF8Encoding($false)))
if ($stopSrc -match 'Wait-PortWithProgress -Port \$pt\.Port -TimeoutSec 10 -Want Closed') { Pass 'stop-all.ps1 的端口释放等待走 Wait-PortWithProgress（等 + 逐秒点 + 收口一份实现）' }
else { Fail 'stop-all.ps1 的端口释放等待没走共享实现（可能又被写回静默 while）' }
if ($stopSrc -match "Join-Path \`$PSScriptRoot 'progress\.ps1'") { Pass 'stop-all.ps1 确实点源了 progress.ps1' }
else { Fail 'stop-all.ps1 没有点源 progress.ps1' }

Write-Host ''
Write-Host '[5] 静态棘轮：TTY 的每一帧都必须**自己带前置回车**（2026-09-25 独立验收抓到的那条）'
# 为什么要有它：`Write-Host -NoNewline` **只保证不换行、不会回到行首** ⇒ 少了 `r，每帧只是往同一行后面接，
#   126 字符一超宽就折行顶屏（观感从"一行转圈"变成"滚动刷屏"）。而这条分支在非交互环境里**看不见**
#   （[1b] 只量 Format-WaitLine 的排版）⇒ 只能拿源码级断言钉住。反例方向：断言必须真找到那些帧写入，
#   否则"零处命中"会恒真通过（本项目最忌讳的假绿灯）。
$progPath = Join-Path $PSScriptRoot 'progress.ps1'
$progSrc = [System.IO.File]::ReadAllText($progPath, (New-Object System.Text.UTF8Encoding($false)))
$frameLines = @([regex]::Matches($progSrc, '(?m)^.*Write-Host \(.*Format-WaitLine.*-NoNewline.*$') | ForEach-Object { $_.Value })
if ($frameLines.Count -ge 2) { Pass ('找到 {0} 处 TTY 帧写入（不是空跑）' -f $frameLines.Count) }
else { Fail ('只找到 {0} 处帧写入 —— 断言可能已失效（期望 >=2）' -f $frameLines.Count) }
$noCr = @($frameLines | Where-Object { $_ -notmatch '"`r" \+' })
if ($noCr.Count -eq 0) { Pass '每一处帧写入都前置了回车 —— cmd 里是同一行原地刷新' }
else { Fail ('有 {0} 处帧写入没带回车（会同行累加 + 折行顶屏）' -f $noCr.Count) }
$fakeNoCr = 'if ($isTty) { Write-Host (Format-WaitLine -Label $l -Elapsed 1 -TimeoutSec 2 -FrameIndex 3) -NoNewline }'
if ($fakeNoCr -notmatch '"`r" \+') { Pass '检查器灵敏：不带回车的帧写入会被判红' }
else { Fail '检查器不灵敏：不带回车的样本没被判红' }
if ($progSrc -match '(?m)^.*Write-Host \("`r" \+\(Format-WaitLine') { Pass '帧写入的写法就是"回车 + 整行"（没有第二份排版）' }
else { Pass '帧写入用的是"回车 + (Format-WaitLine …)"（等价写法，排版仍只有 Format-WaitLine 一处）' }

Write-Host ''
if ($failures.Count -eq 0) { Write-Host '结论：全过 —— 等的时候看得见它在动，而且这条检查本身是可证伪的。'; exit 0 }
Write-Host ('结论：{0} 条失败' -f $failures.Count)
foreach ($f in $failures) { Write-Host ('  ✗ ' + $f) }
exit 1
