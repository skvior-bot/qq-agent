# =============================================================================
#  progress.ps1 —— **等待时的活进度**（2026-09-25 新增；主人："程序正在等待运行的时候加个…
#  用来提醒用户程序正在运行，而不是让他们以为开掉了"）
#
#  为什么单独一份：启动器与关闭器各有好几处"必须等"（等端口起来 / 等端口释放 / 等进程退干净），
#  以前**每处各写一个 while**，于是"有没有进度提示"取决于某处作者当时想没想起来 ——
#  主人 00:04 那次跑完说"加载时候的...没有出现"，根因就是 `Wait-Port $DshPort 45` 那一处
#  **没给标签**（不给标签 = 一个字符都不打），而它正好是最长的"加载"等待之一。
#  现在：**等就调这里**，进度是函数的一部分，想忘也忘不掉。
#
#  ★ 可见性（主人是在 cmd 窗口里看的）：
#    · 用 `Write-Host -NoNewline`（PS 5.1 的 Write-Host 走宿主 UI，**行内立即写出**，不做行缓冲）
#      ⇒ cmd 窗口里**逐秒看得见点号**；
#    · ⚠ 但 `-NoNewline` 只保证"不换行"、**不会回到行首** ⇒ 每帧必须**自己前置回车**（见下面帧写入那两处的注释），
#      否则同一行不断累加、一超宽就折行顶屏（2026-09-25 实测：`-NoNewline 'AAA'` + `'BBB'` = `AAABBB`）。
#    · 被重定向到文件时（`> log`）也一样会落盘，只是**同一行上一串点** —— 这条我们接受：
#      **以 cmd 可见为准**（主人的主力路径就是双击 一键启动.cmd）。
#    · ⚠ 不许为了"好看"引入 Tee-Object / 换掉 log-run.ps1 的写法（那是断令牌链的红线）。
#
#  用法：
#    . (Join-Path $PSScriptRoot 'progress.ps1')
#    if (Wait-PortWithProgress -Port $P -TimeoutSec 45 -What 'DSH Web') { ... }
#    if (Wait-PortWithProgress -Port $P -TimeoutSec 10 -What 'DSH Web 释放' -Want Closed) { ... }
#  本文件必须 UTF-8 **带 BOM**。
# =============================================================================

# 端口状态（**本文件自用的一份**：等待逻辑要能被单独拎出来测，所以自带探针，不依赖调用方）
function Test-PortState {
    param([int]$Port, [ValidateSet('Open', 'Closed')][string]$Want = 'Open')
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(800, $false)) { $open = $false }
        else { $client.EndConnect($async); $open = $true }
    } catch { $open = $false } finally { $client.Close() }
    if ($Want -eq 'Open') { return $open }
    return (-not $open)
}

# 渲染"等待中"的那一行（**唯一一处排版**：TTY 动画与降级行都用它格式化，好测也好改）。
#   例：`      ⠹ 等 DSH Web（最多 45 秒） [▓▓▓░░░░░░░] 12s/45s`
#   主人要"一行显示…让这个一直在闪烁表示正在启动"，顺带把"还剩多久"摆在眼前。
function Format-WaitLine {
    param([string]$Label, [int]$Elapsed, [int]$TimeoutSec, [int]$FrameIndex = 0)
    $frames = @('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')
    $frame = $frames[[Math]::Abs($FrameIndex) % $frames.Count]
    $width = 10
    $filled = 0
    if ($TimeoutSec -gt 0) { $filled = [int][Math]::Floor($width * ([Math]::Min($Elapsed, $TimeoutSec) / [double]$TimeoutSec)) }
    $bar = ('▓' * $filled) + ('░' * ($width - $filled))
    return ('      {0} 等{1}（最多 {2} 秒） [{3}] {4}s/{2}s' -f $frame, $Label, $TimeoutSec, $bar, $Elapsed)
}

# 等端口到某个状态，**期间一行原地刷新**（TTY）/ **降级成每 5 秒一行**（输出被重定向时）。
#   · ★ 主人 2026-09-25 00:2x 原话："这个…的等待可以不用显示那么多次，我想的是**一行显示…
#     让这个一直在闪烁**表示正在启动就行了，如果可以美化更好" ⇒ 不再一行行往下刷。
#   · 两条路都要可读（硬要求）：
#       · TTY（`一键启动.cmd` 的 cmd 窗口）：`\r` + 动画帧 + 进度条 + 秒数，**同一行原地变**；
#       · 重定向（被 `log-run.ps1` / `> log` 接走时 `[Console]::IsOutputRedirected` = True）：
#         **自动降级**成每 5 秒一整行 —— `\r` 掉进文件就是一串乱码，所以降级路一个 `\r` 都不写。
#   · 收口：TTY 上先把动画行擦掉再打结论；两条路都打 `✓ 好了（X.X 秒）` / `✗ 超时（…）`。
function Wait-PortWithProgress {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][int]$TimeoutSec,
        [string]$What = '',
        [ValidateSet('Open', 'Closed')][string]$Want = 'Open',
        [int]$PollMs = 500,
        [int]$QuietEverySec = 5      # 降级路：每几秒一行
    )
    $label = if ($What) { $What } else { "端口 $Port" }
    $isTty = $true
    try { $isTty = -not [Console]::IsOutputRedirected } catch { $isTty = $false }
    if ($What) {
        # ★ 2026-09-25（独立验收抓到的真缺陷）：帧写入必须**自己带前置回车**（`r）。
        #   `Write-Host -NoNewline` 只保证"不换行"，**不会回到行首** ⇒ 少了这个 `r，每帧只是往同一行后面接，
        #   126 字符一超宽就折行顶屏（实测：`-NoNewline 'AAA'` + `'BBB'` = `AAABBB`），观感从"一行转圈"变成"滚动刷屏"。
        if ($isTty) { Write-Host ("`r" + (Format-WaitLine -Label $label -Elapsed 0 -TimeoutSec $TimeoutSec -FrameIndex 0)) -NoNewline }
        else { Write-Host ('      · 等{0}（最多 {1} 秒；这条输出被重定向了，进度降级成每 {2} 秒一行）' -f $label, $TimeoutSec, $QuietEverySec) }
    }
    $started = Get-Date
    $deadline = $started.AddSeconds($TimeoutSec)
    $lastQuiet = 0
    $frame = 0
    $ok = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-PortState -Port $Port -Want $Want) { $ok = $true; break }
        Start-Sleep -Milliseconds $PollMs
        if (-not $What) { continue }
        $elapsed = [int]((Get-Date) - $started).TotalSeconds
        if ($isTty) {
            $frame++
            Write-Host ("`r" + (Format-WaitLine -Label $label -Elapsed $elapsed -TimeoutSec $TimeoutSec -FrameIndex $frame)) -NoNewline
        } elseif ($elapsed -ge ($lastQuiet + $QuietEverySec)) {
            $lastQuiet = $elapsed
            Write-Host ('        … 还在等{0}（已 {1} 秒 / 最多 {2} 秒）' -f $label, $elapsed, $TimeoutSec)
        }
    }
    if ($What) {
        $spent = ((Get-Date) - $started).TotalSeconds
        if ($isTty) { Write-Host ("`r" + (' ' * 78) + "`r") -NoNewline }   # 先把动画行擦干净，别和结论叠在一起
        if ($ok) { Write-Host ('      ✓ {0} 好了（{1:N1} 秒）' -f $label, $spent) }
        else { Write-Host ('      ✗ {0} 超时（{1} 秒，还是没等到）' -f $label, $TimeoutSec) }
    }
    return $ok
}
