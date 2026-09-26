<#
onboard.ps1 —— 「首启引导做完了没有」的**唯一判定与落盘处**（docs\qq-agent-产品设计.md §10.1-5 / §10.2）。

为什么单独一个脚本：窗口要不要留在桌面上（§10.1 第 5 条：**窗口可见性也是引导的一部分**）这件事，
只有一个判据 —— **引导做完没有**。判定散在两处（启动器、窗口）早晚会互相矛盾，所以收在这里：
start-all.ps1 与 dsh-prompt.ps1 都只**消费**它的结论，谁也不自己拼第二套。

判定 = 两半，缺一不可（§10.2 那条★：**引导结束的标志不是"服务起来了"，是"你在 QQ 里收到了回复"**）：
  ① **服务侧**：`tools\control.ps1 status -Json`（唯一动作源）说 `onboarded.done` —— 本脚本**不探端口、
     不自己拼判定**；control 跑不起来就按"没做完"处理（窗口留在桌面上永远不会误伤）。
  ② **真实信号**：QQ 那边**真的出去过消息**。证据来源与取舍见下面 Get-RealSignal 的注释
     （哪些行算、哪些行只是"曾经有过消息"、为什么不采信）。

落盘：`qq-bridge\state\onboarded.json`（形状按 §10.2：`{ qqLoggedIn, firstMessageVerified, completedAt }`，
另加 `source` / `evidence` 供排障与审计）。规矩：
  · **幂等**：已经有 `completedAt` 就是 latch（永不改回去、永不重写正文）；
  · **容错**：文件不在 / 读坏 / 目录没了 → 一律当"没做完"，**绝不抛异常**（窗口留桌面，无副作用）；
  · `-DryRun` 一个字节都不写。

窗口决定的输入（`decision`）：
  `minimize` = 引导已完成（latch 成立）**且**五灯全绿**且**那句一次性告知已经落地过 —— 桌面可以干净了；
  否则 `keep` = 窗口留桌面（它此刻就是引导载体：三步走 + 扫码 + 那一行"下一动作"）。
  ⚠ 为什么把"五灯全绿"也算进来：窗口要是正显示着问题（桥接断了 / QQ 没登录），把它缩掉就是**把报错藏起来**
  —— 那正是 §10.1-5 要避免的。所以"做完了但此刻不绿"照样留桌面（理由写进 `decisionWhy`）。
  ★ 为什么还要"那句告知已经落地过"：那句话说的是"**以后**我会缩到任务栏…" —— 同一轮就缩下去（差几十秒）
  主人很可能根本没读到，而**一条没人读到的告知等于没告知**。所以**第一次说那句话的那一轮留桌面**，
  下一轮起才缩（细节见下面 `$noticeGraceMin` 那段注释）。

用法（都是只读 + 至多一次落盘，绝不重启任何服务）：
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\onboard.ps1              # 人话三行
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\onboard.ps1 -Json        # 机器可读
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\onboard.ps1 -Json -DryRun  # 只判不写
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\onboard.ps1 -NoticeShown   # 把"一次性告知"标成已说

测试钩子（正常启动流程不设；和 dsh-prompt 的 DSH_WINDOW_STATUS_JSON 一个路子）：
  $env:DSH_ONBOARD_FILE       = <onboarded.json 的替身路径，测试只写 qq-bridge\state\_tmp\>
  $env:DSH_WINDOW_STATUS_JSON = <一份 control.ps1 status -Json 形状的假 JSON 文件>
                                （与 dsh-prompt 同名，因为它是由 dsh-prompt 起的子进程，环境变量会继承）

退出码：0 = 判定完成；3 = 读不到状态（已按"留桌面"处理，调用方不必当错误）。
本文件必须存成 UTF-8 **带 BOM**（PS 5.1 对无 BOM 的 UTF-8 按 ANSI 解码 → 中文注释会炸掉解析）。
#>
param(
    # 机器可读：只往 stdout 打一段 JSON（start-all / dsh-prompt 消费它）
    [switch]$Json,
    # 只读：不写 onboarded.json、不改任何标记
    [switch]$DryRun,
    # 记账：把"以后我会缩到任务栏…"这句一次性告知标成已说（幂等；没完成时是空操作）
    [switch]$NoticeShown,
    # 测试钩子（等价于 $env:DSH_ONBOARD_FILE）
    [string]$StateFile = ''
)

$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-StatePath {
    if ($StateFile) { return $StateFile }
    $hook = [string]$env:DSH_ONBOARD_FILE
    if ($hook) { return $hook }
    return (Join-Path $Root 'qq-bridge\state\onboarded.json')
}

# ── 状态侧：唯一动作源 control.ps1 status -Json ────────────────────────────────
# 沿用 tools\dsh-prompt.ps1 里那份样板（**别改成别的抓法**，2026-09-24 实测的坑）：
# 子进程用 `-File` 起、stdout 又被重定向时，PS 5.1 会按 **OEM 码页(936)** 写中文 ⇒ 我们按 UTF-8 解码
# 就得到不可恢复的乱码。所以子进程里先显式把输出编码钉成 UTF-8，命令行用 -EncodedCommand 传。
function Get-ControlStatus {
    $hook = [string]$env:DSH_WINDOW_STATUS_JSON
    if ($hook) {
        try { return ([System.IO.File]::ReadAllText($hook, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) }
        catch { return $null }
    }
    $ctl = Join-Path $PSScriptRoot 'control.ps1'
    if (-not (Test-Path $ctl)) { return $null }
    try {
        $cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & ' + "'" + $ctl + "'" + ' status -Json'
        $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $enc
        $psi.WorkingDirectory = $Root
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $Utf8NoBom
        $psi.StandardErrorEncoding = $Utf8NoBom
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

# ── 真实信号：她**真的**在 QQ 里回过话吗 ───────────────────────────────────────
# 候选来源（2026-09-24 逐个核实过；结论写在这里，别再重新发明）：
#
#  ✅ 采信 Tier 1 —— `qq-bridge\state\qq-activity.log` 里的**发送成功**行。
#     写者只有 state-lib.js 的 appendActivity()（全桥接唯一的活动日志写入口），而这几行由 bridge.js 在
#     **真的把消息交给 QQ 之后**才写：
#       bridge.js:6897  `[send] 成功 N/1 条：…`            （控制台/HTTP 发送路径）
#       bridge.js:4285  `[reserved2] 工具统一发送：成功 N/M 条`（qq_send_message 工具路径）
#       bridge.js:4124  `[reserved2] 工具分条发送：成功 N/M 条`（同上，分条）
#     ⇒ 一行 = 一条**确实出去了**的 QQ 消息。`成功 0/1`（一条都没出去）**不算**。
#  ✅ 采信 Tier 2 —— `qq-bridge\state\daily-stats.json` 里任一天 `sends >= 1`。
#     同一个 appendActivity 顺手按天计的数（state-lib.js:177 的 bumpDaily('sends')），日志被 trim（只留
#     500 行）之后它还在，所以当成 Tier 1 的**兜底**（日志滚掉了不至于把已完成判成未完成）。
#
#  ❌ 不采信 `agent 回复：…`（bridge.js:11448）—— 它写在 `sendToQQ()` **之前**，只说明"她打算说话"，
#     发失败了照样有这行。❌ 不采信 `消息已入未读：…`（bridge.js:10696）—— 那只说明**别人发了话**，
#     "服务起来了但一条都没回出去"时它照样在涨。这两条正是"曾经有过消息 ≠ 引导做完"的反面教材。
#  ❌ 不采信端口 / 进程 / 五灯 —— 那只是"服务起来了"（§10.2 的★就是为它写的）。
function Get-RealSignal {
    # 两个证据文件的路径也留测试钩子（正常流程不设）：好让"日志被 trim 掉、只剩按天计数"这条兜底
    # 真的能被验一遍（不设钩子时就是真实路径）。
    $log = Join-Path $Root 'qq-bridge\state\qq-activity.log'
    if ([string]$env:DSH_ONBOARD_ACTIVITY) { $log = [string]$env:DSH_ONBOARD_ACTIVITY }
    if (Test-Path $log) {
        try {
            # 只读尾巴 200 行（文件会被 trim 到 500 行；够用且廉价）
            $tail = @(Get-Content -LiteralPath $log -Tail 200 -Encoding UTF8 -ErrorAction SilentlyContinue)
            # 成功 N/… 里的 N 必须 ≥ 1：`成功 0/1` = 一条都没出去
            $re = '(工具统一发送|工具分条发送)\s*：\s*成功\s+[1-9]\d*|\[send\] 成功\s+[1-9]\d*'
            foreach ($line in $tail) {
                if ($line -match $re) {
                    return [pscustomobject]@{
                        hit      = $true
                        tier     = 1
                        evidence = 'qq-activity.log 里有"发送成功"记录（消息真的发到 QQ 了）'
                        sample   = $line.Trim()
                    }
                }
            }
        } catch { }
    }
    $daily = Join-Path $Root 'qq-bridge\state\daily-stats.json'
    if ([string]$env:DSH_ONBOARD_DAILY) { $daily = [string]$env:DSH_ONBOARD_DAILY }
    if (Test-Path $daily) {
        try {
            $d = [System.IO.File]::ReadAllText($daily, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            $best = ''
            foreach ($prop in @($d.PSObject.Properties)) {
                $n = 0
                try { $n = [int]$prop.Value.sends } catch { $n = 0 }
                if ($n -ge 1) { $best = ('{0}（那天发了 {1} 条）' -f $prop.Name, $n) }
            }
            if ($best) {
                return [pscustomobject]@{
                    hit      = $true
                    tier     = 2
                    evidence = ('daily-stats.json 里有发送计数：' + $best)
                    sample   = $best
                }
            }
        } catch { }
    }
    return [pscustomobject]@{
        hit      = $false
        tier     = 0
        evidence = '还没有"发到 QQ 的成功记录"（服务起来了 ≠ 她回过话）'
        sample   = ''
    }
}

function Read-OnboardState([string]$path) {
    if (-not (Test-Path $path)) { return $null }
    try { return ([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) }
    catch { return $null }
}

# 容错取字段：文件不在 / 读坏 / 没这个字段 → 一律空串，**绝不抛异常**（"读坏当没做完"就落在这）
function Get-Field($obj, [string]$name) {
    if (-not $obj) { return '' }
    try {
        if (@($obj.PSObject.Properties.Name) -notcontains $name) { return '' }
        return [string]$obj.$name
    } catch { return '' }
}

function Save-OnboardState([string]$path, $obj) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $text = ($obj | ConvertTo-Json -Depth 6)
    $tmp = ($path + '.tmp' + $PID)
    [System.IO.File]::WriteAllText($tmp, $text, $Utf8NoBom)
    # 尽量原子：同卷用 Replace（读者只会看到"旧的或新的"，不会看到半个文件）；退不了再退回 删+移
    try {
        if (Test-Path $path) { [System.IO.File]::Replace($tmp, $path, $null) }
        else { [System.IO.File]::Move($tmp, $path) }
    } catch {
        if (Test-Path $path) { [System.IO.File]::Delete($path) }
        [System.IO.File]::Move($tmp, $path)
    }
}

$statePath = Get-StatePath
$state = Read-OnboardState $statePath
$completedAt = Get-Field $state 'completedAt'
$latched = [bool]$completedAt

$notice = '以后我会缩到任务栏，出问题了它自己会跳出来'

# ── -NoticeShown：只记一笔"这句话说过了"（幂等；没完成时不写）──────────────────
if ($NoticeShown) {
    if (-not $latched) {
        if (-not $Json) { Write-Host '  （引导还没完成 —— 一次性告知不记账，什么都不做）' }
        exit 0
    }
    if (Get-Field $state 'noticeShownAt') {
        if (-not $Json) { Write-Host '  （这句话已经说过了 —— 不重复）' }
        exit 0
    }
    if ($DryRun) {
        if (-not $Json) { Write-Host '  [DryRun] 本来会把"一次性告知"标成已说（现在不动）' }
        exit 0
    }
    try {
        $state | Add-Member -NotePropertyName 'noticeShownAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
        Save-OnboardState -path $statePath -obj $state
        if (-not $Json) { Write-Host '  ✓ 记下了：那句"以后我会缩到任务栏…"已经说过了（不会再重复）' }
    } catch {
        if (-not $Json) { Write-Host ('  [警告] 记账失败（不影响别的）：{0}' -f $_.Exception.Message) }
    }
    exit 0
}

# ── 判定 ──────────────────────────────────────────────────────────────────────
$status = Get-ControlStatus
$statusOk = [bool]$status
$allGreen = $false
$servicesReady = $false
$onboardedSource = '（读不到状态）'
if ($statusOk) {
    $allGreen = [bool]$status.allGreen
    $servicesReady = [bool]$status.onboarded.done
    $onboardedSource = [string]$status.onboarded.source
}

$signal = Get-RealSignal
$done = $latched
$justLatched = $false   # 这次**真的**写下了完成态
$wouldLatch = $false    # 条件成立但 -DryRun 没写（只是"本来会写"）
$now = (Get-Date).ToString('o')

if (-not $done -and $statusOk -and $servicesReady -and $signal.hit) {
    # ★ 两半都齐了才算做完：control 说"引导做完了"（唯一动作源）+ 真实信号（她真的回过话）。
    $done = $true
    if ($DryRun) {
        $wouldLatch = $true
    } else {
        $obj = [ordered]@{
            qqLoggedIn             = [bool]$status.lights.qq
            firstMessageVerified   = $true
            completedAt            = $now
            firstMessageVerifiedAt = $now
            source                 = ('control.ps1 status（' + $onboardedSource + '） + ' + $signal.evidence)
            evidence               = [ordered]@{ tier = [int]$signal.tier; sample = [string]$signal.sample }
        }
        try { Save-OnboardState -path $statePath -obj $obj } catch { }
        $state = Read-OnboardState $statePath
        $completedAt = Get-Field $state 'completedAt'
        $latched = [bool]$completedAt
        $justLatched = $latched
        if (-not $latched) { $done = $false }   # 写不下去就老实说"没做完"（下一轮再试）
    }
}

# ── 窗口决定：做完了**且**此刻五灯全绿**且**那句一次性告知已经落地了 → 才可以缩 ────────
# ★ 2026-09-24 第五批补（主人/主会话的判据）：**第一次说那句话的那一轮不要缩窗口**。
#   为什么：那句话说的是"**以后**我会缩到任务栏…" —— 同一轮就缩下去（差几十秒）用户很可能根本没读到，
#   而"一条没人读到的告知等于没告知"（§10.1 第一条：不要让用户不知道做什么）。
#   所以：这一轮是**第一次**要说那句告知（还没说过 / 刚说完没多久）⇒ 留桌面让人读到；下一轮起才缩。
#   那句话由**窗口横幅**负责说（dsh-prompt.ps1，只有它能把字打在主人眼前），说完它调 -NoticeShown 记账；
#   这里只**读**两个事实：`noticePending`（还没说）与 `noticeRecent`（刚说完 —— 「同一轮」的近似）。
#   ⚠ 用"刚说完 10 分钟内"而不是精确的"同一轮"：横幅与收尾之间有几十秒到几分钟的先后不定（谁先谁后
#     都成立），10 分钟把这个窗口盖住，而且**多留一次窗口是无害的方向**（真正要避免的是"缩了但没读到"）。
#     代价：10 分钟内连着启动两次，第二次也留桌面（下一轮就正常缩了）。
$noticeGraceMin = 10
$noticeShownAt = Get-Field $state 'noticeShownAt'
$noticeRecent = $false
if ($noticeShownAt) {
    try { $noticeRecent = (((Get-Date) - [datetime]::Parse($noticeShownAt)).TotalMinutes -lt $noticeGraceMin) } catch { $noticeRecent = $false }
}
$noticePending = ($done -and -not $noticeShownAt)

# 窗口决定：做完了**且**此刻五灯全绿 → 可以缩；否则留桌面（窗口正是引导/报错载体）。
$decision = 'keep'
$decisionWhy = ''
if (-not $done) {
    if (-not $statusOk) {
        $decisionWhy = '读不到状态（control.ps1 status 没跑起来）—— 窗口留着，它上面有"下一动作"'
    } elseif (-not $signal.hit) {
        $decisionWhy = '引导未完成：还没有"发到 QQ 的成功记录"—— 窗口留在桌面上当引导载体'
    } else {
        $decisionWhy = '引导未完成（control 侧的判定：' + $onboardedSource + '）—— 窗口留桌面'
    }
} elseif (-not $allGreen) {
    $decisionWhy = '引导已完成，但此刻五灯不全绿 —— 窗口留着，别把报错藏起来（出事它会自己跳出来）'
} elseif ($noticePending -or $noticeRecent) {
    $decisionWhy = '这一轮要说的正是那句"以后我会缩到任务栏…"（引导完成后的第一次）—— 留桌面让人读到；' + `
                   '下一轮起才按判据缩（一条没人读到的告知等于没告知）'
} else {
    $decision = 'minimize'
    $decisionWhy = '引导已完成、五灯全绿，那句一次性告知也已经说过了 —— 收尾把窗口一起缩到任务栏（出问题它自己跳回来）'
}

if ($Json) {
    $out = [ordered]@{
        ok              = $statusOk
        done            = $done
        latched         = $latched
        justLatched     = $justLatched
        wouldLatch      = $wouldLatch
        decision        = $decision
        decisionWhy     = $decisionWhy
        evidence        = $signal.evidence
        evidenceTier    = [int]$signal.tier
        evidenceSample  = [string]$signal.sample
        servicesReady   = $servicesReady
        allGreen        = $allGreen
        onboardedSource = $onboardedSource
        noticePending   = $noticePending
        noticeRecent    = $noticeRecent
        noticeGraceMin  = $noticeGraceMin
        noticeShownAt   = $noticeShownAt
        notice          = $notice
        completedAt     = $completedAt
        stateFile       = $statePath
        dryRun          = [bool]$DryRun
    }
    Write-Output ($out | ConvertTo-Json -Depth 6 -Compress)
    if (-not $statusOk) { exit 3 }
    exit 0
}

# ── 人话 ──────────────────────────────────────────────────────────────────────
$mark = if ($done) { '✓ 已完成' } else { '✗ 未完成' }
$byWhat = if ($latched) { ('（判据：' + $statePath + '）') }
          elseif ($wouldLatch) { '（判据齐了 —— 这次是 -DryRun，没落盘）' }
          else { '（还没有完成态记录）' }
Write-Host ''
Write-Host ('  引导      {0}{1}' -f $mark, $byWhat)
Write-Host ('  真实信号  {0} {1}' -f $(if ($signal.hit) { '✓' } else { '✗' }), $signal.evidence)
if ($justLatched) { Write-Host ('  落盘      ✓ 刚写下完成态：{0}' -f $statePath) }
if ($wouldLatch) { Write-Host ('  落盘      ○ [DryRun] 本来会写下：{0}（现在不动）' -f $statePath) }
if (-not $statusOk) { Write-Host '  服务侧    ⚠ 读不到状态（tools\control.ps1 status 没跑起来）' }
else { Write-Host ('  服务侧    {0}（{1}）' -f $(if ($servicesReady) { 'control 说引导已完成' } else { 'control 说引导未完成' }), $onboardedSource) }
if ($noticePending) {
    Write-Host ('  一次性告知 {0}（★ 这一轮要说的就是它 ⇒ 窗口留桌面让人读到）' -f $notice)
} elseif ($noticeRecent) {
    Write-Host ('  一次性告知 刚说过（{0} 分钟内）⇒ 这一轮窗口照旧留桌面，下一轮起才缩' -f $noticeGraceMin)
} else {
    Write-Host ('  一次性告知 已经说过（{0}）—— 不再重复' -f $noticeShownAt)
}
Write-Host ('  窗口决定  {0} —— {1}' -f $(if ($decision -eq 'minimize') { '→ 最小化' } else { '→ 留桌面' }), $decisionWhy)
Write-Host ''
if (-not $statusOk) { exit 3 }
exit 0
